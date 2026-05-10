<template>
  <button class="art-thumb" :class="`kind-${entry.kind}`" :title="title" @click="open">
    <span class="art-thumb-icon">{{ icon }}</span>
    <span class="art-thumb-label">{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ArtifactIndexEntry } from '../stores/artifact-types';
import { useArtifactsStore } from '../stores/artifacts';

const props = defineProps<{ entry: ArtifactIndexEntry }>();
const artifacts = useArtifactsStore();

const ICON: Record<string, string> = {
  image: '🖼', video: '▶', audio: '♪',
  text: '¶', code: '〈/〉', chart: '📊',
  diagram: '◆', visual: '✦',
};
const icon = computed(() => ICON[props.entry.kind] ?? '◇');
const label = computed(() => props.entry.title || prettyKind(props.entry.kind));
const title = computed(() => `${prettyKind(props.entry.kind)} — ${props.entry.title ?? props.entry.preview ?? 'untitled'}`);

function prettyKind(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

async function open(): Promise<void> {
  await artifacts.openInCanvas(props.entry.id);
}
</script>

<style scoped>
.art-thumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(127, 220, 255, 0.1);
  border: 1px solid rgba(127, 220, 255, 0.28);
  color: #e7f6ff;
  font: 12px/1.2 system-ui, sans-serif;
  cursor: pointer;
  transition: background 120ms ease, transform 120ms ease, border-color 120ms ease;
  max-width: 240px;
}
.art-thumb:hover {
  background: rgba(127, 220, 255, 0.18);
  border-color: rgba(127, 220, 255, 0.55);
}
.art-thumb:active { transform: scale(0.97); }

.art-thumb-icon { font-size: 13px; flex-shrink: 0; }
.art-thumb-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind-image  { background: rgba(168, 85, 247, 0.12); border-color: rgba(168, 85, 247, 0.4); color: #f0e0ff; }
.kind-video  { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.4); color: #ffd6d6; }
.kind-audio  { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.4); color: #ffe8b3; }
.kind-text   { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.16); }
.kind-code   { background: rgba(34, 197, 94, 0.12); border-color: rgba(34, 197, 94, 0.4); color: #c8f5cf; }
.kind-chart  { background: rgba(127, 220, 255, 0.12); border-color: rgba(127, 220, 255, 0.4); color: #d6f1ff; }
.kind-diagram{ background: rgba(127, 220, 255, 0.1); border-color: rgba(127, 220, 255, 0.32); color: #d6f1ff; }
.kind-visual { background: rgba(168, 85, 247, 0.12); border-color: rgba(168, 85, 247, 0.4); color: #f0e0ff; }
</style>
