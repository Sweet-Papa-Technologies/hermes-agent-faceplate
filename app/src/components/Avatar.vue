<template>
  <div
    ref="rootEl"
    :class="['avatar-root', { 'is-dragging': dragging }]"
    @mousedown.prevent="onMouseDown"
  >
    <svg
      v-if="manifest"
      ref="svgEl"
      class="avatar-svg"
      :viewBox="`0 0 ${manifest.canvas.width} ${manifest.canvas.height}`"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <StateRing />
      <g class="avatar-head" v-html="headSvg" />
      <VisemeMouth />
      <!-- Theme-specific FX layer. The Robo theme uses this to overlay
           animated state-tinted eye glow + a live audio waveform inside
           the mouth bezel. Other themes have no overlay. -->
      <RoboFx v-if="manifest?.id === 'robo'" />
      <!--
        Hardcoded mic-active LED — not theme-overridable per design §12.1.
        Visible whenever the renderer holds a live MediaStream from the mic.
      -->
      <g v-if="micActive" class="mic-led" aria-hidden="true">
        <circle cx="220" cy="38" r="9" fill="#22c55e" opacity="0.92" />
        <circle cx="220" cy="38" r="4" fill="#0c5132" />
      </g>
    </svg>
    <div v-else class="avatar-loading">
      {{ theme.loadError ?? 'Loading avatar…' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, watchEffect } from 'vue';

import StateRing from './StateRing.vue';
import VisemeMouth from './VisemeMouth.vue';
import RoboFx from './RoboFx.vue';
import { useThemeStore } from '../stores/theme';
import { useSettingsStore } from '../stores/settings';
import { useAgentStore } from '../stores/agent';

const theme = useThemeStore();
const settings = useSettingsStore();
const agent = useAgentStore();

const manifest = computed(() => theme.loaded?.manifest);
const headSvg = computed(() => theme.loaded?.svg.head ?? '');
const micActive = computed(() => agent.micActive);
const scale = computed(() => settings.settings.avatar.scale);

const rootEl = ref<HTMLDivElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);

// Per-pixel hit testing for transparent overlay click-through.
//
// Approach: in overlay mode we tell main `setIgnoreMouseEvents(true,
// {forward:true})` once at mount, then on every mousemove we report whether
// the cursor is inside the avatar's bounds. Main flips click-through
// accordingly. The hit region tracks the **SVG element**, not the root
// div — the window is taller than the avatar so captions can sit below,
// and clicks in the empty space below the face plate should pass through
// to whatever is behind the overlay.
let detachMouse: (() => void) | null = null;

function isInsideAvatar(clientX: number, clientY: number): boolean {
  // Two interactive regions in this overlay window:
  //   1. The avatar SVG (circular bounds — the face plate).
  //   2. Any element marked `data-faceplate-hit-region` (the captions
  //      panel). These need pointer events so the user can scroll long
  //      replies; without including them here, click-through stays ON
  //      over the captions and the scroll wheel passes through to the
  //      desktop instead of scrolling the panel.
  const svg = svgEl.value;
  if (svg) {
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r = Math.min(rect.width, rect.height) / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      if (dx * dx + dy * dy <= r * r) return true;
    }
  }
  // Hit-region opt-ins (e.g. captions panel) live as siblings of the
  // avatar in the OverlayPage, not as descendants of avatar-root, so we
  // query the whole document. Single window — the marker is unambiguous.
  const regions = document.querySelectorAll<HTMLElement>('[data-faceplate-hit-region]');
  for (const el of regions) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
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

// Live-swap the active theme whenever the user picks a new one in Settings.
// Without this, settings.avatar.theme updates on disk + in the store but
// the avatar window keeps showing the old SVG until restart.
watch(
  () => settings.settings.avatar.theme,
  (next, prev) => {
    if (!next || next === prev) return;
    if (theme.loaded?.manifest.id === next) return;
    void theme.load(next);
  },
);

onBeforeUnmount(() => {
  detachMouse?.();
});
</script>

<style scoped>
.avatar-root {
  /* Sized by the SVG it contains, NOT the full window. The overlay page
   * uses a vertical flex stack: avatar shrinks to its content so the
   * tool-badge + captions flow below without reserving dead space. */
  width: 100%;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
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
  transform: scale(v-bind(scale));
  transform-origin: center;
  transition: transform 200ms ease;
}

.mic-led {
  /* Subtle breathing for the LED to make it noticeable. */
  animation: led-pulse 1500ms ease-in-out infinite;
  transform-origin: 220px 38px;
}

@keyframes led-pulse {
  0%, 100% { opacity: 0.85; }
  50%      { opacity: 1; }
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
