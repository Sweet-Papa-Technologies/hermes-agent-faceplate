<template>
  <div class="video-artifact">
    <video v-if="src" :src="src" controls preload="metadata" />
    <div v-else class="video-fallback">{{ error ?? 'No source available' }}</div>
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
.video-artifact {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-artifact video {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  background: #000;
}
.video-fallback { font: 13px/1.4 system-ui, sans-serif; color: #ff9c9c; }
</style>
