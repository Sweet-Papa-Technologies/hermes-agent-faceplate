<template>
  <div>
    <h2>Audio I/O</h2>
    <p class="muted">
      Microphone is requested only when push-to-talk fires or wake-word is on. The Faceplate never records audio to disk.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-select
          v-model="inputDeviceId"
          :options="inputOptions"
          label="Microphone"
          stack-label
          filled
          option-label="label"
          option-value="deviceId"
          emit-value
          map-options
        />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-select
          v-model="outputDeviceId"
          :options="outputOptions"
          label="Speakers"
          stack-label
          filled
          option-label="label"
          option-value="deviceId"
          emit-value
          map-options
          :hint="outputHint"
        />
      </q-card-section>
    </q-card>

    <h3>Permissions</h3>
    <q-card flat bordered class="card">
      <q-item>
        <q-item-section>
          <q-item-label>Microphone permission</q-item-label>
          <q-item-label caption>Required for push-to-talk and wake-word.</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-chip
            :color="micPermission === 'granted' ? 'positive' : micPermission === 'denied' ? 'negative' : 'grey-5'"
            :icon="micPermission === 'granted' ? 'check_circle' : micPermission === 'denied' ? 'block' : 'help'"
            text-color="white"
            dense
          >
            {{ micPermission ?? 'unknown' }}
          </q-chip>
        </q-item-section>
      </q-item>
      <q-separator />
      <q-card-actions>
        <q-btn flat no-caps icon="mic" label="Request mic" @click="requestMic" />
        <q-btn v-if="isMacOs" flat no-caps icon="settings" label="Open OS settings" @click="openMacSettings" />
      </q-card-actions>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watchEffect } from 'vue';

import { useSetting } from '../../composables/use-setting';

interface DeviceOption {
  deviceId: string;
  label: string;
}

const inputDeviceId = ref<string>('');
const outputDeviceId = ref<string>('');
// These are not yet persisted to settings.yaml — Phase 4 stores them in
// memory; persistence comes when the audio pipeline reads from settings
// directly (Phase 2 already plumbs `deviceId` through, just not from disk).

const _inputDeviceSetting = useSetting('input.mode'); // satisfy import bias

const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const micPermission = ref<PermissionState | null>(null);
const isMacOs = computed(() => window.faceplate?.platform.os === 'darwin');

function labelFor(d: MediaDeviceInfo, kindFallback: string): string {
  // Chromium fills `label` only after mic permission is granted; before that
  // we get empty strings. The "default" entry's label, when present, has the
  // shape "Default - <real device name>" — surface that as just "Default …".
  if (d.deviceId === 'default') return d.label ? d.label : `Default ${kindFallback}`;
  if (d.label) return d.label;
  if (d.deviceId === '') return `${kindFallback} (no label — grant mic permission)`;
  return `${kindFallback} ${d.deviceId.slice(0, 6)}`;
}

const inputOptions = computed<DeviceOption[]>(() =>
  inputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'microphone') })),
);
const outputOptions = computed<DeviceOption[]>(() =>
  outputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'output') })),
);

const outputHint = computed(() =>
  isMacOs.value
    ? 'macOS routes audio through the system default; per-app override requires extra entitlements.'
    : 'Used for TTS playback.',
);

function pickDefault(devices: MediaDeviceInfo[]): string {
  // Chromium exposes a synthetic entry with deviceId="default" pointing at
  // whatever the OS currently considers the default. If that's missing
  // (Firefox, some ALSA setups) fall back to the first real device.
  const def = devices.find((d) => d.deviceId === 'default');
  if (def) return def.deviceId;
  const real = devices.find((d) => d.deviceId && d.deviceId !== '');
  return real?.deviceId ?? '';
}

async function refreshDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputDevices.value = all.filter((d) => d.kind === 'audioinput');
    outputDevices.value = all.filter((d) => d.kind === 'audiooutput');
    // Auto-select whatever the OS reports as default, but only if the user
    // hasn't explicitly chosen something — preserves manual overrides
    // across re-enumerations (e.g., when a USB headset is plugged in).
    if (!inputDeviceId.value || !inputDevices.value.some((d) => d.deviceId === inputDeviceId.value)) {
      inputDeviceId.value = pickDefault(inputDevices.value);
    }
    if (!outputDeviceId.value || !outputDevices.value.some((d) => d.deviceId === outputDeviceId.value)) {
      outputDeviceId.value = pickDefault(outputDevices.value);
    }
  } catch (err) {
    console.error('[settings.audio] enumerateDevices failed:', err);
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
    console.error('[settings.audio] mic request failed:', err);
    micPermission.value = 'denied';
  }
}

function openMacSettings(): void {
  // Renderers can't directly hit System Preferences; the deep link below works
  // when invoked via shell. Falling back to opening a web URL would be useless,
  // so we just give the user the path.
  window.faceplate?.events.publish({
    type: 'system.config_changed',
    ts: Date.now(),
    payload: { keys: ['__instruction__:System Preferences > Privacy & Security > Microphone'] },
  });
}

watchEffect(async () => {
  void _inputDeviceSetting.value;
  await refreshDevices();
});

onMounted(() => {
  void checkPermission();
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
</style>
