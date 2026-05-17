// One-click installer for the Hermes-side `faceplate` plugin.
//
// Replaces the manual steps documented in hermes-plugin/README.md with three
// IPC handlers the Settings UI can drive:
//
//   1. installPreview() — read-only inspection. Reports which files would
//      change, which env vars would be appended, and (best-effort) which
//      Docker container looks like a running Hermes. UI shows this in a
//      confirm dialog before any disk write.
//
//   2. install() — copy `hermes-plugin/faceplate/` into `~/.hermes/plugins/`,
//      append FACEPLATE_API_KEY / FACEPLATE_HOME_CHANNEL / FACEPLATE_PORT to
//      `~/.hermes/.env` IFF they're missing (never clobber a user-set value),
//      generate a random key if one wasn't already there, and write that key
//      into Faceplate's own settings so the WebSocket can connect.
//
//   3. restartHermes(name) — `docker restart <name>` against a container the
//      user has explicitly confirmed in the UI. Surfaces the same error
//      diagnoser as kokoro-lifecycle for clearer messages on Docker hiccups.
//
// Side-effect-free aside from the explicit write phase in install() and the
// docker call in restartHermes(). installPreview is safe to call on every
// settings panel mount; both install + restartHermes are idempotent.

import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  IPC,
  type AgentPushInstallPreview,
  type AgentPushInstallResult,
  type HermesContainerCandidate,
  type RestartHermesResult,
} from './preload-api';
import { applyPatch, getSettings } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const ENV_KEYS = ['FACEPLATE_API_KEY', 'FACEPLATE_HOME_CHANNEL', 'FACEPLATE_PORT'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const DEFAULT_ENV_VALUES: Record<EnvKey, () => string> = {
  FACEPLATE_API_KEY: () => crypto.randomBytes(32).toString('hex'),
  FACEPLATE_HOME_CHANNEL: () => 'default',
  FACEPLATE_PORT: () => '8643',
};

// ── path resolution ─────────────────────────────────────────────────────

function expand(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const fromSettings = getSettings().hermes.config_path;
  if (fromSettings && fromSettings.endsWith('config.yaml')) {
    return path.dirname(expand(fromSettings));
  }
  return path.join(os.homedir(), '.hermes');
}

function envPath(): string {
  return path.join(hermesHome(), '.env');
}

function pluginDstDir(): string {
  return path.join(hermesHome(), 'plugins', 'faceplate');
}

/** Resolve the bundled plugin source — packaged builds expose it via
 *  `process.resourcesPath/hermes-plugin/faceplate`; dev walks up from
 *  the Quasar build dir to the repo's hermes-plugin/ folder. */
function pluginSrcDir(): string {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'hermes-plugin', 'faceplate');
    if (existsSync(packaged)) return packaged;
  }
  // Dev: app/dist/electron/... → ../../../hermes-plugin/faceplate
  const dev = path.resolve(currentDir, '..', '..', '..', 'hermes-plugin', 'faceplate');
  if (existsSync(dev)) return dev;
  // Last-ditch: alongside the running script (shouldn't happen but keeps
  // the error message useful by pointing at a real-looking path).
  return path.join(currentDir, 'hermes-plugin', 'faceplate');
}

// ── .env parsing ────────────────────────────────────────────────────────

/** Loose .env parser. Picks up `KEY=value` lines, ignores comments and
 *  malformed lines. We don't try to evaluate shell expansion — `${FOO}` in
 *  values comes back literal. That's fine for our three vars (none of which
 *  the user would reasonably nest). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes — both single and double, single layer.
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

function readEnvFile(): { text: string; vars: Record<string, string> } {
  const p = envPath();
  if (!existsSync(p)) return { text: '', vars: {} };
  try {
    const text = readFileSync(p, 'utf8');
    return { text, vars: parseEnvFile(text) };
  } catch {
    return { text: '', vars: {} };
  }
}

/** Append-only env writer: never rewrites existing lines, just appends a
 *  block of new `KEY=value` lines at the end. Preserves comments, ordering,
 *  and any custom values the user set by hand. */
