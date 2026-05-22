// App-managed Hermes Agent lifecycle (M3).
//
// Ports scripts/start-hermes.sh into the app so the GUI can offer a
// one-click "Install Hermes Agent" instead of the user running the script.
// Mirrors kokoro-lifecycle.ts (status / ensure / stop). The script stays
// for CLI/Make users; this module is the canonical path for the app.
//
// Engine-conditional run args (the critical M0 spike finding):
//   - Podman: --userns=keep-id:uid=10000,gid=10000 so the in-container
//     `hermes` user (uid 10000) maps to the host user → bind-mounted
//     ~/.hermes files stay host-owned and readable. Plus
//     --add-host=host.docker.internal:host-gateway (Podman 5.x aliases it
//     natively; this is defensive for older Podman).
//   - Docker: NO extra flags — byte-identical to what start-hermes.sh runs
//     today (which the user confirmed works), so Docker behavior is
//     unchanged.
//
// Only supported "bare-metal" story is bring-your-own-Hermes: if the user
// already runs Hermes (any engine/name), status() still reports reachable
// via the /v1/health probe and the GUI lets them skip the install.

import { app, ipcMain, net } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runEngine,
  engineAvailable,
  ensureRuntime,
  containerEngine,
  type EngineRun,
} from './container-runtime';
import { ensureHermesApiEnv, readEnvFile, hermesHome } from './hermes-env';
import {
  IPC,
  type HermesAgentStatus,
  type HermesAgentInstallResult,
  type HermesInstallProgress,
} from './preload-api';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const CONTAINER_NAME = 'hermes-personal';
const BASE_IMAGE = 'docker.io/nousresearch/hermes-agent:latest';
const LOCAL_TAG = 'hermes-faceplate:browser';
const BIND = '127.0.0.1';
const API_PORT = 8642;
const PLUGIN_PORT = 8643;

const READY_TIMEOUT_MS = 120_000; // gateway boot is slower than kokoro
const POLL_INTERVAL_MS = 1_500;
const PULL_TIMEOUT_MS = 900_000; // base image is ~5.5 GB (M0)
const BUILD_TIMEOUT_MS = 600_000;
// `podman run -d` returns once the container is created — but on macOS the
// Podman VM + `--userns=keep-id` re-maps the bind-mounted ~/.hermes to the
// container user, which on a large data dir is O(files) and can take
// minutes on first run. 60 s was far too tight (the reported timeout bug).
const RUN_TIMEOUT_MS = 600_000;
const RM_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 8_000;

function baseUrl(): string {
  return `http://${BIND}:${API_PORT}`;
}

/** Bundled Dockerfile dir: packaged → resourcesPath/scripts/hermes;
 *  dev → repo scripts/hermes. (Packaging it is an M6 concern.) */
function dockerfileDir(): string | null {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'scripts', 'hermes');
    if (existsSync(path.join(packaged, 'Dockerfile'))) return packaged;
  }
  const dev = path.resolve(currentDir, '..', '..', '..', 'scripts', 'hermes');
  if (existsSync(path.join(dev, 'Dockerfile'))) return dev;
  return null;
}

function diagnose(action: string, r: EngineRun): string {
  const engine = containerEngine();
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
  const tail = (r.stderr || r.stdout).trim().slice(-280);
  if (
    blob.includes('cannot connect to the docker daemon') ||
    blob.includes('is the docker daemon running')
  ) {
    return `${action} failed: the Docker daemon is not running. Start Docker Desktop and retry.\n\n${tail}`;
  }
  if (blob.includes('no space left on device')) {
    return `${action} failed: out of disk space. The Hermes image is ~6 GB — free space (M0 recommends ≥20 GB) and retry.\n\n${tail}`;
  }
  if (blob.includes('credential') || blob.includes('gcloud.auth')) {
    return `${action} failed: a broken docker credsStore blocked an anonymous pull. (container-runtime isolates Podman from this; if you're on Docker, fix ~/.docker/config.json.)\n\n${tail}`;
  }
  return `${action} failed (${engine} exit ${r.code}): ${tail}`;
}

