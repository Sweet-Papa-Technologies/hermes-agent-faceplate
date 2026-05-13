<template>
  <div
    v-if="visible && shownText"
    class="captions"
    :class="{ 'captions--residual': isResidual }"
    data-faceplate-hit-region="captions"
    @mouseenter="onInteract"
    @mousemove="onInteract"
    @wheel="onInteract"
    @click="onInteract"
  >
    <!-- Auto-close countdown bar. Renders only while a timer is actually
         draining — once the user interacts, the timer is cleared and the
         popup stays open silently (no bar). Fills as time REMAINS,
         draining left-to-right. -->
    <div v-if="showProgress" class="captions-progress">
      <div class="captions-progress-bar" :style="{ transform: `scaleX(${progress})` }" />
    </div>

    <div class="captions-actions">
      <button
        class="captions-btn"
        title="Open conversations"
        @click.stop="openConversations"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M2.5 3.5 H13.5 V10.5 H8 L5 13 V10.5 H2.5 Z"
            fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        class="captions-btn captions-btn-close"
        title="Close"
        @click.stop="closeNow"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M3 3 L13 13 M13 3 L3 13"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <div class="captions-text" v-html="rendered" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { useConversationStore } from '../stores/conversation';
import { useAgentStore } from '../stores/agent';
import { useThemeStore } from '../stores/theme';

const convo = useConversationStore();
const agent = useAgentStore();
const theme = useThemeStore();
const { captionText, captionsVisible, lastAssistant } = storeToRefs(convo);
const { state: agentState } = storeToRefs(agent);

// Marked configuration:
//   - gfm: enables tables / strikethrough / task lists.
//   - breaks: single newlines become <br>, which keeps multi-line streamed
//     deltas readable while the model is still speaking.
//   - async: false so we get a string back synchronously for v-html.
marked.setOptions({ gfm: true, breaks: true, async: false });

// ─── auto-close timing ───────────────────────────────────────────────────
//
// After the agent finishes speaking, the response box stays open for a
// grace window so the user can read it. The countdown:
//   - starts when we transition from speaking/thinking → idle
//   - on user interaction (hover, scroll, click), the timer is *cleared*
//     and the box is "pinned" open — no bar, no auto-close, until the
//     user explicitly hits ✕ (or a new turn replaces it)
//   - hides on expiry OR on close button
//
// Two visibility states besides "live streaming":
//   - residualExpiresAt !== null  → countdown running (progress bar visible)
//   - pinned === true             → user engaged; stay open silently
//
// During both, we show `lastAssistant.text` since currentTurn is null
// after finalize.
const RESIDUAL_MS = 20_000;
const TICK_MS = 100;

