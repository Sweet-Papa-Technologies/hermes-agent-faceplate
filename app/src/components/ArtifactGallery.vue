<template>
  <div class="art-gallery">
    <div class="art-gallery-controls">
      <label class="art-scope">
        <input type="checkbox" v-model="allConversations" />
        All conversations
      </label>
      <span class="art-count">
        {{ visible.length }} {{ visible.length === 1 ? 'artifact' : 'artifacts' }}
      </span>
    </div>
    <div v-if="visible.length === 0" class="art-gallery-empty">
      No artifacts yet. Visualizations the assistant generates will land here.
    </div>
    <div v-else class="art-grid">
      <div
        v-for="entry in visible"
        :key="entry.id"
        class="art-card"
        :class="`kind-${entry.kind}`"
        @click="open(entry.id)"
      >
        <div class="art-card-icon">{{ icon(entry.kind) }}</div>
        <div class="art-card-body">
          <div class="art-card-title">{{ entry.title || prettyKind(entry.kind) }}</div>
          <div v-if="entry.preview" class="art-card-preview">{{ entry.preview }}</div>
          <div class="art-card-meta">
            <span>{{ prettyKind(entry.kind) }}</span>
            <span>·</span>
            <span>{{ formatTime(entry.created_at) }}</span>
            <span v-if="!conversationsById.get(entry.conversation_id)?.title === false" class="art-card-conv">
              · {{ conversationsById.get(entry.conversation_id)?.title ?? entry.conversation_id.slice(0, 6) }}
            </span>
          </div>
        </div>
        <button
          class="art-card-delete"
          title="Delete artifact"
          @click.stop="remove(entry.id)"
        >✕</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { useArtifactsStore } from '../stores/artifacts';
import { useConversationsStore } from '../stores/conversations';

const artifacts = useArtifactsStore();
const convs = useConversationsStore();
const allConversations = ref<boolean>(false);

const conversationsById = computed(() => {
  const m = new Map<string, typeof convs.list[number]>();
  for (const c of convs.list) m.set(c.id, c);
  return m;
});

const visible = computed(() => {
  if (allConversations.value || !convs.activeId) return artifacts.list;
  return artifacts.list.filter((a) => a.conversation_id === convs.activeId);
});

function prettyKind(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}
function icon(k: string): string {
  const ICON: Record<string, string> = {
    image: '🖼', video: '▶', audio: '♪', text: '¶',
    code: '〈/〉', chart: '📊', diagram: '◆', visual: '✦',
  };
  return ICON[k] ?? '◇';
}
function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function open(id: string): Promise<void> {
  await artifacts.openInCanvas(id);
}

async function remove(id: string): Promise<void> {
  if (!window.confirm('Delete this artifact? The body file will be removed from disk.')) return;
  await artifacts.remove(id);
}
</script>

<style scoped>
.art-gallery {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.18) transparent;
}
.art-gallery::-webkit-scrollbar { width: 8px; }
.art-gallery::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }

.art-gallery-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}
.art-scope {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 12px/1 system-ui, sans-serif;
  color: rgba(255,255,255,0.78);
  cursor: pointer;
  user-select: none;
}
.art-scope input { accent-color: #7fdcff; }
.art-count {
  margin-left: auto;
  font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,0.45);
}

.art-gallery-empty {
  margin: 60px auto;
  max-width: 360px;
  text-align: center;
  font: 13px/1.5 system-ui, sans-serif;
  color: rgba(255,255,255,0.4);
}

.art-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.art-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
  position: relative;
}
.art-card:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(127,220,255,0.4);
}
.art-card:active { transform: scale(0.99); }

.art-card-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(127,220,255,0.12);
  font-size: 18px;
  color: #d6f1ff;
  flex-shrink: 0;
}
.art-card.kind-image  .art-card-icon { background: rgba(168, 85, 247, 0.18); color: #f0e0ff; }
.art-card.kind-video  .art-card-icon { background: rgba(239, 68, 68, 0.18); color: #ffd6d6; }
.art-card.kind-audio  .art-card-icon { background: rgba(245, 158, 11, 0.18); color: #ffe8b3; }
.art-card.kind-code   .art-card-icon { background: rgba(34, 197, 94, 0.18); color: #c8f5cf; }
.art-card.kind-visual .art-card-icon { background: rgba(168, 85, 247, 0.18); color: #f0e0ff; }

.art-card-body {
  flex: 1;
  min-width: 0;
}
.art-card-title {
  font: 600 13px/1.3 system-ui, sans-serif;
  color: #f4f5f8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.art-card-preview {
  font: 12px/1.4 system-ui, sans-serif;
  color: rgba(255,255,255,0.55);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.art-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,0.4);
  margin-top: 6px;
}

.art-card-delete {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: 0;
  color: rgba(255,255,255,0.3);
  font: 11px/1 system-ui, sans-serif;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}
.art-card:hover .art-card-delete { opacity: 1; }
.art-card-delete:hover { background: rgba(239,68,68,0.25); color: #ffd2d2; }
</style>
