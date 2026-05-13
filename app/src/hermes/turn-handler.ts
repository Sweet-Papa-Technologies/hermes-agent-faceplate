// Turn orchestrator. Glues:
//   user.input.text / user.input.voice
//     ─► hermes /v1/runs (when discovery says so) OR /v1/chat/completions
//        ─► tokens → conversation store + agent.token events
//        ─► tool_call → agent.tool_call events (post-hoc captions)
//     ─► paraphrase pass (when text > trigger_chars)
//     ─► tts-client (speakStream) → viseme-driver (mouth animation)
//     ─► state machine: idle → thinking → speaking → idle
//
// Barge-in (user.interrupt, user.input.text mid-speech, etc.) aborts the
// in-flight chat fetch, the TTS stream, and POSTs `/v1/runs/{id}/stop` when
// a runs handle is active.

import { eventBus } from '../boot/event-bus';
import { useAgentStore } from '../stores/agent';
import { useConversationStore } from '../stores/conversation';
import { useConversationsStore } from '../stores/conversations';
import { useSettingsStore } from '../stores/settings';
import { useDiscoveryStore } from '../stores/discovery';
import { streamChat, type ChatEndpoint, type ChatTurn } from './chat-client';
import { startRun, type RunHandle, type RunsEndpoint } from './runs-client';
import { startResponse, type ResponseHandle, type ResponsesEndpoint } from './responses-client';
import { paraphrase } from './paraphrase';
import { stripForSpeech } from './strip-for-speech';
import { extractArtifacts } from './extract-artifacts';
import { buildCanvasInstructions } from './canvas-instructions';
import { speakStream, type SpeakHandle } from '../audio/tts-client';
import { startVisemeDriver, type DriverHandle } from '../audio/viseme-driver';
import { suspendAudio, resumeAudio } from '../audio/audio-context';
import type { TtsMime, TtsFormat } from './event-schema';

interface ActiveTurn {
  abort: AbortController;
  tts: SpeakHandle | null;
  driver: DriverHandle | null;
  run: RunHandle | null;
  response: ResponseHandle | null;
}

let active: ActiveTurn | null = null;
let attached = false;
let detach: (() => void) | null = null;

// Cross-module-reload guard. Vite HMR replaces the turn-handler module on
// edit, but the OLD module's eventBus subscriptions remain attached — the
// new module's `attached` flag is false, so it adds a SECOND set of
// listeners. Result: every `user.input.text` fires runTurn twice → two
// user turns saved with the same text, no assistant turn (because the
// second run barges in before the first's `startTurn('assistant')` runs).
//
// Stash the previous detach on globalThis so the next attach can clean
// up regardless of which module the previous attach came from.
const GLOBAL_DETACH_KEY = '__faceplate_turn_handler_detach__';
type GlobalWithDetach = typeof globalThis & { [GLOBAL_DETACH_KEY]?: () => void };

// Session id for hermes-agent's /v1/runs is sourced from the active
// conversation, NOT a module variable. That way it survives app restarts
// (loaded from disk on boot) and follows the user across conversation
// switches without the turn-handler needing to know about either flow.
function getActiveSessionId(): string | null {
  return useConversationsStore().activeSessionId ?? null;
}

function rememberSessionId(sid: string): void {
  const convs = useConversationsStore();
  const convo = useConversationStore();
  if (convs.activeSessionId === sid) return;
  convs.setActiveSessionIdLocal(sid);
  // Persist the session id immediately. Without this, a crash between the
  // first server response and the assistant turn finalize would lose the
  // handle to hermes' server-side conversation memory.
  void convs.saveActive(convo.snapshotForPersist(), sid);
}

function rememberResponseId(rid: string): void {
  const convs = useConversationsStore();
  const convo = useConversationStore();
  if (convs.activeLastResponseId === rid) return;
  convs.setActiveLastResponseIdLocal(rid);
  // Persist immediately so a mid-turn crash doesn't lose the chain head.
  void convs.saveActive(convo.snapshotForPersist(), convs.activeSessionId, rid);
}

let turnCount = 0;
let speakCount = 0;