const residualExpiresAt = ref<number | null>(null);
const pinned = ref<boolean>(false);
const now = ref<number>(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
// Tracks the *id* of the response the user explicitly closed. Used to
// suppress re-display of the same response if a downstream watcher would
// otherwise pop it back open. Cleared when a brand-new assistant turn lands.
const dismissedTurnId = ref<string | null>(null);

function startTick(): void {
  if (tick) return;
  tick = setInterval(() => {
    now.value = Date.now();
    if (residualExpiresAt.value !== null && now.value >= residualExpiresAt.value) {
      residualExpiresAt.value = null;
      stopTick();
    }
  }, TICK_MS);
}

function stopTick(): void {
  if (!tick) return;
  clearInterval(tick);
  tick = null;
}

function armResidualTimer(): void {
  // Don't auto-pop a response the user just dismissed — wait for the next turn.
  if (dismissedTurnId.value && dismissedTurnId.value === lastAssistant.value?.id) return;
  pinned.value = false;
  residualExpiresAt.value = Date.now() + RESIDUAL_MS;
  now.value = Date.now();
  startTick();
}

function onInteract(): void {
  // User engaged — kill the countdown and pin the box open. No more bar,
  // no auto-close. Mid-stream interactions are a no-op (timer's not running
  // yet); the `pinned` state only takes effect once liveText is gone.
  if (residualExpiresAt.value === null) return;
  residualExpiresAt.value = null;
  stopTick();
  pinned.value = true;
}

function closeNow(): void {
  // Hard-close: hide regardless of whether TTS is mid-stream. We also
  // memo the turn id so that any subsequent state-transition watcher
  // doesn't re-pop the same response. Both the in-flight currentTurn id
  // and the post-finalize lastAssistant id are valid targets — they're the
  // same response, just at different phases. Memo whichever we have.
  dismissedTurnId.value = convo.currentTurn?.id ?? lastAssistant.value?.id ?? null;
  residualExpiresAt.value = null;
  pinned.value = false;
  stopTick();
}

async function openConversations(): Promise<void> {
  await window.faceplate?.conversations.togglePanel();
}

// When the agent's active state transitions away from speaking/thinking and
// we have an assistant reply to show, arm the timer.
watch(
  () => agentState.value,
  (state, prev) => {
    const wasActive = prev === 'speaking' || prev === 'thinking' || prev === 'listening';
    const isActive = state === 'speaking' || state === 'thinking' || state === 'listening';
    if (wasActive && !isActive && lastAssistant.value) {
      armResidualTimer();
    }
    if (isActive) {
      // Activity resumed — drop residual + pin and let live captions take over.
      residualExpiresAt.value = null;
      pinned.value = false;
      stopTick();
    }
  },
);

// Defensive arm: when a brand-new assistant turn lands while the agent is
// already idle (e.g. the canvas window opening races with the speaking→idle
// transition and the watcher above misses it), arm the timer so the response
// pop still appears + counts down. Also clears the dismissed memo so the
// new response isn't suppressed by a stale close.
watch(
  () => lastAssistant.value?.id,
  (id, prevId) => {
    if (!id || id === prevId) return;
    if (dismissedTurnId.value && dismissedTurnId.value !== id) {
      dismissedTurnId.value = null;
    }
    const isActive =
      agentState.value === 'speaking' ||
      agentState.value === 'thinking' ||
      agentState.value === 'listening';
    if (!isActive && residualExpiresAt.value === null && !pinned.value) {
      armResidualTimer();
    }
  },
);

onMounted(() => { now.value = Date.now(); });
onBeforeUnmount(stopTick);

// ─── content selection ───────────────────────────────────────────────────
//
// While there's an in-flight currentTurn, show that. Otherwise, if the
// residual timer is running OR the user pinned the popup open, show the
// last assistant turn. Otherwise hide.
const liveText = computed(() => captionText.value);
const isDismissed = computed(() => {
  const id = dismissedTurnId.value;
  if (!id) return false;
  return id === convo.currentTurn?.id || id === lastAssistant.value?.id;
});
const isResidual = computed(() =>
  !liveText.value && (residualExpiresAt.value !== null || pinned.value),
);
const shownText = computed(() => {
  if (isDismissed.value) return '';
  if (liveText.value) return liveText.value;
  if (residualExpiresAt.value === null && !pinned.value) return '';
  return lastAssistant.value?.text ?? '';
});
const visible = computed(() => captionsVisible.value);

const showProgress = computed(
  () => !liveText.value && residualExpiresAt.value !== null,
);
const progress = computed(() => {
  if (residualExpiresAt.value === null) return 0;
  const remaining = residualExpiresAt.value - now.value;
  return Math.max(0, Math.min(1, remaining / RESIDUAL_MS));
});

const rendered = computed<string>(() => {
  const raw = shownText.value ?? '';
  if (!raw) return '';
  const html = marked.parse(raw) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'i', 'em', 'strong', 'u', 'code', 'pre', 'br', 'p',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'span', 'div', 'del', 's', 'sub', 'sup', 'kbd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|#|\/|\.{0,2}\/)/i,
  });
});

const fontFamily = computed(() => theme.loaded?.manifest.captions?.font_family ?? 'Inter, system-ui, sans-serif');
const fontSize = computed(() => `${theme.loaded?.manifest.captions?.font_size_px ?? 16}px`);
const color = computed(() => theme.loaded?.manifest.captions?.color ?? '#ffffff');
const bg = computed(() => theme.loaded?.manifest.captions?.background ?? 'rgba(8, 12, 18, 0.78)');
const offset = computed(() => `${theme.loaded?.manifest.captions?.bottom_offset_px ?? 24}px`);
</script>

<style scoped>
.captions {
  align-self: stretch;
  margin: 6px 12px v-bind(offset);
  padding: 12px 16px 12px 16px;
  border-radius: 14px;
  font-family: v-bind(fontFamily);
  font-size: v-bind(fontSize);
  line-height: 1.45;
  color: v-bind(color);
  background: v-bind(bg);
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.45),
    0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  backdrop-filter: blur(14px) saturate(125%);
  text-align: left;
  pointer-events: auto;
  user-select: text;
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
  position: relative;
  transition: opacity 200ms ease;
}

