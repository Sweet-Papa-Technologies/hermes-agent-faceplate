<template>
  <div class="diagram-artifact">
    <div ref="hostEl" class="diagram-host" v-show="!error" />
    <div v-if="error" class="diagram-fallback">
      <div class="diagram-error">{{ error }}</div>
      <pre class="diagram-source"><code>{{ artifact.body }}</code></pre>
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

onMounted(() => void render());
watch(() => props.artifact.id, () => void render());
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
