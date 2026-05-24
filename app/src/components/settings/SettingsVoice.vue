<template>
  <div>
    <h2>Voice</h2>
    <p class="muted">
      Spoken input (push-to-talk or wake-word) and output (Kokoro TTS).
      Off by default — chat works typing-only. Turn the master switch on
      and point at a speech sidecar URL to enable.
    </p>

    <!-- ── Master switch ───────────────────────────────────────────── -->
    <q-card flat bordered class="card">
      <q-item tag="label">
        <q-item-section>
          <q-item-label>Enable voice</q-item-label>
          <q-item-label caption>
            Master switch. When off, no audio is captured or played and the
            mic LED never lights up.
          </q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-toggle v-model="enabled" />
        </q-item-section>
      </q-item>
    </q-card>

    <template v-if="enabled">
      <!-- ── Input mode ──────────────────────────────────────────── -->
      <h3>Input</h3>
      <q-card flat bordered class="card">
        <q-card-section>
          <div class="row q-gutter-md items-stretch">
            <q-btn
              v-for="opt in modeOptions"
              :key="opt.value"
              :class="['mode-card', mode === opt.value ? 'mode-card-active' : '']"
              flat
              no-caps
              stack
              @click="setMode(opt.value)"
            >
              <q-icon :name="opt.icon" size="32px" />
              <div class="mode-card-label">{{ opt.label }}</div>
              <div class="mode-card-caption">{{ opt.caption }}</div>
            </q-btn>
          </div>
        </q-card-section>

        <q-banner v-if="firstEnable" class="warn q-mx-md q-mb-md" dense>
          <template #avatar><q-icon name="info" color="warning" /></template>
          The microphone will open whenever this mode is active. The avatar's
          halo shows a green LED while the mic is live.
        </q-banner>

        <q-separator v-if="mode === 'push_to_talk'" />
        <q-card-section v-if="mode === 'push_to_talk'">
          <q-input
            v-model="pttHotkey"
            filled
            stack-label
            label="Push-to-talk hotkey"
            hint="Format: CommandOrControl+Shift+Space"
          />
        </q-card-section>

        <q-separator v-if="mode === 'wake_word'" />
        <q-expansion-item
          v-if="mode === 'wake_word'"
          icon="tune"
          label="Wake-word advanced"
          dense
          header-class="text-grey-7"
        >
          <q-card-section class="row q-col-gutter-md">
            <q-input v-model="wakePath" class="col-12" label="Model file path (.onnx)" filled stack-label />
            <div class="col-12">
              <div>Detection threshold ({{ wakeThreshold.toFixed(2) }})</div>
              <q-slider v-model="wakeThreshold" :min="0.1" :max="0.95" :step="0.01" />
            </div>
          </q-card-section>
        </q-expansion-item>
      </q-card>

      <!-- ── Audio devices ──────────────────────────────────────── -->
      <h3>Devices</h3>
      <q-card flat bordered class="card">
        <q-card-section>
          <q-select
            v-model="micDeviceId"
            :options="inputOptions"
            label="Microphone"
            stack-label
            filled
            option-label="label"
            option-value="deviceId"
            emit-value
            map-options
            :hint="micHint"
          />
        </q-card-section>
        <q-separator />
        <q-card-section>
          <q-select
            v-model="outDeviceId"
            :options="outputOptions"
            label="Speakers"
            stack-label
            filled
            option-label="label"
            option-value="deviceId"
            emit-value
            map-options
            :hint="outHint"
          />
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div class="row items-center q-gutter-sm">
            <q-chip
              :color="micPermission === 'granted' ? 'positive' : micPermission === 'denied' ? 'negative' : 'grey-5'"
              :icon="micPermission === 'granted' ? 'check_circle' : micPermission === 'denied' ? 'block' : 'help'"
              text-color="white"
              dense
            >
              mic permission: {{ micPermission ?? 'unknown' }}
            </q-chip>
            <q-btn flat dense no-caps icon="mic" label="Request mic" @click="requestMic" />
          </div>
        </q-card-section>
      </q-card>

      <!-- ── Speech service ─────────────────────────────────────── -->
      <h3>Speech service</h3>
      <q-card flat bordered class="card">
        <q-card-section>
          <q-input
            v-model="sidecarUrl"
            label="Sidecar URL"
            filled
            stack-label
            hint="Run setup/speech-sidecar.sh on this machine, or bring your own OpenAI-compatible TTS/ASR endpoint."
          />
        </q-card-section>
        <q-separator />
        <q-card-section>
          <q-input
            v-model="sidecarToken"
            label="Bearer token"
            :type="showToken ? 'text' : 'password'"
            filled
            stack-label
            hint="Printed by setup/speech-sidecar.sh; empty disables auth (dev only)."
          >
            <template #append>
              <q-btn flat dense round :icon="showToken ? 'visibility_off' : 'visibility'" @click="showToken = !showToken" />
            </template>
          </q-input>
        </q-card-section>
        <q-separator />
        <q-card-section class="row q-col-gutter-md">
          <q-select
            v-model="voice"
            :options="voiceOptions"
            class="col-12"
            label="Voice"
            stack-label
            filled
            use-input
            new-value-mode="add-unique"
            emit-value
            map-options
            hint="Kokoro voices — accent: a=American/b=British, gender: f=female/m=male."
          />
          <div class="col-12">
            <div>Rate ({{ rate.toFixed(2) }}x)</div>
            <q-slider v-model="rate" :min="0.5" :max="2.0" :step="0.05" />
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section class="row items-center q-gutter-sm">
          <q-chip
            :color="sidecarStatus?.up ? 'positive' : 'grey-6'"
            :icon="sidecarStatus?.up ? 'check_circle' : 'pause_circle'"
            text-color="white"
            dense
          >
            {{ sidecarStatus?.up ? `up · ${sidecarStatus.build || 'unknown'}` : 'down' }}
          </q-chip>
          <q-btn flat dense no-caps icon="refresh" label="Refresh" @click="refreshStatus" />
          <TestConnectionButton target="tts" label="Test TTS" />
          <TestConnectionButton target="asr" label="Test ASR" />
        </q-card-section>
      </q-card>

      <!-- ── Paraphrase (compact) ────────────────────────────────── -->
      <h3>Paraphrase for speech</h3>
      <q-card flat bordered class="card">
        <q-card-section>
          <q-item tag="label" dense>
            <q-item-section>
              <q-item-label>Shorten long responses</q-item-label>
              <q-item-label caption>
                Routes through your Hermes-configured LLM (Settings → Connection),
                bypassing the agent loop so session memory isn't corrupted. The
                full transcript stays in captions and chat.
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-toggle v-model="paraphraseEnabled" />
            </q-item-section>
          </q-item>
        </q-card-section>
        <q-separator v-if="paraphraseEnabled" />
        <q-card-section v-if="paraphraseEnabled">
          <div>Paraphrase responses longer than {{ triggerChars }} characters</div>
          <q-slider v-model="triggerChars" :min="80" :max="800" :step="10" />
        </q-card-section>
      </q-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useSetting } from '../../composables/use-setting';
