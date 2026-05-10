<template>
  <div v-if="visible && text" class="captions" data-faceplate-hit-region="captions">
    <div class="captions-text" v-html="rendered" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { useConversationStore } from '../stores/conversation';
import { useThemeStore } from '../stores/theme';

const convo = useConversationStore();
const theme = useThemeStore();
const { captionText, captionsVisible } = storeToRefs(convo);

// Marked configuration:
//   - gfm: enables tables / strikethrough / task lists.
//   - breaks: single newlines become <br>, which keeps multi-line streamed
//     deltas readable while the model is still speaking (without this,
//     two-line bullets render as one wall of text).
//   - async: false so we get a string back synchronously for v-html.
marked.setOptions({ gfm: true, breaks: true, async: false });

const text = computed(() => captionText.value);
const visible = computed(() => captionsVisible.value);

const rendered = computed<string>(() => {
  const raw = text.value ?? '';
  if (!raw) return '';
  // marked.parse with async:false returns a string. The cast makes the
  // type checker accept it without disabling strictness across the file.
  const html = marked.parse(raw) as string;
  // Defence-in-depth: even though the LLM output is text we control, it
  // routinely contains URLs and arbitrary Markdown. Sanitize before v-html.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'i', 'em', 'strong', 'u', 'code', 'pre', 'br', 'p',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'span', 'div', 'del', 's', 'sub', 'sup', 'kbd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'target', 'rel'],
    // Drop any javascript: / data: hrefs.
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
  /* Flows inline in the OverlayPage vertical stack — sits BELOW the avatar
   * (and below the tool-badge if present), no longer overlapping the face
   * plate. Width fills the overlay window minus a small horizontal margin;
   * height grows with content and is capped so very long replies don't
   * push the layout off-screen. */
  align-self: stretch;
  margin: 6px 12px v-bind(offset);
  padding: 12px 16px;
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
  /* Pointer events ARE enabled here so the user can scroll long replies.
   * The avatar window has system-level click-through (setIgnoreMouseEvents)
   * which is opt-in by region — Avatar.vue's hit-test now also matches
   * the data-faceplate-hit-region="captions" element, flipping
   * click-through OFF when the cursor is over this panel. */
  pointer-events: auto;
  user-select: text;
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
  /* Subtle custom scrollbar so it doesn't look like a stray Chromium gray
   * track on the dark glass surface. */
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}

/* WebKit-flavored scrollbar styling — Firefox uses scrollbar-color above. */
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

/* Inline-text formatting from markdown. Spacing tuned for short paragraphs
 * — most replies are 1-3 sentences and look best without fat margins. */
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

/* Inline + block code. We use a slightly off-black so it reads as a code
 * surface without competing with the panel background. */
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

/* Lists, blockquotes, headings. */
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

/* Tables — rare but worth handling. */
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