export function attachTurnHandler(): void {
  if (attached) return;
  // Defensive: if a previous module instance left listeners attached
  // (hot reload), tear them down before adding ours.
  const g = globalThis as GlobalWithDetach;
  const prior = g[GLOBAL_DETACH_KEY];
  if (typeof prior === 'function') {
    console.log('[turn] attachTurnHandler: tearing down stale listeners from prior module instance');
    try { prior(); } catch (err) { console.warn('[turn] prior detach threw:', err); }
  }

  const offText = eventBus.on('user.input.text', (e) => void runTurn(e.payload.text));
  const offVoice = eventBus.on('user.input.voice', (e) => void runTurn(e.payload.text));
  const offInterrupt = eventBus.on('user.interrupt', () => interrupt('user.interrupt'));
  detach = () => {
    offText();
    offVoice();
    offInterrupt();
    interrupt('detach');
  };
  attached = true;
  g[GLOBAL_DETACH_KEY] = detach;
  console.log('[turn] attachTurnHandler: handlers wired');
}

export function detachTurnHandler(): void {
  detach?.();
  detach = null;
  attached = false;
  const g = globalThis as GlobalWithDetach;
  delete g[GLOBAL_DETACH_KEY];
}

/** Silence (or restore) the in-flight TTS audio without aborting the turn.
 * No-op when there's no active TTS handle — safe to call freely from a
 * mute-toggle watcher. The agent's `speaking` state still transitions to
 * idle naturally when the silenced playback ends, the assistant text stays
 * in the conversation, and the viseme driver keeps animating off the
 * (still-decoding) waveform. */
export function setActiveTtsMuted(muted: boolean): void {
  active?.tts?.setMuted(muted);
}

export function interrupt(reason: string): void {
  if (!active) return;
  const a = active;
  active = null;
  try {
    a.tts?.abort();
  } catch {
    /* noop */
  }
  try {
    a.driver?.stop();
  } catch {
    /* noop */
  }
  if (a.run) {
    void a.run.stop();
  }
  // Responses path: aborting the AbortController cancels the SSE stream;
  // server stops generating once the connection drops.
  a.abort.abort(reason);
  // Per design §4.6: barge-in suspends the AudioContext too. We resume on
  // the next play() (TTS client's autoplay flow re-resumes via getAudioContext).
  void suspendAudio();

  const agent = useAgentStore();
  const convo = useConversationStore();
  convo.finalizeTurn();
  agent.setActivity(null);
  // From `error`, only clearError() is allowed by the FSM matrix.
  if (agent.state === 'error') agent.clearError();
  else if (agent.state !== 'idle') agent.transition('idle', reason);

  eventBus.emit({
    type: 'agent.interrupt',
    ts: Date.now(),
    payload: { initiator: reason.startsWith('user') ? 'user' : 'system' },
  });
}

