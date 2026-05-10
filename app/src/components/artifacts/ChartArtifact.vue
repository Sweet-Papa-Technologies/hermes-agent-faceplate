<template>
  <div class="chart-artifact">
    <canvas ref="canvasEl" />
    <div v-if="error" class="chart-error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

interface ChartLikeConfig {
  type?: string;
  data?: unknown;
  options?: unknown;
}

const props = defineProps<{ artifact: Artifact }>();
const canvasEl = ref<HTMLCanvasElement | null>(null);
const error = ref<string | null>(null);
let chart: { destroy: () => void } | null = null;

async function render(): Promise<void> {
  error.value = null;
  if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
  if (!canvasEl.value) return;

  let cfg: ChartLikeConfig;
  try {
    cfg = JSON.parse(props.artifact.body) as ChartLikeConfig;
  } catch (err) {
    error.value = `Invalid chart JSON: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (!cfg.type) {
    error.value = 'Chart config missing "type" field';
    return;
  }
  try {
    const mod = await import('chart.js/auto');
    const Chart = mod.default;
    chart = new Chart(canvasEl.value, cfg as ConstructorParameters<typeof Chart>[1]);
  } catch (err) {
    error.value = `Chart render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

onMounted(() => void render());
watch(() => props.artifact.id, () => void render());

onBeforeUnmount(() => {
  if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
});
</script>

<style scoped>
.chart-artifact {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  padding: 20px;
  position: relative;
}
.chart-artifact canvas {
  max-width: 100%;
  max-height: 100%;
}
.chart-error {
  position: absolute;
  top: 12px;
  left: 12px;
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: #ff9c9c;
  background: rgba(0, 0, 0, 0.6);
  padding: 6px 10px;
  border-radius: 6px;
}
</style>
