// Paraphrase IPC. Lives in main so we can read the LLM API key out of
// ~/.hermes/.env without exposing it to the renderer.
//
// Routing:
//
//   settings.paraphrase.model === 'local_litert' (default):
//     POST to settings.paraphrase.litert_lm_url + '/responses' (default
//     http://127.0.0.1:7860/v1/responses) — the host-native `litert-lm serve
//     --api openai` started by `make litert-up`. As of litert-lm 0.11 the
//     OpenAI-compatible mode only implements the **Responses API**, not Chat
//     Completions, so the wire format is { model, input, max_output_tokens }
//     and we read text from output[].content[].text.
//
//   settings.paraphrase.model === 'reuse_hermes_llm':
//     POST direct to the discovered LLM endpoint (read from local
//     ~/.hermes/config.yaml + .env). Bypasses hermes-agent entirely.
//     This path keeps the Chat Completions shape because real backends
//     (OpenAI, OpenRouter, Ollama, Anthropic) all speak it. If local
//     config isn't readable (Docker / remote hermes), fall through to
//     local_litert with `fallback_reason: 'unsafe_to_bypass'`.
//
//     We do NOT route through hermes-agent's /v1/chat/completions in this
//     case — that endpoint runs the full agent loop (memory + tools + skills)
//     per https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
//     and would corrupt session memory.
//
//   settings.paraphrase.model === 'disabled':
//     Return original text unchanged.

import { ipcMain, net } from 'electron';

import { IPC, type ParaphraseResult } from './preload-api';
import { getSettings } from './settings-store';
import { readLlmEndpoint } from './hermes-discovery';

const TIMEOUT_MS = 12_000;
// Hard upper bound on input length passed to the small paraphrase model.
// Gemma-4-E2B chokes on long multi-paragraph (e.g. tool-augmented research
// answers) and frequently returns canned "please say something" garbage
// instead of a real summary. Above this, we skip the paraphrase entirely
// — the captions still show the full text, TTS just speaks the original.
const PARAPHRASE_MAX_INPUT = 1_800;
// Patterns the tiny model emits when it gives up. Treat any of these as a
// failure signal and fall back to the original text.
const CANNED_FAILURE_RE =
  /\b(please\s+(say|provide|give|tell|share)|smiley\s+face|how\s+can\s+i\s+(assist|help)|i'?m\s+sorry,?\s*(but|i)|i\s+don'?t\s+understand)\b/i;
// Default model id we send to litert-lm. The serve endpoint switches engines
// per `model_id`, so this must match what `make litert-up` imported. Default
// matches DESIGN-ADDENDUM-01 §4 (Gemma 4 E2B IT). Override
// LITERT_MODEL/LITERT_HF_REPO/LITERT_HF_FILE in the environment to swap.
const LITERT_DEFAULT_MODEL = 'gemma-4-E2B-it';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: false;
}

