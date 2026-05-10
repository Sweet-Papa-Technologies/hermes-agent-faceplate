<template>
  <g class="bunny-fx" aria-hidden="true">
    <!-- State-tinted blush overlay. We layer a translucent gradient on top
         of the static pink blushes in head.svg so the bunny stays cheek-y
         pink at rest but glows warm when thinking, cool when listening,
         green when speaking, red when erroring. -->
    <g class="bunny-blush-fx" :style="{ color: blushColor }" :opacity="blushOpacity">
      <circle class="bunny-blush-glow" cx="110" cy="260" r="42" />
      <circle class="bunny-blush-glow" cx="290" cy="260" r="42" />
    </g>

    <!-- Eye-sparkle pulse: a small twinkle that intensifies on state. -->
    <g class="bunny-sparkle" :style="{ color: sparkleColor }">
      <g class="bunny-sparkle-left">
        <circle cx="148" cy="225" r="2.4" fill="currentColor" />
        <circle cx="148" cy="225" r="1.4" fill="#FFFFFF" />
      </g>
      <g class="bunny-sparkle-right">
        <circle cx="268" cy="225" r="2.4" fill="currentColor" />
        <circle cx="268" cy="225" r="1.4" fill="#FFFFFF" />
      </g>
    </g>

    <!-- Live waveform painted under the bunny's mouth — a small soundwave
         when audio is streaming, fades back to the viseme otherwise. Sized
         so it sits below the lip line and doesn't clash with the smile. -->
    <g v-if="showWave" class="bunny-wave" :style="{ color: waveColor }">
      <path :d="waveformPath"
            fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linejoin="round"
            stroke-linecap="round" opacity="0.85" />
    </g>
  </g>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

import { eventBus } from '../boot/event-bus';
import { useAgentStore } from '../stores/agent';
import { useThemeStore } from '../stores/theme';

const agent = useAgentStore();
const theme = useThemeStore();

// Live samples buffer + freshness window — same pattern as RoboFx.
const FRESH_MS = 250;
const samples = ref<number[]>([]);
const lastSampleTs = ref(0);
const showWave = computed(() => samples.value.length > 0 && Date.now() - lastSampleTs.value < FRESH_MS);

// State → color. Idle stays soft pink (matches the bunny's resting palette);
// other states pick up the theme's ring tint so the cheek glow + the state
// ring always agree.
const blushColor = computed(() => {
  if (agent.state === 'idle') return '#FFB6C1';
  return theme.ringTintFor(agent.state);
});
const blushOpacity = computed(() => {
  switch (agent.state) {
    case 'speaking': return 0.45;
    case 'thinking': return 0.4;
    case 'listening': return 0.35;
    case 'error': return 0.5;
    default: return 0.18;
  }
});

// Sparkles always shimmer; tint matches state for subtle reinforcement.
const sparkleColor = computed(() => {
  if (agent.state === 'speaking') return '#FFD9A0';
  if (agent.state === 'thinking') return '#FFE18D';
  if (agent.state === 'listening') return '#A0E5FF';
  if (agent.state === 'error') return '#FF9C9C';
  return '#FFFFFF';
});

const waveColor = computed(() => '#9B5A56');

// Render the downsampled samples as a small SVG path tucked just under
// the bunny's mouth (around y=300). Range matches the mouth zone width.
const waveformPath = computed(() => {
  const xs = samples.value;
  if (xs.length === 0) return '';
  const left = 175, right = 225;
  const span = right - left;
  const baseline = 305;
  const amplitude = 5;
  let d = '';
  for (let i = 0; i < xs.length; i++) {
    const x = left + (i / (xs.length - 1)) * span;
    const y = baseline - (xs[i] ?? 0) * amplitude;
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
});

let off: (() => void) | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  off = eventBus.on('tts.audio.envelope', (e) => {
    const wf = e.payload.waveform;
    if (!wf || wf.length === 0) return;
    samples.value = wf;
    lastSampleTs.value = Date.now();
  });
  fadeTimer = setInterval(() => {
    if (samples.value.length > 0 && Date.now() - lastSampleTs.value >= FRESH_MS) {
      samples.value = [];
    }
  }, FRESH_MS);
});

onBeforeUnmount(() => {
  off?.();
  if (fadeTimer) clearInterval(fadeTimer);
});
</script>

<style scoped>
.bunny-fx { pointer-events: none; }

.bunny-blush-glow {
  fill: currentColor;
  filter: blur(8px);
  transition: opacity 280ms ease;
}
.bunny-blush-fx {
  transition: opacity 280ms ease;
}

/* The sparkle dot itself glows with state color via drop-shadow. */
.bunny-sparkle circle:first-child {
  filter: drop-shadow(0 0 3px currentColor);
  transition: filter 280ms ease;
}

/* Idle: gentle twinkle on both eyes (offset for organic asymmetry). */
.bunny-sparkle-left  { animation: bunny-sparkle-pulse 3.2s ease-in-out infinite; }
.bunny-sparkle-right { animation: bunny-sparkle-pulse 3.2s ease-in-out infinite 1.1s; }

/* Listening / thinking / speaking pulse faster + brighter. */
.state-listening .bunny-sparkle-left,
.state-listening .bunny-sparkle-right {
  animation-duration: 1s;
}
.state-thinking .bunny-sparkle-left,
.state-thinking .bunny-sparkle-right {
  animation-duration: 1.4s;
}
.state-speaking .bunny-sparkle-left,
.state-speaking .bunny-sparkle-right {
  animation-duration: 0.8s;
}

@keyframes bunny-sparkle-pulse {
  0%, 100% { opacity: 0.5; transform: scale(0.92); }
  50%      { opacity: 1;   transform: scale(1.15); }
}

/* Soft glow halo for the live waveform when speaking. */
.bunny-wave path {
  filter: drop-shadow(0 0 2px currentColor);
}

/* Subtle ear wiggle when listening — channels the bunny "I'm paying
 * attention" trope. Kept gentle to not look anxious. */
.state-listening .bunny-ear-left {
  transform-origin: 160px 150px;
  animation: bunny-ear-listen 1.6s ease-in-out infinite;
}
@keyframes bunny-ear-listen {
  0%, 100% { transform: rotate(0deg); }
  50%      { transform: rotate(-3deg); }
}
</style>
