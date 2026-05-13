// TTS streaming client using Media Source Extensions per addendum #1.
//
// Pipeline:
//   sidecar /v1/audio/speech?stream=true&format=mp3
//     → fetch().body.getReader() ───► SourceBuffer.appendBuffer
//                                            │
//                                            ▼
//                                       <audio> element
//                                       (URL.createObjectURL(MediaSource))
//                                            │
//                            ├─► speakers (default routing)
//                            └─► AudioContext.createMediaElementSource → AnalyserNode → destination
//
// Why MSE: it supports chunked HTTP transfer of MP3 / Opus-in-MP4 across
// macOS/Win/Linux Chromium without sample-rate matching or chunk-boundary
// glitches that the PCM path would have required.

import { getAudioContext } from './audio-context';
import type { TtsFormat, TtsMime } from '../hermes/event-schema';

export interface TtsRequest {
  input: string;
  voice: string;
  model: string;
  speed?: number;
}

export interface SpeakOptions {
  baseUrl: string;          // e.g. 'http://127.0.0.1:8080/v1'
  apiKey?: string;
  request: TtsRequest;
  format?: TtsFormat;       // default 'mp3'
  signal?: AbortSignal;
  /** Output sink (speaker) deviceId. Omit / empty / 'system' → OS default.
   * Applied via HTMLMediaElement.setSinkId(); silently no-ops on macOS
   * Chromium without entitlements and on browsers that don't support sink
   * selection. Failure to set the sink never blocks playback. */
  outputDeviceId?: string;
  /** Called once after the AnalyserNode is attached, before audio starts. */
  onAnalyser?: (analyser: AnalyserNode) => void;
  /** Called when the very first chunk has been fed into the SourceBuffer. */
  onFirstChunk?: () => void;
  /** Called when playback ends naturally or due to interrupt. */
  onEnd?: (reason: 'natural' | 'interrupt' | 'error') => void;
}

const FORMAT_TO_MIME: Record<TtsFormat, TtsMime> = {
  mp3: 'audio/mpeg',
  opus: 'audio/mp4; codecs="opus"',
  wav: 'audio/wav',
  aac: 'audio/aac',
};

export interface SpeakHandle {
  /** Resolves when playback ends naturally or is aborted. */
  done: Promise<'natural' | 'interrupt' | 'error'>;
  /** Stop playback. */
  abort(): void;
  /** Silence (or un-silence) live audio output without altering the rest
   * of the pipeline — captions, viseme analyser, agent state, and natural
   * end-of-stream all continue normally. Cheap to call repeatedly. */
  setMuted(muted: boolean): void;
  mime: TtsMime;
  format: TtsFormat;
}

