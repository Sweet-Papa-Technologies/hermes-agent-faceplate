<template>
  <q-input
    :model-value="modelValue"
    :label="label"
    filled
    stack-label
    readonly
    :placeholder="recording ? 'Press a key combination…' : 'Click to record'"
    @focus="recording = true"
    @blur="recording = false"
    @keydown.prevent="handleKey"
  >
    <template #append>
      <q-btn flat dense round icon="restart_alt" :title="`Reset to ${defaultValue}`" @click="$emit('update:modelValue', defaultValue)" />
    </template>
  </q-input>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  modelValue: string;
  label: string;
  defaultValue: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const recording = ref(false);

function handleKey(e: KeyboardEvent): void {
  if (!recording.value) return;
  // Ignore pure modifier presses; wait for the actual character key.
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(electronKey(e));
  emit('update:modelValue', parts.join('+'));
  recording.value = false;
  void props; // satisfy unused
}

function electronKey(e: KeyboardEvent): string {
  // Electron's Accelerator format. Letters are uppercase; named keys are
  // mostly the same as DOM names (Enter/Tab/Space/etc.) but a few differ.
  if (e.code.startsWith('Key')) return e.code.slice(3); // KeyA → A
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  switch (e.key) {
    case ' ':
      return 'Space';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'Escape':
      return 'Escape';
    case 'Enter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    default:
      return e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
}
</script>
