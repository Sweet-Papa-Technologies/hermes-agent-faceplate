<template>
  <div class="chart-artifact">
    <canvas ref="canvasEl" />
    <div v-if="error" class="chart-error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

import type { Artifact } from '../../stores/artifact-types';
import { parseLooseJson } from './extract-json';

interface ChartLikeConfig {
  type?: string;
  data?: { labels?: unknown; datasets?: unknown[] } | unknown;
  options?: { scales?: unknown } | unknown;
  // Common malformations we move into the right place:
  datasets?: unknown[];        // belongs under data.datasets
  labels?: unknown;            // belongs under data.labels
  scales?: unknown;            // belongs under options.scales
}

/**
 * Models reliably emit the right Chart.js *fields* but not always the
 * right *nesting*. The most common failure mode is a flat config:
 *
 *   { type, data:{labels:…}, options:{…}, datasets:[…], scales:{…} }
 *
 * which Chart.js reads as "no datasets, no axes config" and renders blank.
 * Move stray top-level keys to where Chart.js expects them so a
 * structurally-loose response still produces a real chart.
 */
function coerceChartShape(raw: ChartLikeConfig): ChartLikeConfig {
  const cfg = { ...raw } as ChartLikeConfig;
  // Ensure data exists as an object
  let data: { labels?: unknown; datasets?: unknown[] } =
    (typeof cfg.data === 'object' && cfg.data !== null && !Array.isArray(cfg.data))
      ? { ...(cfg.data as Record<string, unknown>) }
      : {};
  // Hoist top-level datasets / labels into data
  if (Array.isArray(cfg.datasets) && !Array.isArray(data.datasets)) {
    data.datasets = cfg.datasets;
  }
  if (cfg.labels !== undefined && data.labels === undefined) {
    data.labels = cfg.labels;
  }
  cfg.data = data;
  delete cfg.datasets;
  delete cfg.labels;

  // Ensure options exists as an object, hoist top-level scales into options
  let options: { scales?: unknown } =
    (typeof cfg.options === 'object' && cfg.options !== null && !Array.isArray(cfg.options))
      ? { ...(cfg.options as Record<string, unknown>) }
      : {};
  if (cfg.scales !== undefined && options.scales === undefined) {
    options.scales = cfg.scales;
  }
  cfg.options = options;
  delete cfg.scales;

  return cfg;
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
    cfg = parseLooseJson<ChartLikeConfig>(props.artifact.body);
  } catch (err) {
    error.value = `Invalid chart JSON: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  cfg = coerceChartShape(cfg);
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
