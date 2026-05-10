<template>
  <div class="audio-artifact">
    <div class="audio-meta">
      <h3>{{ artifact.title || (embed?.kind ? prettyKind(embed.kind) : 'Audio') }}</h3>
      <p v-if="artifact.mime" class="audio-mime">{{ artifact.mime }}</p>
    </div>
    <div v-if="embed" class="audio-embed" :style="aspectStyle">
      <iframe
        :src="embed.src"
        :allow="embed.allow"
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
      />
    </div>
    <audio v-else-if="src" :src="src" controls preload="metadata" />
    <a v-else-if="artifact.body_storage === 'url'" :href="artifact.body" target="_blank" rel="noopener" class="audio-link">
      Open externally ↗
    </a>
    <div v-else class="audio-fallback">{{ error ?? 'No source available' }}</div>
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
  const r = embed.value?.aspectRatio ?? 5 / 1;
  return { aspectRatio: String(r) };
});

function prettyKind(k: string): string {
  return k.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function resolve(): Promise<void> {
  error.value = null;
  embed.value = null;
  src.value = '';

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
  const trimmed = props.artifact.body.trim();
  const e = detectEmbed(trimmed);
  if (e) { embed.value = e; return; }
  src.value = trimmed;
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
  gap: 14px;
}
.audio-meta { text-align: center; }
.audio-meta h3 { margin: 0; font: 600 16px/1.3 system-ui, sans-serif; color: #f4f5f8; }
.audio-mime { margin: 4px 0 0; font: 11px/1 'JetBrains Mono', ui-monospace, monospace; color: rgba(255,255,255,0.45); }
.audio-artifact audio { width: 100%; max-width: 480px; }
.audio-embed {
  width: 100%;
  max-width: 640px;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.4);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
}
.audio-embed iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.audio-link {
  color: #7fdcff;
  text-decoration: underline;
  font: 13px/1.4 system-ui, sans-serif;
}
.audio-fallback { font: 13px/1.4 system-ui, sans-serif; color: #ff9c9c; }
</style>
