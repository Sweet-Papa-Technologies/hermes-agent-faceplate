<template>
  <section class="convtrans">
    <header class="convtrans-head">
      <input
        v-if="active"
        v-model="titleEdit"
        class="convtrans-title"
        spellcheck="false"
        @blur="commitTitle"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />
      <span v-else class="convtrans-title convtrans-title-empty">No conversation selected</span>
      <div v-if="active" class="convtrans-actions">
        <span
          v-if="agentBusy"
          class="convtrans-status"
          :class="`convtrans-status--${agentState}`"
          :title="`Agent is ${agentState}`"
        >
          <span class="convtrans-status-dot" />
          {{ statusLabel }}
        </span>
        <div class="convtrans-tabs">
          <button :class="{ active: tab === 'transcript' }" @click="tab = 'transcript'">Transcript</button>
          <button :class="{ active: tab === 'gallery' }" @click="tab = 'gallery'">Artifacts</button>
        </div>
        <span class="convtrans-meta">
          {{ active.turns.length }} {{ active.turns.length === 1 ? 'turn' : 'turns' }}
          <span v-if="active.hermes_session_id" class="convtrans-session" :title="active.hermes_session_id">
            · session
          </span>
        </span>
        <button class="convtrans-action" title="Export to Markdown" @click="exportMarkdown">
          ⤓
        </button>
      </div>
    </header>
    <div v-if="tab === 'transcript'" ref="scrollEl" class="convtrans-scroll">
      <div v-if="!active" class="convtrans-empty">
        Select or create a conversation to view it.
      </div>
      <div v-else-if="active.turns.length === 0" class="convtrans-empty">
        Empty conversation. Talk to Hermes to populate it.
      </div>
      <template v-else>
        <TurnBubble
          v-for="turn in active.turns"
          :key="turn.id"
          :turn="turn"
        />
      </template>
    </div>
    <ArtifactGallery v-else />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted } from 'vue';

import { storeToRefs } from 'pinia';

import TurnBubble from './TurnBubble.vue';
import ArtifactGallery from './ArtifactGallery.vue';
import { useConversationsStore } from '../stores/conversations';
import { useAgentStore } from '../stores/agent';

const convs = useConversationsStore();
const agent = useAgentStore();
const { state: agentState } = storeToRefs(agent);
const active = computed(() => convs.active);

// Mirror the avatar's activity surface so a user reading the transcript
// without the avatar in view still sees what the agent is doing. Only show
// non-idle states; idle would be visual noise.
const STATUS_LABELS: Record<string, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Error',
};
const agentBusy = computed(() => agentState.value !== 'idle');
const statusLabel = computed(() => STATUS_LABELS[agentState.value] ?? agentState.value);
const titleEdit = ref<string>('');
const scrollEl = ref<HTMLDivElement | null>(null);
const tab = ref<'transcript' | 'gallery'>('transcript');

watch(
  () => active.value?.title,
  (next) => {
    titleEdit.value = next ?? '';
  },
  { immediate: true },
);

watch(
  () => active.value?.id,
  () => {
    void nextTick(() => scrollToBottom('auto'));
  },
);

watch(
  () => active.value?.turns.length,
  () => {
    void nextTick(() => scrollToBottom('smooth'));
  },
);

function commitTitle(): void {
  const next = titleEdit.value.trim();
  if (!active.value || !next || next === active.value.title) return;
  void convs.updateTitle(active.value.id, next);
}

async function exportMarkdown(): Promise<void> {
  if (!active.value) return;
  const md = await convs.exportMarkdown(active.value.id);
  if (!md) return;
  // Push to clipboard. A native save dialog would be nicer but requires
  // adding a main-process IPC for showSaveDialog; v1 keeps it lightweight.
  try {
    await navigator.clipboard.writeText(md);
    flashAction('Copied to clipboard');
  } catch {
    // Fallback: open in a new window so the user can copy manually.
    const w = window.open('', '_blank');
    if (w) {
      w.document.body.innerText = md;
    }
  }
}

const actionFlash = ref<string>('');
function flashAction(msg: string): void {
  actionFlash.value = msg;
  setTimeout(() => {
    actionFlash.value = '';
  }, 1500);
}

function scrollToBottom(behavior: ScrollBehavior): void {
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior });
}

onMounted(() => {
  void nextTick(() => scrollToBottom('auto'));
});
</script>

<style scoped>
.convtrans {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(0, 0, 0, 0.05);
}

.convtrans-head {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.convtrans-title {
  flex: 1;
  background: transparent;
  color: #f4f5f8;
  border: 0;
  outline: 0;
  font: 600 15px/1.3 system-ui, sans-serif;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 120ms ease;
}
.convtrans-title:hover { background: rgba(255, 255, 255, 0.04); }
.convtrans-title:focus { background: rgba(255, 255, 255, 0.08); }
.convtrans-title-empty {
  color: rgba(255, 255, 255, 0.45);
  font-style: italic;
}

.convtrans-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.convtrans-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font: 600 11px/1 system-ui, sans-serif;
  letter-spacing: 0.02em;
  background: rgba(127, 220, 255, 0.12);
  color: #d6f1ff;
  border: 1px solid rgba(127, 220, 255, 0.3);
}
.convtrans-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 currentColor;
  animation: convtrans-pulse 1.6s ease-out infinite;
}
.convtrans-status--listening { color: #b5f3a8; background: rgba(181, 243, 168, 0.12); border-color: rgba(181, 243, 168, 0.3); }
.convtrans-status--thinking  { color: #ffe18d; background: rgba(255, 225, 141, 0.12); border-color: rgba(255, 225, 141, 0.3); }
.convtrans-status--speaking  { color: #d4f1ff; background: rgba(127, 220, 255, 0.14); border-color: rgba(127, 220, 255, 0.32); }
.convtrans-status--error     { color: #ff9c9c; background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.4); }

@keyframes convtrans-pulse {
  0%   { box-shadow: 0 0 0 0   currentColor; opacity: 1; }
  70%  { box-shadow: 0 0 0 6px transparent; opacity: 0.4; }
  100% { box-shadow: 0 0 0 0   transparent; opacity: 1; }
}

.convtrans-tabs {
  display: flex;
  gap: 4px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 8px;
  padding: 2px;
}
.convtrans-tabs button {
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.55);
  font: 11px/1 system-ui, sans-serif;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.convtrans-tabs button.active {
  background: rgba(127, 220, 255, 0.18);
  color: #fff;
}

.convtrans-meta {
  font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.45);
}
.convtrans-session {
  color: rgba(127, 220, 255, 0.65);
}

.convtrans-action {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.75);
  border-radius: 6px;
  width: 28px;
  height: 28px;
  font: 14px/1 system-ui, sans-serif;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.convtrans-action:hover {
  background: rgba(127, 220, 255, 0.18);
  color: #fff;
}

.convtrans-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.convtrans-scroll::-webkit-scrollbar { width: 8px; }
.convtrans-scroll::-webkit-scrollbar-track { background: transparent; }
.convtrans-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.convtrans-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.32);
}

.convtrans-empty {
  margin: 60px auto;
  color: rgba(255, 255, 255, 0.4);
  font: 13px/1.5 system-ui, sans-serif;
  text-align: center;
  max-width: 360px;
}
</style>
