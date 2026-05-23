// In-app installer for the Hermes-side `faceplate` plugin — for the case
// where Hermes runs on this machine, so `~/.hermes` is on the local
// filesystem. For a remote Hermes, run `setup/hermes-faceplate-plugin.sh`
// on the Hermes host instead (same effect), then point Settings at the
// printed WebSocket URL.
//
// Two IPC handlers the Settings UI drives:
//
//   1. installPreview() — read-only inspection. Reports which files would
//      change and which env vars would be appended. UI shows this in a
//      confirm dialog before any disk write.
//
//   2. install() — copy `hermes-plugin/faceplate/` into `~/.hermes/plugins/`,
//      append FACEPLATE_API_KEY / FACEPLATE_HOME_CHANNEL / FACEPLATE_PORT to
//      `~/.hermes/.env` IFF they're missing (never clobber a user-set value),
//      generate a random key if one wasn't already there, and write that key
//      into Faceplate's own settings so the WebSocket can connect. The user
//      then restarts their Hermes gateway so the plugin loader picks it up.
//
// Side-effect-free aside from the explicit write phase in install().
// installPreview is safe to call on every settings panel mount; install is
// idempotent.

import { app, ipcMain } from 'electron';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  hermesHome,
  envPath,
  readEnvFile,
  appendEnvVars,
  atomicWrite,
} from './hermes-env';
import {
  IPC,
  type AgentPushInstallPreview,
  type AgentPushInstallResult,
} from './preload-api';
import { applyPatch } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const ENV_KEYS = ['FACEPLATE_API_KEY', 'FACEPLATE_HOME_CHANNEL', 'FACEPLATE_PORT'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const DEFAULT_ENV_VALUES: Record<EnvKey, () => string> = {
  FACEPLATE_API_KEY: () => crypto.randomBytes(32).toString('hex'),
  FACEPLATE_HOME_CHANNEL: () => 'default',
  FACEPLATE_PORT: () => '8643',
};

// ── path resolution ─────────────────────────────────────────────────────
// hermesHome() / envPath() / .env helpers now live in hermes-env.ts (shared
// with hermes-lifecycle.ts). Plugin-source/dest resolution stays here.

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

// .env parse/read/append/atomicWrite now imported from hermes-env.ts.

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

  return {
    plugin_src: src,
    plugin_dst: dst,
    plugin_already_present: pluginAlreadyPresent,
    env_path: envPath(),
    env_additions: additions,
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

    steps.push(
      'Next: restart your Hermes gateway so the plugin loader picks up the new folder.',
    );

    return { ok: true, api_key: apiKey, steps };
  } catch (err) {
    return {
      ok: false,
      api_key: '',
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── IPC registration ───────────────────────────────────────────────────

export function registerAgentPushInstallerIpc(): void {
  ipcMain.handle(IPC.agentPush.installPreview, () => previewInstall());
  ipcMain.handle(IPC.agentPush.install, () => installPlugin());
}
