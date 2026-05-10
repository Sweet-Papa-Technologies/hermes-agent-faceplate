// Caption + transcript ring buffer. The captions overlay reads from `current`
// (the assistant's in-flight message); the transcript history shows the last
// N turns for the captions panel + conversation transcript view.
//
// History is also persisted to disk via the multi-conversation store
// (conversations.ts) — this store remains the in-memory live view, and the
// syncer pushes turns to disk on every finalize.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { PersistedToolCall, PersistedTurn, TurnRole } from './conversation-types';

export type { TurnRole, PersistedToolCall };

export interface Turn {
  id: string;
  role: TurnRole;
  text: string;
  ts: number;
  /** Streaming-in: text is being appended; toggled false once final. */
  streaming: boolean;
  /** Tool calls fired during this turn, in arrival order. */
  tool_calls?: PersistedToolCall[];
  /** IDs of artifacts attached to this turn (canvas-renderable rich content). */
  artifact_ids?: string[];
  /** Optional model identifier (populated when known). */
  model?: string;
  /** Populated if this turn ended in an error. */
  error?: string;
}

const MAX_HISTORY = 200;

export const useConversationStore = defineStore('conversation', () => {
  const history = ref<Turn[]>([]);
  const currentTurn = ref<Turn | null>(null);
  const captionsVisible = ref<boolean>(true);

  function toggleCaptions(): void {
    captionsVisible.value = !captionsVisible.value;
  }

  function startTurn(role: TurnRole, id?: string): Turn {
    const turn: Turn = {
      id: id ?? crypto.randomUUID(),
      role,
      text: '',
      ts: Date.now(),
      streaming: true,
    };
    if (currentTurn.value) finalizeTurn();
    currentTurn.value = turn;
    return turn;
  }

  function appendDelta(delta: string): void {
    if (!currentTurn.value) return;
    currentTurn.value = { ...currentTurn.value, text: currentTurn.value.text + delta };
  }

  function setText(text: string): void {
    if (!currentTurn.value) return;
    currentTurn.value = { ...currentTurn.value, text };
  }

  function attachArtifact(id: string): void {
    if (!currentTurn.value) return;
    const ids = currentTurn.value.artifact_ids ? [...currentTurn.value.artifact_ids] : [];
    if (!ids.includes(id)) ids.push(id);
    currentTurn.value = { ...currentTurn.value, artifact_ids: ids };
  }

  function appendToolCall(tc: PersistedToolCall): void {
    // If we're between turns when a tool call fires (rare; tool calls outside
    // an assistant turn), park it on a synthetic assistant turn so it gets
    // persisted with the conversation.
    if (!currentTurn.value) {
      currentTurn.value = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: '',
        ts: Date.now(),
        streaming: true,
        tool_calls: [tc],
      };
      return;
    }
    const calls = currentTurn.value.tool_calls ? [...currentTurn.value.tool_calls] : [];
    // Coalesce: if the last entry was a 'started' for the same tool name and
    // this is a completion/failure, mutate it in place rather than pushing a
    // duplicate. Keeps the rendered transcript clean.
    const last = calls[calls.length - 1];
    if (
      last &&
      last.tool === tc.tool &&
      last.status === 'started' &&
      tc.status !== 'started'
    ) {
      calls[calls.length - 1] = { ...last, ...tc };
    } else {
      calls.push(tc);
    }
    currentTurn.value = { ...currentTurn.value, tool_calls: calls };
  }

  function finalizeTurn(): void {
    if (!currentTurn.value) return;
    const finalised: Turn = { ...currentTurn.value, streaming: false };
    history.value = [...history.value.slice(-(MAX_HISTORY - 1)), finalised];
    currentTurn.value = null;
  }

  function clear(): void {
    history.value = [];
    currentTurn.value = null;
  }

  /** Replace the whole history (called when switching conversations). */
  function loadFromPersisted(turns: PersistedTurn[]): void {
    history.value = turns.map((t) => ({
      id: t.id,
      role: t.role,
      text: t.text,
      ts: t.ts,
      streaming: false,
      ...(t.tool_calls ? { tool_calls: t.tool_calls } : {}),
      ...(t.artifact_ids ? { artifact_ids: t.artifact_ids } : {}),
      ...(t.model ? { model: t.model } : {}),
      ...(t.error ? { error: t.error } : {}),
    }));
    currentTurn.value = null;
  }

  /** Snapshot the full turn list for disk persistence. Includes the in-flight
   * turn (so partial assistant replies are recoverable on a clean shutdown). */
  function snapshotForPersist(): PersistedTurn[] {
    const list: PersistedTurn[] = history.value.map((t) => ({
      id: t.id,
      role: t.role,
      text: t.text,
      ts: t.ts,
      ...(t.tool_calls ? { tool_calls: t.tool_calls } : {}),
      ...(t.artifact_ids ? { artifact_ids: t.artifact_ids } : {}),
      ...(t.model ? { model: t.model } : {}),
      ...(t.error ? { error: t.error } : {}),
    }));
    if (currentTurn.value && currentTurn.value.text.length > 0) {
      const t = currentTurn.value;
      list.push({
        id: t.id,
        role: t.role,
        text: t.text,
        ts: t.ts,
        ...(t.tool_calls ? { tool_calls: t.tool_calls } : {}),
        ...(t.artifact_ids ? { artifact_ids: t.artifact_ids } : {}),
      });
    }
    return list;
  }

  const captionText = computed(() => currentTurn.value?.text ?? '');
  const lastAssistant = computed(() =>
    [...history.value].reverse().find((t) => t.role === 'assistant'),
  );

  return {
    history,
    currentTurn,
    captionsVisible,
    startTurn,
    appendDelta,
    setText,
    appendToolCall,
    attachArtifact,
    finalizeTurn,
    clear,
    loadFromPersisted,
    snapshotForPersist,
    toggleCaptions,
    captionText,
    lastAssistant,
  };
});