async function containerState(): Promise<'running' | 'exited' | 'missing'> {
  try {
    const r = await runEngine(
      ['inspect', '--format', '{{.State.Status}}', CONTAINER_NAME],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );
    if (r.code !== 0) return 'missing';
    return r.stdout.trim() === 'running' ? 'running' : 'exited';
  } catch {
    return 'missing';
  }
}

async function imageBuilt(): Promise<boolean> {
  try {
    const r = await runEngine(['image', 'inspect', LOCAL_TAG], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    return r.code === 0;
  } catch {
    return false;
  }
}

function envKey(): string {
  return readEnvFile().vars.API_SERVER_KEY ?? '';
}

async function reachable(): Promise<boolean> {
  const key = envKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_500);
  try {
    const res = await net.fetch(`${baseUrl()}/v1/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pollReady(onTick?: (elapsedSec: number) => void): Promise<boolean> {
  const start = Date.now();
  const deadline = start + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    onTick?.(Math.round((Date.now() - start) / 1000));
  }
  return false;
}

export async function getHermesAgentStatus(): Promise<HermesAgentStatus> {
  const engine = containerEngine();
  const avail = await engineAvailable();
  if (!avail) {
    return {
      engine,
      engine_available: false,
      container_state: 'missing',
      reachable: await reachable(), // bring-your-own-Hermes may still answer
      base_url: baseUrl(),
      image_built: false,
    };
  }
  const [state, built, reach] = await Promise.all([
    containerState(),
    imageBuilt(),
    reachable(),
  ]);
  return {
    engine,
    engine_available: true,
    container_state: state,
    reachable: reach,
    base_url: baseUrl(),
    image_built: built,
  };
}

/** Engine-conditional `run` args. Docker = exactly start-hermes.sh today. */
function runArgs(image: string): string[] {
  const engine = containerEngine();
  const args = ['run', '-d', '--name', CONTAINER_NAME, '--restart', 'unless-stopped'];
  if (engine === 'podman') {
    // M0-validated: maps in-container hermes (uid 10000) → host user.
    args.push('--userns=keep-id:uid=10000,gid=10000');
    args.push('--add-host=host.docker.internal:host-gateway');
  }
  args.push(
    '-p', `${BIND}:${API_PORT}:${API_PORT}`,
    '-p', `${BIND}:${PLUGIN_PORT}:${PLUGIN_PORT}`,
    '-v', `${hermesHome()}:/opt/data`,
    image,
    'gateway', 'run',
  );
  return args;
}

export async function installHermesAgent(
  onProgress?: (p: HermesInstallProgress) => void,
): Promise<HermesAgentInstallResult> {
  const steps: string[] = [];
  const send = (p: HermesInstallProgress): void => {
    try {
      onProgress?.(p);
    } catch {
      /* a dead renderer must not break the install */
    }
  };
  // Milestone — recorded in the result AND appended to the renderer list.
  const report = (message: string): void => {
    steps.push(message);
    send({ kind: 'step', message });
  };
  // Transient sub-progress — only updates the single "current step" label
  // in the UI (never appended), so streaming thousands of pull/build lines
  // can't bloat the list or thrash layout.
  const reportStatus = (message: string): void => {
    send({ kind: 'status', message });
  };
  // Turn a child's raw stdout/stderr into a throttled, single-line status.
  // podman pull/build/machine-init redraw with '\r' and emit many chunks
  // very fast; we take the latest non-empty segment, cap its length, and
  // forward at most ~3×/sec so the IPC + renderer stay smooth.
  const makeOutputSink = (): ((chunk: string) => void) => {
    let last = 0;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      if (pending === null) return;
      last = Date.now();
      const msg = pending;
      pending = null;
      reportStatus(msg);
    };
    return (chunk: string): void => {
      const seg = chunk
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (!seg) return;
      pending = seg.length > 180 ? `${seg.slice(0, 179)}…` : seg;
      const since = Date.now() - last;
      if (since >= 350) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, 350 - since);
      }
    };
  };
  try {
    report('Checking container engine…');
    await ensureRuntime(makeOutputSink());
    report(`Container engine: ${containerEngine()}`);

    const pre = await getHermesAgentStatus();
    if (pre.reachable) {
      report('Hermes already reachable at /v1/health — nothing to do.');
      return { ok: true, steps, status: pre };
    }
    if (!pre.engine_available) {
      return {
        ok: false,
        steps,
        status: pre,
        error:
          'No container engine available. Install Podman (or start Docker) from Settings → Container Engine first.',
      };
    }

    const apiEnv = ensureHermesApiEnv(API_PORT);
    report('Ensured API_SERVER_* in ~/.hermes/.env (existing values preserved).');

    // Base image
    const haveBase = await runEngine(['image', 'inspect', BASE_IMAGE], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    }).then((r) => r.code === 0).catch(() => false);
    if (!haveBase) {
      report(`Pulling ${BASE_IMAGE} (~5.5 GB — this can take several minutes)…`);
      const pull = await runEngine(['pull', BASE_IMAGE], {
        timeoutMs: PULL_TIMEOUT_MS,
        onOutput: makeOutputSink(),
      });
      if (pull.code !== 0) throw new Error(diagnose('pull', pull));
      report('Base image pulled.');
    } else {
      report('Base image already present.');
    }

    // Browser-augmented image
    let runImage = LOCAL_TAG;
    const dfDir = dockerfileDir();
    if (!dfDir) {
      runImage = BASE_IMAGE;
      report('No bundled Dockerfile found — running base image (browser tools disabled).');
    } else {
      report(`Building ${LOCAL_TAG} (chromium + agent-browser; cached after first run)…`);
      const build = await runEngine(
        ['build', '--build-arg', `HERMES_BASE=${BASE_IMAGE}`, '-t', LOCAL_TAG, dfDir],
        { timeoutMs: BUILD_TIMEOUT_MS, onOutput: makeOutputSink() },
      );
      if (build.code !== 0) throw new Error(diagnose('build', build));
      report('Browser image ready.');
    }

    // Recreate (matches start-hermes.sh: rm -f then run, so env/config
    // changes are picked up). ~/.hermes is a bind mount → data preserved.
    if ((await containerState()) !== 'missing') {
      await runEngine(['rm', '-f', CONTAINER_NAME], { timeoutMs: RM_TIMEOUT_MS });
      report(`Removed existing "${CONTAINER_NAME}" (data volume preserved).`);
    }
    report(
      'Creating container… (first run re-maps the ~/.hermes volume to the ' +
        'container user — on a large data dir this can take a few minutes)',
    );
    const run = await runEngine(runArgs(runImage), { timeoutMs: RUN_TIMEOUT_MS });
    if (run.code !== 0) throw new Error(diagnose('run', run));
    report(`Started "${CONTAINER_NAME}" on ${BIND}:${API_PORT}.`);

    report(`Waiting for /v1/health (up to ${READY_TIMEOUT_MS / 1000}s)…`);
    if (
      !(await pollReady((sec) =>
        reportStatus(`Waiting for Hermes gateway to answer… ${sec}s`),
      ))
    ) {
      throw new Error(
        `Container started but /v1/health didn't answer in ${READY_TIMEOUT_MS / 1000}s. Check \`${containerEngine()} logs ${CONTAINER_NAME}\`.`,
      );
    }
    report('Hermes Agent is up.');
    // Surface the key so the wizard/Connection panel can use it.
    report(`API key is in ~/.hermes/.env (API_SERVER_KEY, ${apiEnv.key.slice(0, 6)}…).`);

    return { ok: true, steps, status: await getHermesAgentStatus() };
  } catch (err) {
    return {
      ok: false,
      steps,
      status: await getHermesAgentStatus().catch(() => null),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function stopHermesAgent(): Promise<HermesAgentStatus> {
  const avail = await engineAvailable();
  if (avail && (await containerState()) !== 'missing') {
    await runEngine(['rm', '-f', CONTAINER_NAME], { timeoutMs: RM_TIMEOUT_MS }).catch(
      (e) => console.warn('[hermes] stop failed:', e),
    );
  }
  return getHermesAgentStatus();
}

export function registerHermesLifecycleIpc(): void {
  ipcMain.handle(IPC.hermes.agentStatus, () => getHermesAgentStatus());
  ipcMain.handle(IPC.hermes.agentInstall, (event) =>
    // Stream progress back to the window that started the install.
    installHermesAgent((p) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.hermes.agentInstallProgress, p);
      }
    }),
  );
  ipcMain.handle(IPC.hermes.agentStop, () => stopHermesAgent());
}