function isLocalNetwork(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1') return true;
    if (/^127\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Loopback / private LAN (host-native litert-lm, LAN LLMs reachable from
  // hermes config) bypass Chromium's net stack so we skip system PAC files
  // that swallow private-network traffic. Public URLs go through
  // electron.net.fetch to follow the system cert store + proxy.
  const doFetch = isLocalNetwork(url) ? fetch : net.fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function postChat(
  url: string,
  apiKey: string | undefined,
  body: ChatBody,
): Promise<string> {
  const json = (await postJson(url, apiKey, body)) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

// litert-lm 0.11 `serve --api openai` exposes the Responses API only.
// Wire format: { model, input: [{role, content:[{type:'input_text', text}]}], max_output_tokens }.
// Response shape: { output: [{content: [{type:'output_text', text}]}] }.
async function postResponses(
  url: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  maxOutputTokens: number,
  temperature: number,
): Promise<string> {
  const body = {
    model,
    input: messages.map((m) => ({
      role: m.role,
      content: [{ type: m.role === 'system' ? 'input_text' : 'input_text', text: m.content }],
    })),
    max_output_tokens: maxOutputTokens,
    temperature,
  };
  const json = (await postJson(url, apiKey, body)) as {
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  for (const item of json.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text) return part.text.trim();
    }
  }
  return '';
}

export async function paraphrase(text: string): Promise<ParaphraseResult> {
  const settings = getSettings();
  const cfg = settings.paraphrase;
  const start = Date.now();

  if (cfg.model === 'disabled' || !cfg.enabled) {
    return { text, used: 'disabled', latency_ms: 0 };
  }
  if (text.length <= cfg.trigger_chars) {
    return { text, used: 'skipped', latency_ms: 0 };
  }
  if (text.length > PARAPHRASE_MAX_INPUT) {
    // Long answers (tool-augmented research, multi-section replies) overflow
    // the small paraphrase model's competence. Speak the original; captions
    // already show the full text.
    console.warn(
      `[paraphrase] input ${text.length} chars > ${PARAPHRASE_MAX_INPUT} ceiling, speaking original`,
    );
    return { text, used: 'skipped', latency_ms: 0 };
  }

  const messages: ChatBody['messages'] = [
    { role: 'system', content: cfg.system_prompt },
    { role: 'user', content: text },
  ];

  const tryHermesLlm = async (): Promise<ParaphraseResult> => {
    const llm = readLlmEndpoint();
    if (!llm) {
      // Local ~/.hermes/ not readable (Docker / remote hermes). Refuse to
      // bypass through hermes-agent's /v1/chat/completions — that runs the
      // full agent loop and would corrupt session memory.
      throw new BypassUnsafeError();
    }
    if (!llm.model) {
      throw new Error('Hermes config has no model.default set.');
    }
    const url = `${llm.base_url.replace(/\/+$/, '')}/chat/completions`;
    const result = await postChat(url, llm.api_key, {
      model: llm.model,
      messages,
      max_tokens: Math.max(48, cfg.target_words * 4),
      temperature: 0.4,
      stream: false,
    });
    return {
      text: sanitizeParaphrase(result, text),
      used: 'reuse_hermes_llm',
      latency_ms: Date.now() - start,
    };
  };

  const tryLitert = async (
    fallback_reason?: ParaphraseResult['fallback_reason'],
  ): Promise<ParaphraseResult> => {
    const url = `${cfg.litert_lm_url.replace(/\/+$/, '')}/responses`;
    const result = await postResponses(
      url,
      undefined,
      LITERT_DEFAULT_MODEL,
      messages,
      Math.max(48, cfg.target_words * 4),
      0.4,
    );
    const sanitized = sanitizeParaphrase(result, text);
    return {
      text: sanitized,
      used: 'local_litert',
      latency_ms: Date.now() - start,
      ...(fallback_reason ? { fallback_reason } : {}),
    };
  };

  if (cfg.model === 'reuse_hermes_llm') {
    try {
      return await tryHermesLlm();
    } catch (err) {
      const reason = err instanceof BypassUnsafeError ? 'unsafe_to_bypass' : 'unreachable';
      console.warn(`[paraphrase] hermes LLM ${reason}, falling back to local litert-lm:`, err);
      try {
        return await tryLitert(reason);
      } catch (err2) {
        console.error('[paraphrase] litert-lm also failed:', err2);
        return { text, used: 'skipped', latency_ms: Date.now() - start };
      }
    }
  }
  // local_litert (default)
  try {
    return await tryLitert();
  } catch (err) {
    console.error('[paraphrase] litert-lm failed:', err);
    return { text, used: 'skipped', latency_ms: Date.now() - start };
  }
}

/**
 * Validate the LLM's paraphrase output. Tiny models (Gemma-4-E2B in
 * particular) periodically misfire — they ignore the system prompt and
 * answer the user message as if it were a chat turn ("Please tell me what
 * you'd like me to summarize, smiley face"). When that happens we'd rather
 * speak the original text than the canned reply. Returns the original on
 * any failure signal.
 */
function sanitizeParaphrase(candidate: string, original: string): string {
  const c = candidate.trim();
  if (!c) return original;
  // Way shorter than expected for a real summary AND looks like a refusal.
  if (c.length < 12 && CANNED_FAILURE_RE.test(c)) return original;
  // Anywhere in the output, common refusal patterns. We're stricter on
  // these than on length because they're high-signal.
  if (CANNED_FAILURE_RE.test(c)) {
    console.warn(`[paraphrase] suspicious output (${c.length} chars), using original`);
    return original;
  }
  return c;
}

class BypassUnsafeError extends Error {
  constructor() {
    super('Local hermes config not readable; bypass would corrupt sessions.');
  }
}

export function registerParaphraseIpc(): void {
  ipcMain.handle(IPC.hermes.paraphrase, (_evt, text: string) => paraphrase(text));
}
