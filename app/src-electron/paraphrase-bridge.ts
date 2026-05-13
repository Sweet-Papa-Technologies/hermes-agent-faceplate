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
// Soft input ceiling. Above this length we TRUNCATE the input rather than
// skip paraphrase entirely — lists / tool-augmented research answers are
// long by nature and that's exactly when the user most wants a short TTS
// summary. The first ~1500 chars usually carry the topic + several items,
// which is enough for a 20-word "gist" summary. The full text still
// renders in captions; only TTS uses the truncated paraphrase.
const PARAPHRASE_INPUT_TRUNCATE_AT = 1_500;
const PARAPHRASE_TRUNCATE_MARKER = '\n\n[reply continues — summarize the gist of what was covered above; do not enumerate]';
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
  /** Qwen3 / DeepSeek-style "skip the chain-of-thought" hints. Non-reasoning
   * servers ignore unknown fields. With reasoning models (e.g. Qwen3.6) the
   * default behaviour is to spend the entire token budget on
   * `reasoning_content` and emit an empty `content` — useless for TTS. */
  enable_thinking?: false;
  reasoning_effort?: 'minimal' | 'low';
  chat_template_kwargs?: { enable_thinking: false };
}

/** Rewrite Docker-only hostnames to their host-side equivalents.
 * `host.docker.internal` is a magic name Docker Desktop injects into
 * containers so they can reach the host. From the host itself (where
 * Electron runs), the same name is rarely resolvable — but the same
 * service is reachable on `localhost`. Same for the Linux convention
 * `gateway.docker.internal`. Leaves all other URLs untouched. */
function rewriteDockerHostUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'host.docker.internal' || u.hostname === 'gateway.docker.internal') {
      u.hostname = '127.0.0.1';
      return u.toString();
    }
  } catch {
    /* malformed — leave it */
  }
  return url;
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
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
  };
  const choice = json.choices?.[0];
  const content = choice?.message?.content?.trim() ?? '';
  if (content) return content;
  // Reasoning models can produce empty content if the entire token budget
  // was consumed by chain-of-thought. Log enough to diagnose without
  // spamming the full thought trace.
  const reasoning = choice?.message?.reasoning_content ?? '';
  if (reasoning) {
    console.warn(
      `[paraphrase] empty content but reasoning_content=${reasoning.length} chars present, ` +
      `finish_reason=${choice?.finish_reason}. Reasoning model spent the budget thinking — ` +
      `bump max_tokens or set enable_thinking:false on the request.`,
    );
  }
  return '';
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
    console.log(`[paraphrase] mode=${cfg.model} enabled=${cfg.enabled} → speaking original (${text.length} chars)`);
    return { text, used: 'disabled', latency_ms: 0 };
  }
  if (text.length <= cfg.trigger_chars) {
    console.log(`[paraphrase] ${text.length}≤${cfg.trigger_chars} chars (trigger_chars) → skip, speak original`);
    return { text, used: 'skipped', latency_ms: 0 };
  }

  // Truncate (not skip) when too long — lists are long by nature; that's
  // exactly when the user wants a short TTS summary, not the full readout.
  const truncated = text.length > PARAPHRASE_INPUT_TRUNCATE_AT;
  const userInput = truncated
    ? text.slice(0, PARAPHRASE_INPUT_TRUNCATE_AT) + PARAPHRASE_TRUNCATE_MARKER
    : text;

  const messages: ChatBody['messages'] = [
    { role: 'system', content: cfg.system_prompt },
    { role: 'user', content: userInput },
  ];

  console.log(
    `[paraphrase] start: model=${cfg.model} in=${text.length} chars` +
    `${truncated ? ` (truncated→${PARAPHRASE_INPUT_TRUNCATE_AT})` : ''}` +
    ` target_words=${cfg.target_words} trigger=${cfg.trigger_chars}`,
  );

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
    const baseUrl = rewriteDockerHostUrl(llm.base_url);
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    // Token budget: enough headroom for ~target_words plus a small fudge,
    // OR a generous floor for reasoning models that ignore the no-think
    // hints below and still burn budget on chain-of-thought. Without the
    // floor, Qwen3.6/DeepSeek-style models return empty content
    // (finish_reason=length) because they spent the whole allowance
    // thinking and never wrote the answer.
    const maxTokens = Math.max(512, cfg.target_words * 8);
    const result = await postChat(url, llm.api_key, {
      model: llm.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4,
      stream: false,
      // Three different "don't think" conventions across server stacks
      // (vLLM, llama.cpp+Qwen template, OpenAI Responses-style). Servers
      // that don't recognize these silently ignore them.
      enable_thinking: false,
      reasoning_effort: 'minimal',
      chat_template_kwargs: { enable_thinking: false },
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

  const logOutcome = (r: ParaphraseResult): ParaphraseResult => {
    const wordCount = r.text.split(/\s+/).filter(Boolean).length;
    console.log(
      `[paraphrase] done: used=${r.used} in=${text.length}c → out=${r.text.length}c / ${wordCount}w` +
      ` in ${r.latency_ms}ms${r.fallback_reason ? ` (fallback=${r.fallback_reason})` : ''}` +
      `${r.text === text ? ' [UNCHANGED — paraphrase did not alter text]' : ''}`,
    );
    return r;
  };

  if (cfg.model === 'reuse_hermes_llm') {
    try {
      return logOutcome(await tryHermesLlm());
    } catch (err) {
      const reason = err instanceof BypassUnsafeError ? 'unsafe_to_bypass' : 'unreachable';
      console.warn(`[paraphrase] hermes LLM ${reason}, falling back to local litert-lm:`, err);
      try {
        return logOutcome(await tryLitert(reason));
      } catch (err2) {
        console.error('[paraphrase] litert-lm also failed:', err2);
        return { text, used: 'skipped', latency_ms: Date.now() - start };
      }
    }
  }
  // local_litert (default)
  try {
    return logOutcome(await tryLitert());
  } catch (err) {
    console.error('[paraphrase] litert-lm failed:', err);
    return { text, used: 'skipped', latency_ms: Date.now() - start };
  }
}

/**
 * Clean + validate the LLM's paraphrase output. Two things happen here:
 *
 * 1. Strip meta-prefixes the model adds despite being told not to
 *    ("Sure, here's a summary:", "Summary:", "Here you go:", etc.) plus
 *    leading/trailing quote marks. These would otherwise be read out loud.
 * 2. Reject canned refusals from tiny models that ignored the prompt
 *    entirely ("Please tell me what you'd like me to summarize"). We'd
 *    rather speak the original than the refusal.
 *
 * The cleaned candidate is also logged so it's visible WHY a paraphrase
 * passed or fell back to the original.
 */
function sanitizeParaphrase(candidate: string, original: string): string {
  const raw = candidate.trim();
  console.log(`[paraphrase] raw model output (${raw.length} chars): ${JSON.stringify(raw.slice(0, 240))}${raw.length > 240 ? '…' : ''}`);
  if (!raw) {
    console.warn('[paraphrase] empty output, using original');
    return original;
  }
  // Strip common prefixes the model emits despite the prompt asking it
  // not to. Case-insensitive, only at the very start.
  let c = raw;
  const PREFIXES = [
    /^(?:sure[,!.\s]+)?(?:here(?:'s|\sis)\s+(?:a\s+|the\s+|your\s+)?(?:short\s+)?(?:spoken\s+)?summary[:.\-\s]+)/i,
    /^(?:summary|spoken\s+summary|tts\s+summary|paraphrase|tl;dr)[:.\-\s]+/i,
    /^(?:okay|ok|alright|certainly|absolutely)[,.\s]+/i,
    /^(?:here\s+(?:you\s+go|it\s+is)|got\s+it)[:.\-\s]+/i,
  ];
  for (const re of PREFIXES) {
    const m = c.match(re);
    if (m) {
      c = c.slice(m[0].length).trim();
    }
  }
  // Strip wrapping quotes.
  c = c.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!c) return original;
  // Way shorter than expected for a real summary AND looks like a refusal.
  if (c.length < 12 && CANNED_FAILURE_RE.test(c)) return original;
  // Anywhere in the output, common refusal patterns.
  if (CANNED_FAILURE_RE.test(c)) {
    console.warn(`[paraphrase] suspicious output (${c.length} chars), using original`);
    return original;
  }
  // Defence against the model echoing the input back verbatim — a
  // common failure mode where the model treats the input as something to
  // repeat, not summarize. If the cleaned candidate is >= 95% of the
  // original length, it's almost certainly an echo.
  if (c.length >= Math.floor(original.length * 0.95) && c.length > 80) {
    console.warn(
      `[paraphrase] candidate (${c.length} chars) ≈ original (${original.length}); ` +
      `model echoed instead of summarizing — using original for TTS skip`,
    );
    return original;
  }
  if (c !== raw) console.log(`[paraphrase] cleaned: ${JSON.stringify(c.slice(0, 160))}${c.length > 160 ? '…' : ''}`);
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
