// "Test connection" IPC. Hits each of the five targets and reports
// {ok, latency_ms, detail|error}.

import { ipcMain, net } from 'electron';

import { IPC, type ConnectionTarget, type TestResult } from './preload-api';
import { getSettings } from './settings-store';
import { discoverHermes, readApiServerKey, readLlmEndpoint } from './hermes-discovery';

const TIMEOUT_MS = 5_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latency_ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latency_ms: Date.now() - start };
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  // Electron's `net.fetch` follows the system proxy + cert store; it's
  // strictly preferable to the renderer's `fetch` when we run from main.
  // The signature matches the standard fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { ...init, signal: controller.signal });
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
    return { ok: false, latency_ms: 0, error: 'No LLM endpoint discovered in hermes config.' };
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
  for (const url of [`${base}/voices`, `${base}/v1/voices`, `${base}/v1/models`]) {
    const { value, latency_ms } = await timed(() => fetchJson(url, { headers }));
    if (value.status >= 200 && value.status < 300) {
      return { ok: true, latency_ms, detail: value.body.slice(0, 240) };
    }
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

  // Mode 'reuse_hermes_llm' tests the same endpoint as testLlm, since that's
  // exactly what paraphrase will hit at runtime.
  if (settings.paraphrase.model === 'reuse_hermes_llm') {
    const r = await testLlm();
    if (r.ok) return { ...r, detail: `paraphrase will use hermes LLM (${r.detail ?? ''})` };
    return r;
  }

  // 'sidecar_fallback' — hits the sidecar's /v1/chat/completions which is
  // proxied to litert-lm-api-server in the bundled image.
  const base = settings.speech.sidecar_url.replace(/\/+$/, '');
  const url = `${base}/v1/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.speech.sidecar_token) headers.authorization = `Bearer ${settings.speech.sidecar_token}`;
  const body = JSON.stringify({
    model: 'gemma-4-e2b-it',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  });
  const { value, latency_ms } = await timed(() => fetchJson(url, { method: 'POST', headers, body }));
  if (value.status >= 200 && value.status < 300) {
    return { ok: true, latency_ms, detail: value.body.slice(0, 240) };
  }
  return { ok: false, latency_ms, error: `HTTP ${value.status}: ${value.body.slice(0, 240)}` };
}

export function registerHermesTesterIpc(): void {
  ipcMain.handle(IPC.hermes.test, (_evt, target: ConnectionTarget) => testConnection(target));
}
