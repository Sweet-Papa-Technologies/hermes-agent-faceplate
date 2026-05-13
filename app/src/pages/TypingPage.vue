<template>
  <div class="typing-shell" @click="cancel">
    <div class="typing-card" @click.stop>
      <input
        ref="inputEl"
        v-model="value"
        :placeholder="placeholder"
        autofocus
        spellcheck="false"
        @keydown.enter.prevent="submit"
        @keydown.escape.prevent="cancel"
      />
      <button class="typing-send" :disabled="!value.trim()" @click="submit">
        Send
      </button>
    </div>
    <p class="typing-hint">Enter to send · Esc to cancel</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';

const value = ref('');
const placeholder = 'Talk to Hermes…';
const inputEl = ref<HTMLInputElement | null>(null);

let offOpened: (() => void) | null = null;

function focus(): void {
  void nextTick(() => inputEl.value?.focus());
}

function submit(): void {
  const text = value.value.trim();
  if (!text) return;
  window.faceplate?.typingBar.submit(text);
  value.value = '';
  // Main hides the window on dispatch; clearing the value here means the
  // next open starts fresh.
}

function cancel(): void {
  value.value = '';
  window.faceplate?.typingBar.cancel();
}

onMounted(() => {
  // Mark the host document so our non-scoped style block can target it
  // without bleeding into other windows that may share the same bundle.
  document.body.classList.add('faceplate-typing-bar');
  focus();
  // The main process re-shows the window on subsequent hotkey presses
  // without recreating it, so we listen for the opened ping to refocus.
  offOpened = window.faceplate?.typingBar.onOpened(() => {
    value.value = '';
    focus();
  }) ?? null;
});

onBeforeUnmount(() => {
  document.body.classList.remove('faceplate-typing-bar');
  offOpened?.();
});
</script>

<style scoped>
/* Full-window content. The host window is frameless + transparent (set in
 * main's createTypingBarWindow) so this layout fills the entire native
 * window. The card itself has the visible chrome. */
.typing-shell {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 0;
  background: transparent;
  overflow: hidden;
  /* Whole window is a drag region — grab anywhere to move. The input and
   * send button below override with no-drag so they remain interactive. */
  -webkit-app-region: drag;
}

.typing-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px 18px;
  border-radius: 16px;
  background: rgba(20, 20, 22, 0.92);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.5),
    0 2px 0 rgba(255, 255, 255, 0.05) inset;
  backdrop-filter: blur(18px) saturate(120%);
  -webkit-app-region: drag;
  box-sizing: border-box;
  /* Cycling rainbow border. The card sits on top of a slightly larger
   * conic-gradient pseudo-element, masked to a ring shape via padding +
   * border-radius math. Animation rotates the gradient hue around the
   * border once every 6 seconds. */
  position: relative;
  z-index: 0;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.typing-card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  background: conic-gradient(
    from var(--rainbow-angle, 0deg),
    #ff5e7e, #ff9c4a, #ffe14a, #5ee27a, #5ec8ff, #b078ff, #ff5ec8, #ff5e7e
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  z-index: -1;
  animation: rainbow-spin 6s linear infinite;
}

/* Custom property animation needs @property declaration for interpolation
 * across browsers; without it Chromium still animates the gradient via the
 * fallback CSS animation defined below. */
@property --rainbow-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes rainbow-spin {
  to { --rainbow-angle: 360deg; }
}

.typing-card input {
  flex: 1;
  background: transparent;
  color: #fff;
  border: 0;
  outline: 0;
  font: 22px/1.2 system-ui, sans-serif;
  padding: 10px 4px;
  letter-spacing: 0.01em;
  -webkit-app-region: no-drag;
}

.typing-card input::placeholder {
  color: rgba(255, 255, 255, 0.42);
}

.typing-send {
  background: #22c55e;
  color: #08160c;
  border: 0;
  border-radius: 10px;
  padding: 10px 18px;
  font: 600 14px/1 system-ui, sans-serif;
  cursor: pointer;
  transition: background 120ms ease, opacity 120ms ease;
  -webkit-app-region: no-drag;
}

.typing-send:hover:not(:disabled) {
  background: #16a34a;
}

.typing-send:disabled {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.3);
  cursor: not-allowed;
}

.typing-hint {
  margin: 8px 0 0;
  color: rgba(255, 255, 255, 0.5);
  font: 11px/1.4 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  -webkit-app-region: no-drag;
}
</style>

<!--
  Non-scoped overrides for the typing-bar window only. Quasar / Vue add
  default body margins and the layout machinery sets background colors —
  both of which cause an unwanted scrollbar and the dark Quasar app
  background to bleed through the transparent native window. The
  `body.faceplate-typing-bar` gate (toggled in this component's mount /
  unmount) ensures these rules can't affect other windows that share the
  same code bundle.
-->
<style>
body.faceplate-typing-bar,
body.faceplate-typing-bar #q-app {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
html:has(body.faceplate-typing-bar) {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  height: 100%;
}
</style>
