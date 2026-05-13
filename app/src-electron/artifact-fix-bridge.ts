// AI auto-fix for broken artifacts. The renderer surfaces a "Fix with AI"
// button on chart/diagram render errors; that button calls
// `faceplate:artifact-fix:fix` with {kind, body, error}. We post the body +
// error to the underlying LLM (same direct-bypass path as paraphrase, so
// the agent's session memory isn't touched), with a strict prompt asking
// for ONLY the corrected raw body — no markdown fences, no commentary.
//
// References:
//   - app/src-electron/paraphrase-bridge.ts (the bypass pattern + Docker
//     URL rewrite, both reused below)

import { ipcMain, net } from 'electron';

import { IPC } from './preload-api';
import { readLlmEndpoint } from './hermes-discovery';

const TIMEOUT_MS = 30_000;

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
    if (/^192\.168\./.test(h) || /^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

interface FixInput {
  kind: string;
  body: string;
  error: string;
}

const KIND_HINTS: Record<string, string> = {
  chart:
    'Chart.js v4 JSON config. Required: {"type":"...","data":{"labels":[...],"datasets":[{"label":"...","data":[...]}]}}. ' +
    'Optional: "options" with "scales", "plugins", etc. NEVER put "datasets", "labels", or "scales" at the root.',
  diagram:
    'Mermaid diagram syntax. Pick the right type: flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, gantt (REQUIRES `dateFormat YYYY-MM-DD`), pie. ' +
    'Do NOT wrap output in <![CDATA[...]]> or markdown code fences.',
  code: 'A code body in the language already declared on the artifact. Do NOT add markdown fences.',
  text: 'Markdown prose. Keep formatting, fix structural issues only.',
};

function buildPrompt(input: FixInput): string {
  const hint = KIND_HINTS[input.kind] ?? `${input.kind} content body.`;
  return [
    `You are fixing a broken ${input.kind} artifact body that failed to render.`,
    '',
    `EXPECTED FORMAT: ${hint}`,
    '',
    'RULES:',
    '- Output ONLY the corrected raw body. No markdown fences (```), no <![CDATA[...]]>, no preface, no commentary.',
    '- Preserve the original intent — same data, same diagram type, same code semantics. Only fix what broke.',
    '- If the body is fundamentally salvageable but missing a required field, supply a sensible default.',
    '',
    'RENDER ERROR:',
    input.error,
    '',
    'BROKEN BODY:',
    input.body,
    '',
    'CORRECTED BODY (raw, no fences):',
  ].join('\n');
}

function stripFences(s: string): string {
  // Models love wrapping output in ```json … ``` even when told not to.
  // Strip a single leading + trailing fence pair.
  const m = s.match(/^```[a-zA-Z0-9_-]*\n?([\s\S]*?)\n?```\s*$/);
  return m ? m[1]!.trim() : s.trim();
}

interface ChatBody {
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  max_tokens?: number;
  temperature?: number;
  stream?: false;
  enable_thinking?: false;
  reasoning_effort?: 'minimal' | 'low';
  chat_template_kwargs?: { enable_thinking: false };
}

async function fixArtifact(input: FixInput): Promise<string | null> {
  if (!input || typeof input.body !== 'string') return null;
  const llm = readLlmEndpoint();
  if (!llm || !llm.base_url || !llm.model) {
    console.warn('[artifact-fix] no LLM endpoint readable; skipping');
    return null;
  }
  const baseUrl = rewriteDockerHostUrl(llm.base_url).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const body: ChatBody = {
    model: llm.model,
    messages: [{ role: 'user', content: buildPrompt(input) }],
    // Generous budget: reasoning models need headroom (see paraphrase-bridge
    // notes on Qwen3.6 burning the whole budget on chain-of-thought).
    max_tokens: 2_048,
    temperature: 0.2,
    stream: false,
    enable_thinking: false,
    reasoning_effort: 'minimal',
    chat_template_kwargs: { enable_thinking: false },
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (llm.api_key) headers.authorization = `Bearer ${llm.api_key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const doFetch = isLocalNetwork(url) ? fetch : net.fetch;
  const t0 = Date.now();
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[artifact-fix] HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) {
      console.warn('[artifact-fix] empty content from LLM');
      return null;
    }
    const cleaned = stripFences(raw);
    console.log(
      `[artifact-fix] ${input.kind} fixed: in=${input.body.length}c → out=${cleaned.length}c in ${Date.now() - t0}ms`,
    );
    return cleaned;
  } catch (err) {
    console.warn('[artifact-fix] failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerArtifactFixIpc(): void {
  ipcMain.handle(IPC.artifactFix.fix, (_e, input: FixInput) => fixArtifact(input));
}
