<template>
  <div class="toolcall" :class="`status-${call.status}`">
    <span class="toolcall-icon">{{ statusIcon }}</span>
    <span class="toolcall-name">{{ call.tool }}</span>
    <span v-if="call.args_preview" class="toolcall-args">{{ trimmedArgs }}</span>
    <span class="toolcall-status">{{ call.status }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { PersistedToolCall } from '../stores/conversation-types';

const props = defineProps<{ call: PersistedToolCall }>();

const statusIcon = computed(() => {
  switch (props.call.status) {
    case 'completed': return '✓';
    case 'failed': return '✗';
    case 'started':
    default: return '⚙';
  }
});

const trimmedArgs = computed(() => {
  const oneline = props.call.args_preview.replace(/\s+/g, ' ').trim();
  return oneline.length > 120 ? oneline.slice(0, 117) + '…' : oneline;
});
</script>

<style scoped>
.toolcall {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.32);
  border-radius: 8px;
  font: 11px/1.3 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.toolcall.status-started   { border-color: rgba(245, 158, 11, 0.45); }
.toolcall.status-completed { border-color: rgba(34, 197, 94, 0.45); }
.toolcall.status-failed    { border-color: rgba(239, 68, 68, 0.45); }

.toolcall-icon { font-size: 12px; flex-shrink: 0; }
.toolcall.status-started .toolcall-icon {
  animation: tool-spin 1.4s linear infinite;
  display: inline-block;
}
@keyframes tool-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.toolcall-name {
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.toolcall-args {
  flex: 1;
  min-width: 0;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolcall-status {
  flex-shrink: 0;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.55);
}
.toolcall.status-completed .toolcall-status { color: rgba(34, 197, 94, 0.92); }
.toolcall.status-failed .toolcall-status    { color: rgba(239, 68, 68, 0.92); }
.toolcall.status-started .toolcall-status   { color: rgba(245, 158, 11, 0.92); }
</style>
