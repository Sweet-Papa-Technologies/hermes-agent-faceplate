// Push-to-talk controller.
//
// Caveat that the design doc glosses over: Electron's `globalShortcut` fires
// once per *press* — there's no native key-up event. To approximate hold-to-
// talk we treat the first hotkey press as "start recording" and the second
// press as "stop & send". Power users who need true hold semantics can
// configure a separate "interrupt" hotkey to cancel without sending.
//
// (A v1.1 improvement is a tiny native helper that watches the keyboard for
// release events on macOS/Linux. Out of scope here.)

import { startAsrSession, type AsrSession, type AsrEndpoint } from './asr-client';
import { useAgentStore } from '../stores/agent';
import { useSettingsStore } from '../stores/settings';
import { eventBus } from '../boot/event-bus';
import { interrupt as interruptTurn } from '../hermes/turn-handler';

let session: AsrSession | null = null;
let starting = false;
let stopping = false;
let attached = false;
let detach: (() => void) | null = null;

function log(...args: unknown[]): void {
  // Verbose by design — PTT is hard to debug without seeing every state
  // transition. The avatar's DevTools console is the right place to look.
  console.log('[ptt]', ...args);
}

export function attachPttController(): void {
  if (attached) return;
  const fp = window.faceplate;
  if (!fp) return;
  const off = fp.hotkeys.onPress((name) => {
    if (name === 'push_to_talk') void toggle();
    if (name === 'interrupt' && session) cancel();
  });
  detach = () => {
    off();
    cancel();
  };
  attached = true;
}

export function detachPttController(): void {
  detach?.();
  detach = null;
  attached = false;
}

export async function toggle(): Promise<void> {
  log('toggle pressed', { session: !!session, starting, stopping, agentState: useAgentStore().state });
  if (starting) {
    log('ignoring — start in progress');
    return;
  }
  if (stopping) {
    log('ignoring — stop in progress');
    return;
  }
  return session ? stopAndSend() : start();
}

/** Public escape hatch — wired to the interrupt hotkey AND callable from the
 * settings UI to recover from a wedged session. Tears down everything and
 * resets the FSM to idle. */
export function reset(): void {
  log('reset called');
  if (session) {
    try {
      session.cancel();
    } catch (err) {
      log('cancel during reset threw:', err);
    }
    session = null;
  }
  starting = false;
  stopping = false;
  const agent = useAgentStore();
  if (agent.state === 'listening') agent.transition('idle', 'ptt.reset');
  else if (agent.state === 'error') agent.clearError();
}

async function start(): Promise<void> {
  if (starting || session) {
    log('start: skipping (already starting or active)');
    return;
  }
  starting = true;
  const settings = useSettingsStore();
  const agent = useAgentStore();
  const endpoint = asrEndpointFromSettings(settings);
  if (!endpoint) {
    log('start: no ASR endpoint (sidecar disabled?)');
    starting = false;
    return;
  }

  // If the agent is mid-turn (thinking or speaking), barge-in first so the
  // FSM matrix allows the listening transition.
  if (agent.state === 'thinking' || agent.state === 'speaking') {
    interruptTurn('user.ptt');
  }

  log('start: opening mic…');
  try {
    const next = await startAsrSession({ endpoint });
    session = next;
    agent.transition('listening', 'ptt');
    log('start: recording');
    next.done.catch((err) => {
      // Distinguish "user cancelled" from "real failure" — cancel rejects
      // the done promise with "asr cancelled" but isn't an error condition
      // the user should see.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'asr cancelled') {
        log('session ended via cancel');
        if (session === next) session = null;
        return;
      }
      if (session === next) session = null;
      console.error('[ptt] session failed:', err);
      agent.setError('asr.failure', msg);
    });
  } catch (err) {
    console.error('[ptt] failed to open mic:', err);
    agent.setError('mic.permission', err instanceof Error ? err.message : String(err));
  } finally {
    starting = false;
  }
}

async function stopAndSend(): Promise<void> {
  if (!session) {
    log('stopAndSend: no active session');
    return;
  }
  if (stopping) {
    log('stopAndSend: already stopping, ignoring');
    return;
  }
  stopping = true;
  const agent = useAgentStore();
  const s = session;
  session = null;
  log('stopAndSend: stopping recorder, awaiting transcript…');
  try {
    const result = await s.stop();
    log('stopAndSend: transcript received', { len: result.text.length, ms: result.duration_ms });
    if (!result.text) {
      // listening → idle is legal; if we somehow drifted into error, clear it.
      if (agent.state === 'error') agent.clearError();
      else agent.transition('idle', 'asr.empty');
      return;
    }
    eventBus.emit({
      type: 'user.input.voice',
      ts: Date.now(),
      payload: {
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        duration_ms: result.duration_ms,
      },
    });
  } catch (err) {
    console.error('[ptt] transcription failed:', err);
    agent.setError('asr.transcribe', err instanceof Error ? err.message : String(err));
  } finally {
    stopping = false;
  }
}

function cancel(): void {
  if (!session) return;
  log('cancel called');
  const agent = useAgentStore();
  session.cancel();
  session = null;
  stopping = false;
  if (agent.state === 'listening') agent.transition('idle', 'ptt.cancel');
}

function asrEndpointFromSettings(settings: ReturnType<typeof useSettingsStore>): AsrEndpoint | null {
  const s = settings.settings.speech;
  if (s.sidecar_mode === 'disabled') return null;
  return {
    baseUrl: `${s.sidecar_url.replace(/\/$/, '')}/v1`,
    ...(s.sidecar_token ? { apiKey: s.sidecar_token } : {}),
    model: s.asr.model,
    language: s.asr.language,
  };
}
