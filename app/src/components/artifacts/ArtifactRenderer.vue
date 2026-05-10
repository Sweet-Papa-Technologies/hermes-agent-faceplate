<template>
  <component :is="renderer" :artifact="artifact" class="artifact-renderer" />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();

// Lazy-loaded renderers keep the per-window bundle small — the canvas
// window only pays for what it actually displays. defineAsyncComponent
// returns a wrapper Vue can mount as a regular component.
const ImageArtifact = defineAsyncComponent(() => import('./ImageArtifact.vue'));
const VideoArtifact = defineAsyncComponent(() => import('./VideoArtifact.vue'));
const AudioArtifact = defineAsyncComponent(() => import('./AudioArtifact.vue'));
const TextArtifact = defineAsyncComponent(() => import('./TextArtifact.vue'));
const CodeArtifact = defineAsyncComponent(() => import('./CodeArtifact.vue'));
const ChartArtifact = defineAsyncComponent(() => import('./ChartArtifact.vue'));
const DiagramArtifact = defineAsyncComponent(() => import('./DiagramArtifact.vue'));
const VisualArtifact = defineAsyncComponent(() => import('./VisualArtifact.vue'));

const renderer = computed<Component>(() => {
  switch (props.artifact.kind) {
    case 'image': return ImageArtifact;
    case 'video': return VideoArtifact;
    case 'audio': return AudioArtifact;
    case 'text': return TextArtifact;
    case 'code': return CodeArtifact;
    case 'chart': return ChartArtifact;
    case 'diagram': return DiagramArtifact;
    case 'visual': return VisualArtifact;
  }
});
</script>

<style scoped>
.artifact-renderer {
  width: 100%;
  min-height: 100%;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
}
</style>