/* Subtler fade while the residual timer drains. Visual cue that this is
 * about to disappear; the progress bar at the top provides the actual
 * countdown. */
.captions--residual {
  opacity: 0.92;
}

.captions-progress {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.06);
  border-top-left-radius: 14px;
  border-top-right-radius: 14px;
  overflow: hidden;
}
.captions-progress-bar {
  height: 100%;
  background: linear-gradient(
    90deg,
    rgba(127, 220, 255, 0.85) 0%,
    rgba(127, 220, 255, 0.45) 100%
  );
  transform-origin: left center;
  /* No transition — value updates at TICK_MS (100ms) intervals look
   * smooth enough without animating between frames. */
}

.captions-actions {
  position: absolute;
  top: 6px;
  right: 8px;
  display: flex;
  gap: 4px;
  z-index: 2;
}
.captions-btn {
  pointer-events: auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 100ms ease, color 100ms ease, transform 100ms ease;
  padding: 0;
}
.captions-btn:hover {
  background: rgba(127, 220, 255, 0.22);
  color: #fff;
  transform: scale(1.05);
  border-color: rgba(127, 220, 255, 0.4);
}
.captions-btn-close:hover {
  background: rgba(239, 68, 68, 0.7);
  border-color: rgba(239, 68, 68, 0.4);
}

.captions::-webkit-scrollbar {
  width: 8px;
}
.captions::-webkit-scrollbar-track {
  background: transparent;
}
.captions::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.captions::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.35);
  background-clip: padding-box;
  border: 2px solid transparent;
}

.captions-text :deep(p) {
  margin: 0 0 0.5em;
}
.captions-text :deep(p:last-child) {
  margin-bottom: 0;
}
.captions-text :deep(strong),
.captions-text :deep(b) {
  color: #ffe18d;
  font-weight: 600;
}
.captions-text :deep(em),
.captions-text :deep(i) {
  color: #d4f1ff;
  font-style: italic;
}
.captions-text :deep(a) {
  color: #7fdcff;
  text-decoration: underline;
  text-decoration-color: rgba(127, 220, 255, 0.5);
}
.captions-text :deep(del),
.captions-text :deep(s) {
  color: rgba(255, 255, 255, 0.55);
}
.captions-text :deep(code) {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.9em;
  padding: 1px 6px;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 4px;
  color: #b5f3a8;
}
.captions-text :deep(pre) {
  margin: 0.4em 0;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 8px;
  overflow: auto;
  max-width: 100%;
}
.captions-text :deep(pre code) {
  padding: 0;
  background: transparent;
  color: #e6f5d6;
  font-size: 0.86em;
  line-height: 1.4;
  display: block;
  white-space: pre;
}
.captions-text :deep(ul),
.captions-text :deep(ol) {
  margin: 0.3em 0 0.5em;
  padding-left: 1.4em;
}
.captions-text :deep(li) {
  margin: 0.15em 0;
}
.captions-text :deep(li::marker) {
  color: rgba(255, 255, 255, 0.5);
}
.captions-text :deep(blockquote) {
  margin: 0.4em 0;
  padding: 4px 12px;
  border-left: 3px solid rgba(127, 220, 255, 0.55);
  color: rgba(255, 255, 255, 0.82);
  font-style: italic;
}
.captions-text :deep(h1),
.captions-text :deep(h2),
.captions-text :deep(h3),
.captions-text :deep(h4) {
  margin: 0.5em 0 0.25em;
  font-weight: 600;
  color: #ffffff;
}
.captions-text :deep(h1) { font-size: 1.18em; }
.captions-text :deep(h2) { font-size: 1.10em; }
.captions-text :deep(h3) { font-size: 1.04em; }
.captions-text :deep(h4) { font-size: 1.00em; }
.captions-text :deep(table) {
  border-collapse: collapse;
  margin: 0.4em 0;
  font-size: 0.92em;
}
.captions-text :deep(th),
.captions-text :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 4px 8px;
  text-align: left;
}
.captions-text :deep(th) {
  background: rgba(255, 255, 255, 0.08);
}
.captions-text :deep(hr) {
  border: 0;
  height: 1px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0.6em 0;
}
.captions-text :deep(kbd) {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 5px;
  border-radius: 3px;
  border-bottom: 2px solid rgba(0, 0, 0, 0.4);
  font-size: 0.85em;
}
</style>
