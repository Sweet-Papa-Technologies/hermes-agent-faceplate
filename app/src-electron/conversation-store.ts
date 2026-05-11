// Conversation persistence — single source of truth on disk, owned by main.
//
// Layout:
//   <userData>/conversations/manifest.json     — index + active_id pointer
//   <userData>/conversations/<id>.json         — one file per conversation
//   <userData>/conversations/archive/<id>.json — soft-deleted (archived)
//
// Design notes:
//   - Atomic writes: write-to-tmp, rename. Crash mid-write keeps the previous
//     good copy.
//   - The manifest is a fast-loading projection of every conversation's
//     header (title, preview, last_used_at) so the panel can render the
//     conversation list without reading dozens of files. Per-conversation
//     bodies are read on demand.
//   - In-flight turns are written on every `finalizeTurn` from the renderer
//     (one disk write per finalize). Saving the WHOLE turns array each time
//     is wasteful but simple and reliable for typical conversation sizes
//     (tens to low hundreds of turns).

import { app, ipcMain, BrowserWindow } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { IPC } from './preload-api';
import type {
  ConversationFile,
  ConversationManifest,
  ConversationManifestEntry,
  PersistedTurn,
} from '../src/stores/conversation-types';

const DIR = 'conversations';
const ARCHIVE = 'archive';
const MANIFEST = 'manifest.json';

function dirPath(): string { return path.join(app.getPath('userData'), DIR); }
function archivePath(): string { return path.join(dirPath(), ARCHIVE); }
function manifestPath(): string { return path.join(dirPath(), MANIFEST); }
function convFilePath(id: string): string { return path.join(dirPath(), `${id}.json`); }

function ensureDirs(): void {
  if (!existsSync(dirPath())) mkdirSync(dirPath(), { recursive: true });
  if (!existsSync(archivePath())) mkdirSync(archivePath(), { recursive: true });
}

