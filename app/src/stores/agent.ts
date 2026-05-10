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

/**
 * What the agent is currently doing — surfaced to the user during long
 * pauses so a Qwen3-style "1-minute reasoning, no visible tokens" silence
 * doesn't look like a hang. Cleared as soon as the assistant starts
 * emitting visible message text (captions take over from there).
 */
export interface AgentActivity {
  /** Short human-readable label, e.g. "Thinking", "Loading skill", "Calling tool". */
  label: string;
  /** Optional secondary detail, e.g. tool name. */
  detail?: string;
  /** Material icon name; used for the activity badge. */
  icon?: string;
  /** Monotonic ts so we can do "stale > N ms → hide" if events stop flowing. */
  ts: number;
}

export const useAgentStore = defineStore('agent', () => {
  const state = ref<AgentState>('idle');
  const lastError = ref<{ code: string; message: string } | null>(null);
  const currentTurnId = ref<string | null>(null);
  const activity = ref<AgentActivity | null>(null);
  /**
   * True whenever the renderer holds a live MediaStream from the mic. Drives
   * the hardcoded green-LED indicator on the avatar halo per design §12.1
   * (theme-immutable on purpose).
   */
  const micActive = ref<boolean>(false);

  function setMicActive(active: boolean): void {
    micActive.value = active;
  }

  function setActivity(next: AgentActivity | null): void {
    activity.value = next;
  }

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
    activity,
    micActive,
    transition,
    setError,
    clearError,
    setTurn,
    setMicActive,
    setActivity,
    isIdle,
    isSpeaking,
    isListening,
  };
});
