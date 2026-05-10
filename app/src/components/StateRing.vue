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

/* The "racer" element exists in every theme's ring.svg — a stroke with
 * pathLength=100 + stroke-dasharray="18 82" so 18% of the perimeter is
 * visible. We animate stroke-dashoffset to make that visible segment
 * travel along the perimeter, which works for circles AND rounded rects
 * (or any closed path). The racer is hidden by default; only the
 * thinking state reveals it. Old approach (CSS rotate on the whole ring)
 * spun rectangular halos around their center which looked broken. */
.state-ring :deep(.state-ring-racer) {
  opacity: 0;
  transition: opacity 200ms ease;
}

/* idle: gentle 4s breathe */
.state-idle {
  animation: ring-pulse 4000ms ease-in-out infinite;
}

/* listening: faster 2s breathe */
.state-listening {
  animation: ring-pulse 2000ms ease-in-out infinite;
}

/* thinking: a comet head races around the perimeter — shape-aware,
 * unlike a transform: rotate which only looks right on circles. */
.state-thinking :deep(.state-ring-racer) {
  opacity: 1;
  animation: ring-race 1800ms linear infinite;
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

/* Negative offset = clockwise travel. With pathLength=100 set on the
 * racer element, going from 0 to -100 traces the full perimeter exactly
 * once per iteration. */
@keyframes ring-race {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: -100; }
}

@keyframes ring-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-4px); }
  75%      { transform: translateX(4px); }
}
</style>