export function speakStream(opts: SpeakOptions): SpeakHandle {
  const format: TtsFormat = opts.format ?? 'mp3';
  const mime: TtsMime = FORMAT_TO_MIME[format];

  if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) {
    throw new Error(`Unsupported TTS MIME on this platform: ${mime}`);
  }

  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';

  // Apply user-chosen speaker device. setSinkId is async + may reject; we
  // log + ignore so a missing sink (USB DAC unplugged) never blocks TTS —
  // the audio just plays through the OS default sink for this turn.
  if (opts.outputDeviceId && opts.outputDeviceId !== 'system') {
    type AudioWithSinkId = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    const setSinkId = (audio as AudioWithSinkId).setSinkId;
    if (typeof setSinkId === 'function') {
      void setSinkId.call(audio, opts.outputDeviceId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tts] setSinkId('${opts.outputDeviceId?.slice(0, 8)}…') failed, using OS default: ${msg}`);
      });
    }
  }

  const ctx = getAudioContext();
  const sourceNode = ctx.createMediaElementSource(audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  sourceNode.connect(analyser);
  analyser.connect(ctx.destination);
  opts.onAnalyser?.(analyser);

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  audio.src = objectUrl;

  const internalAbort = new AbortController();
  const signal: AbortSignal = opts.signal
    ? anySignal([opts.signal, internalAbort.signal])
    : internalAbort.signal;

  let resolveDone: (reason: 'natural' | 'interrupt' | 'error') => void = () => {};
  const done = new Promise<'natural' | 'interrupt' | 'error'>((res) => {
    resolveDone = res;
  });

  let endedFor: 'natural' | 'interrupt' | 'error' | null = null;
  function finish(reason: 'natural' | 'interrupt' | 'error') {
    if (endedFor !== null) return;
    endedFor = reason;
    try {
      audio.pause();
    } catch {
      /* noop */
    }
    try {
      sourceNode.disconnect();
      analyser.disconnect();
    } catch {
      /* noop */
    }
    // Release the MSE blob URL + drop the audio element's reference so the
    // MediaElementAudioSourceNode↔HTMLMediaElement binding is torn down.
    // Without this, Chrome accumulates one MES node per turn until throwing
    // `InvalidStateError: HTMLMediaElement already connected to a different
    // MediaElementSourceNode`.
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* noop */
    }
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* noop */
    }
    opts.onEnd?.(reason);
    resolveDone(reason);
  }

  signal.addEventListener('abort', () => finish('interrupt'));

  audio.addEventListener('ended', () => finish('natural'));
  audio.addEventListener('error', () => finish('error'));

  void run().catch((err) => {
    console.error('[tts] stream failed:', err);
    finish('error');
  });

  return {
    done,
    abort: () => internalAbort.abort(),
    setMuted: (muted: boolean) => { audio.muted = muted; },
    mime,
    format,
  };

  // ---------------------------------------------------------------- run

  async function run(): Promise<void> {
    await new Promise<void>((res) => {
      ms.addEventListener('sourceopen', () => res(), { once: true });
    });
    if (signal.aborted) return;

    const sb = ms.addSourceBuffer(mime);
    sb.mode = 'sequence';

    const url = `${opts.baseUrl.replace(/\/$/, '')}/audio/speech`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...opts.request,
        stream: true,
        response_format: format,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`TTS HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const reader = res.body.getReader();
    const queue: Uint8Array[] = [];
    let firstChunkSeen = false;

    function pump(): void {
      if (sb.updating || queue.length === 0) return;
      const next = queue.shift();
      if (!next) return;
      try {
        // Copy into a plain ArrayBuffer-backed view; the DOM `BufferSource`
        // type rejects ArrayBufferLike (potentially shared) views.
        const copy = new Uint8Array(next.byteLength);
        copy.set(next);
        sb.appendBuffer(copy);
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          opts.onFirstChunk?.();
          void audio.play().catch(() => {
            /* blocked by autoplay — caller is expected to ensure user gesture */
          });
        }
      } catch (err) {
        console.error('[tts] sourceBuffer append failed:', err);
      }
    }

    sb.addEventListener('updateend', pump);

    function awaitUpdateEnd(): Promise<void> {
      if (!sb.updating) return Promise.resolve();
      return new Promise((res) => {
        sb.addEventListener('updateend', () => res(), { once: true });
      });
    }

    async function flushAndClose(): Promise<void> {
      // Detach the permanent pump listener so it doesn't race with our
      // sequential drain (which calls appendBuffer directly and then awaits
      // updateend before the next chunk).
      sb.removeEventListener('updateend', pump);
      while (queue.length > 0) {
        await awaitUpdateEnd();
        const next = queue.shift();
        if (!next) break;
        try {
          const copy = new Uint8Array(next.byteLength);
          copy.set(next);
          sb.appendBuffer(copy);
        } catch (err) {
          console.error('[tts] drain append failed:', err);
          break;
        }
      }
      await awaitUpdateEnd();
      try {
        if (ms.readyState === 'open') ms.endOfStream();
      } catch {
        /* noop */
      }
    }

    while (true) {
      if (signal.aborted) {
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
        // Use the no-arg form on a deliberate abort. Passing 'decode' fires
        // an `error` event on the <audio> element which races with our own
        // interrupt finish() and produces noisy stack traces.
        try {
          if (ms.readyState === 'open') ms.endOfStream();
        } catch {
          /* noop */
        }
        return;
      }
      const { done: streamDone, value } = await reader.read();
      if (streamDone) {
        await flushAndClose();
        return;
      }
      if (value) {
        queue.push(value);
        pump();
      }
    }
  }
}

// AbortSignal.any is available in modern Chromium but not consistently typed
// in our DOM lib; the wrapper avoids a feature-detect mess.
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