function appendEnvVars(currentText: string, additions: Array<{ key: string; value: string }>): string {
  if (additions.length === 0) return currentText;
  const trail = currentText.endsWith('\n') || currentText === '' ? '' : '\n';
  const banner = '\n# Added by HermesAgent Faceplate (Hermes Pings setup)';
  const body = additions.map(({ key, value }) => `${key}=${value}`).join('\n');
  return `${currentText}${trail}${banner}\n${body}\n`;
}

function atomicWrite(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.faceplate.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, targetPath);
}

// ── docker discovery ───────────────────────────────────────────────────

interface DockerRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runDocker(args: string[], timeoutMs = 15_000): Promise<DockerRun> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('docker', args);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* noop */
      }
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Heuristic match: anything whose name OR image contains a known Hermes
 *  string, ranked so 'hermes-agent' / 'tirith' beat looser matches. */
const HERMES_MATCHERS: Array<{ pattern: RegExp; priority: number }> = [
  { pattern: /hermes-agent/i, priority: 100 },
  { pattern: /\btirith\b/i, priority: 90 },
  { pattern: /\bhermes\b/i, priority: 50 },
];

function scoreMatch(name: string, image: string): number {
  const haystack = `${name} ${image}`;
  let best = 0;
  for (const { pattern, priority } of HERMES_MATCHERS) {
    if (pattern.test(haystack) && priority > best) best = priority;
  }
  return best;
}

