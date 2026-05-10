<template>
  <div
    class="convitem"
    :class="{ 'is-active': active }"
    @click="$emit('select')"
    @dblclick="startRename"
  >
    <div class="convitem-row1">
      <input
        v-if="renaming"
        ref="renameEl"
        v-model="renameValue"
        class="convitem-rename"
        spellcheck="false"
        @keydown.enter.prevent="commitRename"
        @keydown.escape.prevent="cancelRename"
        @blur="commitRename"
        @click.stop
      />
      <span v-else class="convitem-title">{{ entry.title || 'Untitled' }}</span>
      <span class="convitem-time">{{ relativeTime(entry.last_used_at) }}</span>
    </div>
    <div v-if="entry.preview" class="convitem-preview">{{ entry.preview }}</div>
    <div class="convitem-meta">
      <span class="convitem-count">{{ entry.turn_count }} {{ entry.turn_count === 1 ? 'turn' : 'turns' }}</span>
      <button
        class="convitem-delete"
        title="Archive"
        @click.stop="$emit('delete')"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';

import type { ConversationManifestEntry } from '../stores/conversation-types';

const props = defineProps<{
  entry: ConversationManifestEntry;
  active: boolean;
}>();

const emit = defineEmits<{
  (e: 'select'): void;
  (e: 'delete'): void;
  (e: 'rename', title: string): void;
}>();

const renaming = ref<boolean>(false);
const renameValue = ref<string>('');
const renameEl = ref<HTMLInputElement | null>(null);

function startRename(): void {
  renameValue.value = props.entry.title;
  renaming.value = true;
  void nextTick(() => renameEl.value?.select());
}

function commitRename(): void {
  if (!renaming.value) return;
  const next = renameValue.value.trim();
  renaming.value = false;
  if (next && next !== props.entry.title) emit('rename', next);
}

function cancelRename(): void {
  renaming.value = false;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString();
}
</script>

<style scoped>
.convitem {
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  margin-bottom: 4px;
  border-radius: 8px;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.convitem:hover { background: rgba(255, 255, 255, 0.05); }
.convitem.is-active {
  background: rgba(127, 220, 255, 0.12);
  border-color: rgba(127, 220, 255, 0.32);
}

.convitem-row1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.convitem-title {
  flex: 1;
  font: 600 13px/1.25 system-ui, sans-serif;
  color: #f4f5f8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.convitem-rename {
  flex: 1;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  border: 1px solid rgba(127, 220, 255, 0.55);
  border-radius: 4px;
  outline: 0;
  font: 600 13px/1.2 system-ui, sans-serif;
  padding: 2px 6px;
  min-width: 0;
}

.convitem-time {
  font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.42);
  flex-shrink: 0;
}

.convitem-preview {
  font: 12px/1.35 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.55);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.convitem-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.convitem-count {
  font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.35);
}
.convitem-delete {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.3);
  font: 12px/1 system-ui, sans-serif;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}
.convitem:hover .convitem-delete { opacity: 1; }
.convitem-delete:hover {
  background: rgba(239, 68, 68, 0.22);
  color: #ffd2d2;
}
</style>
