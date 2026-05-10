// Hermes-agent discovery.
//
// Two independent paths. The Faceplate works fine with only the HTTP probe
// — local config reading is a strict optimisation for the "reuse hermes'
// LLM" paraphrase mode.
//
//   1. HTTP probe (always)         GET ${base_url}/health   + GET ${base_url}/capabilities
//      Works against any hermes deployment (local / Docker / remote).
//
//   2. Local-config peek (best-effort)   reads ~/.hermes/config.yaml + .env
//      Provides provider / base_url / api_key for the underlying LLM, which
//      lets paraphrase bypass hermes' agent loop. Skipped silently when
//      files aren't there (e.g. Docker, remote).
//
// The renderer / paraphrase IPC consults `local_config_readable` to decide
// whether the user's `paraphrase.model = 'reuse_hermes_llm'` choice can
// actually be honoured. When it can't, paraphrase is rerouted through the
// sidecar — bypassing hermes' chat-completions endpoint is REQUIRED because
// hermes' /v1/chat/completions runs the full agent loop (memory + tools)
// per https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server.

import { ipcMain, net } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

import {
  IPC,
  type HermesCapabilities,
  type HermesDiscovery,
  type HermesLocalConfig,
} from './preload-api';
import { getSettings } from './settings-store';

const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 8642;
const PROBE_TIMEOUT_MS = 4_000;