import { SYSTEM_DEFAULT_DEVICE } from '../../stores/settings-schema';
import TestConnectionButton from './TestConnectionButton.vue';
import type { SidecarStatus } from '../../../src-electron/preload-api';

// ─── Settings bindings ───────────────────────────────────────────────────
const enabled = useSetting('speech.enabled');
const mode = useSetting('input.mode');
const pttHotkey = useSetting('input.ptt_hotkey');
const wakePath = useSetting('input.wake.model_path');
const wakeThreshold = useSetting('input.wake.threshold');
const micWarningShown = useSetting('privacy.mic_warning_shown');

const micDeviceId = useSetting('input.device_id');
const outDeviceId = useSetting('output.device_id');

const sidecarUrl = useSetting('speech.sidecar_url');
const sidecarToken = useSetting('speech.sidecar_token');
const voice = useSetting('speech.tts.voice');
const ttsModel = useSetting('speech.tts.model');
const rate = useSetting('speech.tts.rate');

const paraphraseEnabled = useSetting('paraphrase.enabled');
const triggerChars = useSetting('paraphrase.trigger_chars');

// ─── Input mode UI ───────────────────────────────────────────────────────
const firstEnable = ref(false);

watch(mode, (m, prev) => {
  if (prev === 'off' && m !== 'off' && !micWarningShown.value) {
    firstEnable.value = true;
    micWarningShown.value = true;
  }
});

function setMode(value: 'off' | 'push_to_talk' | 'wake_word'): void {
  mode.value = value;
}

const modeOptions = computed(() => [
  { value: 'off' as const, label: 'Off', caption: 'Type only.', icon: 'mic_off' },
  { value: 'push_to_talk' as const, label: 'Push to talk', caption: 'Press a hotkey to speak.', icon: 'touch_app' },
  { value: 'wake_word' as const, label: 'Wake word', caption: '"Hey Hermes" hands-free.', icon: 'graphic_eq' },
]);

