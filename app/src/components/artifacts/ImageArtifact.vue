<template>
  <div class="image-artifact">
    <img v-if="src" :src="src" :alt="artifact.title ?? 'image'" @error="onError" />
    <div v-else class="image-fallback">
      {{ error ?? 'No source available' }}
    </div>
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
  if (props.artifact.body_storage === 'url') {
    src.value = props.artifact.body;
    return;
  }
  if (props.artifact.body_storage === 'file') {
    const url = await window.faceplate?.artifacts.resolveUrl(props.artifact.id);
    src.value = url ?? '';
    return;
  }
  // Inline + image: rare, but treat as a data: URL or raw URL
  src.value = props.artifact.body;
}

function onError(): void {
  error.value = `Failed to load: ${src.value}`;
  src.value = '';
}

watch(() => props.artifact.id, () => void resolve(), { immediate: true });
</script>

<style scoped>
.image-artifact {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.image-artifact img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
}
.image-fallback {
  font: 13px/1.4 system-ui, sans-serif;
  color: #ff9c9c;
}
</style>
