// Multi-conversation manager — talks to the main process for disk
// persistence, holds the current list + active conversation, and brokers
// switches between them.
//
// Sister store to `useConversationStore` (which is the in-memory live
// turn buffer). The conversation-syncer in `boot/conversation-syncer.ts`
// glues the two together: when active changes here, it reloads the
// singular store; when the singular store finalizes a turn, the syncer
// snapshots and saves through this store.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type {
  ConversationFile,
  ConversationManifestEntry,
} from './conversation-types';

export const useConversationsStore = defineStore('conversations', () => {
  const list = ref<ConversationManifestEntry[]>([]);
  const active = ref<ConversationFile | null>(null);
  const loading = ref<boolean>(false);
  const search = ref<string>('');
  const searchResults = ref<ConversationManifestEntry[] | null>(null);

  const activeId = computed<string | null>(() => active.value?.id ?? null);
  const activeSessionId = computed<string | null>(() => active.value?.hermes_session_id ?? null);
  const activeLastResponseId = computed<string | null>(() =>
    active.value?.hermes_last_response_id ?? null,
  );
  const visibleList = computed(() => searchResults.value ?? list.value);

  function setActiveSessionIdLocal(sid: string | null): void {
    if (!active.value) return;
    if (active.value.hermes_session_id === sid) return;
    active.value = { ...active.value, hermes_session_id: sid };
  }

  function setActiveLastResponseIdLocal(id: string | null): void {
    if (!active.value) return;
    if (active.value.hermes_last_response_id === id) return;
    active.value = { ...active.value, hermes_last_response_id: id };
  }

  /** Apply a broadcast from main (came from another window's switch). */
  function applyActiveChanged(msg: {
    id: string | null;
    conversation: ConversationFile | null;
  }): void {
    active.value = msg.conversation;
  }

  /** Apply a broadcast from main (a save/title-change/delete in any window).
   * Updates `active` in-place if the changed conversation IS the active one,
   * so live transcript views reflect the latest persisted state. */
  function applyChanged(msg: {
    id: string;
    conversation: ConversationFile | null;
  }): void {
    if (msg.conversation && active.value?.id === msg.id) {
      active.value = msg.conversation;
    }
  }

  async function refreshList(): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    list.value = await fp.conversations.list();
  }

  async function refreshActive(): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    active.value = await fp.conversations.getActive();
  }

  async function load(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      await Promise.all([refreshList(), refreshActive()]);
    } finally {
      loading.value = false;
    }
  }

  async function createNew(title?: string): Promise<ConversationFile | null> {
    const fp = window.faceplate;
    if (!fp) return null;
    const c = await fp.conversations.create(title);
    active.value = c;
    await refreshList();
    return c;
  }

  async function switchTo(id: string): Promise<ConversationFile | null> {
    const fp = window.faceplate;
    if (!fp) return null;
    const c = await fp.conversations.setActive(id);
    if (c) active.value = c;
    await refreshList();
    return c;
  }

  async function updateTitle(id: string, title: string): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    await fp.conversations.updateTitle(id, title);
    if (active.value?.id === id) active.value = { ...active.value, title };
    await refreshList();
  }

  async function archive(id: string): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    await fp.conversations.archive(id);
    await refreshList();
    await refreshActive();
  }

  async function remove(id: string): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    await fp.conversations.delete(id);
    await refreshList();
    await refreshActive();
  }

  async function exportMarkdown(id: string): Promise<string> {
    const fp = window.faceplate;
    if (!fp) return '';
    return fp.conversations.exportMarkdown(id);
  }

  async function runSearch(query: string): Promise<void> {
    search.value = query;
    if (!query.trim()) {
      searchResults.value = null;
      return;
    }
    const fp = window.faceplate;
    if (!fp) return;
    searchResults.value = await fp.conversations.search(query);
  }

  function clearSearch(): void {
    search.value = '';
    searchResults.value = null;
  }

  /** Push the latest turns + session id to disk. Called by the syncer on
   * every finalize; safe to call frequently — main writes atomically.
   * `lastResponseId` is sticky: pass undefined to leave as-is, null to clear,
   * a string to set. */
  async function saveActive(
    turns: import('./conversation-types').PersistedTurn[],
    sessionId: string | null,
    lastResponseId?: string | null,
  ): Promise<void> {
    const fp = window.faceplate;
    if (!fp) {
      console.log('[convsave] saveActive: no faceplate bridge, skipping');
      return;
    }
    // Defence-in-depth: structured-clone over contextBridge will throw
    // "An object could not be cloned" if any caller hands us a Vue reactive
    // Proxy. JSON-roundtrip strips the proxies — disk persistence is JSON
    // anyway, so there is no information loss.
    const safeTurns = JSON.parse(JSON.stringify(turns)) as typeof turns;
    console.log(`[convsave] saveActive IPC SEND: turns.len=${safeTurns.length} roles=${JSON.stringify(safeTurns.map((t) => t.role))} → main`);
    const updated = await fp.conversations.saveActive(safeTurns, sessionId, lastResponseId);
    console.log(`[convsave] saveActive IPC REPLY: updated=${updated ? `id=${updated.id.slice(0, 8)} turns=${updated.turns.length}` : 'null'}`);
    if (updated) active.value = updated;
  }

  return {
    list,
    active,
    activeId,
    activeSessionId,
    loading,
    search,
    searchResults,
    visibleList,
    load,
    createNew,
    switchTo,
    updateTitle,
    archive,
    remove,
    exportMarkdown,
    runSearch,
    clearSearch,
    saveActive,
    refreshList,
    refreshActive,
    setActiveSessionIdLocal,
    setActiveLastResponseIdLocal,
    activeLastResponseId,
    applyActiveChanged,
    applyChanged,
  };
});