// ─── Voice picker — Kokoro curated catalog ───────────────────────────────
// Keep `tts.model` in sync with the voice id (it's always `kokoro:<voice>`
// for the bundled sidecar). Legacy `piper:` prefixes are migrated forward.
watch(voice, (next) => {
  if (!next) return;
  const expected = `kokoro:${next}`;
  if (
    ttsModel.value !== expected
    && (!ttsModel.value
      || ttsModel.value.startsWith('kokoro:')
      || ttsModel.value.startsWith('piper:'))
  ) {
    ttsModel.value = expected;
  }
});

const voiceOptions = [
  { label: 'af_bella — American female (default)', value: 'af_bella' },
  { label: 'af_heart — American female',           value: 'af_heart' },
  { label: 'af_nicole — American female',          value: 'af_nicole' },
  { label: 'am_adam — American male',              value: 'am_adam' },
  { label: 'am_michael — American male',           value: 'am_michael' },
  { label: 'bf_emma — British female',             value: 'bf_emma' },
  { label: 'bm_george — British male',             value: 'bm_george' },
];

// ─── Audio device enumeration ────────────────────────────────────────────
interface DeviceOption { deviceId: string; label: string }

const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const micPermission = ref<PermissionState | null>(null);
const isMacOs = computed(() => window.faceplate?.platform.os === 'darwin');

const SYSTEM_OPTION: DeviceOption = {
  deviceId: SYSTEM_DEFAULT_DEVICE,
  label: '🔊 System Setting (follow OS default)',
};

function labelFor(d: MediaDeviceInfo, kindFallback: string): string {
  if (d.deviceId === 'default') return d.label ? d.label : `Default ${kindFallback}`;
  if (d.label) return d.label;
  if (d.deviceId === '') return `${kindFallback} (no label — grant mic permission)`;
  return `${kindFallback} ${d.deviceId.slice(0, 6)}`;
}

const inputOptions = computed<DeviceOption[]>(() => [
  SYSTEM_OPTION,
  ...inputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'microphone') })),
]);
const outputOptions = computed<DeviceOption[]>(() => [
  SYSTEM_OPTION,
  ...outputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'output') })),
]);

const outHint = computed(() =>
  isMacOs.value
    ? 'macOS routes audio through the system default; per-app override requires extra entitlements.'
    : 'Used for TTS playback.',
);

const micHint = computed(() => {
  if (micDeviceId.value === SYSTEM_DEFAULT_DEVICE) return '';
  if (inputDevices.value.length === 0) return '';
  const present = inputDevices.value.some((d) => d.deviceId === micDeviceId.value);
  return present ? '' : 'Saved device is not currently connected — falling back to System Setting until it returns.';
});

async function refreshDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputDevices.value = all.filter((d) => d.kind === 'audioinput');
    outputDevices.value = all.filter((d) => d.kind === 'audiooutput');
  } catch (err) {
    console.error('[settings.voice] enumerateDevices failed:', err);
  }
}

async function checkPermission(): Promise<void> {
  if (!navigator.permissions) return;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    micPermission.value = status.state;
    status.addEventListener('change', () => {
      micPermission.value = status.state;
    });
  } catch {
    micPermission.value = null;
  }
}

async function requestMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    micPermission.value = 'granted';
    await refreshDevices();
  } catch (err) {
    console.error('[settings.voice] mic request failed:', err);
    micPermission.value = 'denied';
  }
}

function onDeviceChange(): void { void refreshDevices(); }

// ─── Sidecar status polling ──────────────────────────────────────────────
const showToken = ref(false);
const sidecarStatus = ref<SidecarStatus | null>(null);
let statusTimer: ReturnType<typeof setInterval> | null = null;

async function refreshStatus(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  try {
    sidecarStatus.value = await fp.sidecar.status();
  } catch (err) {
    console.warn('[settings.voice] sidecar.status threw:', err);
  }
}

watch(enabled, (on) => {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (on) {
    void refreshStatus();
    statusTimer = setInterval(() => void refreshStatus(), 5_000);
  }
}, { immediate: true });

// ─── Lifecycle ───────────────────────────────────────────────────────────
onMounted(async () => {
  void checkPermission();
  await refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
});

onBeforeUnmount(() => {
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  if (statusTimer) clearInterval(statusTimer);
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }

.mode-card {
  flex: 1;
  min-width: 160px;
  padding: 16px;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px;
  background: #fff;
}
.mode-card-active {
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
}
.mode-card-label { font-weight: 600; margin-top: 8px; }
.mode-card-caption { color: #666; font-size: 12px; margin-top: 4px; text-align: center; }
</style>
