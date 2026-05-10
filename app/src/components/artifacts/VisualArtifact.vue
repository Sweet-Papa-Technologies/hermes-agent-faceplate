<template>
  <div class="visual-artifact">
    <div class="visual-stub">
      <div class="visual-stub-icon">◆</div>
      <h3>{{ artifact.title || '3D / Visual artifact' }}</h3>
      <p class="visual-stub-msg">
        Three.js rendering ships in the next update. For now, here's the
        artifact body — you can download it to view externally.
      </p>
      <pre class="visual-body">{{ truncated }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();

const truncated = computed(() => {
  const raw = props.artifact.body || '(empty)';
  return raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
});
</script>

<style scoped>
.visual-artifact {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.visual-stub {
  max-width: 480px;
  text-align: center;
  padding: 24px;
}
.visual-stub-icon {
  font-size: 56px;
  color: rgba(127, 220, 255, 0.7);
  margin-bottom: 12px;
}
.visual-stub h3 {
  margin: 0 0 6px;
  font: 600 16px/1.3 system-ui, sans-serif;
  color: #f4f5f8;
}
.visual-stub-msg {
  font: 13px/1.5 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.55);
  margin: 0 0 14px;
}
.visual-body {
  background: rgba(0, 0, 0, 0.45);
  padding: 10px 12px;
  border-radius: 8px;
  font: 11px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.7);
  text-align: left;
  max-height: 200px;
  overflow: auto;
  user-select: text;
}
</style>
