// Artifact Pinia store — list + active artifact across windows.
//
// Mirrors the conversations store pattern: a fast list (manifest projection)
// plus an `active` artifact that the canvas window focuses on.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type {
  Artifact,
  ArtifactIndexEntry,
  CreateArtifactInput,
} from './artifact-types';

export const useArtifactsStore = defineStore('artifacts', () => {
  const list = ref<ArtifactIndexEntry[]>([]);
  const active = ref<Artifact | null>(null);
  const loading = ref<boolean>(false);

  // Derived: artifacts grouped by conversation, for the panel gallery.
  const byConversation = computed<Map<string, ArtifactIndexEntry[]>>(() => {
    const m = new Map<string, ArtifactIndexEntry[]>();
    for (const a of list.value) {
      const arr = m.get(a.conversation_id) ?? [];
      arr.push(a);
      m.set(a.conversation_id, arr);
    }
    return m;
  });

  async function refreshList(filter?: { conversation_id?: string }): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    list.value = await fp.artifacts.list(filter);
  }

  async function load(id: string): Promise<Artifact | null> {
    const fp = window.faceplate;
    if (!fp) return null;
    return fp.artifacts.get(id);
  }

  async function setActive(id: string | null): Promise<void> {
    if (!id) {
      active.value = null;
      return;
    }
    const fp = window.faceplate;
    if (!fp) return;
    active.value = await fp.artifacts.get(id);
  }

  async function loadIfMissing(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      await refreshList();
    } finally {
      loading.value = false;
    }
  }

  async function create(input: CreateArtifactInput): Promise<Artifact | null> {
    const fp = window.faceplate;
    if (!fp) return null;
    const a = await fp.artifacts.create(input);
    await refreshList();
    return a;
  }

  async function remove(id: string): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    await fp.artifacts.delete(id);
    if (active.value?.id === id) active.value = null;
    await refreshList();
  }

  async function download(id: string): Promise<{ ok: boolean; path?: string }> {
    const fp = window.faceplate;
    if (!fp) return { ok: false };
    return fp.artifacts.download(id);
  }

  async function openInCanvas(id?: string): Promise<void> {
    const fp = window.faceplate;
    if (!fp) return;
    await fp.artifacts.openCanvas(id);
  }

  /** Apply a broadcast from main: handle create, update, and delete cases. */
  function applyChanged(msg: { id: string; artifact: Artifact | null }): void {
    if (!msg.artifact) {
      // Delete
      list.value = list.value.filter((a) => a.id !== msg.id);
      if (active.value?.id === msg.id) active.value = null;
      return;
    }
    // Create or update — merge into list as the index entry, refresh active
    // if it's the same id.
    const a = msg.artifact;
    const entry: ArtifactIndexEntry = {
      id: a.id,
      conversation_id: a.conversation_id,
      turn_id: a.turn_id,
      kind: a.kind,
      ...(a.title ? { title: a.title } : {}),
      created_at: a.created_at,
      preview: a.body_storage === 'inline' ? a.body.slice(0, 80) : (a.title ?? ''),
    };
    const i = list.value.findIndex((x) => x.id === a.id);
    if (i >= 0) list.value[i] = entry;
    else list.value = [entry, ...list.value];
    if (active.value?.id === a.id) active.value = a;
  }

  return {
    list,
    active,
    loading,
    byConversation,
    refreshList,
    load,
    setActive,
    loadIfMissing,
    create,
    remove,
    download,
    openInCanvas,
    applyChanged,
  };
});
