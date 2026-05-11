<template>
  <div class="canvas-shell" @click.self="closeWindow">
    <div class="canvas-card" @click="onAnchorClick" @auxclick="onAnchorClick">
      <header class="canvas-titlebar">
        <span class="canvas-titlebar-grip" aria-hidden="true">⋮⋮</span>
        <span class="canvas-titlebar-text">
          <template v-if="active">
            {{ active.title || prettyKind }}
          </template>
          <template v-else>Canvas</template>
        </span>
        <span class="canvas-titlebar-pos" v-if="list.length > 0">
          {{ position }} / {{ list.length }}
        </span>
        <button
          class="canvas-titlebar-btn"
          :disabled="!canPrev"
          title="Previous (←)"
          @click="prev"
        >‹</button>
        <button
          class="canvas-titlebar-btn"
          :disabled="!canNext"
          title="Next (→)"
          @click="next"
        >›</button>
        <span class="canvas-titlebar-sep" aria-hidden="true">·</span>
        <button
          class="canvas-titlebar-btn"
          :disabled="!canZoomOut"
          title="Zoom out (⌘−)"
          @click="zoomOut"
        >−</button>
        <button
          class="canvas-titlebar-btn canvas-titlebar-zoom"
          title="Reset zoom (⌘0)"
          @click="resetZoom"
        >{{ Math.round(zoom * 100) }}%</button>
        <button
          class="canvas-titlebar-btn"
          :disabled="!canZoomIn"
          title="Zoom in (⌘+)"
          @click="zoomIn"
        >+</button>
        <span class="canvas-titlebar-sep" aria-hidden="true">·</span>
        <button
          class="canvas-titlebar-btn"
          title="Download"
          :disabled="!active"
          @click="download"
        >⤓</button>
        <button
          class="canvas-titlebar-btn canvas-titlebar-close"
          title="Close (Esc)"
          @click="closeWindow"
        >×</button>
      </header>
      <div class="canvas-body">
        <!-- The zoom-aware wrapper. Browser-native CSS `zoom` (Chromium-
             supported) scales everything inside — text, SVGs, charts, and
             iframes — without needing per-renderer logic. Layout reflows
             cleanly so scrollbars adjust correctly when an artifact gets
             bigger than the viewport. -->
        <div
          v-if="active"
          class="canvas-zoom"
          :style="{ zoom: zoom }"
        >
          <ArtifactRenderer :artifact="active" />
        </div>
        <div v-else class="canvas-empty">
          No artifacts yet. When the assistant produces visual content,
          it'll show up here automatically.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';

import ArtifactRenderer from '../components/artifacts/ArtifactRenderer.vue';
import { useArtifactsStore } from '../stores/artifacts';
import type { ArtifactKind } from '../stores/artifact-types';

const artifacts = useArtifactsStore();

// ─── zoom ─────────────────────────────────────────────────────────────
//
// CSS `zoom` (Chromium-supported, used by Electron's webview) scales the
// artifact's whole subtree — text, SVG charts, mermaid diagrams, iframes,
// images — without needing per-renderer code. The titlebar shows the
// percent and offers click controls; ⌘+ / ⌘− / ⌘0 also work.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.15;

const zoom = ref<number>(1);
const canZoomIn  = computed(() => zoom.value < ZOOM_MAX - 0.001);
const canZoomOut = computed(() => zoom.value > ZOOM_MIN + 0.001);

function clampZoom(v: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v * 100) / 100));
}
function zoomIn():    void { zoom.value = clampZoom(zoom.value + ZOOM_STEP); }
function zoomOut():   void { zoom.value = clampZoom(zoom.value - ZOOM_STEP); }
function resetZoom(): void { zoom.value = 1; }
const list = computed(() => artifacts.list);
const active = computed(() => artifacts.active);

const KIND_LABELS: Record<ArtifactKind, string> = {
  image: 'Image', video: 'Video', audio: 'Audio',
  text: 'Text', code: 'Code', chart: 'Chart',
  diagram: 'Diagram', visual: 'Visual',
};
const prettyKind = computed(() => active.value ? KIND_LABELS[active.value.kind] : '');

const activeIndex = computed(() => {
  if (!active.value) return -1;
  return list.value.findIndex((a) => a.id === active.value!.id);
});
const position = computed(() => activeIndex.value >= 0 ? activeIndex.value + 1 : 0);
const canPrev = computed(() => activeIndex.value > 0);
const canNext = computed(() => activeIndex.value >= 0 && activeIndex.value < list.value.length - 1);

async function prev(): Promise<void> {
  if (!canPrev.value) return;
  await artifacts.setActive(list.value[activeIndex.value - 1]!.id);
}
async function next(): Promise<void> {
  if (!canNext.value) return;
  await artifacts.setActive(list.value[activeIndex.value + 1]!.id);
}

async function download(): Promise<void> {
  if (!active.value) return;
  await artifacts.download(active.value.id);
}

function closeWindow(): void {
  window.close();
}

