// ASR client: opens the mic, records WebM/Opus, posts to the
// OpenAI-compatible /v1/audio/transcriptions endpoint, returns final text.
//
// Streaming partials are not exposed in v1 (the design optionally surfaces
// them via SSE; we leave the hook in place but do not consume it for now).

export interface AsrEndpoint {
  baseUrl: string;          // e.g. 'http://127.0.0.1:8080/v1'
  apiKey?: string;
  model?: string;
  language?: string;        // 'auto' or BCP-47
}

export interface AsrSessionOptions {
  endpoint: AsrEndpoint;
  deviceId?: string;
  /** Hard ceiling so we don't keep recording forever if PTT release is missed. */
  maxDurationMs?: number;
}

export interface AsrResult {
  text: string;
  duration_ms: number;
  language?: string;
  raw?: unknown;
}

export interface AsrSession {
  /** Stop recording and resolve with the transcript. */
  stop(): Promise<AsrResult>;
  /** Cancel without sending. */
  cancel(): void;
  /** Resolves to the result if stop() was called, or rejects on cancel/error. */
  done: Promise<AsrResult>;
}

const DEFAULT_MAX_MS = 30_000;

export async function startAsrSession(opts: AsrSessionOptions): Promise<AsrSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: opts.deviceId
      ? { deviceId: { exact: opts.deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true },
  });

  const mimeType = pickRecorderMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = performance.now();
  let cancelled = false;
  let stopped = false;

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  let resolveDone: (r: AsrResult) => void = () => {};
  let rejectDone: (e: unknown) => void = () => {};
  const done = new Promise<AsrResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  function teardownStream(): void {
    for (const t of stream.getTracks()) t.stop();
  }

  recorder.addEventListener('stop', () => {
    if (cancelled) {
      teardownStream();
      rejectDone(new Error('asr cancelled'));
      return;
    }
    const duration_ms = Math.round(performance.now() - startedAt);
    const blob = new Blob(chunks, { type: mimeType ?? recorder.mimeType ?? 'audio/webm' });
    teardownStream();
    transcribe(blob, opts.endpoint, duration_ms).then(resolveDone).catch(rejectDone);
  });

  recorder.start(250); // 250 ms timeslice — keeps memory bounded for long sessions

  const ceiling = opts.maxDurationMs ?? DEFAULT_MAX_MS;
  const ceilingTimer = window.setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, ceiling);

  return {
    stop: async () => {
      window.clearTimeout(ceilingTimer);
      if (stopped) return done;
      stopped = true;
      if (recorder.state === 'recording') recorder.stop();
      return done;
    },
    cancel: () => {
      window.clearTimeout(ceilingTimer);
      if (stopped) return;
      stopped = true;
      cancelled = true;
      if (recorder.state === 'recording') recorder.stop();
    },
    done,
  };
}

async function transcribe(
  blob: Blob,
  endpoint: AsrEndpoint,
  duration_ms: number,
): Promise<AsrResult> {
  const url = `${endpoint.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', blob, suggestFilename(blob.type));
  if (endpoint.model) form.append('model', endpoint.model);
  if (endpoint.language && endpoint.language !== 'auto') {
    form.append('language', endpoint.language);
  }
  form.append('response_format', 'json');

  const headers: Record<string, string> = {};
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    throw new Error(`ASR HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { text?: string; language?: string } & Record<string, unknown>;
  return {
    text: (json.text ?? '').trim(),
    duration_ms,
    ...(json.language ? { language: json.language } : {}),
    raw: json,
  };
}

function pickRecorderMime(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function suggestFilename(mime: string): string {
  if (mime.startsWith('audio/webm')) return 'mic.webm';
  if (mime.startsWith('audio/ogg')) return 'mic.ogg';
  if (mime.startsWith('audio/mp4')) return 'mic.m4a';
  return 'mic.bin';
}