interface ParsedHermesConfig {
  model?: {
    default?: string;
    provider?: string;
    base_url?: string;
    api_key?: string;
  };
  [key: string]: unknown;
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const configPath = expandPath(getSettings().hermes.config_path);
  if (configPath && configPath.endsWith('config.yaml')) {
    return path.dirname(configPath);
  }
  return path.join(os.homedir(), '.hermes');
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function providerKeyName(provider: string | undefined): string | null {
  if (!provider) return null;
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `${upper}_API_KEY`;
}

function defaultBaseUrlFor(provider: string | undefined): string | undefined {
  switch ((provider ?? '').toLowerCase()) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'ollama':
      return 'http://127.0.0.1:11434/v1';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- HTTP probe

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    return await net.fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeResult {
  reachable: boolean;
  http_status?: number;
  capabilities?: HermesCapabilities;
  health_status?: 'ok' | 'degraded' | 'unknown';
  warnings: string[];
}

async function httpProbe(baseUrl: string, apiKey: string): Promise<ProbeResult> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const trimmed = baseUrl.replace(/\/+$/, '');
  // /v1/health is the canonical endpoint per hermes-agent docs; /health
  // also works on most deployments. Try both.
  const healthCandidates = [`${trimmed}/health`, `${trimmed.replace(/\/v1$/, '')}/health`];

  const warnings: string[] = [];
  let healthRes: Response | null = null;
  let lastStatus: number | undefined;
  for (const url of healthCandidates) {
    const res = await fetchWithTimeout(url, { headers });
    if (!res) continue;
    lastStatus = res.status;
    if (res.ok) {
      healthRes = res;
      break;
    }
    if (res.status === 401 || res.status === 403) {
      warnings.push('Auth rejected by hermes — check the API key.');
      return { reachable: false, http_status: res.status, warnings };
    }
  }

  if (!healthRes) {
    warnings.push(`Hermes health probe failed (last status: ${lastStatus ?? 'no response'}).`);
    return {
      reachable: false,
      ...(lastStatus !== undefined ? { http_status: lastStatus } : {}),
      warnings,
    };
  }

  let healthStatus: 'ok' | 'degraded' | 'unknown' = 'ok';
  try {
    const body = (await healthRes.json()) as { status?: string };
    if (typeof body.status === 'string' && body.status !== 'ok' && body.status !== 'OK') {
      healthStatus = 'degraded';
    }
  } catch {
    // Plain text or no body — hermes treats 200 as healthy.
  }

  // /v1/capabilities — best-effort. Older hermes-agents (< v0.12) won't have it.
  const capsRes = await fetchWithTimeout(`${trimmed}/capabilities`, { headers });
  let capabilities: HermesCapabilities | undefined;
  if (capsRes && capsRes.ok) {
    try {
      const raw = (await capsRes.json()) as Record<string, unknown>;
      capabilities = parseCapabilities(raw);
    } catch {
      warnings.push('Hermes /v1/capabilities returned non-JSON.');
    }
  }

  return {
    reachable: true,
    http_status: healthRes.status,
    health_status: healthStatus,
    ...(capabilities ? { capabilities } : {}),
    warnings,
  };
}

function parseCapabilities(raw: Record<string, unknown>): HermesCapabilities {
  const features = (raw.features ?? {}) as Record<string, unknown>;
  const auth = raw.auth as { required?: boolean } | undefined;
  return {
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
    ...(typeof auth?.required === 'boolean' ? { auth_required: auth.required } : {}),
    features: {
      ...(typeof features.chat_completions === 'boolean' ? { chat_completions: features.chat_completions } : {}),
      ...(typeof features.responses_api === 'boolean' ? { responses_api: features.responses_api } : {}),
      ...(typeof features.runs === 'boolean' ? { runs: features.runs } : {}),
      ...(typeof features.streaming === 'boolean' ? { streaming: features.streaming } : {}),
      ...(typeof features.cancellation === 'boolean' ? { cancellation: features.cancellation } : {}),
    },
    raw,
  };
}

// ---------------------------------------------------------------- local fs

interface LocalReadResult {
  readable: boolean;
  config?: HermesLocalConfig;
  warnings: string[];
}

function readLocalConfig(): LocalReadResult {
  const home = hermesHome();
  const configPath = path.join(home, 'config.yaml');
  const envPath = path.join(home, '.env');
  const warnings: string[] = [];

  if (!existsSync(configPath) && !existsSync(envPath)) {
    // Common case for Docker / remote deployments — not actually a problem.
    return { readable: false, warnings: [] };
  }

  let cfg: ParsedHermesConfig | null = null;
  if (existsSync(configPath)) {
    try {
      cfg = (YAML.parse(readFileSync(configPath, 'utf8')) ?? {}) as ParsedHermesConfig;
    } catch (err) {
      warnings.push(`Failed to parse config.yaml: ${err instanceof Error ? err.message : String(err)}`);
      return { readable: false, warnings };
    }
  }

  let env: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      env = parseDotenv(readFileSync(envPath, 'utf8'));
    } catch (err) {
      warnings.push(`Failed to parse .env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const apiServerEnabled = (env.API_SERVER_ENABLED ?? '').toLowerCase() === 'true';
  const apiHost = env.API_SERVER_HOST ?? DEFAULT_API_HOST;
  const apiPort = env.API_SERVER_PORT ? Number(env.API_SERVER_PORT) : DEFAULT_API_PORT;
  const apiKeyPresent = Boolean(env.API_SERVER_KEY);

  const llmProvider = cfg?.model?.provider;
  const llmBaseUrl = cfg?.model?.base_url ?? defaultBaseUrlFor(llmProvider);
  const llmApiKey = cfg?.model?.api_key ?? (() => {
    const key = providerKeyName(llmProvider);
    return key ? env[key] : undefined;
  })();

  return {
    readable: true,
    config: {
      config_path: configPath,
      api_server_enabled: apiServerEnabled,
      api_server_host: apiHost,
      api_server_port: Number.isFinite(apiPort) ? apiPort : DEFAULT_API_PORT,
      api_key_present_in_env: apiKeyPresent,
      llm: {
        ...(llmProvider !== undefined ? { provider: llmProvider } : {}),
        ...(llmBaseUrl !== undefined ? { base_url: llmBaseUrl } : {}),
        ...(cfg?.model?.default !== undefined ? { model: cfg.model.default } : {}),
        api_key_present: Boolean(llmApiKey),
      },
    },
    warnings,
  };
}

// ---------------------------------------------------------------- top-level

export async function discoverHermes(): Promise<HermesDiscovery> {
  const settings = getSettings();
  const baseUrl = settings.hermes.base_url.replace(/\/+$/, '');
  const apiKey = settings.hermes.api_key;

  const [probe, local] = await Promise.all([
    httpProbe(baseUrl, apiKey),
    Promise.resolve(readLocalConfig()),
  ]);

  // If HTTP probe succeeded but no key has been pasted into Settings AND
  // local .env has one, surface a hint.
  const warnings = [...probe.warnings, ...local.warnings];
  if (probe.reachable && !apiKey && local.readable && local.config?.api_key_present_in_env) {
    warnings.push(
      'Hermes is reachable but Settings has no API key. Copy API_SERVER_KEY from ~/.hermes/.env into Settings → Connection.',
    );
  }
  if (!probe.reachable && !local.readable) {
    warnings.push(
      `Hermes not reachable at ${baseUrl} and no local ~/.hermes/ config found. ` +
        'Paste the gateway URL + API_SERVER_KEY into Settings → Connection.',
    );
  }

  return {
    base_url: baseUrl,
    reachable: probe.reachable,
    ...(probe.http_status !== undefined ? { http_status: probe.http_status } : {}),
    ...(probe.capabilities ? { capabilities: probe.capabilities } : {}),
    ...(probe.health_status ? { health_status: probe.health_status } : {}),
    local_config_readable: local.readable,
    ...(local.config ? { local_config: local.config } : {}),
    warnings,
  };
}

/**
 * Resolves the underlying LLM endpoint when local config is readable.
 * Returns null otherwise — paraphrase callers must fall back to the sidecar
 * because hermes' /v1/chat/completions runs the agent loop.
 */
export function readLlmEndpoint(): {
  base_url: string;
  api_key: string | undefined;
  model: string | undefined;
} | null {
  const local = readLocalConfig();
  if (!local.readable || !local.config) return null;
  const { llm } = local.config;
  if (!llm.base_url) return null;

  const home = hermesHome();
  const envPath = path.join(home, '.env');
  let apiKey: string | undefined;
  if (existsSync(envPath)) {
    try {
      const env = parseDotenv(readFileSync(envPath, 'utf8'));
      const cfgPath = path.join(home, 'config.yaml');
      let cfgKey: string | undefined;
      if (existsSync(cfgPath)) {
        const cfg = (YAML.parse(readFileSync(cfgPath, 'utf8')) ?? {}) as ParsedHermesConfig;
        cfgKey = cfg.model?.api_key;
      }
      const provKey = providerKeyName(llm.provider);
      apiKey = cfgKey ?? (provKey ? env[provKey] : undefined);
    } catch {
      /* noop */
    }
  }
  return {
    base_url: llm.base_url,
    api_key: apiKey,
    ...(llm.model !== undefined ? { model: llm.model } : { model: undefined }),
  };
}

export function readApiServerKey(): string | undefined {
  const home = hermesHome();
  const envPath = path.join(home, '.env');
  if (!existsSync(envPath)) return undefined;
  try {
    const env = parseDotenv(readFileSync(envPath, 'utf8'));
    return env.API_SERVER_KEY;
  } catch {
    return undefined;
  }
}

export function isLocalConfigReadable(): boolean {
  return readLocalConfig().readable;
}

export function registerHermesDiscoveryIpc(): void {
  ipcMain.handle(IPC.hermes.discover, () => discoverHermes());
}
