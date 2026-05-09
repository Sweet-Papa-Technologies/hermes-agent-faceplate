// Sidecar Docker lifecycle. Resolves the right compose file for the user's
// chosen image variant, runs `docker compose up -d`/`down`, and surfaces a
// health-poll status to the renderer.
//
// Compose files live under `sidecar/` in dev and under
// `process.resourcesPath/sidecar/` in packaged builds (see
// quasar.config.ts → electron.builder.extraResources).

import { app, ipcMain, net } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IPC, type SidecarStatus, type SidecarBuild } from './preload-api';
import { getSettings } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

interface ComposeRun {
  code: number;
  stdout: string;
  stderr: string;
}

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

function runCompose(args: string[], composeFile: string): Promise<ComposeRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', '-f', composeFile, ...args], {
      env: {
        ...process.env,
        FACEPLATE_API_KEY: getSettings().speech.sidecar_token || '',
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
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
  const result = await runCompose(['up', '-d'], composeFile);
  if (result.code !== 0) {
    throw new Error(`docker compose up failed (exit ${result.code}): ${result.stderr.slice(0, 240)}`);
  }
}

export async function stopSidecar(): Promise<void> {
  const settings = getSettings();
  const composeFile = composeFileFor(settings.speech.sidecar_image);
  if (!existsSync(composeFile)) return;
  await runCompose(['down'], composeFile);
}

export async function sidecarStatus(): Promise<SidecarStatus> {
  const settings = getSettings();
  const url = `${settings.speech.sidecar_url.replace(/\/+$/, '')}/health`;
  const headers: Record<string, string> = {};
  if (settings.speech.sidecar_token) {
    headers.authorization = `Bearer ${settings.speech.sidecar_token}`;
  }
  try {
    const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { up: false, build: settings.speech.sidecar_image };
    const json = (await res.json()) as {
      models?: Record<string, 'loaded' | 'idle' | 'error'>;
      ram_mb?: number;
      version?: string;
    };
    return {
      up: true,
      build: settings.speech.sidecar_image,
      ...(json.models ? { models: json.models } : {}),
      ...(json.ram_mb !== undefined ? { ram_mb: json.ram_mb } : {}),
      ...(json.version ? { version: json.version } : {}),
    };
  } catch {
    return { up: false, build: settings.speech.sidecar_image };
  }
}

export function registerSidecarIpc(): void {
  ipcMain.handle(IPC.sidecar.status, () => sidecarStatus());
  ipcMain.handle(IPC.sidecar.start, () => startSidecar());
  ipcMain.handle(IPC.sidecar.stop, () => stopSidecar());
}
