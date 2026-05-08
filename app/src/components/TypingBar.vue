<template>
  <div v-if="visible" class="typing-bar-overlay" @click.self="close">
    <div class="typing-bar">
      <input
        ref="inputEl"
        v-model="value"
        :placeholder="placeholder"
        autofocus
        spellcheck="false"
        @keydown.enter.prevent="submit"
        @keydown.escape.prevent="close"
      />
      <button class="typing-bar-send" :disabled="!value.trim()" @click="submit">
        Send
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue';

import { eventBus } from '../boot/event-bus';

const visible = ref(false);
const value = ref('');
const placeholder = 'Talk to Hermes…';
const inputEl = ref<HTMLInputElement | null>(null);

function open() {
  visible.value = true;
  void nextTick(() => inputEl.value?.focus());
}

function close() {
  visible.value = false;
  value.value = '';
}

function submit() {
  const text = value.value.trim();
  if (!text) return;
  eventBus.emit({
    type: 'user.input.text',
    ts: Date.now(),
    payload: { text, source: 'typingbar' },
  });
  close();
}

watch(visible, (v) => {
  if (v) void nextTick(() => inputEl.value?.focus());
});

defineExpose({ open, close, toggle: () => (visible.value ? close() : open()) });
</script>

<style scoped>
.typing-bar-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
  z-index: 100;
}

.typing-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(720px, 80vw);
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(20, 20, 20, 0.95);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}

.typing-bar input {
  flex: 1;
  background: transparent;
  color: #fff;
  border: 0;
  outline: 0;
  font: 16px/1 system-ui, sans-serif;
  padding: 8px 4px;
}

.typing-bar input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.typing-bar-send {
  background: #22c55e;
  color: #08160c;
  border: 0;
  border-radius: 8px;
  padding: 8px 14px;
  font: 600 13px/1 system-ui, sans-serif;
  cursor: pointer;
}

.typing-bar-send:disabled {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.3);
  cursor: not-allowed;
}
</style>
