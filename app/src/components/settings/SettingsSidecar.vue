<template>
  <div>
    <h2>Speech Sidecar</h2>
    <p class="muted">
      The bundled Docker sidecar exposes OpenAI-compatible TTS, ASR, wake-word, and a paraphrase fallback. You can also point at any external URL that satisfies the same shape.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-option-group v-model="mode" type="radio" :options="modeOptions" inline />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-input v-model="url" :disable="mode === 'disabled'" label="Sidecar URL" filled stack-label />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-input
          v-model="token"
          :disable="mode === 'disabled'"
          label="Bearer token"
          :type="showToken ? 'text' : 'password'"
          filled
          stack-label
        >
          <template #append>
            <q-btn flat dense round :icon="showToken ? 'visibility_off' : 'visibility'" @click="showToken = !showToken" />
          </template>
        </q-input>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-select v-model="image" :options="imageOptions" label="Bundled image variant" filled stack-label emit-value map-options />
      </q-card-section>
    </q-card>

    <h3>Text-to-speech</h3>
    <q-card flat bordered class="card">
      <q-card-section class="row q-col-gutter-md">
        <q-select
          v-model="ttsModel"
          :options="ttsModelOptions"
          class="col-6"
          label="Model"
          filled
          stack-label
          use-input
          new-value-mode="add-unique"
          :loading="loadingDiscovery"
          emit-value
          map-options
        />
        <q-select
          v-model="ttsVoice"
          :options="voiceOptions"
          class="col-6"
          label="Voice"
          filled
          stack-label
          use-input
          new-value-mode="add-unique"
          :loading="loadingDiscovery"
          emit-value
          map-options
        />
        <div class="col-12">
          <div>Rate ({{ ttsRate.toFixed(2) }}x)</div>
          <q-slider v-model="ttsRate" :min="0.5" :max="2.0" :step="0.05" />
        </div>
        <q-select v-model="ttsFormat" :options="formatOptions" label="Stream format (MSE)" filled stack-label class="col-12" emit-value map-options />
      </q-card-section>
      <q-card-actions>
        <TestConnectionButton target="tts" label="Test TTS" />
        <q-btn flat dense no-caps icon="refresh" label="Refresh from sidecar" :loading="loadingDiscovery" @click="refreshDiscovery" />
      </q-card-actions>
    </q-card>

    <h3>Speech-to-text</h3>
    <q-card flat bordered class="card">
      <q-card-section class="row q-col-gutter-md">
        <q-select
          v-model="asrModel"
          :options="asrModelOptions"
          class="col-6"
          label="Model"
          filled
          stack-label
          use-input
          new-value-mode="add-unique"
          :loading="loadingDiscovery"
          emit-value
          map-options
        />
        <q-input v-model="asrLang" class="col-6" label="Language" filled stack-label hint="`auto` or BCP-47 tag (en, fr, …)" />
      </q-card-section>
      <q-card-actions>
        <TestConnectionButton target="asr" label="Test ASR" />
      </q-card-actions>
    </q-card>

    <h3>Container lifecycle</h3>
    <q-card flat bordered class="card">
      <q-card-section class="row items-center q-gutter-sm">
        <q-chip :color="status?.up ? 'positive' : 'grey-6'" text-color="white" :icon="status?.up ? 'check_circle' : 'pause_circle'" dense>
          {{ status?.up ? `up · ${status.build}` : 'down' }}
        </q-chip>
        <q-chip v-if="status?.ram_mb" outline dense>
          RAM {{ status.ram_mb }} MB
        </q-chip>
        <q-chip v-if="status?.version" outline dense>
          v{{ status.version }}
        </q-chip>
      </q-card-section>
      <q-card-actions>
        <q-btn outline no-caps icon="play_arrow" label="Start" :loading="lifecycleBusy === 'start'" :disable="mode !== 'bundled'" @click="lifecycle('start')" />
        <q-btn outline no-caps icon="stop" label="Stop" :loading="lifecycleBusy === 'stop'" :disable="mode !== 'bundled'" @click="lifecycle('stop')" />
        <q-btn outline no-caps icon="restart_alt" label="Restart" :loading="lifecycleBusy === 'restart'" :disable="mode !== 'bundled'" @click="lifecycle('restart')" />
        <q-btn flat no-caps icon="refresh" label="Refresh status" @click="refreshStatus" />
      </q-card-actions>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useSetting } from '../../composables/use-setting';