async function runTurn(userText: string): Promise<void> {
  const id = ++turnCount;
  console.log(`[convsave] runTurn #${id} START text="${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}" active=${active ? 'yes(barge-in)' : 'no'}`);
  if (active) interrupt('barge-in');

  const settings = useSettingsStore();
  const discovery = useDiscoveryStore();
  const agent = useAgentStore();
  const convo = useConversationStore();

  // Record the user turn in conversation history.
  convo.startTurn('user');
  convo.setText(userText);
  convo.finalizeTurn();

  agent.transition('thinking', 'turn.start');
  agent.setActivity({ label: 'Thinking', icon: 'auto_awesome', ts: Date.now() });
  convo.startTurn('assistant');

  // Bring the avatar to the front so the user sees the response without
  // hunting for the window. Doesn't steal text focus (main uses moveTop /
  // showInactive). Disabled via settings.avatar.raise_on_submit.
  if (settings.settings.avatar.raise_on_submit) {
    void window.faceplate?.window.raiseAvatar();
  }

  const abort = new AbortController();
  const handle: ActiveTurn = { abort, tts: null, driver: null, run: null, response: null };
  active = handle;

  let assistantText = '';
  try {
    // Try /v1/responses first — it gives us server-managed conversation
    // state via previous_response_id chaining (same flow the in-process
    // TUI gets). Fall back to /v1/runs for older Hermes builds, or to
    // /v1/chat/completions if even runs is unavailable.
    if (discovery.useRuns) {
      try {
        assistantText = await consumeResponses(handle, userText, settings);
      } catch (err) {
        if (active !== handle || abort.signal.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        // 404 (endpoint missing on older hermes) → fall through to runs.
        // Anything else → re-throw.
        if (!/HTTP 404/i.test(reason)) throw err;
        console.warn('[turn] /v1/responses 404; falling back to /v1/runs');
        assistantText = await consumeRuns(handle, userText, settings);
      }
    } else {
      assistantText = await consumeChat(handle, userText, settings);
    }
  } catch (err) {
    // If the user already barged in, interrupt() handled the FSM + caption
    // teardown — don't re-emit error/aborted events from this stale turn.
    if (active !== handle) return;
    active = null;
    convo.finalizeTurn();
    if (abort.signal.aborted) {
      agent.transition('idle', 'chat.aborted');
      return;
    }
    agent.setError('chat.failure', err instanceof Error ? err.message : String(err));
    return;
  }

  if (!assistantText) {
    if (active !== handle) return;
    active = null;
    convo.finalizeTurn();
    agent.transition('idle', 'chat.empty');
    return;
  }

  // Critical guard: if a barge-in (`interrupt('barge-in')` from a newer
  // turn) replaced us while we were awaiting consumeRuns/consumeChat, drop
  // out before we paraphrase, emit, or — most importantly — start a TTS
  // stream. Without this, two concurrent runTurns both call speakAndAnimate
  // and the user hears two voices talking over each other.
  if (active !== handle) return;

  // Extract any inline <artifact> tags from the assistant response. Each
  // tag becomes a persisted artifact; the in-flight turn's text is
  // rewritten without the tags so captions, conversation panel, and TTS
  // all see the prose only. Done BEFORE paraphrase so the paraphrase
  // model isn't asked to rephrase JSON / chart configs / mermaid source.
  const extracted = extractArtifacts(assistantText);
  if (extracted.artifacts.length > 0) {
    assistantText = extracted.cleanedText;
    convo.setText(assistantText);
    // Must AWAIT — `attachArtifact()` only modifies the in-flight
    // currentTurn. If we fired this and continued, speakAndAnimate would
    // call finalizeTurn() (clearing currentTurn) BEFORE the artifact
    // creates returned. The subsequent attachArtifact calls would no-op
    // (early-return when currentTurn is null), the syncer's $onAction
    // save fires WITHOUT artifact_ids on the turn, and the conversation
    // panel ends up with the turn but no chips.
    await persistAndAttachArtifacts(handle, extracted.artifacts);
    if (active !== handle) return;
  }

  // Paraphrase pass — defer to main process which holds the LLM api key.
  let spokenText = assistantText;
  let paraphraseText: string | undefined;
  try {
    const r = await paraphrase(assistantText);
    if (r.used !== 'skipped' && r.used !== 'disabled' && r.text && r.text !== assistantText) {
      spokenText = r.text;
      paraphraseText = r.text;
    }
  } catch (err) {
    console.warn('[turn] paraphrase failed (non-fatal):', err);
  }

  // Same guard after the paraphrase await — barge-in may have happened
  // while we were waiting on litert-lm.
  if (active !== handle) return;

  eventBus.emit({
    type: 'agent.response',
    ts: Date.now(),
    payload: {
      text: assistantText,
      ...(paraphraseText ? { paraphrase: paraphraseText } : {}),
      finished_reason: 'stop',
    },
  });

  // Captions get the original (markdown intact); TTS gets a stripped
  // version so Piper doesn't read "asterisk asterisk bold asterisk asterisk".
  // Wrap in try/catch — any unhandled rejection from TTS (sidecar down,
  // network blip, MSE edge case) would otherwise propagate up to the
  // event-bus handler that called us via `void runTurn(...)`, becoming
  // an unhandled promise rejection. The assistant turn never finalizes
  // and the conversation save never fires — turn vanishes from history.
  try {
    await speakAndAnimate(handle, stripForSpeech(spokenText), settings);
  } catch (err) {
    console.warn('[turn] speakAndAnimate threw — finalizing defensively:', err);
  }
  // Re-arm the AudioContext for the next turn (suspended on barge-in).
  void resumeAudio();

  // Defensive belt-and-suspenders save. speakAndAnimate normally calls
  // finalizeTurn (which fires the syncer's $onAction → saveActive). If
  // any path above bypassed that — early return when active != handle,
  // an exception, an aborted handle — we still want the assistant turn
  // and any tool_calls / artifact_ids on it to land on disk. finalizeTurn
  // is a no-op when currentTurn is already null, so calling it twice is
  // safe.
  if (active === handle) {
    convo.finalizeTurn();
    active = null;
  }
  agent.setActivity(null);

  // Final belt: directly call saveActive at the very end, bypassing the
  // syncer's $onAction path entirely. We've seen disk states with the
  // user turn but no assistant — meaning $onAction for the assistant's
  // finalize didn't fire (possibly hot-reload tearing down the listener,
  // or a Pinia action-tracking edge case). This explicit save guarantees
  // the assistant turn lands on disk.
  const convs = useConversationsStore();
  const snap = convo.snapshotForPersist();
  console.log(`[convsave] runTurn #${id} END snapshot.turns=${snap.length} roles=${JSON.stringify(snap.map((t) => t.role))} activeId=${convs.activeId ?? 'null'}`);
  if (convs.activeId) {
    void convs.saveActive(snap, convs.activeSessionId);
  }
}

// ---------------------------------------------------------------- transports

async function consumeResponses(
  handle: ActiveTurn,
  userText: string,
  settings: ReturnType<typeof useSettingsStore>,
): Promise<string> {
  const endpoint = responsesEndpointFromSettings(settings);
  if (!endpoint) throw new Error('responses endpoint not configured');

  const response = await startResponse({
    endpoint,
    input: userText,
    signal: handle.abort.signal,
  });
  handle.response = response;

  const agent = useAgentStore();
  const convo = useConversationStore();
  let buffered = '';
  let finalText = '';
  let started = false;
  let capturedId = false;

  for await (const evt of response.events) {
    // Capture the response id on the first event after response.created.
    // (responses-client stamps it onto the handle via a closure.)
    if (!capturedId && response.responseId) {
      rememberResponseId(response.responseId);
      capturedId = true;
    }
    switch (evt.type) {
      case 'started':
        break;
      case 'token':
        if (!started) {
          started = true;
          eventBus.emit({ type: 'agent.thinking', ts: Date.now(), payload: {} });
        }
        if (!evt.isReasoning) {
          buffered += evt.delta;
          convo.appendDelta(evt.delta);
          if (agent.activity) agent.setActivity(null);
        } else {
          const last = agent.activity;
          const now = Date.now();
          if (!last || last.label !== 'Reasoning' || now - last.ts > 800) {
            agent.setActivity({ label: 'Reasoning', icon: 'psychology', ts: now });
          }
        }
        eventBus.emit({
          type: 'agent.token',
          ts: Date.now(),
          payload: {
            delta: evt.delta,
            index: 0,
            ...(evt.isReasoning ? { is_reasoning: true } : {}),
          },
        });
        break;
      case 'tool_call':
        convo.appendToolCall({
          tool: evt.tool,
          args_preview: evt.argsPreview,
          status: evt.status,
          ts: Date.now(),
        });
        if (evt.status === 'started') {
          const isSkill = evt.tool === 'skill_view';
          agent.setActivity({
            label: isSkill ? 'Loading skill' : `Calling ${evt.tool}`,
            ...(evt.argsPreview ? { detail: evt.argsPreview } : {}),
            icon: isSkill ? 'school' : 'build',
            ts: Date.now(),
          });
        }
        eventBus.emit({
          type: 'agent.tool_call',
          ts: Date.now(),
          payload: {
            tool: evt.tool,
            args_preview: evt.argsPreview,
            status: evt.status,
          },
        });
        break;
      case 'final':
        finalText = evt.text || buffered;
        break;
      case 'error':
        throw new Error(`${evt.code}: ${evt.message}`);
    }
  }

  // Last chance to capture id (some servers may emit response.created late).
  if (!capturedId && response.responseId) rememberResponseId(response.responseId);

  return finalText || buffered;
}

async function consumeRuns(
  handle: ActiveTurn,
  userText: string,
  settings: ReturnType<typeof useSettingsStore>,
): Promise<string> {
  const endpoint = runsEndpointFromSettings(settings);
  if (!endpoint) throw new Error('runs endpoint not configured');

  const run = await startRun({
    endpoint,
    input: userText,
    signal: handle.abort.signal,
  });
  handle.run = run;
  if (run.sessionId) rememberSessionId(run.sessionId);

  const agent = useAgentStore();
  const convo = useConversationStore();
  let buffered = '';
  let finalText = '';
  let started = false;

  for await (const evt of run.events) {
    switch (evt.type) {
      case 'started':
        // No-op; agent.thinking fires on first token instead.
        break;
      case 'token':
        if (!started) {
          started = true;
          eventBus.emit({ type: 'agent.thinking', ts: Date.now(), payload: {} });
        }
        if (!evt.isReasoning) {
          buffered += evt.delta;
          convo.appendDelta(evt.delta);
          // First visible token clears the "Thinking…" / "Reasoning…" badge
          // — captions take over the user's attention from here.
          if (agent.activity) agent.setActivity(null);
        } else {
          // Reasoning tokens flow during long Qwen3-style think loops. Keep
          // the badge visible (and rate-limit updates) so the user sees
          // *something* moving instead of dead air.
          const last = agent.activity;
          const now = Date.now();
          if (!last || last.label !== 'Reasoning' || now - last.ts > 800) {
            agent.setActivity({ label: 'Reasoning', icon: 'psychology', ts: now });
          }
        }
        eventBus.emit({
          type: 'agent.token',
          ts: Date.now(),
          payload: {
            delta: evt.delta,
            index: 0,
            ...(evt.isReasoning ? { is_reasoning: true } : {}),
          },
        });
        break;
      case 'tool_call':
        // Persist on the in-flight turn so it shows up in the conversation
        // panel transcript next to the assistant's text, not just as a
        // transient toast on the avatar.
        convo.appendToolCall({
          tool: evt.tool,
          args_preview: evt.argsPreview,
          status: evt.status,
          ts: Date.now(),
        });
        // Surface as live activity so the user sees what's happening during
        // long pauses. skill_view gets a friendlier label.
        if (evt.status === 'started') {
          const isSkill = evt.tool === 'skill_view';
          agent.setActivity({
            label: isSkill ? 'Loading skill' : `Calling ${evt.tool}`,
            ...(evt.argsPreview ? { detail: evt.argsPreview } : {}),
            icon: isSkill ? 'school' : 'build',
            ts: Date.now(),
          });
        }
        eventBus.emit({
          type: 'agent.tool_call',
          ts: Date.now(),
          payload: {
            tool: evt.tool,
            args_preview: evt.argsPreview,
            status: evt.status,
          },
        });
        break;
      case 'final':
        finalText = evt.text || buffered;
        break;
      case 'error':
        throw new Error(`${evt.code}: ${evt.message}`);
    }
  }

  return finalText || buffered;
}

async function consumeChat(
  handle: ActiveTurn,
  userText: string,
  settings: ReturnType<typeof useSettingsStore>,
): Promise<string> {
  const endpoint = chatEndpointFromSettings(settings);
  if (!endpoint) throw new Error('chat endpoint not configured');

  const convo = useConversationStore();
  let started = false;

  const result = await streamChat({
    endpoint,
    messages: buildMessages(userText),
    signal: handle.abort.signal,
    onStart: () => {
      started = true;
      eventBus.emit({ type: 'agent.thinking', ts: Date.now(), payload: {} });
    },
    onDelta: (delta) => {
      if (!started) {
        started = true;
        eventBus.emit({ type: 'agent.thinking', ts: Date.now(), payload: {} });
      }
      convo.appendDelta(delta);
      eventBus.emit({
        type: 'agent.token',
        ts: Date.now(),
        payload: { delta, index: 0 },
      });
    },
  });
  return result.text;
}

// --------------------------------------------------------------------- TTS

async function speakAndAnimate(
  handle: ActiveTurn,
  text: string,
  settings: ReturnType<typeof useSettingsStore>,
): Promise<void> {
  // Last-line defence against the "two voices talking over each other" bug.
  // The caller checks `active === handle` before calling us, but a sync
  // re-entry (another `runTurn` firing in the same task before this one
  // gets to its first await) could slip past. Drop out without touching
  // the audio graph if our handle has been retired.
  if (active !== handle || handle.abort.signal.aborted) return;

  const agent = useAgentStore();
  const convo = useConversationStore();
  agent.transition('speaking', 'tts.start');

  const speech = settings.settings.speech;
  // Two ways to skip TTS: a permanent setting (`sidecar_mode: disabled`)
  // and a transient toggle (`agent.muted`, controlled by the HUD's mute
  // button). Both finalize the assistant turn immediately so it still
  // lands in the conversation history without playing audio.
  if (speech.sidecar_mode === 'disabled' || agent.muted) {
    convo.finalizeTurn();
    agent.transition('idle', agent.muted ? 'tts.muted' : 'tts.disabled');
    return;
  }

  const ttsBaseUrl = `${speech.sidecar_url.replace(/\/$/, '')}/v1`;

  const sid = ++speakCount;
  console.log(`[turn] speakStream #${sid} START voice="${speech.tts.voice}" model="${speech.tts.model}" len=${text.length} active===handle? ${active === handle}`);
  let speak: SpeakHandle;
  try {
    const outputDeviceId = settings.settings.output.device_id;
    speak = speakStream({
      baseUrl: ttsBaseUrl,
      ...(speech.sidecar_token ? { apiKey: speech.sidecar_token } : {}),
      request: {
        input: text,
        voice: speech.tts.voice,
        model: speech.tts.model,
        speed: speech.tts.rate,
      },
      format: speech.tts.format,
      signal: handle.abort.signal,
      ...(outputDeviceId ? { outputDeviceId } : {}),
      onAnalyser: (analyser) => {
        handle.driver?.stop();
        handle.driver = startVisemeDriver(analyser);
        eventBus.emit({
          type: 'tts.audio.start',
          ts: Date.now(),
          payload: {
            voice: speech.tts.voice,
            mime: mimeFor(speech.tts.format),
            format: speech.tts.format,
          },
        });
      },
      onEnd: (reason) => {
        handle.driver?.stop();
        handle.driver = null;
        eventBus.emit({ type: 'tts.audio.end', ts: Date.now(), payload: { reason } });
      },
    });
  } catch (err) {
    if (active !== handle) return;
    convo.finalizeTurn();
    agent.setError('tts.failure', err instanceof Error ? err.message : String(err));
    return;
  }

  handle.tts = speak;
  const reason = await speak.done;
  // If interrupt() ran, it already finalised conversation + state.
  if (active !== handle) return;
  convo.finalizeTurn();
  if (reason !== 'interrupt') agent.transition('idle', `tts.${reason}`);
}

// ------------------------------------------------------------------ helpers

function buildMessages(userText: string): ChatTurn[] {
  // Prepend the artifact protocol as a system message so the OpenAI-compat
  // chat path enforces the same output contract as /v1/runs. Append
  // conversation history so this path also has memory across turns.
  const settings = useSettingsStore();
  const history = buildHistoryFromConvo(settings.settings.hermes.max_history_turns);
  return [
    { role: 'system', content: buildCanvasInstructions(settings.settings.artifacts.eagerness) },
    ...history,
    { role: 'user', content: userText },
  ];
}

async function persistAndAttachArtifacts(
  handle: ActiveTurn,
  artifacts: ReturnType<typeof extractArtifacts>['artifacts'],
): Promise<void> {
  const fp = window.faceplate;
  const convs = useConversationsStore();
  const convo = useConversationStore();
  if (!fp || !convs.activeId) return;
  const turnId = convo.currentTurn?.id ?? null;
  let firstId: string | null = null;
  for (const item of artifacts) {
    if (active !== handle) return;
    try {
      const created = await fp.artifacts.create({
        ...item.input,
        conversation_id: convs.activeId,
        turn_id: turnId,
      });
      convo.attachArtifact(created.id);
      if (!firstId) firstId = created.id;
    } catch (err) {
      console.warn('[turn-handler] artifact create failed:', err);
    }
  }
  // Auto-open the canvas focused on the latest artifact. Spec choice: most
  // recent takes focus, prev/next nav steps backward through history.
  if (firstId) void fp.artifacts.openCanvas(firstId);
}

function chatEndpointFromSettings(
  settings: ReturnType<typeof useSettingsStore>,
): ChatEndpoint | null {
  const h = settings.settings.hermes;
  if (!h.base_url) return null;
  return {
    baseUrl: h.base_url.replace(/\/$/, ''),
    ...(h.api_key ? { apiKey: h.api_key } : {}),
    // hermes-agent's chat-completions ignores `model` (routes per its own
    // config); the field is still required by the OpenAI schema.
    model: 'hermes-default',
  };
}

// Per-turn body cap — keeps a single overlong reply (e.g. an old artifact
// JSON dump that pre-dated the extraction pass) from eating most of the
// context budget. Truncated turns get a "[truncated]" suffix so the model
// knows it's seeing a slice.
const MAX_HISTORY_CHARS_PER_TURN = 4000;

type HistoryTurn = NonNullable<RunsEndpoint['history']>[number];

function buildHistoryFromConvo(maxTurns: number): HistoryTurn[] {
  if (maxTurns <= 0) return [];
  const convo = useConversationStore();
  const out: HistoryTurn[] = [];
  for (const t of convo.history) {
    if (t.role !== 'user' && t.role !== 'assistant' && t.role !== 'system') continue;
    if (!t.text || !t.text.trim()) continue;
    let content = t.text;
    if (content.length > MAX_HISTORY_CHARS_PER_TURN) {
      content = content.slice(0, MAX_HISTORY_CHARS_PER_TURN) + '\n[…truncated]';
    }
    out.push({ role: t.role, content });
  }
  // Drop the most recent user turn — turn-handler just finalized it before
  // calling consumeRuns, but Hermes wants it as `input`, not as history.
  if (out.length > 0 && out[out.length - 1]!.role === 'user') {
    out.pop();
  }
  if (out.length > maxTurns) {
    return out.slice(-maxTurns);
  }
  return out;
}

function runsEndpointFromSettings(
  settings: ReturnType<typeof useSettingsStore>,
): RunsEndpoint | null {
  const h = settings.settings.hermes;
  if (!h.base_url) return null;
  const sid = getActiveSessionId();
  const history = buildHistoryFromConvo(h.max_history_turns);
  return {
    baseUrl: h.base_url.replace(/\/$/, ''),
    ...(h.api_key ? { apiKey: h.api_key } : {}),
    ...(sid ? { sessionId: sid } : {}),
    // Always inject the artifact protocol as ephemeral_system_prompt.
    // Stable per-eagerness string → server-side prompt caching keeps this cheap.
    instructions: buildCanvasInstructions(settings.settings.artifacts.eagerness),
    // CRITICAL: Hermes session_id is an audit handle, NOT a memory key.
    // Conversation memory comes from explicit history — without this every
    // turn is amnesic regardless of session continuity.
    ...(history.length > 0 ? { history } : {}),
  };
}

function responsesEndpointFromSettings(
  settings: ReturnType<typeof useSettingsStore>,
): ResponsesEndpoint | null {
  const h = settings.settings.hermes;
  if (!h.base_url) return null;
  const convs = useConversationsStore();
  const prevId = convs.activeLastResponseId;
  return {
    baseUrl: h.base_url.replace(/\/$/, ''),
    ...(h.api_key ? { apiKey: h.api_key } : {}),
    instructions: buildCanvasInstructions(settings.settings.artifacts.eagerness),
    // Stateful chain: server reconstructs full conversation from its
    // response_store. We don't replay history.
    ...(prevId ? { previousResponseId: prevId } : {}),
  };
}

function mimeFor(format: TtsFormat): TtsMime {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/mp4; codecs="opus"';
    case 'wav':
      return 'audio/wav';
    case 'aac':
      return 'audio/aac';
  }
}
