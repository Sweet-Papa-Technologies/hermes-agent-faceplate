<template>
  <div class="code-artifact">
    <div v-if="hasPreview" class="code-tabs">
      <button :class="{ active: tab === 'preview' }" @click="tab = 'preview'">Preview</button>
      <button :class="{ active: tab === 'source' }" @click="tab = 'source'">Source</button>
    </div>

    <!-- HTML / SVG: sandboxed iframe -->
    <iframe
      v-if="tab === 'preview' && previewKind === 'html'"
      class="code-preview"
      :srcdoc="srcdoc"
      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      referrerpolicy="strict-origin-when-cross-origin"
    />

    <!-- CSV / TSV: rendered as a sortable table -->
    <div v-else-if="tab === 'preview' && previewKind === 'csv'" class="csv-preview">
      <div v-if="csvParsed.error" class="csv-error">{{ csvParsed.error }}</div>
      <table v-else class="csv-table">
        <thead v-if="csvParsed.header.length">
          <tr>
            <th
              v-for="(col, i) in csvParsed.header"
              :key="i"
              :class="{ sorted: sortIdx === i }"
              @click="toggleSort(i)"
            >
              {{ col }}
              <span v-if="sortIdx === i" class="csv-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in sortedRows" :key="ri">
            <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="csvParsed.rows.length > MAX_ROWS" class="csv-overflow">
        Showing first {{ MAX_ROWS }} of {{ csvParsed.rows.length }} rows. Download to see them all.
      </div>
    </div>

    <!-- Default: highlighted source -->
    <pre v-else class="code-source"><code ref="codeEl" :class="`language-${lang}`">{{ artifact.body }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';

import type { Artifact } from '../../stores/artifact-types';

const props = defineProps<{ artifact: Artifact }>();

const MAX_ROWS = 500;

const lang = computed(() => (props.artifact.language || 'plaintext').toLowerCase());

// Three rendering modes:
//   - 'html'  → sandboxed iframe (full HTML/SVG preview)
//   - 'csv'   → parsed table with sortable columns
//   - null    → no preview tab; show source only
const previewKind = computed<'html' | 'csv' | null>(() => {
  if (lang.value === 'html' || lang.value === 'svg') return 'html';
  if (lang.value === 'csv' || lang.value === 'tsv') return 'csv';
  return null;
});
const hasPreview = computed(() => previewKind.value !== null);
const srcdoc = computed(() => previewKind.value === 'html' ? props.artifact.body : '');
const tab = ref<'preview' | 'source'>(hasPreview.value ? 'preview' : 'source');

const codeEl = ref<HTMLElement | null>(null);

// ─── CSV parsing ─────────────────────────────────────────────────────────
//
// RFC-4180-ish: handles quoted fields with embedded commas, escaped quotes
// (""), CRLF / LF line endings, and TSV via the language hint. Not bullet-
// proof for every wild CSV-in-the-wild but covers the shapes the model
// emits when the user asks "give me a CSV of …".

interface CsvParseResult {
  header: string[];
  rows: string[][];
  error: string | null;
}

const csvParsed = computed<CsvParseResult>(() => {
  if (previewKind.value !== 'csv') {
    return { header: [], rows: [], error: null };
  }
  try {
    const sep = lang.value === 'tsv' ? '\t' : ',';
    const all = parseCsv(props.artifact.body, sep);
    if (all.length === 0) return { header: [], rows: [], error: 'Empty file' };
    const [header, ...rows] = all;
    return { header: header ?? [], rows, error: null };
  } catch (err) {
    return {
      header: [],
      rows: [],
      error: `CSV parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
});

function parseCsv(text: string, sep: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ""
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue; // skip CR; LF handles row break
    if (ch === '\n') {
      row.push(field);
      // Skip blank trailing lines.
      if (!(row.length === 1 && row[0] === '')) out.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // Flush trailing field/row if no terminating newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) out.push(row);
  }
  return out;
}

// ─── Column sort ─────────────────────────────────────────────────────────
const sortIdx = ref<number | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');

function toggleSort(idx: number): void {
  if (sortIdx.value === idx) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortIdx.value = idx;
    sortDir.value = 'asc';
  }
}

const sortedRows = computed(() => {
  const limited = csvParsed.value.rows.slice(0, MAX_ROWS);
  if (sortIdx.value === null) return limited;
  const idx = sortIdx.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...limited].sort((a, b) => {
    const av = a[idx] ?? '';
    const bv = b[idx] ?? '';
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') {
      return (an - bn) * dir;
    }
    return av.localeCompare(bv) * dir;
  });
});

// Reset sort when the artifact changes — column indexes may not match.
watch(() => props.artifact.id, () => { sortIdx.value = null; sortDir.value = 'asc'; });

// ─── highlight.js (lazy) ─────────────────────────────────────────────────
async function highlight(): Promise<void> {
  if (!codeEl.value) return;
  try {
    const hljs = (await import('highlight.js')).default;
    codeEl.value.removeAttribute('data-highlighted');
    hljs.highlightElement(codeEl.value);
  } catch (err) {
    console.warn('[code-artifact] highlight.js load failed:', err);
  }
}

onMounted(() => void highlight());
watch(() => props.artifact.id, () => void highlight());
watch(tab, (t) => { if (t === 'source') void highlight(); });
</script>

<style scoped>
.code-artifact {
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.code-tabs {
  display: flex;
  gap: 4px;
  padding: 0 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}
.code-tabs button {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.7);
  font: 12px/1 'JetBrains Mono', ui-monospace, monospace;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.code-tabs button.active {
  background: rgba(127,220,255,0.18);
  color: #fff;
  border-color: rgba(127,220,255,0.4);
}
.code-preview {
  flex: 1;
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: #fff;
  min-height: 0;
}
.code-source {
  flex: 1;
  margin: 0;
  padding: 12px 16px;
  background: rgba(0,0,0,0.55);
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.5 'JetBrains Mono', ui-monospace, monospace;
  color: #e6f5d6;
  user-select: text;
}

/* CSV preview */
.csv-preview {
  flex: 1;
  overflow: auto;
  background: rgba(0, 0, 0, 0.32);
  border-radius: 8px;
  padding: 6px;
  min-height: 0;
}
.csv-table {
  border-collapse: collapse;
  font: 12px/1.4 system-ui, sans-serif;
  color: #f4f5f8;
  width: 100%;
}
.csv-table th,
.csv-table td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  text-align: left;
  white-space: nowrap;
  user-select: text;
}
.csv-table th {
  background: rgba(127, 220, 255, 0.12);
  color: #d6f1ff;
  font-weight: 600;
  cursor: pointer;
  position: sticky;
  top: 0;
  z-index: 1;
  user-select: none;
}
.csv-table th:hover { background: rgba(127, 220, 255, 0.22); }
.csv-table th.sorted { background: rgba(127, 220, 255, 0.32); }
.csv-table tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
.csv-table tbody tr:hover { background: rgba(127, 220, 255, 0.08); }
.csv-arrow {
  margin-left: 6px;
  font-size: 9px;
  opacity: 0.7;
}
.csv-overflow {
  margin-top: 8px;
  padding: 6px 10px;
  font: 11px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
}
.csv-error {
  color: #ff9c9c;
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  padding: 12px;
}
</style>

<style>
@import 'highlight.js/styles/atom-one-dark.css';
</style>
