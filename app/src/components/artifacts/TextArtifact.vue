<template>
  <div class="text-artifact" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();

marked.setOptions({ gfm: true, breaks: true, async: false });

const rendered = computed<string>(() => {
  const raw = props.artifact.body || '';
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
</script>

<style scoped>
.text-artifact {
  width: 100%;
  padding: 16px 20px;
  font: 14px/1.6 system-ui, sans-serif;
  color: #f4f5f8;
  user-select: text;
  overflow: auto;
}
.text-artifact :deep(h1),
.text-artifact :deep(h2),
.text-artifact :deep(h3) { margin: 0.6em 0 0.3em; color: #fff; }
.text-artifact :deep(strong) { color: #ffe18d; }
.text-artifact :deep(em) { color: #d4f1ff; }
.text-artifact :deep(a) { color: #7fdcff; }
.text-artifact :deep(code) {
  background: rgba(0,0,0,0.4); padding: 1px 6px; border-radius: 4px;
  font-family: 'JetBrains Mono', ui-monospace, monospace; color: #b5f3a8;
}
.text-artifact :deep(pre) {
  background: rgba(0,0,0,0.55); padding: 10px 12px; border-radius: 8px;
  overflow: auto;
}
</style>
