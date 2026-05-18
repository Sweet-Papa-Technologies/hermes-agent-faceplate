// Single source of truth for ~/.hermes path resolution and ~/.hermes/.env
// reading/writing.
//
// Before M3 this logic was duplicated: the bash `ensure_var` in
// scripts/start-hermes.sh and the .env helpers in agent-push-installer.ts.
// Both are append-only and never clobber a value the user set by hand —
// that contract is preserved here exactly.
//
// `ensureHermesApiEnv()` ports start-hermes.sh's API_SERVER_* bootstrap so
// the app-managed Hermes lifecycle (hermes-lifecycle.ts) can guarantee the
// gateway is enabled + reachable with a known key, without shelling out.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { getSettings } from './settings-store';

const DEFAULT_BANNER = '# Added by HermesAgent Faceplate (Hermes Pings setup)';

export function expandTilde(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** Resolve the Hermes data dir. Precedence matches the prior
 *  agent-push-installer logic exactly: HERMES_HOME env → settings
 *  hermes.config_path's dir → ~/.hermes. */
export function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const fromSettings = getSettings().hermes.config_path;
  if (fromSettings && fromSettings.endsWith('config.yaml')) {
    return path.dirname(expandTilde(fromSettings));
  }
  return path.join(os.homedir(), '.hermes');
}

export function envPath(): string {
  return path.join(hermesHome(), '.env');
}

/** Loose `.env` parser. `KEY=value`, ignores comments/blank/malformed,
 *  strips one layer of surrounding quotes. No shell expansion. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function readEnvFile(): { text: string; vars: Record<string, string> } {
  const p = envPath();
  if (!existsSync(p)) return { text: '', vars: {} };
  try {
    const text = readFileSync(p, 'utf8');
    return { text, vars: parseEnvFile(text) };
  } catch {
    return { text: '', vars: {} };
  }
}

/** Append-only writer: never rewrites existing lines. Banner defaults to
 *  the exact string agent-push-installer used (preserves its behavior). */
export function appendEnvVars(
  currentText: string,
  additions: Array<{ key: string; value: string }>,
  banner: string = DEFAULT_BANNER,
): string {
  if (additions.length === 0) return currentText;
  const trail = currentText.endsWith('\n') || currentText === '' ? '' : '\n';
  const body = additions.map(({ key, value }) => `${key}=${value}`).join('\n');
  return `${currentText}${trail}\n${banner}\n${body}\n`;
}

export function atomicWrite(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.faceplate.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, targetPath);
}

export interface HermesApiEnv {
  enabled: string;
  host: string;
  port: string;
  key: string;
}

/** Port of scripts/start-hermes.sh `ensure_var`: ensure the API_SERVER_*
 *  block exists in ~/.hermes/.env, appending only the missing keys (never
 *  clobbering a user value), generating a random key if absent. Returns
 *  the effective values (existing or just-written). */
export function ensureHermesApiEnv(port = 8642): HermesApiEnv {
  const { text, vars } = readEnvFile();
  const defaults: Record<keyof HermesApiEnv, string> = {
    enabled: 'true',
    host: '0.0.0.0',
    port: String(port),
    key: crypto.randomBytes(32).toString('hex'),
  };
  const keyName: Record<keyof HermesApiEnv, string> = {
    enabled: 'API_SERVER_ENABLED',
    host: 'API_SERVER_HOST',
    port: 'API_SERVER_PORT',
    key: 'API_SERVER_KEY',
  };

  const result = {} as HermesApiEnv;
  const toAppend: Array<{ key: string; value: string }> = [];
  (Object.keys(keyName) as Array<keyof HermesApiEnv>).forEach((field) => {
    const envKey = keyName[field];
    const existing = vars[envKey];
    if (existing !== undefined && existing !== '') {
      result[field] = existing;
    } else {
      result[field] = defaults[field];
      toAppend.push({ key: envKey, value: defaults[field] });
    }
  });

  if (toAppend.length > 0) {
    atomicWrite(
      envPath(),
      appendEnvVars(text, toAppend, '# Added by HermesAgent Faceplate (Hermes Agent setup)'),
    );
  }
  return result;
}
