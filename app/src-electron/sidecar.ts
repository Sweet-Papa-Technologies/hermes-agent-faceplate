// Sidecar status probe. The Faceplate connects to a speech sidecar by URL;
// it does not install, build, or supervise one. Get a sidecar by running
// `setup/speech-sidecar.sh`, bringing your own OpenAI-compatible TTS/ASR
// endpoint, or pointing at a remote one — then paste the URL into Settings.
// This module only health-checks whatever URL is configured.

import { ipcMain, net } from 'electron';

import { IPC, type SidecarStatus } from './preload-api';
import { getSettings } from './settings-store';

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
}
