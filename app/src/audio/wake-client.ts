// Wake-word client. Streams 16 kHz mono PCM frames to the sidecar's
// `/wake` WebSocket. On detection, emits a `user.wake` event and (optionally)
// triggers an ASR capture window so the user's follow-up command is
// transcribed without a button press.
//
// Off by default — only attached when settings.input.mode === 'wake_word'.

import { eventBus } from '../boot/event-bus';
import { useAgentStore } from '../stores/agent';
import { useSettingsStore } from '../stores/settings';
import { startAsrSession, type AsrEndpoint, type AsrSession } from './asr-client';
import { interrupt as interruptTurn } from '../hermes/turn-handler';

const TARGET_SR = 16_000;
const FRAME_MS = 40; // 640 samples per frame at 16 kHz

interface WakeServerMessage {
  type: 'wake' | 'silence' | 'ready' | 'error';
  model?: string;
  score?: number;
  ts?: number;
  message?: string;
}

let socket: WebSocket | null = null;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let processor: AudioWorkletNode | ScriptProcessorNode | null = null;
let asrSession: AsrSession | null = null;
let cooldownUntil = 0;

const POST_WAKE_COOLDOWN_MS = 1500;

export async function startWakeClient(): Promise<void> {
  if (socket) return;
  const settings = useSettingsStore();
  const url = wakeWsUrl(settings);
  if (!url) return;

  // Honour the user's persisted mic choice for wake-word too. 'system' (or
  // empty) → omit deviceId so the OS default flows through. If the saved
  // device isn't currently present we retry without it; the saved value
  // stays put so re-plugging restores the choice.
  const savedId = settings.settings.input.device_id;
  const deviceId = savedId && savedId !== 'system' ? savedId : undefined;
  const baseConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // AEC + NS on so the wake model doesn't self-trigger on its own TTS
      // playback. The detector still gets clean speech because Chromium's
      // AEC is downstream-aware.
      audio: deviceId
        ? { ...baseConstraints, deviceId: { exact: deviceId } }
        : baseConstraints,
    });
    useAgentStore().setMicActive(true);
  } catch (err) {
    if (deviceId && err instanceof Error && /NotFoundError|OverconstrainedError/.test(err.name)) {
      console.warn(`[wake] saved deviceId unavailable, retrying with system default:`, err.message);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
        useAgentStore().setMicActive(true);
      } catch (err2) {
        console.error('[wake] mic open failed (system default):', err2);
        return;
      }
    } else {
      console.error('[wake] mic open failed:', err);
      return;
    }
  }

  context = new AudioContext({ sampleRate: TARGET_SR });
  const src = context.createMediaStreamSource(stream);

  socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    socket?.send(
      JSON.stringify({
        type: 'config',
        sample_rate: TARGET_SR,
        encoding: 'pcm_s16le',
        frame_ms: FRAME_MS,
      }),
    );
  });
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', () => stopWakeClient());
  socket.addEventListener('error', (e) => {
    console.error('[wake] ws error:', e);
    stopWakeClient();
  });

  const node = createPcmFramer(context, FRAME_MS, (frame) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame);
  });
  src.connect(node);
  processor = node;
}

export function stopWakeClient(): void {
  asrSession?.cancel();
  asrSession = null;
  if (processor) {
    try {
      processor.disconnect();
    } catch {
      /* noop */
    }
    processor = null;
  }
  if (context && context.state !== 'closed') void context.close();
  context = null;
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
    useAgentStore().setMicActive(false);
  }
  if (socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    socket = null;
  }
}

function onMessage(ev: MessageEvent<string | ArrayBuffer>): void {
  if (typeof ev.data !== 'string') return;
  let msg: WakeServerMessage;
  try {
    msg = JSON.parse(ev.data) as WakeServerMessage;
  } catch {
    return;
  }
  if (msg.type !== 'wake') return;

  // Suppress detections that happen while the avatar is speaking — even
  // with AEC the detector can still self-trigger on its own TTS output.
  const agent = useAgentStore();
  if (agent.state === 'speaking') return;

  const now = Date.now();
  if (now < cooldownUntil) return;
  cooldownUntil = now + POST_WAKE_COOLDOWN_MS;

  eventBus.emit({
    type: 'user.wake',
    ts: now,
    payload: { model: msg.model ?? 'unknown', score: msg.score ?? 0 },
  });

  void openCaptureWindow();
}

async function openCaptureWindow(): Promise<void> {
  const settings = useSettingsStore();
  const agent = useAgentStore();
  const endpoint = asrEndpointFromSettings(settings);
  if (!endpoint) return;
  // Barge-in if anything's already in flight so the FSM allows listening.
  if (agent.state === 'thinking' || agent.state === 'speaking') {
    interruptTurn('user.wake');
  }
  // Same device-resolution dance as ptt-controller — use the persisted
  // mic if set, fall back to OS default if it's missing this session.
  const savedId = settings.settings.input.device_id;
  const deviceId = savedId && savedId !== 'system' ? savedId : undefined;
  try {
    try {
      asrSession = await startAsrSession(
        deviceId
          ? { endpoint, deviceId, maxDurationMs: 8_000 }
          : { endpoint, maxDurationMs: 8_000 },
      );
    } catch (err) {
      if (deviceId && err instanceof Error && /NotFoundError|OverconstrainedError/.test(err.name)) {
        asrSession = await startAsrSession({ endpoint, maxDurationMs: 8_000 });
      } else {
        throw err;
      }
    }
    agent.transition('listening', 'wake');
    const result = await asrSession.stop();
    asrSession = null;
    if (!result.text) {
      if (agent.state === 'listening') agent.transition('idle', 'wake.silent');
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
    console.error('[wake] capture failed:', err);
    asrSession = null;
    agent.setError('wake.capture', err instanceof Error ? err.message : String(err));
  }
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

function wakeWsUrl(settings: ReturnType<typeof useSettingsStore>): string | null {
  const sidecar = settings.settings.speech.sidecar_url;
  if (!sidecar) return null;
  const u = new URL(sidecar);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = (u.pathname.replace(/\/$/, '')) + '/wake';
  if (settings.settings.speech.sidecar_token) {
    u.searchParams.set('token', settings.settings.speech.sidecar_token);
  }
  return u.toString();
}

// Float32 → Int16 PCM frame extractor. Prefers AudioWorklet when available;
// falls back to a deprecated ScriptProcessorNode otherwise (the sidecar
// doesn't care which path delivers the frames).
function createPcmFramer(
  ctx: AudioContext,
  frameMs: number,
  onFrame: (pcm: ArrayBuffer) => void,
): ScriptProcessorNode {
  const bufferSize = nextPow2((frameMs / 1000) * ctx.sampleRate);
  const node = ctx.createScriptProcessor(bufferSize, 1, 1);
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    onFrame(out.buffer);
  };
  // ScriptProcessorNode requires a connection to the destination to pump,
  // but we don't actually want it audible — route through a zero-gain node.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  return node;
}

function nextPow2(n: number): number {
  let p = 256;
  while (p < n && p < 16_384) p *= 2;
  return p;
}
