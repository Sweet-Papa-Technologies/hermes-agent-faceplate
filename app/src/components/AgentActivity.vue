<template>
  <transition name="activity-fade">
    <div v-if="activity" class="activity">
      <span class="activity-spinner" aria-hidden="true">
        <span v-for="i in 3" :key="i" class="activity-dot" :style="{ animationDelay: `${i * 120}ms` }" />
      </span>
      <span class="activity-label">{{ activity.label }}</span>
      <span v-if="activity.detail" class="activity-detail">{{ trimDetail(activity.detail) }}</span>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useAgentStore } from '../stores/agent';
import { useConversationStore } from '../stores/conversation';

const agent = useAgentStore();
const convo = useConversationStore();
const { activity } = storeToRefs(agent);
const { captionText } = storeToRefs(convo);

// Hide activity once the assistant has produced any visible text — the
// captions are the user's primary signal at that point. Reasoning loops
// re-show it via setActivity() if more reasoning tokens come through.
const _show = computed(() => activity.value && !captionText.value);
void _show; // referenced via template guard above

function trimDetail(d: string): string {
  const oneline = d.replace(/\s+/g, ' ').trim();
  return oneline.length > 60 ? oneline.slice(0, 57) + '…' : oneline;
}
</script>

<style scoped>
.activity {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  padding: 5px 12px;
  background: rgba(20, 20, 22, 0.85);
  color: rgba(255, 255, 255, 0.92);
  border-radius: 999px;
  border: 1px solid rgba(127, 220, 255, 0.32);
  font: 11px/1.3 'JetBrains Mono', ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 92%;
  pointer-events: none;
  backdrop-filter: blur(4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.activity-spinner {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  height: 8px;
}
.activity-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(127, 220, 255, 0.85);
  animation: activity-bounce 1200ms ease-in-out infinite;
}
@keyframes activity-bounce {
  0%, 80%, 100% { transform: scale(0.4); opacity: 0.4; }
  40%           { transform: scale(1);   opacity: 1; }
}

.activity-label {
  color: #f4f5f8;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.activity-detail {
  color: rgba(255, 255, 255, 0.55);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-fade-enter-active,
.activity-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.activity-fade-enter-from,
.activity-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
