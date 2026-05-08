// Minimal streaming chat-completions client.
//
// This is the Phase 2 placeholder: a plain `/v1/chat/completions` SSE consumer
// pointed at hermes-agent (or any OpenAI-compatible endpoint). Phase 3 will
// add proper /v1/runs lifecycle handling so we observe agent.thinking,
// tool_call, etc. natively. Until then, "thinking" is just the gap before
// the first delta and "speaking" is post-final.

export interface ChatEndpoint {
  baseUrl: string;          // e.g. 'http://127.0.0.1:8642/v1'
  apiKey?: string;
  model: string;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatStreamOptions {
  endpoint: ChatEndpoint;
  messages: ChatTurn[];
  signal?: AbortSignal;
  /** Called for every delta token. */
  onDelta?: (delta: string) => void;
  /** Called once when the first delta arrives. */
  onStart?: () => void;
}

export interface ChatStreamResult {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_call' | 'interrupt' | 'error' | 'unknown';
}

export async function streamChat(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  const url = `${opts.endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (opts.endpoint.apiKey) headers.authorization = `Bearer ${opts.endpoint.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.endpoint.model,
      messages: opts.messages,
      stream: true,
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let started = false;
  let finishReason: ChatStreamResult['finishReason'] = 'unknown';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      // SSE: events separated by blank line. Each event has `data: ` prefix lines.
      const events = pending.split('\n\n');
      pending = events.pop() ?? '';
      for (const evt of events) {
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            return { text, finishReason };
          }
          try {
            const json = JSON.parse(payload) as ChatCompletionStreamChunk;
            const delta = json.choices?.[0]?.delta?.content ?? '';
            const reason = json.choices?.[0]?.finish_reason;
            if (delta) {
              if (!started) {
                started = true;
                opts.onStart?.();
              }
              text += delta;
              opts.onDelta?.(delta);
            }
            if (reason) finishReason = mapFinishReason(reason);
          } catch {
            // tolerate malformed chunks
          }
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      return { text, finishReason: 'interrupt' };
    }
    throw err;
  }
  return { text, finishReason };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

function mapFinishReason(r: string): ChatStreamResult['finishReason'] {
  switch (r) {
    case 'stop':
    case 'length':
    case 'tool_call':
      return r;
    default:
      return 'unknown';
  }
}
