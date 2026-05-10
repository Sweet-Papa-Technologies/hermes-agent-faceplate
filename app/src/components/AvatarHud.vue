<template>
  <div class="hud" data-faceplate-hit-region="hud">
    <button
      class="hud-btn hud-menu"
      title="Menu"
      :aria-expanded="menuOpen"
      @click.stop="toggleMenu"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="3" cy="8" r="1.6" fill="currentColor" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        <circle cx="13" cy="8" r="1.6" fill="currentColor" />
      </svg>
    </button>

    <button class="hud-btn hud-close" title="Hide overlay" @click.stop="hide">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M3 3 L13 13 M13 3 L3 13"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        />
      </svg>
    </button>

    <transition name="hud-menu-fade">
      <div v-if="menuOpen" ref="menuEl" class="hud-menu-pop" role="menu">
        <!-- Big touchable size buttons. The corner-drag handles on a
             transparent always-on-top window are hard to grab; this is
             the primary way users resize the overlay. -->
        <div class="hud-size-row">
          <button class="hud-size-btn" title="Smaller" @click.stop="shrink">−</button>
          <button class="hud-size-btn hud-size-reset" title="Reset to default size" @click.stop="reset">Reset</button>
          <button class="hud-size-btn" title="Bigger" @click.stop="grow">+</button>
        </div>
        <div class="hud-menu-sep" />
        <button class="hud-menu-item" @click="run(newConversation)">
          <span class="hud-menu-icon">＋</span>
          New conversation
        </button>
        <button class="hud-menu-item" @click="run(openConversations)">
          <span class="hud-menu-icon">☰</span>
          Conversations…
          <span class="hud-menu-key">⇧⌘J</span>
        </button>
        <button class="hud-menu-item" @click="run(openCanvas)">
          <span class="hud-menu-icon">▦</span>
          Canvas…
          <span class="hud-menu-key">⇧⌘K</span>
        </button>
        <div class="hud-menu-sep" />
        <button class="hud-menu-item" @click="run(openSettings)">
          <span class="hud-menu-icon">⚙</span>
          Settings…
        </button>
        <button class="hud-menu-item" @click="run(hide)">
          <span class="hud-menu-icon">↘</span>
          Hide overlay
          <span class="hud-menu-key">⇧⌘H</span>
        </button>
        <div class="hud-menu-sep" />
        <button class="hud-menu-item hud-menu-item-danger" @click="run(quit)">
          <span class="hud-menu-icon">⏻</span>
          Quit Faceplate
        </button>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';

import { useConversationsStore } from '../stores/conversations';

const convs = useConversationsStore();
const menuOpen = ref(false);
const menuEl = ref<HTMLDivElement | null>(null);

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value;
}

function closeMenu(): void {
  menuOpen.value = false;
}

async function run(fn: () => Promise<void> | void): Promise<void> {
  closeMenu();
  await fn();
}

async function newConversation(): Promise<void> {
  await convs.createNew();
}

async function openConversations(): Promise<void> {
  await window.faceplate?.conversations.togglePanel();
}

async function openCanvas(): Promise<void> {
  await window.faceplate?.artifacts.openCanvas();
}

async function openSettings(): Promise<void> {
  await window.faceplate?.window.openSettings();
}

async function hide(): Promise<void> {
  await window.faceplate?.window.showHide('hide');
}

async function quit(): Promise<void> {
  if (!window.confirm('Quit HermesAgent Faceplate?')) return;
  await window.faceplate?.window.quit();
}

// Width steps; height re-fits via the ResizeObserver in OverlayPage.
async function grow(): Promise<void> {
  await window.faceplate?.window.resizeBy(60);
}
async function shrink(): Promise<void> {
  await window.faceplate?.window.resizeBy(-60);
}
async function reset(): Promise<void> {
  await window.faceplate?.window.resetSize();
}

// Click-anywhere-else closes the menu — the popup mounts inside the
// avatar window's DOM so a global mousedown listener catches outside taps.
function onDocClick(e: MouseEvent): void {
  if (!menuOpen.value) return;
  const target = e.target as Node | null;
  if (menuEl.value && target && menuEl.value.contains(target)) return;
  closeMenu();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && menuOpen.value) {
    e.preventDefault();
    closeMenu();
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
/* Position absolute over the avatar bounding box. The HUD belongs to the
 * `.avatar-root` slot (which is now `position: relative` for this anchor). */
.hud {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  z-index: 20;
  pointer-events: none; /* re-enabled per-button below; click-through everywhere else */
  opacity: 0;
  transition: opacity 180ms ease;
}

/* Show on hover anywhere in the avatar slot. The parent .avatar-root
 * matches; we use a synthetic :has() so the HUD is independent of
 * mouse position over the buttons themselves. Falls back to .hud:hover
 * (so once you've reached a button it stays visible). */
.avatar-root:hover .hud,
.hud:hover,
.hud:focus-within {
  opacity: 1;
}

.hud-btn {
  pointer-events: auto;
  -webkit-app-region: no-drag;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 20, 22, 0.78);
  color: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.hud-btn:hover {
  background: rgba(40, 40, 44, 0.9);
  color: #fff;
  transform: scale(1.05);
}
.hud-close:hover {
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
  border-color: rgba(239, 68, 68, 0.5);
}

/* ─── menu popup ─── */
.hud-menu-pop {
  pointer-events: auto;
  position: absolute;
  top: 32px;
  left: 0;
  min-width: 220px;
  background: rgba(16, 16, 18, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
  z-index: 30;
}

.hud-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: #f4f5f8;
  font: 12px/1.3 system-ui, sans-serif;
  cursor: pointer;
  text-align: left;
  transition: background 100ms ease;
}
.hud-menu-item:hover {
  background: rgba(127, 220, 255, 0.14);
}
.hud-menu-item-danger:hover {
  background: rgba(239, 68, 68, 0.22);
  color: #ffd2d2;
}

.hud-menu-icon {
  width: 18px;
  font: 13px/1 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
}
.hud-menu-item:hover .hud-menu-icon {
  color: #fff;
}
.hud-menu-key {
  margin-left: auto;
  font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.4);
}

.hud-menu-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.07);
  margin: 4px 6px;
}

/* Size-control row at the top of the menu. Three big touchable buttons —
 * the corner-drag resize handles on a transparent always-on-top window
 * are notoriously hard to grab, so this is the primary sizing control. */
.hud-size-row {
  display: flex;
  gap: 6px;
  padding: 4px 6px 6px;
}
.hud-size-btn {
  flex: 1;
  height: 32px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  border-radius: 6px;
  font: 700 16px/1 system-ui, sans-serif;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 100ms ease, transform 100ms ease, border-color 100ms ease;
}
.hud-size-btn:hover {
  background: rgba(127, 220, 255, 0.18);
  border-color: rgba(127, 220, 255, 0.45);
  color: #fff;
}
.hud-size-btn:active {
  transform: scale(0.96);
}
.hud-size-reset {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
}

.hud-menu-fade-enter-active,
.hud-menu-fade-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}
.hud-menu-fade-enter-from,
.hud-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
