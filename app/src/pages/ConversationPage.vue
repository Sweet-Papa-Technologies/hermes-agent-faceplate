<template>
  <div class="convpanel-shell" @click.self="closeWindow">
    <div class="convpanel-card">
      <header class="convpanel-titlebar">
        <span class="convpanel-titlebar-grip" aria-hidden="true">⋮⋮</span>
        <span class="convpanel-titlebar-text">Conversations</span>
        <button class="convpanel-titlebar-close" title="Close (Esc)" @click="closeWindow">×</button>
      </header>
      <div class="convpanel-body">
        <ConversationList class="convpanel-list" />
        <ConversationTranscript class="convpanel-transcript" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';

import ConversationList from '../components/ConversationList.vue';
import ConversationTranscript from '../components/ConversationTranscript.vue';
import { useConversationsStore } from '../stores/conversations';

const convs = useConversationsStore();

function closeWindow(): void {
  void window.faceplate?.conversations.togglePanel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeWindow();
  }
}

onMounted(() => {
  document.body.classList.add('faceplate-conversation-panel');
  // Make sure list is current — boot already loaded it but we may have
  // missed broadcasts that fired before the route was mounted.
  void convs.load();
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  document.body.classList.remove('faceplate-conversation-panel');
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
.convpanel-shell {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  padding: 14px;
  box-sizing: border-box;
  background: transparent;
}

.convpanel-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(14, 16, 22, 0.94);
  border-radius: 16px;
  box-shadow:
    0 28px 80px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  backdrop-filter: blur(18px) saturate(125%);
  overflow: hidden;
  color: #f4f5f8;
}

.convpanel-titlebar {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px 0 14px;
  background: rgba(0, 0, 0, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.convpanel-titlebar-grip {
  font: 14px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.32);
  letter-spacing: -2px;
  user-select: none;
}

.convpanel-titlebar-text {
  font: 600 13px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 0.02em;
}

.convpanel-titlebar-close {
  -webkit-app-region: no-drag;
  margin-left: auto;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.55);
  font: 18px/1 system-ui, sans-serif;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.convpanel-titlebar-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.convpanel-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.convpanel-list {
  width: 280px;
  min-width: 240px;
  max-width: 360px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.18);
}

.convpanel-transcript {
  flex: 1;
  min-width: 0;
}
</style>

<!--
  Non-scoped overrides for the conversation panel window only. Same trick as
  the typing bar: gate via body.faceplate-conversation-panel so the global
  resets don't bleed into other windows that share the bundle.
-->
<style>
body.faceplate-conversation-panel,
body.faceplate-conversation-panel #q-app {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
html:has(body.faceplate-conversation-panel) {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
</style>
