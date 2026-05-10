<template>
  <div class="diagram-artifact">
    <div ref="hostEl" class="diagram-host" />
    <div v-if="error" class="diagram-error">{{ error }}</div>
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
.diagram-error {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: #ff9c9c;
  background: rgba(0, 0, 0, 0.6);
  padding: 6px 10px;
  border-radius: 6px;
}
</style>
