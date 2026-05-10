<template>
  <div class="overlay-page" :class="`mode-${settings.mode}`">
    <Avatar />
    <ToolBadge />
    <Captions />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';

import Avatar from '../components/Avatar.vue';
import Captions from '../components/Captions.vue';
import ToolBadge from '../components/ToolBadge.vue';
import { eventBus } from '../boot/event-bus';
import { useSettingsStore } from '../stores/settings';
import { useConversationStore } from '../stores/conversation';
import { replayLastAssistant } from '../hermes/replay';

const settings = useSettingsStore();
const convo = useConversationStore();

let detachHotkeys: (() => void) | null = null;
let detachTypingDispatch: (() => void) | null = null;

onMounted(() => {
  const fp = window.faceplate;
  if (!fp) return;
  detachHotkeys = fp.hotkeys.onPress((name) => {
    switch (name) {
      case 'replay':
        void replayLastAssistant();
        return;
      case 'captions':
        convo.toggleCaptions();
        return;
      default:
        // show_hide / cycle_monitor / typing_bar are owned by main;
        // push_to_talk lives in the audio pipeline; interrupt is handled
        // separately by both the audio pipeline and the turn handler.
        return;
    }
  });

  // The typing bar lives in its own native window now (centered on the
  // active display). When the user submits there, main forwards the text
  // to us via the typingBar.dispatch IPC channel; we re-emit it on the
  // local event bus so turn-handler picks it up the same way it did when
  // the typing bar was inside this window.
  detachTypingDispatch = fp.typingBar.onDispatch((text: string) => {
    eventBus.emit({
      type: 'user.input.text',
      ts: Date.now(),
      payload: { text, source: 'typingbar' },
    });
  });
});

onBeforeUnmount(() => {
  detachHotkeys?.();
  detachTypingDispatch?.();
});
</script>

<style scoped>
.overlay-page {
  width: 100vw;
  height: 100vh;
  background: var(--faceplate-bg, transparent);
  /* Vertical stack: avatar pinned to top via its own flex alignment, then
   * tool badge, then captions. Each below-avatar child collapses to zero
   * via v-if when not active so the layout doesn't reserve dead space. */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  overflow: hidden;
}

:root[data-mode='windowed'] .overlay-page {
  background: var(--faceplate-bg, #1a1a1a);
}
</style>
