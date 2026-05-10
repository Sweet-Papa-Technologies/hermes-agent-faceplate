// hermes-agent /v1/responses (OpenAI Responses API) SSE consumer.
//
// Why this exists alongside runs-client.ts: /v1/runs is fire-and-forget — it
// runs the agent with whatever you send and returns the final text, but it
// does NOT persist a response we can chain off of next turn. /v1/responses
// IS stateful: every response gets stored in Hermes' response_store.db keyed
// by `response_id`, and the next turn sends `previous_response_id` instead
// of replaying the whole conversation_history from our side. The server then
// reconstructs the rich message log (including tool calls + tool results +
// reasoning + system context) — same flow the in-process TUI gets.
//
// Wire shape (OpenAI Responses API SSE — same events as openai.com):
//   response.created               — initial; carries the response_id
//   response.output_item.added     — function_call OR message item appears
//   response.output_text.delta     — streaming assistant text token
//   response.output_text.done      — message text complete
//   response.output_item.done      — function_call args finalized OR message done
//   response.completed             — terminal; full output array + usage
//   response.failed                — terminal on error
//
// We translate these into the same `RunEvent` shape as runs-client so the
// turn-handler doesn't care which transport was used.

import type { AgentToolCall } from './event-schema';
import type { RunEvent } from './runs-client';

export interface ResponsesEndpoint {
  baseUrl: string;          // e.g. 'http://127.0.0.1:8642/v1'
  apiKey?: string;
  /** Chain off the server's stored conversation. When set, server reconstructs
   * memory from response_store.db; we DON'T send conversation_history. */
  previousResponseId?: string;
  /** Ephemeral system prompt addendum — same `instructions` field /v1/runs uses. */
  instructions?: string;
}

export interface StartResponseOptions {
  endpoint: ResponsesEndpoint;
  input: string;
  signal?: AbortSignal;
}

export interface ResponseHandle {
  /** Set after `response.created` lands. Persist this in the conversation
   * so the next turn can chain off it via `previous_response_id`. */
  responseId: string | null;
  events: AsyncIterable<RunEvent>;
}

export async function startResponse(opts: StartResponseOptions): Promise<ResponseHandle> {
  const url = `${opts.endpoint.baseUrl.replace(/\/+$/, '')}/responses`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (opts.endpoint.apiKey) headers.authorization = `Bearer ${opts.endpoint.apiKey}`;

  const body: Record<string, unknown> = {
    input: opts.input,
    stream: true,
    store: true,
  };
  if (opts.endpoint.previousResponseId) {
    body.previous_response_id = opts.endpoint.previousResponseId;
  }
  if (opts.endpoint.instructions) body.instructions = opts.endpoint.instructions;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`/v1/responses HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  // Mutable container so events can stamp the captured response_id back.
  // The handle is returned synchronously while events stream lazily, so we
  // can't capture it before returning the handle — the consumer reads
  // `handle.responseId` after iterating events.
  const handle: { id: string | null } = { id: null };
  const events = consumeEvents(res.body, handle, opts.signal);

  // Wrap to expose the captured id post-hoc.
  return {
    get responseId() { return handle.id; },
    events,
  };
}

interface SseEvent {
  event?: string;
  data: string;
}

async function* consumeEvents(
  body: ReadableStream<Uint8Array>,
  handle: { id: string | null },
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  yield { type: 'started', runId: 'pending' };

  // Track pending tool_calls so we can mark them completed on output_item.done.
  // Keyed by item_id (Hermes ties function_call items to call_id under it.id).
  const pendingTools = new Map<string, { name: string; argsPreview: string }>();
  // Function-call output → completion marker.
  const pendingOutputCallIds = new Set<string>();
  let finalText = '';
  let buffered = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split('\n\n');
      pending = events.pop() ?? '';
      for (const evt of events) {
        const parsed = parseSseEvent(evt);
        if (!parsed) continue;
        if (parsed.data === '[DONE]') return;
        yield* mapEvent(parsed, handle, pendingTools, pendingOutputCallIds, (text) => {
          buffered += text;
        }, (text) => {
          finalText = text;
        });
      }
    }
    if (finalText || buffered) {
      yield { type: 'final', text: finalText || buffered, finishReason: 'stop' };
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

interface ResponsesPayload {
  type?: string;
  delta?: string;
  text?: string;
  response?: { id?: string; output?: unknown[] };
  item?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    status?: string;
  };
  error?: string | { message?: string; code?: string };
}

function* mapEvent(
  evt: SseEvent,
  handle: { id: string | null },
  pendingTools: Map<string, { name: string; argsPreview: string }>,
  _pendingOutputCallIds: Set<string>,
  onText: (text: string) => void,
  onFinalText: (text: string) => void,
): Generator<RunEvent> {
  let json: ResponsesPayload;
  try {
    json = JSON.parse(evt.data) as ResponsesPayload;
  } catch {
    return;
  }
  const type = json.type ?? evt.event ?? '';

  switch (type) {
    case 'response.created': {
      const id = json.response?.id;
      if (typeof id === 'string') handle.id = id;
      return;
    }
    case 'response.output_text.delta': {
      const delta = json.delta ?? '';
      if (delta) {
        onText(delta);
        yield { type: 'token', delta };
      }
      return;
    }
    case 'response.output_text.done': {
      // The `text` field carries the final assembled message; we already
      // streamed deltas, so nothing to emit. Buffer is up to date.
      return;
    }
    case 'response.output_item.added': {
      const item = json.item;
      if (!item) return;
      if (item.type === 'function_call' && item.id) {
        const name = item.name ?? 'tool';
        const args = item.arguments ?? '';
        pendingTools.set(item.id, { name, argsPreview: args });
        yield {
          type: 'tool_call',
          tool: name,
          argsPreview: args,
          status: 'started',
        };
      }
      return;
    }
    case 'response.output_item.done': {
      const item = json.item;
      if (!item) return;
      if (item.type === 'function_call' && item.id) {
        const pending = pendingTools.get(item.id);
        const name = pending?.name ?? item.name ?? 'tool';
        const args = item.arguments ?? pending?.argsPreview ?? '';
        // Hermes' output_item.done for function_call carries finalized
        // arguments — the actual completion (with output) lands as a
        // sibling function_call_output item.
        yield {
          type: 'tool_call',
          tool: name,
          argsPreview: args,
          status: ((item.status as AgentToolCall['status']) || 'completed'),
        };
        pendingTools.delete(item.id);
      }
      return;
    }
    case 'response.completed': {
      const out = json.response?.output;
      let text = '';
      if (Array.isArray(out)) {
        for (const itemRaw of out) {
          const item = itemRaw as { type?: string; content?: Array<{ text?: string; type?: string }> };
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === 'output_text' && typeof c.text === 'string') {
                text += c.text;
              }
            }
          }
        }
      }
      if (text) onFinalText(text);
      return;
    }
    case 'response.failed': {
      const err = json.error;
      const message = typeof err === 'string'
        ? err
        : (err?.message ?? 'response failed');
      const code = typeof err === 'object' && err && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'failed';
      yield { type: 'error', code, message };
      return;
    }
  }
}
