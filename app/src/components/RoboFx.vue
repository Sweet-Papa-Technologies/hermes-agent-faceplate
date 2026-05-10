<template>
  <g class="robo-fx" aria-hidden="true">
    <!-- Outer eye-glow halos: tinted by agent state. The static head SVG
         already paints a cyan inner glow + white pupil; we overlay a
         state-colored ring around the existing pupil so the eye reads as
         "listening" / "thinking" / "speaking" without overwriting the
         alive-looking white pupil dot underneath. -->
    <g class="robo-eyes" :style="{ color: eyeColor }">
      <circle class="robo-eye-halo" cx="140" cy="190" r="34" />
      <circle class="robo-eye-halo" cx="260" cy="190" r="34" />
      <circle class="robo-eye-iris" cx="140" cy="190" r="14" />
      <circle class="robo-eye-iris" cx="260" cy="190" r="14" />
    </g>

    <!-- Live waveform painted inside the mouth bezel rectangle that lives
         in robo/head.svg (135,265 → 265,315). Only visible while audio is
         streaming; falls back to the underlying viseme otherwise. -->
    <g v-if="showWave" class="robo-wave" :style="{ color: waveColor }">
      <!-- Centered baseline so the eye is drawn to motion against silence. -->
      <line x1="148" y1="290" x2="252" y2="290"
            stroke="currentColor" stroke-width="0.8"
            stroke-linecap="round" opacity="0.18" />
      <path :d="waveformPath"
            fill="none" stroke="currentColor"
            stroke-width="2.4" stroke-linejoin="round"
            stroke-linecap="round"
            opacity="0.95" />
      <path :d="waveformPath"
            fill="none" stroke="currentColor"
            stroke-width="6" stroke-linejoin="round"
            stroke-linecap="round"
            opacity="0.18" />
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

// Live samples buffer + freshness — when no envelope event lands for
// FRESH_MS the waveform fades back to the bezel.
const FRESH_MS = 250;
const samples = ref<number[]>([]);
const lastSampleTs = ref(0);

const showWave = computed(() => samples.value.length > 0 && Date.now() - lastSampleTs.value < FRESH_MS);

// State→color mapping. Reuses the theme's ring tints so eye color and the
// state-ring racer always agree on what state we're in.
const eyeColor = computed(() => {
  // Speaking always shines bright cyan to read as "talking", regardless of
  // the ring tint. The other states fall through to the theme's mapping.
  if (agent.state === 'speaking') return '#7fdcff';
  return theme.ringTintFor(agent.state);
});

const waveColor = computed(() => '#7fdcff');

// Render the downsampled samples as an SVG polyline path inside the mouth
// bezel (135,265 → 265,315 in viewBox coords). We pad both edges so the
// trace meets the bezel border smoothly.
const waveformPath = computed(() => {
  const xs = samples.value;
  if (xs.length === 0) return '';
  const left = 145, right = 255;
  const span = right - left;
  const baseline = 290;
  const amplitude = 17; // pixels — comfortably inside the 50-tall bezel.
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
  // Periodically poke reactivity so showWave flips back to false after
  // FRESH_MS without us depending on a setInterval-driven re-render
  // anywhere else.
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
.robo-fx { pointer-events: none; }

/* The halo + pupil both inherit `color` from the parent; SVG's currentColor
 * resolves through the `style` binding above. */
.robo-eye-halo {
  fill: currentColor;
  opacity: 0.22;
  filter: blur(3px);
  transition: opacity 280ms ease;
}
.robo-eye-iris {
  /* Ring (no fill) around the head SVG's inner glow + white pupil so the
   * underlying alive-looking white dot survives. */
  fill: none;
  stroke: currentColor;
  stroke-width: 4;
  opacity: 0.85;
  filter: drop-shadow(0 0 5px currentColor);
  transition: opacity 280ms ease, stroke 280ms ease;
}

/* State-specific motion. Pulses stay subtle; we don't want to compete
 * with the mouth waveform for the user's attention while speaking. */
.robo-fx .robo-eyes {
  animation: robo-eye-idle 4s ease-in-out infinite;
}
.state-listening .robo-fx .robo-eyes,
.robo-fx.state-listening .robo-eyes {
  animation: robo-eye-pulse 1.2s ease-in-out infinite;
}

/* Glow line drop-shadow gives the trace that oscilloscope feel. */
.robo-wave path {
  filter: drop-shadow(0 0 4px currentColor);
}

@keyframes robo-eye-idle {
  0%, 100% { opacity: 0.95; }
  50%      { opacity: 0.7; }
}
@keyframes robo-eye-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
</style>