async function findHermesContainer(): Promise<HermesContainerCandidate | null> {
  let result: DockerRun;
  try {
    // Format: "name<TAB>image<TAB>state". `-a` so we also pick up stopped
    // containers — they're valid restart targets if the user previously
    // stopped Hermes.
    result = await runDocker(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}']);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const candidates: Array<{ name: string; image: string; state: string; score: number }> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    const [name, image, state] = cleaned.split('\t');
    if (!name || !image) continue;
    const score = scoreMatch(name, image);
    if (score === 0) continue;
    candidates.push({ name, image, state: state ?? 'unknown', score });
  }
  if (candidates.length === 0) return null;
  // Prefer running > paused > exited, then by score, then by name (stable).
  candidates.sort((a, b) => {
    const stateRank = (s: string): number => (s === 'running' ? 2 : s === 'paused' ? 1 : 0);
    const sa = stateRank(a.state);
    const sb = stateRank(b.state);
    if (sa !== sb) return sb - sa;
    if (a.score !== b.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  const pick = candidates[0];
  if (!pick) return null;
  return {
    name: pick.name,
    image: pick.image,
    state: pick.state,
    ambiguous: candidates.length > 1,
  };
}

function diagnoseDockerError(action: string, r: DockerRun): string {
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
  const tail = (r.stderr || r.stdout).trim().slice(-280);
  if (blob.includes('cannot connect to the docker daemon') || blob.includes('is the docker daemon running')) {
    return `${action} failed: Docker daemon is not running. Start Docker Desktop and retry.\n\nRaw error: ${tail}`;
  }
  if (blob.includes('no such container')) {
    return `${action} failed: no container by that name exists anymore. Check \`docker ps -a\`.\n\nRaw error: ${tail}`;
  }
  if (blob.includes('permission denied') && blob.includes('docker.sock')) {
    return `${action} failed: you're not in the docker group. Linux: \`sudo usermod -aG docker $USER\`, log out, log back in.\n\nRaw error: ${tail}`;
  }
  return `${action} failed (exit ${r.code}): ${tail}`;
}

// ── preview ────────────────────────────────────────────────────────────

export async function previewInstall(): Promise<AgentPushInstallPreview> {
  const src = pluginSrcDir();
  const dst = pluginDstDir();
  const pluginAlreadyPresent = existsSync(path.join(dst, 'plugin.yaml'));

  const env = readEnvFile();
  const additions = ENV_KEYS.map((key) => {
    const existing = env.vars[key];
    return {
      key,
      value: existing ?? DEFAULT_ENV_VALUES[key](),
      already_set: existing !== undefined,
    };
  });

  const hermes = await findHermesContainer();

  return {
    plugin_src: src,
    plugin_dst: dst,
    plugin_already_present: pluginAlreadyPresent,
    env_path: envPath(),
    env_additions: additions,
    hermes_container: hermes,
  };
}

// ── install ────────────────────────────────────────────────────────────

export async function installPlugin(): Promise<AgentPushInstallResult> {
  const steps: string[] = [];
  try {
    const src = pluginSrcDir();
    if (!existsSync(path.join(src, 'plugin.yaml'))) {
      throw new Error(`bundled plugin source not found at ${src}`);
    }
    const dst = pluginDstDir();
    const dstParent = path.dirname(dst);
    if (!existsSync(dstParent)) mkdirSync(dstParent, { recursive: true });

    // Copy the folder. Using cpSync with recursive — overwrites in place,
    // which is what we want when the user re-runs install after a Faceplate
    // update bumped the adapter.
    cpSync(src, dst, { recursive: true });
    steps.push(`Copied plugin → ${dst}`);

    // Append missing env vars. We re-read the file inside install() (rather
    // than trusting the preview) so a user editing .env between preview +
    // confirm doesn't trigger a duplicate-key write.
    const env = readEnvFile();
    const toAppend: Array<{ key: string; value: string }> = [];
    let apiKey = env.vars.FACEPLATE_API_KEY ?? '';
    for (const key of ENV_KEYS) {
      if (env.vars[key] === undefined) {
        const value = DEFAULT_ENV_VALUES[key]();
        toAppend.push({ key, value });
        if (key === 'FACEPLATE_API_KEY') apiKey = value;
      }
    }
    if (toAppend.length > 0) {
      atomicWrite(envPath(), appendEnvVars(env.text, toAppend));
      const keys = toAppend.map((a) => a.key).join(', ');
      steps.push(`Added to ~/.hermes/.env: ${keys}`);
    } else {
      steps.push('All env vars already present in ~/.hermes/.env (left untouched).');
    }
    if (!apiKey) {
      // Belt-and-braces — should be unreachable since we either read or
      // generate FACEPLATE_API_KEY above. Surface a clear error if it
      // happens so the user doesn't end up with mismatched settings.
      throw new Error('failed to determine FACEPLATE_API_KEY (env read returned empty)');
    }

    // Mirror the key into Faceplate's settings so the WebSocket can connect.
    // Also flip `enabled` on by default — the user clicked Install, they
    // clearly want this on. They can still toggle it off via the existing
    // switch above the button.
    applyPatch({
      agent_push: {
        api_key: apiKey,
        enabled: true,
      },
    });
    steps.push('Wrote FACEPLATE_API_KEY into Faceplate settings and enabled Hermes Pings.');

    // Best-effort container lookup. UI uses this to drive the confirm-and-
    // restart dialog; null is a valid outcome (user runs Hermes bare-metal
    // or under a name we don't recognise).
    const hermes = await findHermesContainer();
    if (hermes) {
      steps.push(`Next: restart "${hermes.name}" so the plugin loader picks up the new folder.`);
    } else {
      steps.push('Next: restart Hermes manually so the plugin loader picks up the new folder.');
    }

    return { ok: true, api_key: apiKey, hermes_container: hermes, steps };
  } catch (err) {
    return {
      ok: false,
      api_key: '',
      hermes_container: null,
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── restart ────────────────────────────────────────────────────────────

export async function restartHermesContainer(name: string): Promise<RestartHermesResult> {
  // Reject obvious garbage early — docker is forgiving but we don't want
  // to spawn a process for empty strings or paths.
  if (!name || /[\s/\\]/.test(name)) {
    return { ok: false, container: name, error: 'invalid container name' };
  }
  let run: DockerRun;
  try {
    run = await runDocker(['restart', name], 60_000);
  } catch (err) {
    return {
      ok: false,
      container: name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (run.code !== 0) {
    return { ok: false, container: name, error: diagnoseDockerError('docker restart', run) };
  }
  return { ok: true, container: name };
}

// ── IPC registration ───────────────────────────────────────────────────

export function registerAgentPushInstallerIpc(): void {
  ipcMain.handle(IPC.agentPush.installPreview, () => previewInstall());
  ipcMain.handle(IPC.agentPush.install, () => installPlugin());
  ipcMain.handle(IPC.agentPush.restartHermes, (_evt, name: string) =>
    restartHermesContainer(name),
  );
}
