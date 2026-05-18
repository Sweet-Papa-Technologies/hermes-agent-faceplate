// Sidecar Docker lifecycle. Resolves the right compose file for the user's
// chosen image variant, runs `docker compose up -d`/`down`, and surfaces a
// health-poll status to the renderer.
//
// Compose files live under `sidecar/` in dev and under
// `process.resourcesPath/sidecar/` in packaged builds (see
// quasar.config.ts → electron.builder.extraResources).

import { app, ipcMain, net } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEngineCompose, ensureRuntime } from './container-runtime';
import { IPC, type SidecarStatus, type SidecarBuild } from './preload-api';
import { getSettings } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

function composeFileFor(image: SidecarBuild): string {
  const filename = `compose.${image}.yml`;
  // Packaged: resourcesPath/sidecar/compose.<image>.yml
  if (app.isPackaged) {
    const resourceCandidate = path.join(process.resourcesPath, 'sidecar', filename);
    if (existsSync(resourceCandidate)) return resourceCandidate;
  }
  // Dev: walk up from the .quasar build dir to the repo root.
  const dev = path.resolve(currentDir, '..', '..', '..', 'sidecar', filename);
  if (existsSync(dev)) return dev;
  // Last-ditch fallback: alongside the running script.
  return path.join(currentDir, 'sidecar', filename);
}

/** The old `runCompose` always injected FACEPLATE_API_KEY for *both* `up`
 *  and `down`; preserve that exactly (the compose file references it, and
 *  `down` resolving it avoids a compose interpolation warning). No timeout
 *  — matching the old runner, since `up` may pull large images. */
function composeEnv(): Record<string, string> {
  return { FACEPLATE_API_KEY: getSettings().speech.sidecar_token || '' };
}

export async function startSidecar(): Promise<void> {
  const settings = getSettings();
  if (settings.speech.sidecar_mode !== 'bundled') {
    throw new Error(`Sidecar lifecycle only applies to 'bundled' mode (current: ${settings.speech.sidecar_mode}).`);
  }
  const composeFile = composeFileFor(settings.speech.sidecar_image);
  if (!existsSync(composeFile)) {
    throw new Error(`Compose file not found: ${composeFile}`);
  }
  // No-op under docker (M1 default) / Linux; ensures the podman VM is up.
  await ensureRuntime();
  const result = await runEngineCompose(['up', '-d'], composeFile, { env: composeEnv() });
  if (result.code !== 0) {
    throw new Error(`docker compose up failed (exit ${result.code}): ${result.stderr.slice(0, 240)}`);
  }
}

export async function stopSidecar(): Promise<void> {
  const settings = getSettings();
  const composeFile = composeFileFor(settings.speech.sidecar_image);
  if (!existsSync(composeFile)) return;
  await runEngineCompose(['down'], composeFile, { env: composeEnv() });
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
