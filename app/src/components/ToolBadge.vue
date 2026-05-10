<template>
  <transition name="tool-badge-fade">
    <div v-if="visibleCall" class="tool-badge" :class="`status-${visibleCall.status}`">
      <span class="tool-badge-icon">{{ statusIcon }}</span>
      <span class="tool-badge-tool">{{ visibleCall.tool }}</span>
      <span v-if="visibleCall.args_preview" class="tool-badge-args">
        {{ trimArgs(visibleCall.args_preview) }}
      </span>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

import { eventBus } from '../boot/event-bus';

interface ToolCall {
  tool: string;
  args_preview: string;
  status: 'started' | 'completed' | 'failed';
  ts: number;
}

const visibleCall = ref<ToolCall | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const statusIcon = computed(() => {
  switch (visibleCall.value?.status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'started':
    default:
      return '⚙';
  }
});

function trimArgs(args: string): string {
  // The args_preview can be a long JSON blob; clip to one short line so the
  // badge stays compact under the avatar.
  const oneline = args.replace(/\s+/g, ' ').trim();
  return oneline.length > 60 ? oneline.slice(0, 57) + '…' : oneline;
}

function showCall(c: ToolCall): void {
  visibleCall.value = c;
  if (hideTimer) clearTimeout(hideTimer);
  // Completed/failed calls auto-fade. Started ones stick until we see a
  // completion or the agent transitions to speaking/idle (handled below).
  if (c.status !== 'started') {
    hideTimer = setTimeout(() => {
      visibleCall.value = null;
    }, 2_500);
  }
}

let off1: (() => void) | null = null;
let off2: (() => void) | null = null;
let off3: (() => void) | null = null;
let off4: (() => void) | null = null;

onMounted(() => {
  off1 = eventBus.on('agent.tool_call', (e) => {
    showCall({
      tool: e.payload.tool,
      args_preview: e.payload.args_preview,
      status: e.payload.status,
      ts: e.ts,
    });
  });
  // Clear the badge once the agent moves on so we don't leave a stale
  // "running" badge stuck after a turn ends.
  const clearOnAdvance = (): void => {
    visibleCall.value = null;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };
  off2 = eventBus.on('agent.response', clearOnAdvance);
  off3 = eventBus.on('agent.interrupt', clearOnAdvance);
  off4 = eventBus.on('tts.audio.end', clearOnAdvance);
});

onBeforeUnmount(() => {
  off1?.();
  off2?.();
  off3?.();
  off4?.();
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<style scoped>
.tool-badge {
  /* Flows inline in the OverlayPage's vertical stack — sits between the
   * avatar and the captions. Centered horizontally inside its strip. */
  align-self: center;
  margin: 6px 0;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  max-width: 90%;
  padding: 4px 10px;
  background: rgba(20, 20, 20, 0.85);
  color: rgba(255, 255, 255, 0.95);
  border-radius: 999px;
  font: 11px/1.3 'JetBrains Mono', ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 10;
  backdrop-filter: blur(4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.tool-badge.status-started {
  border: 1px solid rgba(245, 158, 11, 0.55);
}
.tool-badge.status-completed {
  border: 1px solid rgba(34, 197, 94, 0.55);
}
.tool-badge.status-failed {
  border: 1px solid rgba(239, 68, 68, 0.55);
}

.tool-badge-icon {
  font-size: 12px;
}
.tool-badge.status-started .tool-badge-icon {
  animation: tool-badge-spin 1.4s linear infinite;
  display: inline-block;
}

.tool-badge-tool {
  font-weight: 600;
}

.tool-badge-args {
  opacity: 0.7;
}

.tool-badge-fade-enter-active,
.tool-badge-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.tool-badge-fade-enter-from,
.tool-badge-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@keyframes tool-badge-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
