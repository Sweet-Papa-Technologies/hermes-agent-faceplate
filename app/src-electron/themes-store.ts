// User-supplied themes live under `<userData>/themes/<id>/manifest.json`.
// Built-in themes are bundled by Vite and resolved entirely in the renderer
// (see src/themes/loader.ts). This module only exposes IPC for the user
// directory; if it's empty (Phase 1 state), `list()` returns nothing.

import { app, ipcMain } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { IPC, type ThemeListing } from './preload-api';
import {
  AvatarThemeManifest,
  type AvatarThemeManifest as AvatarThemeManifestT,
} from '../src/themes/manifest-schema';

function userThemesDir(): string {
  return path.join(app.getPath('userData'), 'themes');
}

function listUserThemes(): ThemeListing[] {
  const dir = userThemesDir();
  if (!existsSync(dir)) return [];
  const entries: ThemeListing[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const manifestPath = path.join(full, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: string; name?: string };
      entries.push({
        id: raw.id ?? name,
        name: raw.name ?? name,
        builtin: false,
      });
    } catch {
      // ignore unreadable theme dirs
    }
  }
  return entries;
}

function loadUserTheme(id: string): AvatarThemeManifestT {
  const dir = path.join(userThemesDir(), id);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Theme not found: ${id}`);
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  // Inline any external SVG sources at IPC time so the renderer never reads
  // disk directly.
  const layers = (raw.layers ?? {}) as Record<string, { src?: string; inline_svg?: string }>;
  for (const layer of Object.values(layers)) {
    if (layer.src && !layer.inline_svg) {
      const filePath = path.join(dir, layer.src);
      if (existsSync(filePath)) {
        layer.inline_svg = readFileSync(filePath, 'utf8');
      }
    }
  }

  const parsed = AvatarThemeManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`Theme manifest invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function registerThemesIpc(): void {
  ipcMain.handle(IPC.themes.list, () => listUserThemes());
  ipcMain.handle(IPC.themes.load, (_evt, id: string) => loadUserTheme(id));
}
