// Paraphrase IPC. Lives in main so we can read the LLM API key out of
// ~/.hermes/.env without exposing it to the renderer.
//
// Routing:
//   settings.paraphrase.model === 'reuse_hermes_llm' (default):
//     POST direct to the discovered LLM endpoint
//     fall through to sidecar on network error
//   settings.paraphrase.model === 'sidecar_fallback':
//     POST to sidecar /v1/chat/completions (proxied to litert-lm-api-server)
//   settings.paraphrase.model === 'disabled':
//     return original text unchanged

import { ipcMain, net } from 'electron';

import { IPC, type ParaphraseResult } from './preload-api';
import { getSettings } from './settings-store';
import { readLlmEndpoint } from './hermes-discovery';

const TIMEOUT_MS = 12_000;

interface ChatBody {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: false;
}

async function postChat(
  url: string,
  apiKey: string | undefined,
  body: ChatBody,
): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  } finally {
    clearTimeout(timer);
  }
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

  const messages: ChatBody['messages'] = [
    { role: 'system', content: cfg.system_prompt },
    { role: 'user', content: text },
  ];

  const tryHermes = async (): Promise<ParaphraseResult> => {
    const llm = readLlmEndpoint();
    if (!llm || !llm.model) {
      throw new Error('No discovered LLM endpoint.');
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
      text: result || text,
      used: 'reuse_hermes_llm',
      latency_ms: Date.now() - start,
    };
  };

  const trySidecar = async (): Promise<ParaphraseResult> => {
    if (settings.speech.sidecar_mode === 'disabled') {
      throw new Error('Sidecar disabled.');
    }
    const url = `${settings.speech.sidecar_url.replace(/\/+$/, '')}/v1/chat/completions`;
    const result = await postChat(url, settings.speech.sidecar_token || undefined, {
      model: 'gemma-4-e2b-it',
      messages,
      max_tokens: Math.max(48, cfg.target_words * 4),
      temperature: 0.4,
      stream: false,
    });
    return {
      text: result || text,
      used: 'sidecar_fallback',
      latency_ms: Date.now() - start,
    };
  };

  if (cfg.model === 'reuse_hermes_llm') {
    try {
      return await tryHermes();
    } catch (err) {
      console.warn('[paraphrase] hermes LLM failed, falling back to sidecar:', err);
      try {
        return await trySidecar();
      } catch (err2) {
        console.error('[paraphrase] sidecar also failed:', err2);
        return { text, used: 'skipped', latency_ms: Date.now() - start };
      }
    }
  }
  // sidecar_fallback
  try {
    return await trySidecar();
  } catch (err) {
    console.error('[paraphrase] sidecar failed:', err);
    return { text, used: 'skipped', latency_ms: Date.now() - start };
  }
}

export function registerParaphraseIpc(): void {
  ipcMain.handle(IPC.hermes.paraphrase, (_evt, text: string) => paraphrase(text));
}
