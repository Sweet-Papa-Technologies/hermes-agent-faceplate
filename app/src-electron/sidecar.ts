// Sidecar lifecycle. M4: converted off `docker compose` to a plain
// `run` invocation via the container-runtime abstraction (Decision #5 —
// no dependency on the fragile `podman compose`/`podman-compose`). This is
// a faithful translation of sidecar/compose.*.yml (now retired): same
// container name, ports, named volumes, RO config bind, env, healthcheck,
// restart policy, and CUDA GPU reservation.
//
// The sidecar dir (Dockerfile.* + config.yaml) lives under `sidecar/` in
// dev and `process.resourcesPath/sidecar/` in packaged builds (see
// quasar.config.ts → electron.builder.extraResources).

import { app, ipcMain, net } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEngine, containerEngine, ensureRuntime } from './container-runtime';
import { IPC, type SidecarStatus, type SidecarBuild } from './preload-api';
import { getSettings } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

// Single container name across all variants (matches every compose.*.yml
// `container_name: faceplate-sidecar`).
const CONTAINER_NAME = 'faceplate-sidecar';
const HOST = '127.0.0.1';
const PORT = 8080;

const BUILD_TIMEOUT_MS = 900_000; // first build compiles a heavy Python stack
const RUN_TIMEOUT_MS = 60_000;
const RM_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 8_000;

interface VariantSpec {
  dockerfile: string;
  image: string;
  buildLabel: string;
  startPeriod: string;
  gpu: boolean;
  extraEnv: Record<string, string>;
}

function variantSpec(v: SidecarBuild): VariantSpec {
  if (v === 'cuda') {
    return {
      dockerfile: 'Dockerfile.cuda',
      image: 'ghcr.io/nousresearch/hermes-faceplate-sidecar:cuda',
      buildLabel: 'cuda',
      startPeriod: '30s',
      gpu: true,
      extraEnv: {
        LITERT_LM_BACKEND: 'gpu',
        NVIDIA_VISIBLE_DEVICES: 'all',
        NVIDIA_DRIVER_CAPABILITIES: 'compute,utility',
      },
    };
  }
  if (v === 'cpu-slim') {
    return {
      dockerfile: 'Dockerfile.cpu-slim',
      image: 'ghcr.io/nousresearch/hermes-faceplate-sidecar:cpu-slim',
      buildLabel: 'cpu-slim',
      startPeriod: '20s',
      gpu: false,
      extraEnv: {},
    };
  }
  return {
    dockerfile: 'Dockerfile.cpu',
    image: 'ghcr.io/nousresearch/hermes-faceplate-sidecar:cpu',
    buildLabel: 'cpu',
    startPeriod: '20s',
    gpu: false,
    extraEnv: {},
  };
}

/** Resolve the `sidecar/` dir (Dockerfile.* + config.yaml live here). */
function sidecarDir(): string {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'sidecar');
    if (existsSync(packaged)) return packaged;
  }
  const dev = path.resolve(currentDir, '..', '..', '..', 'sidecar');
  if (existsSync(dev)) return dev;
  return path.join(currentDir, 'sidecar');
}

