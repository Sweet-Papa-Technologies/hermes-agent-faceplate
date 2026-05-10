<template>
  <div class="video-artifact">
    <div v-if="embed" class="video-embed" :style="aspectStyle">
      <iframe
        :src="embed.src"
        :allow="embed.allow"
        allowfullscreen
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
      />
    </div>
    <video v-else-if="src" :src="src" controls preload="metadata" />
    <div v-else class="video-fallback">{{ error ?? 'No source available' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Artifact } from '../../stores/artifact-types';
import { detectEmbed, type EmbedConfig } from './media-embed-detect';

const props = defineProps<{ artifact: Artifact }>();
const src = ref<string>('');
const error = ref<string | null>(null);
const embed = ref<EmbedConfig | null>(null);

const aspectStyle = computed(() => {
  const r = embed.value?.aspectRatio ?? 16 / 9;
  return { aspectRatio: String(r) };
});

async function resolve(): Promise<void> {
  error.value = null;
  embed.value = null;
  src.value = '';

  // URL-stored video: try to detect a platform embed first (YouTube etc.).
  // Fall back to a plain <video> tag for direct-streamable URLs.
  if (props.artifact.body_storage === 'url') {
    const e = detectEmbed(props.artifact.body);
    if (e) { embed.value = e; return; }
    src.value = props.artifact.body;
    return;
  }
  if (props.artifact.body_storage === 'file') {
    const url = await window.faceplate?.artifacts.resolveUrl(props.artifact.id);
    src.value = url ?? '';
    return;
  }
  // Inline body — try as URL anyway in case the model wrapped one without
  // the body_storage hint.
  const trimmed = props.artifact.body.trim();
  const e = detectEmbed(trimmed);
  if (e) { embed.value = e; return; }
  src.value = trimmed;
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
.video-embed {
  width: 100%;
  max-width: 960px;
  border-radius: 10px;
  overflow: hidden;
  background: #000;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
}
.video-embed iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.video-fallback { font: 13px/1.4 system-ui, sans-serif; color: #ff9c9c; }
</style>
