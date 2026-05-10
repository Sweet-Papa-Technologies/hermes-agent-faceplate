<template>
  <div class="code-artifact">
    <div v-if="canPreview" class="code-tabs">
      <button :class="{ active: tab === 'preview' }" @click="tab = 'preview'">Preview</button>
      <button :class="{ active: tab === 'source' }" @click="tab = 'source'">Source</button>
    </div>
    <iframe
      v-if="tab === 'preview' && canPreview"
      class="code-preview"
      :srcdoc="srcdoc"
      sandbox="allow-scripts"
    />
    <pre v-else class="code-source"><code ref="codeEl" :class="`language-${lang}`">{{ artifact.body }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();

const lang = computed(() => (props.artifact.language || 'plaintext').toLowerCase());
const canPreview = computed(() => lang.value === 'html' || lang.value === 'svg');
const srcdoc = computed(() => canPreview.value ? props.artifact.body : '');
const tab = ref<'preview' | 'source'>(canPreview.value ? 'preview' : 'source');

const codeEl = ref<HTMLElement | null>(null);

// highlight.js is lazy-loaded so the canvas doesn't pay for the bundle
// when the user only ever opens images/charts.
async function highlight(): Promise<void> {
  if (!codeEl.value) return;
  try {
    const hljs = (await import('highlight.js')).default;
    // Strip stale highlight markers if Vue re-rendered the same node.
    codeEl.value.removeAttribute('data-highlighted');
    hljs.highlightElement(codeEl.value);
  } catch (err) {
    // No highlight = plain text. Not fatal.
    console.warn('[code-artifact] highlight.js load failed:', err);
  }
}

onMounted(() => void highlight());
watch(() => props.artifact.id, () => void highlight());
watch(tab, (t) => { if (t === 'source') void highlight(); });
</script>

<style scoped>
.code-artifact {
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.code-tabs {
  display: flex;
  gap: 4px;
  padding: 0 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}
.code-tabs button {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.7);
  font: 12px/1 'JetBrains Mono', ui-monospace, monospace;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.code-tabs button.active {
  background: rgba(127,220,255,0.18);
  color: #fff;
  border-color: rgba(127,220,255,0.4);
}
.code-preview {
  flex: 1;
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: #fff;
  min-height: 0;
}
.code-source {
  flex: 1;
  margin: 0;
  padding: 12px 16px;
  background: rgba(0,0,0,0.55);
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.5 'JetBrains Mono', ui-monospace, monospace;
  color: #e6f5d6;
  user-select: text;
}
</style>

<!-- Pull in a highlight.js stylesheet via global tag. Theme: dark, atom-one. -->
<style>
@import 'highlight.js/styles/atom-one-dark.css';
</style>
