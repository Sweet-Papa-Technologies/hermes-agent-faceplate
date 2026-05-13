<template>
  <div class="chart-artifact">
    <canvas v-show="!error" ref="canvasEl" />
    <div v-if="error" class="chart-fallback">
      <div class="chart-error">
        <span v-if="fixing" class="chart-fix-spinner" aria-hidden="true" />
        <span>{{ fixing ? `Fixing chart automatically (attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS})…` : error }}</span>
      </div>
      <!-- Manual escape hatch ONLY after auto-fix attempts are exhausted.
           Until then the fix runs on its own — user shouldn't have to click. -->
      <div v-if="!fixing && fixAttempts >= MAX_FIX_ATTEMPTS" class="chart-fix-actions">
        <button class="chart-fix-btn" @click="manualRetry">
          ✨ Try AI fix again
        </button>
        <span class="chart-fix-spent">
          Or regenerate from chat — the source is shown below for reference.
        </span>
      </div>
      <pre v-if="!fixing && fixAttempts >= MAX_FIX_ATTEMPTS" class="chart-source"><code>{{ artifact.body }}</code></pre>
    </div>
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

// AI auto-fix bookkeeping. The fix runs automatically when the chart
// fails to render — no clicking required. Bounded so a misbehaving model
// can't loop forever; once both auto-attempts are exhausted the user
// falls through to a "view source" pane with one optional manual retry.
const MAX_FIX_ATTEMPTS = 2;
const fixing = ref(false);
const fixAttempts = ref(0);
// Reset per artifact so a fresh chart gets its own budget.
watch(() => props.artifact.id, () => { fixAttempts.value = 0; fixing.value = false; });

// Auto-fire the fix whenever an error appears AND we still have attempts.
// Watch handles both the initial render-fail and any subsequent re-render
// that also failed (post-fix, the new body is rendered; if it still
// errors, this watch fires again with the next attempt budget).
watch(error, async (next) => {
  if (!next) return;
  if (fixing.value) return;
  if (fixAttempts.value >= MAX_FIX_ATTEMPTS) return;
  await runFix();
});

async function runFix(): Promise<void> {
  if (!error.value) return;
  fixing.value = true;
  fixAttempts.value += 1;
  try {
    const corrected = await window.faceplate?.artifactFix.fix({
      kind: 'chart',
      body: props.artifact.body,
      error: error.value,
    });
    if (!corrected) return;
    const updated = await window.faceplate?.artifacts.updateBody(props.artifact.id, corrected);
    // The artifacts store broadcasts the update; our own re-render is
    // also triggered manually here for the immediate case (the same
    // artifact ref with a new body).
    if (updated) await render();
  } finally {
    fixing.value = false;
  }
}

// Manual escape hatch shown only after the auto-attempts are spent. Bumps
// the budget by one so the user can nudge the model with fresh context.
async function manualRetry(): Promise<void> {
  if (fixing.value) return;
  fixAttempts.value = Math.max(0, MAX_FIX_ATTEMPTS - 1);
  await runFix();
}

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
.chart-fallback {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px;
}
.chart-error {
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: #ff9c9c;
  background: rgba(255, 156, 156, 0.08);
  border: 1px solid rgba(255, 156, 156, 0.25);
  padding: 8px 12px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.chart-fix-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(127, 220, 255, 0.25);
  border-top-color: #7fdcff;
  border-radius: 50%;
  animation: chart-spin 700ms linear infinite;
  flex-shrink: 0;
}
@keyframes chart-spin {
  to { transform: rotate(360deg); }
}
.chart-fix-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.chart-fix-btn {
  background: linear-gradient(135deg, rgba(127, 220, 255, 0.22), rgba(168, 85, 247, 0.22));
  border: 1px solid rgba(127, 220, 255, 0.45);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font: 600 12px/1.2 system-ui, sans-serif;
  cursor: pointer;
  transition: transform 100ms ease, border-color 100ms ease, opacity 100ms ease;
}
.chart-fix-btn:hover:not(:disabled) {
  transform: scale(1.03);
  border-color: rgba(127, 220, 255, 0.7);
}
.chart-fix-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.chart-fix-spent {
  font: 11px/1.3 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.55);
}
.chart-source {
  margin: 0;
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.5 'JetBrains Mono', ui-monospace, monospace;
  color: #e6f5d6;
  user-select: text;
  white-space: pre-wrap;
  max-height: 200px;
}
</style>
