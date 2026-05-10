// Artifact persistence — sibling layer to conversation-store.ts.
//
// One file per artifact for two reasons:
//   1. Binary bodies (image bytes, video) need their own files, not a JSON
//      blob. Each artifact gets its own directory; the directory holds the
//      manifest plus any body-on-disk.
//   2. Atomic write per artifact — modifying one doesn't risk corrupting
//      others.
//
// The top-level manifest.json is a fast projection so the canvas + panel
// gallery views can render lists without reading every body.

import { app, ipcMain, BrowserWindow, dialog } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { IPC } from './preload-api';
import type {
  Artifact,
  ArtifactIndexEntry,
  ArtifactKind,
  ArtifactsManifest,
  CreateArtifactInput,
} from '../src/stores/artifact-types';

const DIR = 'artifacts';
const MANIFEST = 'manifest.json';
const BODY_FILE = 'body.bin';

function rootDir(): string { return path.join(app.getPath('userData'), DIR); }
function manifestPath(): string { return path.join(rootDir(), MANIFEST); }
function artifactDir(id: string): string { return path.join(rootDir(), id); }
function artifactManifestPath(id: string): string {
  return path.join(artifactDir(id), MANIFEST);
}
function artifactBodyPath(id: string, ext: string): string {
  return path.join(artifactDir(id), `body${ext}`);
}

function ensureRoot(): void {
  if (!existsSync(rootDir())) mkdirSync(rootDir(), { recursive: true });
}

function atomicWrite(file: string, content: string | Buffer): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

let cachedManifest: ArtifactsManifest | null = null;