import TestConnectionButton from './TestConnectionButton.vue';
import type { SidecarStatus } from '../../../src-electron/preload-api';

const mode = useSetting('speech.sidecar_mode');
const url = useSetting('speech.sidecar_url');
const token = useSetting('speech.sidecar_token');
const image = useSetting('speech.sidecar_image');
const ttsModel = useSetting('speech.tts.model');
const ttsVoice = useSetting('speech.tts.voice');
const ttsRate = useSetting('speech.tts.rate');
const ttsFormat = useSetting('speech.tts.format');
const asrModel = useSetting('speech.asr.model');
const asrLang = useSetting('speech.asr.language');

const showToken = ref(false);
const status = ref<SidecarStatus | null>(null);
const lifecycleBusy = ref<'start' | 'stop' | 'restart' | null>(null);
const $q = useQuasar();

interface OptionRow { label: string; value: string }

const ttsModelsRaw = ref<OptionRow[]>([]);
const asrModelsRaw = ref<OptionRow[]>([]);
const voicesRaw = ref<OptionRow[]>([]);
const loadingDiscovery = ref(false);

const ttsModelOptions = computed(() => mergeWithCurrent(ttsModelsRaw.value, ttsModel.value));
const asrModelOptions = computed(() => mergeWithCurrent(asrModelsRaw.value, asrModel.value));
const voiceOptions = computed(() => mergeWithCurrent(voicesRaw.value, ttsVoice.value));

function mergeWithCurrent(rows: OptionRow[], current: string): OptionRow[] {
  if (!current || rows.some((r) => r.value === current)) return rows;
  return [...rows, { label: `${current} (current)`, value: current }];
}

async function refreshDiscovery(): Promise<void> {
  loadingDiscovery.value = true;
  const baseUrl = `${url.value.replace(/\/+$/, '')}/v1`;
  try {
    const headers: Record<string, string> = {};
    if (token.value) headers.authorization = `Bearer ${token.value}`;

    const [models, voices] = await Promise.all([
      fetch(`${baseUrl}/models`, { headers }).then((r) => (r.ok ? r.json() : { data: [] })),
      fetch(`${baseUrl}/voices`, { headers }).then((r) => (r.ok ? r.json() : { data: [] })),
    ]);
    const allModels = (models?.data ?? []) as Array<{ id: string; kind?: string }>;
    ttsModelsRaw.value = allModels.filter((m) => m.kind === 'tts').map((m) => ({ label: m.id, value: m.id }));
    asrModelsRaw.value = allModels.filter((m) => m.kind === 'asr').map((m) => ({ label: m.id, value: m.id }));
    const voiceData = (voices?.data ?? []) as Array<{ voice?: string; id?: string }>;
    voicesRaw.value = voiceData.map((v) => {
      const value = v.voice ?? v.id ?? '';
      return { label: value, value };
    }).filter((row) => row.value);
  } catch (err) {
    console.warn('[settings.sidecar] discovery failed:', err);
  } finally {
    loadingDiscovery.value = false;
  }
}

async function refreshStatus(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  status.value = await fp.sidecar.status();
}

async function lifecycle(action: 'start' | 'stop' | 'restart'): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  lifecycleBusy.value = action;
  try {
    if (action === 'start') {
      await fp.sidecar.start();
    } else if (action === 'stop') {
      await fp.sidecar.stop();
    } else {
      await fp.sidecar.stop();
      await fp.sidecar.start();
    }
    await refreshStatus();
    $q.notify({ type: 'positive', message: `sidecar ${action}ed`, timeout: 3000 });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : String(err), timeout: 6000 });
  } finally {
    lifecycleBusy.value = null;
  }
}

onMounted(() => {
  void refreshStatus();
  void refreshDiscovery();
});

const modeOptions = [
  { label: 'Bundled Docker (recommended)', value: 'bundled' },
  { label: 'External URL', value: 'external' },
  { label: 'Disabled', value: 'disabled' },
];

const imageOptions = [
  { label: 'cpu — full (incl. paraphrase fallback, 4 GB)', value: 'cpu' },
  { label: 'cpu-slim — no paraphrase (1.4 GB)', value: 'cpu-slim' },
  { label: 'cuda — GPU (8 GB+ VRAM)', value: 'cuda' },
];

const formatOptions = [
  { label: 'MP3 (default — broadest support)', value: 'mp3' },
  { label: 'Opus in MP4', value: 'opus' },
  { label: 'WAV', value: 'wav' },
  { label: 'AAC', value: 'aac' },
];
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
</style>
