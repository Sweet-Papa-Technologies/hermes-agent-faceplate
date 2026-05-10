<template>
  <div class="audio-artifact">
    <div class="audio-meta">
      <h3>{{ artifact.title || 'Audio' }}</h3>
      <p v-if="artifact.mime" class="audio-mime">{{ artifact.mime }}</p>
    </div>
    <audio v-if="src" :src="src" controls preload="metadata" />
    <div v-else class="audio-fallback">{{ error ?? 'No source available' }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();
const src = ref<string>('');
const error = ref<string | null>(null);

async function resolve(): Promise<void> {
  error.value = null;
  if (props.artifact.body_storage === 'url') { src.value = props.artifact.body; return; }
  if (props.artifact.body_storage === 'file') {
    const url = await window.faceplate?.artifacts.resolveUrl(props.artifact.id);
    src.value = url ?? '';
    return;
  }
  src.value = props.artifact.body;
}

watch(() => props.artifact.id, () => void resolve(), { immediate: true });
</script>

<style scoped>
.audio-artifact {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
.audio-meta { text-align: center; }
.audio-meta h3 { margin: 0; font: 600 16px/1.3 system-ui, sans-serif; color: #f4f5f8; }
.audio-mime { margin: 4px 0 0; font: 11px/1 'JetBrains Mono', ui-monospace, monospace; color: rgba(255,255,255,0.45); }
.audio-artifact audio { width: 100%; max-width: 480px; }
.audio-fallback { font: 13px/1.4 system-ui, sans-serif; color: #ff9c9c; }
</style>
