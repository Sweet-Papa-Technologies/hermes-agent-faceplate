<template>
  <g
    v-if="ringSvg"
    :style="{ color: tint }"
    :class="['state-ring', `state-${state}`]"
    v-html="ringSvg"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useAgentStore } from '../stores/agent';
import { useThemeStore } from '../stores/theme';

const agent = useAgentStore();
const theme = useThemeStore();
const { state } = storeToRefs(agent);

const ringSvg = computed(() => theme.loaded?.svg.state_ring ?? '');
const tint = computed(() => theme.ringTintFor(state.value));
</script>

<style scoped>
.state-ring {
  transition: color 280ms ease;
}

/* idle: gentle 4s breathe */
.state-idle {
  animation: ring-pulse 4000ms ease-in-out infinite;
}

/* listening: faster 2s breathe */
.state-listening {
  animation: ring-pulse 2000ms ease-in-out infinite;
}

/* thinking: rotating arc */
.state-thinking {
  transform-origin: 128px 128px;
  animation: ring-spin 1800ms linear infinite;
}

/* speaking: hold steady — mouth carries the motion */
.state-speaking {
  opacity: 1;
}

/* error: short shake */
.state-error {
  animation: ring-shake 200ms ease-in-out 1;
}

@keyframes ring-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}

@keyframes ring-spin {
  from { transform: rotate(0); }
  to   { transform: rotate(360deg); }
}

@keyframes ring-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-4px); }
  75%      { transform: translateX(4px); }
}
</style>
