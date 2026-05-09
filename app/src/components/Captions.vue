<template>
  <div v-if="visible && text" class="captions">
    <span class="captions-text">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useConversationStore } from '../stores/conversation';
import { useThemeStore } from '../stores/theme';

const convo = useConversationStore();
const theme = useThemeStore();
const { captionText, captionsVisible } = storeToRefs(convo);

const text = computed(() => captionText.value);
const visible = computed(() => captionsVisible.value);
const fontFamily = computed(() => theme.loaded?.manifest.captions?.font_family ?? 'Inter, system-ui, sans-serif');
const fontSize = computed(() => `${theme.loaded?.manifest.captions?.font_size_px ?? 16}px`);
const color = computed(() => theme.loaded?.manifest.captions?.color ?? '#ffffff');
const bg = computed(() => theme.loaded?.manifest.captions?.background ?? 'rgba(0,0,0,0.55)');
const offset = computed(() => `${theme.loaded?.manifest.captions?.bottom_offset_px ?? 24}px`);
</script>

<style scoped>
.captions {
  position: fixed;
  left: 50%;
  bottom: v-bind(offset);
  transform: translateX(-50%);
  max-width: min(80vw, 720px);
  padding: 8px 14px;
  border-radius: 10px;
  font-family: v-bind(fontFamily);
  font-size: v-bind(fontSize);
  color: v-bind(color);
  background: v-bind(bg);
  text-align: center;
  pointer-events: none;
  user-select: none;
}
</style>
