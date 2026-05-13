<template>
  <div class="diagram-artifact">
    <div ref="hostEl" class="diagram-host" v-show="!error" />
    <div v-if="error" class="diagram-fallback">
      <div class="diagram-error">
        <span v-if="fixing" class="diagram-fix-spinner" aria-hidden="true" />
        <span>{{ fixing ? `Fixing diagram automatically (attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS})…` : error }}</span>
      </div>
      <!-- Manual escape hatch only appears after auto-attempts run out. -->
      <div v-if="!fixing && fixAttempts >= MAX_FIX_ATTEMPTS" class="diagram-fix-actions">
        <button class="diagram-fix-btn" @click="manualRetry">
          ✨ Try AI fix again
        </button>
        <span class="diagram-fix-spent">
          Or regenerate from chat — the source is shown below for reference.
        </span>
      </div>
      <pre v-if="!fixing && fixAttempts >= MAX_FIX_ATTEMPTS" class="diagram-source"><code>{{ artifact.body }}</code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();
const hostEl = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

let mermaidLoaded: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidLoaded) {
    mermaidLoaded = import('mermaid').then((mod) => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'system-ui, sans-serif',
      });
      return m;
    });
  }
  return mermaidLoaded;
}

async function render(): Promise<void> {
  error.value = null;
  if (!hostEl.value) return;
  hostEl.value.innerHTML = '';
  try {
    const mermaid = await loadMermaid();
    const id = `mmd-${props.artifact.id.slice(0, 8)}-${Date.now()}`;
    const { svg } = await mermaid.render(id, props.artifact.body);
    hostEl.value.innerHTML = svg;
  } catch (err) {
    error.value = `Diagram render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// AI auto-fix bookkeeping. Runs automatically on render error — no click
// required. Bounded so a flaky model can't burn budget; after auto-
// attempts are exhausted, the user sees the source pane + one optional
// manual retry button.
const MAX_FIX_ATTEMPTS = 2;
const fixing = ref(false);
const fixAttempts = ref(0);

// Auto-fire whenever an error appears and we still have budget. Fires
// again automatically if the post-fix render also errors.
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
      kind: 'diagram',
      body: props.artifact.body,
      error: error.value,
    });
    if (!corrected) return;
    const updated = await window.faceplate?.artifacts.updateBody(props.artifact.id, corrected);
    if (updated) await render();
  } finally {
    fixing.value = false;
  }
}

async function manualRetry(): Promise<void> {
  if (fixing.value) return;
  fixAttempts.value = Math.max(0, MAX_FIX_ATTEMPTS - 1);
  await runFix();
}

onMounted(() => void render());
watch(() => props.artifact.id, () => {
  fixAttempts.value = 0;
  fixing.value = false;
  void render();
});
</script>

<style scoped>
.diagram-artifact {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  position: relative;
}
.diagram-host {
  max-width: 100%;
  max-height: 100%;
}
.diagram-host :deep(svg) {
  max-width: 100%;
  height: auto;
}
.diagram-fallback {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
}
.diagram-error {
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
.diagram-fix-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(127, 220, 255, 0.25);
  border-top-color: #7fdcff;
  border-radius: 50%;
  animation: diagram-spin 700ms linear infinite;
  flex-shrink: 0;
}
@keyframes diagram-spin {
  to { transform: rotate(360deg); }
}
.diagram-fix-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.diagram-fix-btn {
  background: linear-gradient(135deg, rgba(127, 220, 255, 0.22), rgba(168, 85, 247, 0.22));
  border: 1px solid rgba(127, 220, 255, 0.45);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font: 600 12px/1.2 system-ui, sans-serif;
  cursor: pointer;
  transition: transform 100ms ease, border-color 100ms ease, opacity 100ms ease;
}
.diagram-fix-btn:hover:not(:disabled) {
  transform: scale(1.03);
  border-color: rgba(127, 220, 255, 0.7);
}
.diagram-fix-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.diagram-fix-spent {
  font: 11px/1.3 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.55);
}
.diagram-source {
  margin: 0;
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.5 'JetBrains Mono', ui-monospace, monospace;
  color: #e6f5d6;
  user-select: text;
  white-space: pre-wrap;
}
</style>
