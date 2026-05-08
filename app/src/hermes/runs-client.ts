// hermes-agent /v1/runs SSE consumer (Strategy A from §5.3).
//
// Wire shape (best-effort — we treat unknown event types as no-ops so the
// flow tolerates upstream schema drift):
//   POST /v1/runs            { input, session_id?, ...} → { run_id, session_id }
//   GET  /v1/runs/{id}/events (text/event-stream)
//                              ─► token { delta, index?, is_reasoning? }
//                              ─► tool_call { name, args_preview, status }
//                              ─► final { text, finish_reason }
//                              ─► error { code, message }
//   POST /v1/runs/{id}/stop   on barge-in / interrupt

import type { AgentToolCall } from './event-schema';

export interface RunsEndpoint {
  baseUrl: string;          // e.g. 'http://127.0.0.1:8642/v1'
  apiKey?: string;
  sessionId?: string;
}

export type RunEvent =
  | { type: 'started'; runId: string; sessionId?: string }
  | { type: 'token'; delta: string; isReasoning?: boolean }
  | { type: 'tool_call'; tool: string; argsPreview: string; status: AgentToolCall['status'] }
  | { type: 'final'; text: string; finishReason: 'stop' | 'length' | 'tool_call' | 'interrupt' | 'unknown' }
  | { type: 'error'; code: string; message: string };

export interface StartRunOptions {
  endpoint: RunsEndpoint;
  input: string;
  signal?: AbortSignal;
}

export interface RunHandle {
  runId: string;
  sessionId?: string;
  events: AsyncIterable<RunEvent>;
  /** Tells the server to stop this run. Best-effort. */
  stop(): Promise<void>;
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  // hermes-agent extends with tool_call snapshots
  tool_calls?: Array<{ name: string; args_preview?: string; status?: string }>;
}

interface RunsStartResponse {
  run_id: string;
  session_id?: string;
}

export async function startRun(opts: StartRunOptions): Promise<RunHandle> {
  const url = `${opts.endpoint.baseUrl.replace(/\/+$/, '')}/runs`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.endpoint.apiKey) headers.authorization = `Bearer ${opts.endpoint.apiKey}`;

  const startBody: Record<string, unknown> = { input: opts.input };
  if (opts.endpoint.sessionId) startBody.session_id = opts.endpoint.sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(startBody),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`/v1/runs HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = (await res.json()) as RunsStartResponse;
  if (!json.run_id) throw new Error('hermes /v1/runs response missing run_id');

  const events = consumeEvents(opts.endpoint, json.run_id, opts.signal);

  return {
    runId: json.run_id,
    ...(json.session_id ? { sessionId: json.session_id } : {}),
    events,
    stop: () => stopRun(opts.endpoint, json.run_id),
  };
}

async function stopRun(endpoint: RunsEndpoint, runId: string): Promise<void> {
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}/stop`;
  const headers: Record<string, string> = {};
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  await fetch(url, { method: 'POST', headers }).catch(() => {
    /* best-effort */
  });
}

async function* consumeEvents(
  endpoint: RunsEndpoint,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}/events`;
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  const res = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) {
    yield {
      type: 'error',
      code: 'http',
      message: `events HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`,
    };
    return;
  }

  yield { type: 'started', runId };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split('\n\n');
      pending = events.pop() ?? '';
      for (const evt of events) {
        const parsed = parseSseEvent(evt);
        if (!parsed) continue;
        yield* mapEvent(parsed);
        if (parsed.event === 'final' || parsed.event === 'done' || parsed.event === 'error') {
          return;
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      yield { type: 'error', code: 'aborted', message: 'aborted' };
      return;
    }
    yield {
      type: 'error',
      code: 'stream',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split('\n').map((l) => l.trim());
  let evt: SseEvent | null = null;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      evt ??= { data: '' };
      evt.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      evt ??= { data: '' };
      evt.data += (evt.data ? '\n' : '') + line.slice(5).trim();
    }
  }
  return evt && evt.data ? evt : null;
}

function* mapEvent(evt: SseEvent): Generator<RunEvent> {
  // hermes-agent uses both `event:` typed events and untagged JSON-only `data:`
  // chunks (the latter mirroring the OpenAI chat-completions stream shape).
  // Cover both.
  const tag = evt.event ?? '';
  if (evt.data === '[DONE]') return;

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(evt.data) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (tag) {
    case 'token':
      if (typeof json.delta === 'string' && json.delta.length > 0) {
        yield {
          type: 'token',
          delta: json.delta,
          ...(typeof json.is_reasoning === 'boolean' ? { isReasoning: json.is_reasoning } : {}),
        };
      }
      return;
    case 'tool_call':
      yield {
        type: 'tool_call',
        tool: typeof json.tool === 'string' ? json.tool : 'tool',
        argsPreview: typeof json.args_preview === 'string' ? json.args_preview : '',
        status: ['started', 'completed', 'failed'].includes(json.status as string)
          ? (json.status as AgentToolCall['status'])
          : 'started',
      };
      return;
    case 'final':
      yield {
        type: 'final',
        text: typeof json.text === 'string' ? json.text : '',
        finishReason: mapFinishReason(json.finish_reason),
      };
      return;
    case 'error':
      yield {
        type: 'error',
        code: typeof json.code === 'string' ? json.code : 'unknown',
        message: typeof json.message === 'string' ? json.message : 'unknown error',
      };
      return;
  }

  // Untagged (chat-completions-shaped) chunk:
  const choices = (json as OpenAIChatChunk).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0]!;
    const delta = c.delta?.content ?? '';
    const reasoning = c.delta?.reasoning_content ?? '';
    if (delta) yield { type: 'token', delta };
    if (reasoning) yield { type: 'token', delta: reasoning, isReasoning: true };
    if (c.finish_reason) {
      yield {
        type: 'final',
        text: '',
        finishReason: mapFinishReason(c.finish_reason),
      };
    }
  }
}

function mapFinishReason(r: unknown): 'stop' | 'length' | 'tool_call' | 'interrupt' | 'unknown' {
  if (r === 'stop' || r === 'length' || r === 'tool_call' || r === 'interrupt') return r;
  return 'unknown';
}
