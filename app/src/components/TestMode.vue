<template>
  <div class="test-mode">
    <Avatar />
    <div class="test-mode-hud">
      <div>state: <strong>{{ agent.state }}</strong></div>
      <div>viseme: <strong>{{ theme.currentViseme }}</strong></div>
      <div class="test-mode-grid">
        <button v-for="s in states" :key="s" :class="{ active: agent.state === s }" @click="forceState(s)">
          {{ s }}
        </button>
      </div>
      <div class="test-mode-grid">
        <button v-for="v in visemes" :key="v" :class="{ active: theme.currentViseme === v }" @click="forceViseme(v)">
          {{ v }}
        </button>
      </div>
      <button class="test-mode-toggle" @click="toggleAuto">
        {{ auto ? 'Stop auto-cycle' : 'Start auto-cycle' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import Avatar from './Avatar.vue';
import { useAgentStore } from '../stores/agent';
import { useThemeStore } from '../stores/theme';
import type { AgentState, VisemeCode } from '../hermes/event-schema';

const agent = useAgentStore();
const theme = useThemeStore();

const states: AgentState[] = ['idle', 'listening', 'thinking', 'speaking', 'error'];
const visemes: VisemeCode[] = ['A', 'B', 'C', 'D', 'E', 'F', 'X'];

const auto = ref(true);
let stateIdx = 0;
let visemeIdx = 0;
let stateTimer: number | null = null;
let visemeTimer: number | null = null;

function forceState(s: AgentState) {
  agent.transition(s, 'test-mode');
}

function forceViseme(v: VisemeCode) {
  theme.setViseme(v);
}

function startAuto() {
  stopAuto();
  stateTimer = window.setInterval(() => {
    stateIdx = (stateIdx + 1) % states.length;
    const next = states[stateIdx]!;
    // Bypass FSM constraints in test mode by hopping through 'idle'.
    if (next !== agent.state) {
      const ok = agent.transition(next, 'auto-cycle');
      if (!ok) {
        agent.transition('idle', 'auto-cycle-reset');
        agent.transition(next, 'auto-cycle');
      }
    }
  }, 2000);
  visemeTimer = window.setInterval(() => {
    visemeIdx = (visemeIdx + 1) % visemes.length;
    theme.setViseme(visemes[visemeIdx]!);
  }, 250);
}

function stopAuto() {
  if (stateTimer !== null) window.clearInterval(stateTimer);
  if (visemeTimer !== null) window.clearInterval(visemeTimer);
  stateTimer = null;
  visemeTimer = null;
}

function toggleAuto() {
  auto.value = !auto.value;
  if (auto.value) startAuto();
  else stopAuto();
}

onMounted(() => {
  if (auto.value) startAuto();
});

onBeforeUnmount(() => {
  stopAuto();
});
</script>

<style scoped>
.test-mode {
  width: 100%;
  height: 100vh;
  display: grid;
  grid-template-columns: 1fr 320px;
  background: #0e0e10;
  color: #f3f3f3;
}

.test-mode-hud {
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font: 13px/1.4 system-ui, sans-serif;
}

.test-mode-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.test-mode-grid button,
.test-mode-toggle {
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  cursor: pointer;
}

.test-mode-grid button.active {
  background: #22c55e;
  color: #08160c;
  border-color: transparent;
}

.test-mode-toggle {
  background: rgba(255, 255, 255, 0.1);
  margin-top: auto;
}
</style>
