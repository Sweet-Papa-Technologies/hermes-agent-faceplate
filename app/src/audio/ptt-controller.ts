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

let session: AsrSession | null = null;
let attached = false;
let detach: (() => void) | null = null;

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
  return session ? stopAndSend() : start();
}

async function start(): Promise<void> {
  const settings = useSettingsStore();
  const agent = useAgentStore();
  const endpoint = asrEndpointFromSettings(settings);
  if (!endpoint) return;

  try {
    session = await startAsrSession({ endpoint });
    agent.transition('listening', 'ptt');
    session.done.catch((err) => {
      console.error('[ptt] session failed:', err);
      agent.setError('asr.failure', err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.error('[ptt] failed to open mic:', err);
    agent.setError('mic.permission', err instanceof Error ? err.message : String(err));
  }
}

async function stopAndSend(): Promise<void> {
  if (!session) return;
  const agent = useAgentStore();
  const s = session;
  session = null;
  try {
    const result = await s.stop();
    if (!result.text) {
      agent.transition('idle', 'asr.empty');
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
  }
}

function cancel(): void {
  if (!session) return;
  const agent = useAgentStore();
  session.cancel();
  session = null;
  agent.transition('idle', 'ptt.cancel');
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
