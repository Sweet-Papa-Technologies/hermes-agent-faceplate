// Settings persistence — single source of truth on disk, owned by the main
// process. Renderer reads/writes via IPC (see preload-api.ts).
//
// File layout: `<userData>/settings.yaml`. Created with full defaults on first
// run. On every read we re-validate via the Zod schema; missing keys get
// defaults, unknown keys are dropped.

import { app, ipcMain, BrowserWindow } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import {
  FaceplateSettings,
  defaultSettings,
  type FaceplateSettings as FaceplateSettingsT,
} from '../src/stores/settings-schema';
import { IPC, type DeepPartial } from './preload-api';

const SETTINGS_FILENAME = 'settings.yaml';

let cached: FaceplateSettingsT | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadFromDisk(): FaceplateSettingsT {
  const file = settingsPath();
  if (!existsSync(file)) {
    const defaults = defaultSettings();
    writeToDisk(defaults);
    return defaults;
  }
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = YAML.parse(raw) ?? {};
    const result = FaceplateSettings.safeParse(parsed);
    if (result.success) return result.data;
    console.warn('[settings] validation failed, applying defaults for invalid keys:', result.error.flatten());
    // Salvage what we can by re-parsing with defaults filled in by the schema.
    return defaultSettings();
  } catch (err) {
    console.error('[settings] failed to read settings.yaml:', err);
    return defaultSettings();
  }
}

function writeToDisk(s: FaceplateSettingsT): void {
  const file = settingsPath();
  ensureDir(file);
  writeFileSync(file, YAML.stringify(s), 'utf8');
}

export function getSettings(): FaceplateSettingsT {
  if (!cached) cached = loadFromDisk();
  return cached;
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== 'object' || base === null) return patch as T;
  if (Array.isArray(base)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(patch as object)) {
    const bv = (base as Record<string, unknown>)[key];
    const pv = (patch as Record<string, unknown>)[key];
    if (
      typeof bv === 'object' &&
      bv !== null &&
      !Array.isArray(bv) &&
      typeof pv === 'object' &&
      pv !== null &&
      !Array.isArray(pv)
    ) {
      out[key] = deepMerge(bv, pv as DeepPartial<typeof bv>);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out as T;
}

function broadcastChange(s: FaceplateSettingsT, changedKeys: string[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.settings.changed, { settings: s, keys: changedKeys });
    }
  }
  for (const cb of mainListeners) {
    try {
      cb(s, changedKeys);
    } catch (err) {
      console.warn('[settings] main listener threw:', err);
    }
  }
}

type SettingsListener = (settings: FaceplateSettingsT, changedKeys: string[]) => void;
const mainListeners = new Set<SettingsListener>();

/** Subscribe (in main process) to settings changes. Returns an unsubscribe
 * function. Used by long-lived bridges (agent-push, etc.) that need to
 * react to user-toggled settings without polling. */
export function onSettingsChanged(cb: SettingsListener): () => void {
  mainListeners.add(cb);
  return () => mainListeners.delete(cb);
}

function flattenChangedKeys(
  before: unknown,
  after: unknown,
  prefix = '',
  acc: string[] = [],
): string[] {
  if (before === after) return acc;
  if (
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    before === null ||
    after === null
  ) {
    acc.push(prefix.replace(/^\./, ''));
    return acc;
  }
  const keys = new Set([
    ...Object.keys(before as object),
    ...Object.keys(after as object),
  ]);
  for (const k of keys) {
    flattenChangedKeys(
      (before as Record<string, unknown>)[k],
      (after as Record<string, unknown>)[k],
      `${prefix}.${k}`,
      acc,
    );
  }
  return acc;
}

export function applyPatch(patch: DeepPartial<FaceplateSettingsT>): FaceplateSettingsT {
  const before = getSettings();
  const merged = deepMerge(before, patch);
  const validated = FaceplateSettings.parse(merged);
  cached = validated;
  writeToDisk(validated);
  const changed = flattenChangedKeys(before, validated);
  broadcastChange(validated, changed);
  return validated;
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settings.get, () => getSettings());
  ipcMain.handle(IPC.settings.set, (_evt, patch: DeepPartial<FaceplateSettingsT>) =>
    applyPatch(patch),
  );
}

export function settingsFilePath(): string {
  return settingsPath();
}