function loadManifestFromDisk(): ArtifactsManifest {
  ensureRoot();
  if (!existsSync(manifestPath())) {
    const fresh: ArtifactsManifest = { schema_version: 1, artifacts: [] };
    atomicWrite(manifestPath(), JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const raw = readFileSync(manifestPath(), 'utf8');
    const json = JSON.parse(raw) as ArtifactsManifest;
    json.artifacts ??= [];
    json.schema_version = 1;
    return json;
  } catch (err) {
    console.error('[artifacts] manifest unreadable, rebuilding:', err);
    const fresh: ArtifactsManifest = { schema_version: 1, artifacts: [] };
    atomicWrite(manifestPath(), JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveManifest(m: ArtifactsManifest): void {
  cachedManifest = m;
  atomicWrite(manifestPath(), JSON.stringify(m, null, 2));
}

function getManifest(): ArtifactsManifest {
  if (!cachedManifest) cachedManifest = loadManifestFromDisk();
  return cachedManifest;
}

function loadArtifact(id: string): Artifact | null {
  const file = artifactManifestPath(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Artifact;
  } catch (err) {
    console.error(`[artifacts] failed to read ${id}:`, err);
    return null;
  }
}

function saveArtifact(a: Artifact): void {
  atomicWrite(artifactManifestPath(a.id), JSON.stringify(a, null, 2));
}

function previewFor(a: Artifact): string {
  switch (a.kind) {
    case 'text':
    case 'code':
    case 'chart':
    case 'diagram':
      return a.body_storage === 'inline'
        ? a.body.replace(/\s+/g, ' ').trim().slice(0, 80)
        : '';
    default:
      return a.title ?? '';
  }
}

function indexEntry(a: Artifact): ArtifactIndexEntry {
  return {
    id: a.id,
    conversation_id: a.conversation_id,
    turn_id: a.turn_id,
    kind: a.kind,
    ...(a.title ? { title: a.title } : {}),
    created_at: a.created_at,
    preview: previewFor(a),
  };
}

function syncManifestEntry(a: Artifact): void {
  const m = getManifest();
  const next = indexEntry(a);
  const existing = m.artifacts.findIndex((e) => e.id === a.id);
  if (existing >= 0) m.artifacts[existing] = next;
  else m.artifacts.push(next);
  m.artifacts.sort((x, y) => y.created_at - x.created_at);
  saveManifest(m);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// Best-effort extension from a mime type. Falls back to .bin so the file
// at least exists on disk; renderer uses the `mime` field anyway.
function extFor(mime: string | undefined, kind: ArtifactKind): string {
  if (mime) {
    const m = mime.toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
    if (m.includes('png')) return '.png';
    if (m.includes('gif')) return '.gif';
    if (m.includes('webp')) return '.webp';
    if (m.includes('svg')) return '.svg';
    if (m.includes('mp4')) return '.mp4';
    if (m.includes('webm')) return '.webm';
    if (m.includes('mov')) return '.mov';
    if (m.includes('mp3')) return '.mp3';
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('wav')) return '.wav';
    if (m.includes('gltf')) return '.gltf';
    if (m.includes('glb')) return '.glb';
  }
  if (kind === 'image') return '.png';
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.bin';
}

// ─────────────────────────── public API ──────────────────────────────────

export function listArtifacts(filter?: { conversation_id?: string }): ArtifactIndexEntry[] {
  const all = getManifest().artifacts;
  if (filter?.conversation_id) {
    return all.filter((a) => a.conversation_id === filter.conversation_id);
  }
  return all;
}

export function getArtifact(id: string): Artifact | null {
  return loadArtifact(id);
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  ensureRoot();
  const id = crypto.randomUUID();
  const now = Date.now();
  const dir = artifactDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let bodyStored = input.body;
  if (input.body_storage === 'file') {
    // Body comes in as base64 from the renderer; decode and write to disk.
    // The artifact's persisted `body` field holds the relative filename.
    const ext = extFor(input.mime, input.kind);
    const filename = `body${ext}`;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.body, 'base64');
    } catch (err) {
      console.error(`[artifacts] failed to decode base64 body for ${id}:`, err);
      bytes = Buffer.alloc(0);
    }
    atomicWrite(path.join(dir, filename), bytes);
    bodyStored = filename;
  }

  const a: Artifact = {
    id,
    conversation_id: input.conversation_id,
    turn_id: input.turn_id ?? null,
    kind: input.kind,
    ...(input.title ? { title: input.title } : {}),
    created_at: now,
    body_storage: input.body_storage,
    body: bodyStored,
    ...(input.mime ? { mime: input.mime } : {}),
    ...(input.language ? { language: input.language } : {}),
    source: input.source ?? 'inline',
  };
  saveArtifact(a);
  syncManifestEntry(a);
  broadcast(IPC.artifacts.changed, { id, artifact: a });
  return a;
}

export function deleteArtifact(id: string): void {
  const m = getManifest();
  m.artifacts = m.artifacts.filter((a) => a.id !== id);
  saveManifest(m);
  const dir = artifactDir(id);
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (err) { console.warn(`[artifacts] delete dir ${dir}:`, err); }
  }
  broadcast(IPC.artifacts.changed, { id, artifact: null });
}

/**
 * Resolve a usable URL for the renderer. For 'file'-stored bodies this is a
 * `file://` URL; for 'url' it's the original URL; for 'inline' there is no
 * URL — the renderer uses the inline body directly.
 */
export function resolveBodyUrl(a: Artifact): string | null {
  if (a.body_storage === 'url') return a.body;
  if (a.body_storage === 'file') {
    const p = path.join(artifactDir(a.id), a.body);
    return `file://${p}`;
  }
  return null;
}

/**
 * Read the raw bytes of a file-stored artifact body. Used by the download
 * handler when the user picks a save location.
 */
function readBodyBytes(a: Artifact): Buffer | null {
  if (a.body_storage === 'inline') return Buffer.from(a.body, 'utf8');
  if (a.body_storage === 'file') {
    const p = path.join(artifactDir(a.id), a.body);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }
  return null;
}

function suggestedFilename(a: Artifact): string {
  const slug = (a.title ?? a.kind).replace(/[^\w.-]+/g, '_').slice(0, 60);
  if (a.body_storage === 'file') return a.body.startsWith('body') ? `${slug}${path.extname(a.body)}` : a.body;
  if (a.kind === 'code') {
    const ext = a.language ? `.${a.language}` : '.txt';
    return `${slug}${ext}`;
  }
  if (a.kind === 'chart') return `${slug}.json`;
  if (a.kind === 'diagram') return `${slug}.mmd`;
  return `${slug}.txt`;
}

async function downloadArtifact(id: string, parentWin: BrowserWindow | null): Promise<{ ok: boolean; path?: string }> {
  const a = loadArtifact(id);
  if (!a) return { ok: false };
  if (a.body_storage === 'url') {
    // Renderer should open externally instead — but we'll let main also try.
    return { ok: false };
  }
  const bytes = readBodyBytes(a);
  if (!bytes) return { ok: false };
  const result = await dialog.showSaveDialog(parentWin ?? undefined as unknown as BrowserWindow, {
    defaultPath: suggestedFilename(a),
    title: 'Download artifact',
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    writeFileSync(result.filePath, bytes);
    return { ok: true, path: result.filePath };
  } catch (err) {
    console.error('[artifacts] download write failed:', err);
    return { ok: false };
  }
}

export function registerArtifactsIpc(): void {
  ipcMain.handle(IPC.artifacts.list, (_e, filter?: { conversation_id?: string }) =>
    listArtifacts(filter),
  );
  ipcMain.handle(IPC.artifacts.get, (_e, id: string) => getArtifact(id));
  ipcMain.handle(IPC.artifacts.create, (_e, input: CreateArtifactInput) => createArtifact(input));
  ipcMain.handle(IPC.artifacts.delete, (_e, id: string) => deleteArtifact(id));
  ipcMain.handle(IPC.artifacts.resolveUrl, (_e, id: string) => {
    const a = loadArtifact(id);
    return a ? resolveBodyUrl(a) : null;
  });
  ipcMain.handle(IPC.artifacts.download, (evt, id: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    return downloadArtifact(id, win);
  });
}
