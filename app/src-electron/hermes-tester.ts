// "Test connection" IPC. Hits each of the five targets and reports
// {ok, latency_ms, detail|error}.

import { ipcMain, net } from 'electron';

import { IPC, type ConnectionTarget, type TestResult } from './preload-api';
import { getSettings } from './settings-store';
import { readApiServerKey, readLlmEndpoint } from './hermes-discovery';

const TIMEOUT_MS = 5_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latency_ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latency_ms: Date.now() - start };
}

function isLocalNetwork(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1') return true;
    // 127.0.0.0/8
    if (/^127\./.test(h)) return true;
    // RFC 1918 private IPv4 — covers home LANs, Docker bridges, cgnat-style setups.
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    // Link-local
    if (/^169\.254\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  // Pick the right fetch:
  //   - loopback / RFC1918 (litert-lm, sidecar via host port, hermes pointing
  //     at a LAN LLM at 192.168.x): use Node's built-in fetch so we bypass
  //     Chromium's PAC/proxy config. Several macOS setups (Little Snitch,
  //     CleanMyMac, corp PAC) intercept private-network traffic and net.fetch
  //     surfaces the result as ERR_ADDRESS_UNREACHABLE.
  //   - everything else (remote hermes / external LLM): keep electron.net.fetch
  //     so we follow the system cert store + proxy intentionally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  const useNode = isLocalNetwork(url);
  console.log(`[hermes-tester] fetch ${url} via ${useNode ? 'node-undici' : 'electron.net'}`);
  const doFetch = useNode ? fetch : net.fetch;
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(target: ConnectionTarget): Promise<TestResult> {
  try {
    switch (target) {
      case 'agent':
        return await testAgent();
      case 'llm':
        return await testLlm();
      case 'tts':
        return await testTts();
      case 'asr':
        return await testAsr();
      case 'paraphrase':
        return await testParaphrase();
    }
  } catch (err) {
    return { ok: false, latency_ms: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testAgent(): Promise<TestResult> {
  const settings = getSettings();
  const base = settings.hermes.base_url.replace(/\/+$/, '');
  // Hermes-agent exposes /v1/health AND /health. Try /health first because
  // it's documented as canonical in §5.1.
  const candidates = [
    base.replace(/\/v1$/, '') + '/health',
    base + '/health',
  ];
  const headers: Record<string, string> = {};
  const apiKey = settings.hermes.api_key || readApiServerKey() || '';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  for (const url of candidates) {
    const { value, latency_ms } = await timed(() => fetchJson(url, { headers }));
    if (value.status >= 200 && value.status < 300) {
      return { ok: true, latency_ms, detail: value.body.slice(0, 240) };
    }
  }
  return { ok: false, latency_ms: 0, error: 'Hermes API server not reachable on /health' };
}

async function testLlm(): Promise<TestResult> {
  const llm = readLlmEndpoint();
  if (!llm) {
    return {
      ok: false,
      latency_ms: 0,
      error: 'No local hermes config found. The "Reuse hermes\' LLM" paraphrase mode requires read access to ~/.hermes/. Use the sidecar fallback for Docker / remote installs.',
    };
  }
  if (!llm.model) {
    return { ok: false, latency_ms: 0, error: 'hermes-agent config has no model.default set.' };
  }
  const url = `${llm.base_url.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (llm.api_key) headers.authorization = `Bearer ${llm.api_key}`;
  const body = JSON.stringify({
    model: llm.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  });
  const { value, latency_ms } = await timed(() => fetchJson(url, { method: 'POST', headers, body }));
  if (value.status >= 200 && value.status < 300) {
    return { ok: true, latency_ms, detail: `${llm.model} replied (${value.body.length} bytes)` };
  }
  return { ok: false, latency_ms, error: `HTTP ${value.status}: ${value.body.slice(0, 240)}` };
}

async function testTts(): Promise<TestResult> {
  const settings = getSettings();
  if (settings.speech.sidecar_mode === 'disabled') {
    return { ok: false, latency_ms: 0, error: 'Sidecar disabled.' };
  }
  // Lightweight: fetch /voices (or /v1/voices). Don't actually synthesise.
  const base = settings.speech.sidecar_url.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (settings.speech.sidecar_token) headers.authorization = `Bearer ${settings.speech.sidecar_token}`;
  let lastStatus = 0;
  let lastLatency = 0;
  let lastBody = '';
  for (const url of [`${base}/voices`, `${base}/v1/voices`, `${base}/v1/models`]) {
    const { value, latency_ms } = await timed(() => fetchJson(url, { headers }));
    if (value.status >= 200 && value.status < 300) {
      return { ok: true, latency_ms, detail: value.body.slice(0, 240) };
    }
    lastStatus = value.status;
    lastLatency = latency_ms;
    lastBody = value.body;
  }
  if (lastStatus === 401 || lastStatus === 403) {
    return {
      ok: false,
      latency_ms: lastLatency,
      error: `HTTP ${lastStatus}: ${lastBody.slice(0, 200)} — paste the FACEPLATE_API_KEY printed by \`make setup\` into Settings → Speech Sidecar → Bearer token.`,
    };
  }
  if (lastStatus > 0) {
    return { ok: false, latency_ms: lastLatency, error: `HTTP ${lastStatus}: ${lastBody.slice(0, 240)}` };
  }
  return { ok: false, latency_ms: 0, error: 'Sidecar TTS endpoint unreachable.' };
}

async function testAsr(): Promise<TestResult> {
  const settings = getSettings();
  if (settings.speech.sidecar_mode === 'disabled') {
    return { ok: false, latency_ms: 0, error: 'Sidecar disabled.' };
  }
  const base = settings.speech.sidecar_url.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (settings.speech.sidecar_token) headers.authorization = `Bearer ${settings.speech.sidecar_token}`;
  // /v1/models is the canonical OpenAI-compatible probe; ASR servers all
  // expose it. We don't post audio in the test.
  const { value, latency_ms } = await timed(() => fetchJson(`${base}/v1/models`, { headers }));
  if (value.status >= 200 && value.status < 300) {
    return {
      ok: true,
      latency_ms,
      detail: value.body.slice(0, 240),
    };
  }
  return { ok: false, latency_ms, error: `HTTP ${value.status}: ${value.body.slice(0, 240)}` };
}

async function testParaphrase(): Promise<TestResult> {
  const settings = getSettings();
  if (settings.paraphrase.model === 'disabled') {
    return { ok: false, latency_ms: 0, error: 'Paraphrase disabled in settings.' };
  }

  // 'reuse_hermes_llm' tests the same endpoint as testLlm, since that's
  // exactly what paraphrase will hit at runtime.
  if (settings.paraphrase.model === 'reuse_hermes_llm') {
    const r = await testLlm();
    if (r.ok) return { ...r, detail: `paraphrase will use hermes LLM (${r.detail ?? ''})` };
    return r;
  }

  // 'local_litert' — POSTs to host-native `litert-lm serve --api openai` at
  // the URL set in settings.paraphrase.litert_lm_url (default
  // http://127.0.0.1:7860/v1). litert-lm 0.11 only exposes the **Responses**
  // API on this mode, not Chat Completions, so we POST to /responses with
  // the Responses-shaped body.
  const base = settings.paraphrase.litert_lm_url.replace(/\/+$/, '');
  const url = `${base}/responses`;
  const body = JSON.stringify({
    model: 'gemma-4-E2B-it',
    input: 'ping',
    max_output_tokens: 1,
  });
  const { value, latency_ms } = await timed(() =>
    fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  if (value.status >= 200 && value.status < 300) {
    return { ok: true, latency_ms, detail: value.body.slice(0, 240) };
  }
  if (value.status === 0) {
    return {
      ok: false,
      latency_ms,
      error: `litert-lm not reachable at ${base}. Run \`make litert-up\` on the host first.`,
    };
  }
  return { ok: false, latency_ms, error: `HTTP ${value.status}: ${value.body.slice(0, 240)}` };
}

export function registerHermesTesterIpc(): void {
  ipcMain.handle(IPC.hermes.test, (_evt, target: ConnectionTarget) => testConnection(target));
}
