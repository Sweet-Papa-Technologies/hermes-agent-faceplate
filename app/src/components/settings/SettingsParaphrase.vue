<template>
  <div>
    <h2>Paraphrase</h2>
    <p class="muted">
      Long agent responses are shortened for spoken delivery; the full transcript stays in captions. Paraphrase reuses hermes-agent's configured LLM directly; if that LLM can't be reached, the full text is spoken unchanged.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Enable paraphrase</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="enabled" />
          </q-item-section>
        </q-item>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <div>Paraphrase responses longer than {{ trigger }} characters</div>
        <q-slider v-model="trigger" :min="80" :max="800" :step="10" />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <div>Target length: ~{{ target }} words for speech</div>
        <q-slider v-model="target" :min="10" :max="60" :step="1" />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-option-group v-model="model" :options="modelOptions" type="radio" />
        <q-banner v-if="!canBypass && model === 'reuse_hermes_llm'" class="warning q-mt-sm" dense>
          <template #avatar><q-icon name="warning" color="warning" /></template>
          Local <code>~/.hermes/</code> isn't readable on this machine, so we can't reach your underlying LLM directly. Paraphrase will be skipped and the full text spoken until you run hermes-agent on this machine.
        </q-banner>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-input
          v-model="prompt"
          label="System prompt"
          type="textarea"
          autogrow
          filled
          stack-label
        />
      </q-card-section>
    </q-card>

    <h3>Try it</h3>
    <q-card flat bordered class="card">
      <q-card-section>
        <q-input v-model="sample" type="textarea" autogrow filled stack-label label="Sample assistant response" />
      </q-card-section>
      <q-card-actions>
        <q-btn no-caps :loading="loading" outline icon="auto_fix_high" label="Paraphrase" @click="run" />
      </q-card-actions>
      <q-card-section v-if="result">
        <q-banner :class="['q-mb-sm', resultClass]" dense>
          {{ resultBanner }}
        </q-banner>
        <pre class="result">{{ result.text }}</pre>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

import { useSetting } from '../../composables/use-setting';
import { useDiscoveryStore } from '../../stores/discovery';
import { paraphrase, type ParaphraseOutcome } from '../../hermes/paraphrase';

const enabled = useSetting('paraphrase.enabled');
const trigger = useSetting('paraphrase.trigger_chars');
const target = useSetting('paraphrase.target_words');
const model = useSetting('paraphrase.model');
const prompt = useSetting('paraphrase.system_prompt');

const discovery = useDiscoveryStore();
const canBypass = computed(() => discovery.canBypassParaphrase);

const sample = ref(
  'I dug into the logs and found that the failing requests all share a common upstream — the auth service was rejecting tokens issued before the rotation at 14:02 UTC. Restarting the dependent services and forcing a token refresh restored normal traffic; I have a backfill running for the queued jobs and will keep an eye on the dashboards for the next hour.',
);
const result = ref<ParaphraseOutcome | null>(null);
const loading = ref(false);

const modelOptions = [
  { label: "Reuse hermes-agent's configured LLM (default)", value: 'reuse_hermes_llm' },
  { label: 'Disabled — always speak the full text', value: 'disabled' },
];

const resultBanner = computed(() => {
  const r = result.value;
  if (!r) return '';
  if (r.used === 'disabled') return 'Paraphrase is disabled.';
  if (r.used === 'reuse_hermes_llm') return `hermes LLM (${r.latency_ms} ms)`;
  if (r.used === 'skipped') {
    if (r.fallback_reason === 'unsafe_to_bypass') {
      return "Skipped — local ~/.hermes config isn't readable, so the underlying LLM can't be reached directly. Full text spoken.";
    }
    if (r.fallback_reason === 'unreachable') {
      return 'Skipped — the hermes LLM was unreachable. Full text spoken.';
    }
    return 'Below trigger threshold — original returned unchanged.';
  }
  return r.used;
});

const resultClass = computed(() => {
  const used = result.value?.used;
  if (used === 'reuse_hermes_llm') return 'banner-ok';
  if (used === 'skipped' || used === 'disabled') return 'banner-info';
  return '';
});

async function run(): Promise<void> {
  loading.value = true;
  try {
    result.value = await paraphrase(sample.value);
  } catch (err) {
    console.error('[settings.paraphrase] test failed:', err);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.banner-ok { background: rgba(34, 197, 94, 0.12); }
.banner-info { background: rgba(59, 130, 246, 0.12); }
.result {
  margin: 0;
  padding: 12px;
  background: #0e0e10;
  color: #d8d8d8;
  border-radius: 6px;
  font: 13px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
}
</style>