function atomicWrite(file: string, content: string): void {
  ensureDirs();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

let cachedManifest: ConversationManifest | null = null;

function loadManifestFromDisk(): ConversationManifest {
  ensureDirs();
  if (!existsSync(manifestPath())) {
    const fresh: ConversationManifest = {
      schema_version: 1,
      active_id: null,
      conversations: [],
    };
    atomicWrite(manifestPath(), JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const raw = readFileSync(manifestPath(), 'utf8');
    const json = JSON.parse(raw) as ConversationManifest;
    json.conversations ??= [];
    if (json.active_id === undefined) json.active_id = null;
    json.schema_version = 1;
    return json;
  } catch (err) {
    console.error('[conversations] manifest unreadable, rebuilding:', err);
    const fresh: ConversationManifest = {
      schema_version: 1,
      active_id: null,
      conversations: [],
    };
    atomicWrite(manifestPath(), JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveManifest(m: ConversationManifest): void {
  cachedManifest = m;
  atomicWrite(manifestPath(), JSON.stringify(m, null, 2));
}

export function getManifest(): ConversationManifest {
  if (!cachedManifest) cachedManifest = loadManifestFromDisk();
  return cachedManifest;
}

function loadConversation(id: string): ConversationFile | null {
  const file = convFilePath(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ConversationFile;
  } catch (err) {
    console.error(`[conversations] failed to read ${id}:`, err);
    return null;
  }
}

function saveConversation(c: ConversationFile): void {
  const payload = JSON.stringify(c, null, 2);
  atomicWrite(convFilePath(c.id), payload);
  console.log(`[convsave] disk write: ${convFilePath(c.id)} (${payload.length} bytes, ${c.turns.length} turns, roles=${JSON.stringify(c.turns.map((t) => t.role))})`);
}

function previewFromTurns(turns: PersistedTurn[]): string {
  const last = [...turns].reverse().find((t) => t.text && t.text.trim().length > 0);
  if (!last) return '';
  return last.text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function syncManifestEntry(c: ConversationFile): void {
  const m = getManifest();
  const entry: ConversationManifestEntry = {
    id: c.id,
    title: c.title,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
    preview: previewFromTurns(c.turns),
    turn_count: c.turns.length,
    hermes_session_id: c.hermes_session_id,
  };
  const existing = m.conversations.find((e) => e.id === c.id);
  if (existing) Object.assign(existing, entry);
  else m.conversations.push(entry);
  m.conversations.sort((a, b) => b.last_used_at - a.last_used_at);
  saveManifest(m);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ─────────────────────────── public API ──────────────────────────────────

export function listConversations(): ConversationManifestEntry[] {
  return getManifest().conversations.filter((c) => !c.archived);
}

export function getActiveConversation(): ConversationFile | null {
  const m = getManifest();
  if (!m.active_id) return null;
  return loadConversation(m.active_id);
}

export function createConversation(title?: string): ConversationFile {
  const now = Date.now();
  const id = crypto.randomUUID();
  const c: ConversationFile = {
    schema_version: 1,
    id,
    title: title ?? 'New conversation',
    created_at: now,
    last_used_at: now,
    hermes_session_id: null,
    turns: [],
  };
  saveConversation(c);
  syncManifestEntry(c);
  setActiveConversation(id);
  return c;
}

export function setActiveConversation(id: string): ConversationFile | null {
  const c = loadConversation(id);
  if (!c) return null;
  const m = getManifest();
  m.active_id = id;
  // INTENTIONAL: do NOT touch `c.last_used_at` here. Switching to a
  // conversation in the panel is a navigation, not a content change —
  // bumping the timestamp on every click would re-sort the list and
  // push older conversations toward the bottom for no reason. Only
  // `saveActiveConversation` (a real content write) updates the
  // timestamp + reorders the manifest.
  saveManifest(m);
  broadcast(IPC.conversations.activeChanged, { id, conversation: c });
  return c;
}

export function saveActiveConversation(
  turns: PersistedTurn[],
  sessionId: string | null,
  lastResponseId?: string | null,
): ConversationFile | null {
  const m = getManifest();
  if (!m.active_id) {
    console.log('[convsave] main saveActiveConversation: no active_id → skipping');
    return null;
  }
  const c = loadConversation(m.active_id);
  if (!c) {
    console.log(`[convsave] main saveActiveConversation: failed to load active_id=${m.active_id}`);
    return null;
  }
  const before = c.turns.length;
  c.turns = turns;
  c.last_used_at = Date.now();
  c.hermes_session_id = sessionId;
  // Only update lastResponseId when the caller explicitly passed it (undefined
  // = leave as-is). null = clear (e.g. "new conversation"). string = set.
  if (lastResponseId !== undefined) {
    c.hermes_last_response_id = lastResponseId;
  }
  saveConversation(c);
  syncManifestEntry(c);
  console.log(`[convsave] main saveActiveConversation: id=${m.active_id.slice(0, 8)} turns ${before} → ${turns.length} roles=${JSON.stringify(turns.map((t) => t.role))} session=${sessionId ? sessionId.slice(0, 8) : 'null'}`);
  broadcast(IPC.conversations.changed, { id: c.id, conversation: c });
  return c;
}

export function updateTitle(id: string, title: string): ConversationFile | null {
  const c = loadConversation(id);
  if (!c) return null;
  c.title = title.trim() || c.title;
  saveConversation(c);
  syncManifestEntry(c);
  broadcast(IPC.conversations.changed, { id: c.id, conversation: c });
  return c;
}

export function archiveConversation(id: string): void {
  const m = getManifest();
  const e = m.conversations.find((x) => x.id === id);
  if (e) {
    e.archived = true;
    saveManifest(m);
  }
  ensureDirs();
  const src = convFilePath(id);
  if (existsSync(src)) {
    renameSync(src, path.join(archivePath(), `${id}.json`));
  }
  if (m.active_id === id) {
    const next = listConversations()[0];
    if (next) setActiveConversation(next.id);
    else {
      m.active_id = null;
      saveManifest(m);
      broadcast(IPC.conversations.activeChanged, { id: null, conversation: null });
    }
  }
  broadcast(IPC.conversations.changed, { id, conversation: null });
}

export function deleteConversation(id: string): void {
  const m = getManifest();
  m.conversations = m.conversations.filter((x) => x.id !== id);
  saveManifest(m);
  for (const dir of [dirPath(), archivePath()]) {
    const f = path.join(dir, `${id}.json`);
    if (existsSync(f)) {
      try { unlinkSync(f); } catch (err) { console.warn(`[conversations] delete ${f}:`, err); }
    }
  }
  if (m.active_id === id) {
    const next = listConversations()[0];
    if (next) setActiveConversation(next.id);
    else {
      m.active_id = null;
      saveManifest(m);
      broadcast(IPC.conversations.activeChanged, { id: null, conversation: null });
    }
  }
  broadcast(IPC.conversations.changed, { id, conversation: null });
}

export function searchConversations(query: string): ConversationManifestEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return listConversations();
  const matches: ConversationManifestEntry[] = [];
  for (const e of listConversations()) {
    if (e.title.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q)) {
      matches.push(e);
      continue;
    }
    const c = loadConversation(e.id);
    if (!c) continue;
    if (c.turns.some((t) => t.text.toLowerCase().includes(q))) matches.push(e);
  }
  return matches;
}

export function exportConversationMarkdown(id: string): string {
  const c = loadConversation(id);
  if (!c) return '';
  const lines: string[] = [
    `# ${c.title}`,
    '',
    `_Created ${new Date(c.created_at).toISOString()}_`,
    '',
  ];
  for (const t of c.turns) {
    if (t.role === 'user') lines.push(`**You:** ${t.text}`);
    else if (t.role === 'assistant') lines.push(`**Hermes:** ${t.text}`);
    else lines.push(`> ${t.text}`);
    if (t.tool_calls?.length) {
      for (const tc of t.tool_calls) {
        lines.push(`> 🛠️ \`${tc.tool}\` (${tc.status}) ${tc.args_preview}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Boot-time: ensure there's an active conversation, creating one if needed. */
export function ensureBootstrapConversation(): ConversationFile {
  const active = getActiveConversation();
  if (active) return active;
  const list = listConversations();
  if (list.length > 0) {
    const promoted = setActiveConversation(list[0]!.id);
    if (promoted) return promoted;
  }
  return createConversation();
}

export function loadConversationById(id: string): ConversationFile | null {
  return loadConversation(id);
}

export function registerConversationsIpc(): void {
  ipcMain.handle(IPC.conversations.list, () => listConversations());
  ipcMain.handle(IPC.conversations.load, (_e, id: string) => loadConversation(id));
  ipcMain.handle(IPC.conversations.getActive, () => getActiveConversation());
  ipcMain.handle(IPC.conversations.create, (_e, title?: string) => createConversation(title));
  ipcMain.handle(IPC.conversations.setActive, (_e, id: string) => setActiveConversation(id));
  ipcMain.handle(
    IPC.conversations.saveActive,
    (_e, turns: PersistedTurn[], sessionId: string | null, lastResponseId?: string | null) => {
      console.log(`[convsave] IPC saveActive RECEIVED: turns.len=${Array.isArray(turns) ? turns.length : 'NOT-ARRAY'} roles=${Array.isArray(turns) ? JSON.stringify(turns.map((t) => t?.role)) : '?'} session=${sessionId ? sessionId.slice(0, 8) : 'null'} respId=${lastResponseId === undefined ? '(unset)' : lastResponseId === null ? 'null' : lastResponseId.slice(0, 8)}`);
      return saveActiveConversation(turns, sessionId, lastResponseId);
    },
  );
  ipcMain.handle(
    IPC.conversations.updateTitle,
    (_e, id: string, title: string) => updateTitle(id, title),
  );
  ipcMain.handle(IPC.conversations.archive, (_e, id: string) => archiveConversation(id));
  ipcMain.handle(IPC.conversations.delete, (_e, id: string) => deleteConversation(id));
  ipcMain.handle(IPC.conversations.search, (_e, query: string) => searchConversations(query));
  ipcMain.handle(
    IPC.conversations.exportMarkdown,
    (_e, id: string) => exportConversationMarkdown(id),
  );
}
