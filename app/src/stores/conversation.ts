// Caption + transcript ring buffer. The captions overlay reads from `current`
// (the assistant's in-flight message); the transcript history shows the last
// N turns for the optional "captions panel" view.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export type TurnRole = 'user' | 'assistant' | 'system';

export interface Turn {
  id: string;
  role: TurnRole;
  text: string;
  ts: number;
  /** Streaming-in: text is being appended; toggled false once final. */
  streaming: boolean;
}

const MAX_HISTORY = 100;

export const useConversationStore = defineStore('conversation', () => {
  const history = ref<Turn[]>([]);
  const currentTurn = ref<Turn | null>(null);

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

  const captionText = computed(() => currentTurn.value?.text ?? '');
  const lastAssistant = computed(() =>
    [...history.value].reverse().find((t) => t.role === 'assistant'),
  );

  return {
    history,
    currentTurn,
    startTurn,
    appendDelta,
    setText,
    finalizeTurn,
    clear,
    captionText,
    lastAssistant,
  };
});
