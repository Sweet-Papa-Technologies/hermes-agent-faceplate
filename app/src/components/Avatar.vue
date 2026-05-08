<template>
  <div
    ref="rootEl"
    :class="['avatar-root', { 'is-dragging': dragging }]"
    @mousedown.prevent="onMouseDown"
  >
    <svg
      v-if="manifest"
      class="avatar-svg"
      :viewBox="`0 0 ${manifest.canvas.width} ${manifest.canvas.height}`"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <StateRing />
      <g class="avatar-head" v-html="headSvg" />
      <VisemeMouth />
    </svg>
    <div v-else class="avatar-loading">
      {{ theme.loadError ?? 'Loading avatar…' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watchEffect } from 'vue';

import StateRing from './StateRing.vue';
import VisemeMouth from './VisemeMouth.vue';
import { useThemeStore } from '../stores/theme';
import { useSettingsStore } from '../stores/settings';

const theme = useThemeStore();
const settings = useSettingsStore();

const manifest = computed(() => theme.loaded?.manifest);
const headSvg = computed(() => theme.loaded?.svg.head ?? '');

const rootEl = ref<HTMLDivElement | null>(null);

// Per-pixel hit testing for transparent overlay click-through.
//
// Approach: in overlay mode we tell main `setIgnoreMouseEvents(true,
// {forward:true})` once at mount, then on every mousemove we report whether
// the cursor is inside the avatar's circular bounds. Main flips
// click-through accordingly. This is the polling pattern the design doc
// references (electron/electron#1335).
let detachMouse: (() => void) | null = null;

function isInsideAvatar(clientX: number, clientY: number): boolean {
  const el = rootEl.value;
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const r = Math.min(rect.width, rect.height) / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  return dx * dx + dy * dy <= r * r;
}

watchEffect(() => {
  // Re-attach when mode flips. detachMouse cleanup runs first.
  detachMouse?.();
  detachMouse = null;

  if (!window.faceplate) return;
  if (settings.settings.avatar.mode !== 'overlay') {
    void window.faceplate.window.setClickThrough(false);
    return;
  }
  if (!settings.settings.avatar.click_through_default) {
    void window.faceplate.window.setClickThrough(false);
    return;
  }

  void window.faceplate.window.setClickThrough(true);

  let lastInside: boolean | null = null;
  const onMove = (e: MouseEvent) => {
    const inside = isInsideAvatar(e.clientX, e.clientY);
    if (inside !== lastInside) {
      lastInside = inside;
      void window.faceplate?.window.reportHitRegion(inside);
    }
  };
  window.addEventListener('mousemove', onMove);
  detachMouse = () => window.removeEventListener('mousemove', onMove);
});

// Drag-to-move (overlay mode only — windowed mode uses the OS title bar).
//
// Drag from anywhere inside the avatar bubble. There are no clickable
// elements inside the avatar yet; this halo-drag covers the entire shape
// and avoids the `-webkit-app-region: drag` foot-guns that would also
// disable click events.
const dragging = ref(false);

function onMouseDown(e: MouseEvent): void {
  if (settings.settings.avatar.mode !== 'overlay') return;
  if (e.button !== 0) return;
  if (!isInsideAvatar(e.clientX, e.clientY)) return;
  dragging.value = true;
  let lastX = e.screenX;
  let lastY = e.screenY;

  const onMove = (ev: MouseEvent) => {
    const dx = ev.screenX - lastX;
    const dy = ev.screenY - lastY;
    lastX = ev.screenX;
    lastY = ev.screenY;
    if (dx !== 0 || dy !== 0) void window.faceplate?.window.moveBy(dx, dy);
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

onMounted(() => {
  if (!theme.loaded && settings.loaded) {
    void theme.load(settings.settings.avatar.theme);
  }
});

onBeforeUnmount(() => {
  detachMouse?.();
});
</script>

<style scoped>
.avatar-root {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--faceplate-bg, transparent);
  filter: var(--faceplate-card, none);
}

:root[data-mode='windowed'] .avatar-root {
  background: var(--faceplate-bg, #1a1a1a);
}

.avatar-svg {
  width: 100%;
  height: 100%;
  max-width: 320px;
  max-height: 320px;
}

.avatar-loading {
  font: 13px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.6);
}

.avatar-root.is-dragging {
  cursor: grabbing;
}

.avatar-root {
  cursor: grab;
}

:root[data-mode='windowed'] .avatar-root {
  cursor: default;
}
</style>
