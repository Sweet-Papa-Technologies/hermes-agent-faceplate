<template>
  <div class="overlay-page" :class="`mode-${settings.mode}`">
    <Avatar />
    <Captions />
    <TypingBar ref="typingBarRef" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';

import Avatar from '../components/Avatar.vue';
import Captions from '../components/Captions.vue';
import TypingBar from '../components/TypingBar.vue';
import { useSettingsStore } from '../stores/settings';
import { useConversationStore } from '../stores/conversation';
import { replayLastAssistant } from '../hermes/replay';

const settings = useSettingsStore();
const convo = useConversationStore();

interface TypingBarHandle {
  toggle(): void;
  open(): void;
  close(): void;
}
const typingBarRef = ref<TypingBarHandle | null>(null);

let detachHotkeys: (() => void) | null = null;

onMounted(() => {
  const fp = window.faceplate;
  if (!fp) return;
  detachHotkeys = fp.hotkeys.onPress((name) => {
    switch (name) {
      case 'typing_bar':
        typingBarRef.value?.toggle();
        return;
      case 'replay':
        void replayLastAssistant();
        return;
      case 'captions':
        convo.toggleCaptions();
        return;
      case 'interrupt':
        typingBarRef.value?.close();
        return;
      default:
        // show_hide / cycle_monitor are owned by main; push_to_talk lives
        // in the audio pipeline.
        return;
    }
  });
});

onBeforeUnmount(() => {
  detachHotkeys?.();
});
</script>

<style scoped>
.overlay-page {
  width: 100vw;
  height: 100vh;
  background: var(--faceplate-bg, transparent);
}

:root[data-mode='windowed'] .overlay-page {
  background: var(--faceplate-bg, #1a1a1a);
}
</style>