async function containerExists(): Promise<boolean> {
  try {
    const r = await runEngine(
      ['inspect', '--format', '{{.State.Status}}', CONTAINER_NAME],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Pull-first, build-fallback — matches the prior `compose up` intent
 *  (the prebuilt image lives on ghcr; building is the offline/dev path).
 *  Keeps packaged installs fast without needing the build context, while
 *  still working when the registry is unreachable. */
async function ensureImage(spec: VariantSpec, dir: string): Promise<void> {
  const have = await runEngine(['image', 'inspect', spec.image], {
    timeoutMs: INSPECT_TIMEOUT_MS,
  })
    .then((r) => r.code === 0)
    .catch(() => false);
  if (have) return;

  const pull = await runEngine(['pull', spec.image], { timeoutMs: BUILD_TIMEOUT_MS }).catch(
    () => ({ code: -1, stdout: '', stderr: 'pull threw' }),
  );
  if (pull.code === 0) return;

  const df = path.join(dir, spec.dockerfile);
  if (!existsSync(df)) {
    throw new Error(
      `sidecar image ${spec.image} not local, pull failed, and no Dockerfile to build from at ${df}.`,
    );
  }
  const build = await runEngine(['build', '-f', df, '-t', spec.image, dir], {
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (build.code !== 0) {
    throw new Error(
      `sidecar image build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(-240)}`,
    );
  }
}

function runArgs(spec: VariantSpec, dir: string, apiKey: string): string[] {
  const args = [
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--restart', 'unless-stopped',
    '-p', `${HOST}:${PORT}:${PORT}`,
    '-v', 'faceplate-models:/models',
    '-v', 'faceplate-voices:/voices',
    '-v', 'faceplate-wakewords:/wakewords',
  ];
  // ./config.yaml:/etc/faceplate-sidecar/config.yaml:ro — only if it
  // exists. (Compose let docker auto-create an empty file here; podman
  // errors on a missing bind source, so skipping is both safer and
  // strictly better than the documented compose footgun.)
  const cfg = path.join(dir, 'config.yaml');
  if (existsSync(cfg)) {
    args.push('-v', `${cfg}:/etc/faceplate-sidecar/config.yaml:ro`);
  }
  args.push('-e', `FACEPLATE_API_KEY=${apiKey}`);
  args.push('-e', `FACEPLATE_BUILD=${spec.buildLabel}`);
  for (const [k, val] of Object.entries(spec.extraEnv)) {
    args.push('-e', `${k}=${val}`);
  }
  if (spec.gpu) {
    // compose deploy.resources.reservations.devices: nvidia → engine-
    // specific run flag.
    args.push(containerEngine() === 'podman' ? '--device' : '--gpus');
    args.push(containerEngine() === 'podman' ? 'nvidia.com/gpu=all' : 'all');
  }
  args.push(
    '--health-cmd', `curl -fsS http://127.0.0.1:${PORT}/health`,
    '--health-interval', '30s',
    '--health-timeout', '5s',
    '--health-start-period', spec.startPeriod,
    '--health-retries', '3',
    spec.image,
  );
  return args;
}

export async function startSidecar(): Promise<void> {
  const settings = getSettings();
  if (settings.speech.sidecar_mode !== 'bundled') {
    throw new Error(`Sidecar lifecycle only applies to 'bundled' mode (current: ${settings.speech.sidecar_mode}).`);
  }
  // No-op under docker (M1 default) / Linux; ensures the podman VM is up.
  await ensureRuntime();
  const spec = variantSpec(settings.speech.sidecar_image);
  const dir = sidecarDir();
  await ensureImage(spec, dir);
  if (await containerExists()) {
    await runEngine(['rm', '-f', CONTAINER_NAME], { timeoutMs: RM_TIMEOUT_MS });
  }
  const apiKey = settings.speech.sidecar_token || '';
  const result = await runEngine(runArgs(spec, dir, apiKey), { timeoutMs: RUN_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`sidecar run failed (exit ${result.code}): ${result.stderr.slice(0, 240)}`);
  }
}

export async function stopSidecar(): Promise<void> {
  if (await containerExists()) {
    await runEngine(['rm', '-f', CONTAINER_NAME], { timeoutMs: RM_TIMEOUT_MS }).catch(
      (e) => console.warn('[sidecar] stop failed:', e),
    );
  }
}

export async function sidecarStatus(): Promise<SidecarStatus> {
  const settings = getSettings();
  const baseUrl = settings.speech.sidecar_url.replace(/\/+$/, '');
  const url = `${baseUrl}/health`;
  const headers: Record<string, string> = {};
  if (settings.speech.sidecar_token) {
    headers.authorization = `Bearer ${settings.speech.sidecar_token}`;
  }
  try {
    const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { up: false, build: settings.speech.sidecar_image, url: baseUrl };
    const json = (await res.json()) as {
      models?: Record<string, 'loaded' | 'idle' | 'error'>;
      ram_mb?: number;
      version?: string;
    };
    return {
      up: true,
      build: settings.speech.sidecar_image,
      url: baseUrl,
      ...(json.models ? { models: json.models } : {}),
      ...(json.ram_mb !== undefined ? { ram_mb: json.ram_mb } : {}),
      ...(json.version ? { version: json.version } : {}),
    };
  } catch {
    return { up: false, build: settings.speech.sidecar_image, url: baseUrl };
  }
}

export function registerSidecarIpc(): void {
  ipcMain.handle(IPC.sidecar.status, () => sidecarStatus());
  ipcMain.handle(IPC.sidecar.start, () => startSidecar());
  ipcMain.handle(IPC.sidecar.stop, () => stopSidecar());
}