// Delegated handler: catch clicks (incl. middle-click via auxclick) on any
// <a href> anywhere inside the canvas card and route them to the system
// browser via the preload bridge. The bridge filters to http/https/mailto.
// Runs via event delegation so it covers links inside any artifact renderer
// (text, code, mermaid, chart tooltips, etc.) without each one wiring its
// own handler.
function onAnchorClick(e: MouseEvent): void {
  // Ignore right-click / modifier-click / non-primary button-2; let the
  // default behaviour (context menu, new tab) be a no-op rather than
  // silently swallowing.
  if (e.button !== 0 && e.button !== 1) return;
  const target = e.target as HTMLElement | null;
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  void window.faceplate?.platform.openExternal(href);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeWindow(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); void prev(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); void next(); return; }
  // Zoom shortcuts. Cmd on macOS, Ctrl elsewhere.  `=` covers Cmd+= for
  // unshifted-plus on US keyboards (which is how most browsers handle it).
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomIn();    return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomOut();   return; }
  if (mod && e.key === '0')                    { e.preventDefault(); resetZoom(); return; }
}

// Reset zoom when the user navigates to a different artifact — otherwise
// a 200% zoom on a tall code listing carries over to a small image and
// looks bizarre.
watch(() => artifacts.active?.id, () => { resetZoom(); });

let detachFocus: (() => void) | null = null;
let detachChanged: (() => void) | null = null;

onMounted(async () => {
  document.body.classList.add('faceplate-canvas');
  await artifacts.refreshList();
  // If main fired a focus IPC before we mounted (e.g. window opened with
  // an artifact id), it'll arrive on the next tick — onFocus handles it.
  // Otherwise default to the most recent artifact (sorted by created_at).
  if (!active.value && list.value.length > 0) {
    await artifacts.setActive(list.value[0]!.id);
  }

  const fp = window.faceplate;
  if (fp) {
    detachFocus = fp.artifacts.onFocus((id) => {
      void artifacts.setActive(id);
    });
    detachChanged = fp.artifacts.onChanged((msg) => {
      artifacts.applyChanged(msg);
    });
  }
  window.addEventListener('keydown', onKey);
});

watch(
  () => list.value.length,
  (next, prev) => {
    // When the very first artifact appears (or any new one), if nothing's
    // currently focused, jump to it.
    if (next > prev && !active.value && list.value.length > 0) {
      void artifacts.setActive(list.value[0]!.id);
    }
  },
);

onBeforeUnmount(() => {
  document.body.classList.remove('faceplate-canvas');
  detachFocus?.();
  detachChanged?.();
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
.canvas-shell {
  width: 100vw;
  height: 100vh;
  padding: 12px;
  box-sizing: border-box;
  background: transparent;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
}

.canvas-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(14, 16, 22, 0.92);
  border-radius: 14px;
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  backdrop-filter: blur(16px) saturate(120%);
  overflow: hidden;
  color: #f4f5f8;
}

.canvas-titlebar {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 6px 0 12px;
  background: rgba(0, 0, 0, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.canvas-titlebar-grip {
  font: 14px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.32);
  letter-spacing: -2px;
  user-select: none;
}

.canvas-titlebar-text {
  flex: 1;
  font: 600 13px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.canvas-titlebar-pos {
  font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.45);
  margin-right: 4px;
}

.canvas-titlebar-btn {
  -webkit-app-region: no-drag;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.7);
  font: 16px/1 system-ui, sans-serif;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.canvas-titlebar-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.canvas-titlebar-btn:disabled {
  color: rgba(255, 255, 255, 0.22);
  cursor: not-allowed;
}
.canvas-titlebar-close:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.4);
  color: #fff;
}

.canvas-titlebar-sep {
  color: rgba(255, 255, 255, 0.18);
  font: 14px/1 system-ui, sans-serif;
  user-select: none;
  margin: 0 2px;
}

/* Zoom-percent button is wider than the icon buttons — it shows a
 * 3-character label (e.g. "100%") and acts as the "reset to 100%" tap. */
.canvas-titlebar-zoom {
  width: auto;
  min-width: 44px;
  padding: 0 8px;
  font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.78);
}
.canvas-titlebar-zoom:hover:not(:disabled) {
  color: #7fdcff;
}

.canvas-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: auto;
  padding: 12px;
}

/* Zoom wrapper — flexes to fill the body so the artifact has the same
 * box it had pre-zoom. CSS `zoom` reflows children so scrollbars on the
 * canvas-body parent kick in once content exceeds the viewport. */
.canvas-zoom {
  flex: 1;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  min-width: 0;
  min-height: 0;
}

.canvas-empty {
  margin: auto;
  max-width: 360px;
  text-align: center;
  font: 13px/1.5 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.45);
  padding: 0 24px;
}
</style>

<style>
body.faceplate-canvas,
body.faceplate-canvas #q-app {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
html:has(body.faceplate-canvas) {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
</style>
