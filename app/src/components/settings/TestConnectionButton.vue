<template>
  <div class="test-connection">
    <q-btn
      :label="label"
      :icon="icon"
      :loading="state === 'in_flight'"
      :color="buttonColor"
      flat
      no-caps
      dense
      @click="run"
    />
    <q-banner v-if="result" :class="['test-banner', result.ok ? 'test-banner-ok' : 'test-banner-fail']" dense>
      <template #avatar>
        <q-icon :name="result.ok ? 'check_circle' : 'error'" />
      </template>
      <span class="test-banner-summary">
        {{ result.ok ? `${result.latency_ms} ms` : (result.error ?? 'failed') }}
      </span>
      <q-btn v-if="result.detail" flat dense size="xs" icon="more_horiz" @click="showDetail = !showDetail" />
      <pre v-if="showDetail && result.detail" class="test-banner-detail">{{ result.detail }}</pre>
    </q-banner>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

import type { ConnectionTarget, TestResult } from '../../../src-electron/preload-api';

const props = defineProps<{
  target: ConnectionTarget;
  label?: string;
}>();

const state = ref<'idle' | 'in_flight' | 'done'>('idle');
const result = ref<TestResult | null>(null);
const showDetail = ref(false);

const label = computed(() => props.label ?? `Test ${props.target}`);
const icon = computed(() => (state.value === 'in_flight' ? 'sync' : 'play_arrow'));
const buttonColor = computed(() => {
  if (!result.value) return 'primary';
  return result.value.ok ? 'positive' : 'negative';
});

async function run(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  state.value = 'in_flight';
  showDetail.value = false;
  try {
    result.value = await fp.hermes.testConnection(props.target);
  } catch (err) {
    result.value = {
      ok: false,
      latency_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    state.value = 'done';
  }
}
</script>

<style scoped>
.test-connection {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.test-banner {
  flex: 1;
  min-width: 200px;
  border-radius: 8px;
  padding: 4px 8px !important;
}

.test-banner-ok {
  background: rgba(34, 197, 94, 0.12);
  color: #0c5132;
}

.test-banner-fail {
  background: rgba(239, 68, 68, 0.12);
  color: #7c1d1d;
}

.test-banner-summary {
  font: 13px/1 'JetBrains Mono', ui-monospace, monospace;
}

.test-banner-detail {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  font: 11px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}
</style>
