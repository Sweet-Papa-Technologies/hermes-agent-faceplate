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
        <q-input v-model="ttsModel" class="col-6" label="Model" filled stack-label />
        <q-input v-model="ttsVoice" class="col-6" label="Voice" filled stack-label />
        <div class="col-12">
          <div>Rate ({{ ttsRate.toFixed(2) }}x)</div>
          <q-slider v-model="ttsRate" :min="0.5" :max="2.0" :step="0.05" />
        </div>
        <q-select v-model="ttsFormat" :options="formatOptions" label="Stream format (MSE)" filled stack-label class="col-12" emit-value map-options />
      </q-card-section>
      <q-card-actions>
        <TestConnectionButton target="tts" label="Test TTS" />
      </q-card-actions>
    </q-card>

    <h3>Speech-to-text</h3>
    <q-card flat bordered class="card">
      <q-card-section class="row q-col-gutter-md">
        <q-input v-model="asrModel" class="col-6" label="Model" filled stack-label />
        <q-input v-model="asrLang" class="col-6" label="Language" filled stack-label hint="`auto` or BCP-47 tag (en, fr, …)" />
      </q-card-section>
      <q-card-actions>
        <TestConnectionButton target="asr" label="Test ASR" />
      </q-card-actions>
    </q-card>

    <h3>Container lifecycle</h3>
    <q-banner class="card" dense>
      <template #avatar><q-icon name="info" /></template>
      Container start/stop is wired to the sidecar IPC in Phase 5; the buttons below remain inactive until the bundled compose file ships.
    </q-banner>
    <div class="row q-gutter-sm q-mt-sm">
      <q-btn outline no-caps icon="play_arrow" label="Start" disable />
      <q-btn outline no-caps icon="stop" label="Stop" disable />
      <q-btn outline no-caps icon="restart_alt" label="Restart" disable />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { useSetting } from '../../composables/use-setting';
import TestConnectionButton from './TestConnectionButton.vue';

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
