<template>
  <aside class="convlist">
    <div class="convlist-toolbar">
      <input
        v-model="searchInput"
        class="convlist-search"
        type="text"
        placeholder="Search…"
        spellcheck="false"
        @input="onSearch"
      />
      <button class="convlist-new" title="New conversation (⌘N)" @click="newConv">+</button>
    </div>
    <div class="convlist-scroll">
      <div v-if="visible.length === 0" class="convlist-empty">
        {{ search ? 'No matches' : 'No conversations yet' }}
      </div>
      <ConversationListItem
        v-for="entry in visible"
        :key="entry.id"
        :entry="entry"
        :active="entry.id === convs.activeId"
        @select="onSelect(entry.id)"
        @delete="onDelete(entry.id)"
        @rename="onRename(entry.id, $event)"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

import ConversationListItem from './ConversationListItem.vue';
import { useConversationsStore } from '../stores/conversations';

const convs = useConversationsStore();

const searchInput = ref<string>('');
const search = computed(() => searchInput.value.trim());
const visible = computed(() => convs.visibleList);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void convs.runSearch(searchInput.value);
  }, 120);
}

async function newConv(): Promise<void> {
  await convs.createNew();
}

async function onSelect(id: string): Promise<void> {
  if (id === convs.activeId) return;
  await convs.switchTo(id);
}

async function onDelete(id: string): Promise<void> {
  // Soft-delete (archive). Hard delete is available via right-click menu in v2.
  // Confirm to avoid accidents on misclicks.
  const ok = window.confirm('Archive this conversation? You can recover it from disk later.');
  if (!ok) return;
  await convs.archive(id);
}

async function onRename(id: string, title: string): Promise<void> {
  await convs.updateTitle(id, title);
}

onMounted(() => {
  void convs.load();
});
</script>

<style scoped>
.convlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.convlist-toolbar {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.convlist-search {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: #fff;
  font: 13px/1.3 system-ui, sans-serif;
  padding: 6px 10px;
  outline: 0;
  transition: border-color 120ms ease, background 120ms ease;
}
.convlist-search:focus {
  border-color: rgba(127, 220, 255, 0.55);
  background: rgba(255, 255, 255, 0.09);
}
.convlist-search::placeholder {
  color: rgba(255, 255, 255, 0.38);
}

.convlist-new {
  -webkit-app-region: no-drag;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 0;
  background: #22c55e;
  color: #08160c;
  font: 700 18px/1 system-ui, sans-serif;
  cursor: pointer;
  transition: background 120ms ease, transform 120ms ease;
  flex-shrink: 0;
}
.convlist-new:hover { background: #16a34a; }
.convlist-new:active { transform: scale(0.96); }

.convlist-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.convlist-scroll::-webkit-scrollbar { width: 6px; }
.convlist-scroll::-webkit-scrollbar-track { background: transparent; }
.convlist-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}

.convlist-empty {
  padding: 24px 12px;
  color: rgba(255, 255, 255, 0.45);
  font: 12px/1.4 system-ui, sans-serif;
  text-align: center;
}
</style>
