// Reads hermes-agent's local configuration so the renderer can pre-fill
// Settings and the turn handler knows which transport to use.
//
// Files we touch (read-only):
//   $HERMES_HOME/config.yaml   — model.{default,provider,base_url,api_key}
//   $HERMES_HOME/.env          — API_SERVER_*, *_API_KEY
// Defaults: $HERMES_HOME = ~/.hermes
//
// We never write to either file. Strategy B (the shell-hook bridge) writes a
// single line to config.yaml only after the user confirms a YAML diff in
// Settings; that lives in a separate module (Phase 6).

import { ipcMain } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

import { IPC, type HermesDiscovery } from './preload-api';
import { getSettings } from './settings-store';

const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 8642;

interface ParsedHermesConfig {
  model?: {
    default?: string;
    provider?: string;
    base_url?: string;
    api_key?: string;
  };
  // hermes-agent has many other keys (platforms, hooks, plugins) — we only
  // touch `model`. Unknown keys are ignored.
  [key: string]: unknown;
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  // Settings may override the config_path — in which case we use its parent
  // directory as the home.
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

export function discoverHermes(): HermesDiscovery {
  const home = hermesHome();
  const configPath = path.join(home, 'config.yaml');
  const envPath = path.join(home, '.env');

  const warnings: string[] = [];

  let cfg: ParsedHermesConfig | null = null;
  if (existsSync(configPath)) {
    try {
      cfg = (YAML.parse(readFileSync(configPath, 'utf8')) ?? {}) as ParsedHermesConfig;
    } catch (err) {
      warnings.push(`Failed to parse config.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warnings.push(`Hermes config not found at ${configPath}`);
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
  if (!apiServerEnabled) {
    warnings.push(
      'Hermes API server is disabled. Set API_SERVER_ENABLED=true and API_SERVER_KEY=<token> in ~/.hermes/.env to enable it.',
    );
  }

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
    found: cfg !== null,
    config_path: configPath,
    api_server_enabled: apiServerEnabled,
    api_server_host: apiHost,
    api_server_port: Number.isFinite(apiPort) ? apiPort : DEFAULT_API_PORT,
    api_key_present: apiKeyPresent,
    llm: {
      ...(llmProvider !== undefined ? { provider: llmProvider } : {}),
      ...(llmBaseUrl !== undefined ? { base_url: llmBaseUrl } : {}),
      ...(cfg?.model?.default !== undefined ? { model: cfg.model.default } : {}),
      api_key_present: Boolean(llmApiKey),
    },
    warnings,
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

export function readLlmEndpoint(): {
  base_url: string;
  api_key: string | undefined;
  model: string | undefined;
} | null {
  const d = discoverHermes();
  if (!d.llm.base_url) return null;
  // Pull the actual API key value (we only return the existence flag from
  // discoverHermes since it's IPC-visible); the renderer uses this through
  // the paraphrase IPC, never directly.
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
      const provKey = providerKeyName(d.llm.provider);
      apiKey = cfgKey ?? (provKey ? env[provKey] : undefined);
    } catch {
      /* noop */
    }
  }
  return {
    base_url: d.llm.base_url,
    api_key: apiKey,
    model: d.llm.model,
  };
}

export function registerHermesDiscoveryIpc(): void {
  ipcMain.handle(IPC.hermes.discover, () => discoverHermes());
}
