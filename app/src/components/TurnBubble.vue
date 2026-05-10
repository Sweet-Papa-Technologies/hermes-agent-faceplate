<template>
  <div class="turn" :class="`turn-${turn.role}`">
    <div class="turn-meta">
      <span class="turn-role">{{ roleLabel }}</span>
      <span class="turn-time">{{ formatTime(turn.ts) }}</span>
    </div>
    <div
      v-if="turn.role === 'assistant'"
      class="turn-bubble turn-bubble-assistant"
      v-html="rendered"
    />
    <div v-else class="turn-bubble turn-bubble-user">
      {{ turn.text }}
    </div>
    <div v-if="turnArtifacts.length" class="turn-artifacts">
      <ArtifactThumbnail
        v-for="entry in turnArtifacts"
        :key="entry.id"
        :entry="entry"
      />
    </div>
    <div v-if="turn.tool_calls?.length" class="turn-tools">
      <ToolCallCard v-for="(tc, i) in turn.tool_calls" :key="i" :call="tc" />
    </div>
    <div v-if="turn.error" class="turn-error">{{ turn.error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import ToolCallCard from './ToolCallCard.vue';
import ArtifactThumbnail from './ArtifactThumbnail.vue';
import type { PersistedTurn } from '../stores/conversation-types';
import { useArtifactsStore } from '../stores/artifacts';

const props = defineProps<{ turn: PersistedTurn }>();
const artifacts = useArtifactsStore();

// Index entries are kept in-store and broadcast across windows; we lookup
// by id rather than refetching. If an id isn't (yet) in the list — e.g.
// freshly created and the broadcast hasn't landed — we just skip it; the
// next refresh will populate.
const turnArtifacts = computed(() => {
  const ids = props.turn.artifact_ids;
  if (!ids || ids.length === 0) return [];
  return ids
    .map((id) => artifacts.list.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => !!a);
});

const roleLabel = computed(() => {
  switch (props.turn.role) {
    case 'user': return 'You';
    case 'assistant': return 'Hermes';
    default: return 'System';
  }
});

marked.setOptions({ gfm: true, breaks: true, async: false });

const rendered = computed<string>(() => {
  if (props.turn.role !== 'assistant') return '';
  const raw = props.turn.text || '';
  if (!raw) return '';
  const html = marked.parse(raw) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'i', 'em', 'strong', 'u', 'code', 'pre', 'br', 'p',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'span', 'div', 'del', 's', 'sub', 'sup', 'kbd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|#|\/|\.{0,2}\/)/i,
  });
});

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
</script>

<style scoped>
.turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 80%;
}
.turn-user { align-self: flex-end; align-items: flex-end; }
.turn-assistant { align-self: flex-start; align-items: flex-start; }
.turn-system { align-self: center; max-width: 90%; }

.turn-meta {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.4);
  padding: 0 6px;
}
.turn-role { font-weight: 600; }

.turn-bubble {
  padding: 10px 14px;
  border-radius: 14px;
  font: 14px/1.5 system-ui, sans-serif;
  word-wrap: break-word;
  white-space: pre-wrap;
  user-select: text;
}
.turn-bubble-user {
  background: rgba(127, 220, 255, 0.12);
  color: #f4f5f8;
  border: 1px solid rgba(127, 220, 255, 0.22);
  border-bottom-right-radius: 4px;
}
.turn-bubble-assistant {
  background: rgba(255, 255, 255, 0.06);
  color: #f4f5f8;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom-left-radius: 4px;
  white-space: normal;
}

.turn-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.turn-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
}

.turn-error {
  font: 12px/1.4 system-ui, sans-serif;
  color: #ff9c9c;
  background: rgba(239, 68, 68, 0.12);
  padding: 6px 10px;
  border-radius: 8px;
}

/* Markdown rendering inside assistant bubbles. */
.turn-bubble-assistant :deep(p) { margin: 0 0 0.5em; }
.turn-bubble-assistant :deep(p:last-child) { margin-bottom: 0; }
.turn-bubble-assistant :deep(strong),
.turn-bubble-assistant :deep(b) { color: #ffe18d; font-weight: 600; }
.turn-bubble-assistant :deep(em),
.turn-bubble-assistant :deep(i) { color: #d4f1ff; font-style: italic; }
.turn-bubble-assistant :deep(a) {
  color: #7fdcff; text-decoration: underline;
  text-decoration-color: rgba(127, 220, 255, 0.5);
}
.turn-bubble-assistant :deep(code) {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.9em;
  padding: 1px 6px;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  color: #b5f3a8;
}
.turn-bubble-assistant :deep(pre) {
  margin: 0.4em 0;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 8px;
  overflow: auto;
}
.turn-bubble-assistant :deep(pre code) {
  padding: 0; background: transparent; color: #e6f5d6;
  font-size: 0.86em; line-height: 1.4; display: block; white-space: pre;
}
.turn-bubble-assistant :deep(ul),
.turn-bubble-assistant :deep(ol) { margin: 0.3em 0 0.5em; padding-left: 1.4em; }
.turn-bubble-assistant :deep(li) { margin: 0.15em 0; }
.turn-bubble-assistant :deep(blockquote) {
  margin: 0.4em 0; padding: 4px 12px;
  border-left: 3px solid rgba(127, 220, 255, 0.55);
  color: rgba(255, 255, 255, 0.82);
  font-style: italic;
}
.turn-bubble-assistant :deep(table) {
  border-collapse: collapse; margin: 0.4em 0; font-size: 0.92em;
}
.turn-bubble-assistant :deep(th),
.turn-bubble-assistant :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 4px 8px; text-align: left;
}
.turn-bubble-assistant :deep(th) { background: rgba(255, 255, 255, 0.08); }
</style>
