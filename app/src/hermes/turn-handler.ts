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
import { useSettingsStore } from '../stores/settings';
import { useDiscoveryStore } from '../stores/discovery';
import { streamChat, type ChatEndpoint, type ChatTurn } from './chat-client';
import { startRun, type RunHandle, type RunsEndpoint } from './runs-client';
import { paraphrase } from './paraphrase';
import { stripForSpeech } from './strip-for-speech';
import { speakStream, type SpeakHandle } from '../audio/tts-client';
import { startVisemeDriver, type DriverHandle } from '../audio/viseme-driver';
import { suspendAudio, resumeAudio } from '../audio/audio-context';
import type { TtsMime, TtsFormat } from './event-schema';

interface ActiveTurn {
  abort: AbortController;
  tts: SpeakHandle | null;
  driver: DriverHandle | null;
  run: RunHandle | null;
}

let active: ActiveTurn | null = null;
let attached = false;
let detach: (() => void) | null = null;

let lastSessionId: string | null = null;
let turnCount = 0;
let speakCount = 0;

export function attachTurnHandler(): void {
  if (attached) return;
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
}

export function detachTurnHandler(): void {
  detach?.();
  detach = null;
  attached = false;
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
  a.abort.abort(reason);
  // Per design §4.6: barge-in suspends the AudioContext too. We resume on
  // the next play() (TTS client's autoplay flow re-resumes via getAudioContext).
  void suspendAudio();

  const agent = useAgentStore();
  const convo = useConversationStore();
  convo.finalizeTurn();
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
  console.log(`[turn] runTurn #${id} START len=${userText.length} active=${active ? 'yes(barge-in)' : 'no'} text="${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}"`);
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
  convo.startTurn('assistant');

  const abort = new AbortController();
  const handle: ActiveTurn = { abort, tts: null, driver: null, run: null };
  active = handle;

  let assistantText = '';
  try {
    if (discovery.useRuns) {
      assistantText = await consumeRuns(handle, userText, settings);
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
  await speakAndAnimate(handle, stripForSpeech(spokenText), settings);
  // Re-arm the AudioContext for the next turn (suspended on barge-in).
  void resumeAudio();

  if (active === handle) active = null;
}

// ---------------------------------------------------------------- transports

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
  if (run.sessionId) lastSessionId = run.sessionId;

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
  if (speech.sidecar_mode === 'disabled') {
    convo.finalizeTurn();
    agent.transition('idle', 'tts.disabled');
    return;
  }

  const ttsBaseUrl = `${speech.sidecar_url.replace(/\/$/, '')}/v1`;

  const sid = ++speakCount;
  console.log(`[turn] speakStream #${sid} START voice="${speech.tts.voice}" model="${speech.tts.model}" len=${text.length} active===handle? ${active === handle}`);
  let speak: SpeakHandle;
  try {
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
  return [{ role: 'user', content: userText }];
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

function runsEndpointFromSettings(
  settings: ReturnType<typeof useSettingsStore>,
): RunsEndpoint | null {
  const h = settings.settings.hermes;
  if (!h.base_url) return null;
  return {
    baseUrl: h.base_url.replace(/\/$/, ''),
    ...(h.api_key ? { apiKey: h.api_key } : {}),
    ...(lastSessionId ? { sessionId: lastSessionId } : {}),
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
