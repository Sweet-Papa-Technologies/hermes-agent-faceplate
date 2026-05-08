// Agent state machine. Five states (idle/listening/thinking/speaking/error).
// Allowed transitions live in the matrix below; invalid transitions are
// dropped with a console warning rather than throwing — we'd rather drift
// back to idle than crash the renderer when the bus emits something unusual.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { AgentState } from '../hermes/event-schema';

const ALLOWED: Record<AgentState, AgentState[]> = {
  idle: ['listening', 'thinking', 'speaking', 'error'],
  listening: ['thinking', 'idle', 'error'],
  thinking: ['speaking', 'idle', 'error'],
  speaking: ['idle', 'thinking', 'error'],
  error: ['idle'],
};

export const useAgentStore = defineStore('agent', () => {
  const state = ref<AgentState>('idle');
  const lastError = ref<{ code: string; message: string } | null>(null);
  const currentTurnId = ref<string | null>(null);

  function transition(to: AgentState, reason?: string): boolean {
    const from = state.value;
    if (from === to) return true;
    if (!ALLOWED[from].includes(to)) {
      console.warn(`[agent] illegal transition ${from} → ${to} (reason: ${reason ?? 'n/a'})`);
      return false;
    }
    state.value = to;
    return true;
  }

  function setError(code: string, message: string): void {
    lastError.value = { code, message };
    transition('error', code);
  }

  function clearError(): void {
    lastError.value = null;
    if (state.value === 'error') transition('idle');
  }

  function setTurn(id: string | null): void {
    currentTurnId.value = id;
  }

  const isIdle = computed(() => state.value === 'idle');
  const isSpeaking = computed(() => state.value === 'speaking');
  const isListening = computed(() => state.value === 'listening');

  return {
    state,
    lastError,
    currentTurnId,
    transition,
    setError,
    clearError,
    setTurn,
    isIdle,
    isSpeaking,
    isListening,
  };
});
