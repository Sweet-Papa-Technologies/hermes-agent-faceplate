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
          :hint="inputHint"
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

import { useSetting } from '../../composables/use-setting';
import { SYSTEM_DEFAULT_DEVICE } from '../../stores/settings-schema';

interface DeviceOption {
  deviceId: string;
  label: string;
}

// Persisted via settings.yaml. 'system' is the default sentinel meaning
// "follow OS default device." When the user picks an explicit device that
// later disappears (USB headset unplugged), we don't clobber the saved
// value — the audio pipeline transparently falls back to the OS default
// for that session, so re-plugging the device restores it automatically.
const inputDeviceId = useSetting('input.device_id');
const outputDeviceId = useSetting('output.device_id');

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

const SYSTEM_OPTION: DeviceOption = {
  deviceId: SYSTEM_DEFAULT_DEVICE,
  label: '🔊 System Setting (follow OS default)',
};

const inputOptions = computed<DeviceOption[]>(() => [
  SYSTEM_OPTION,
  ...inputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'microphone') })),
]);
const outputOptions = computed<DeviceOption[]>(() => [
  SYSTEM_OPTION,
  ...outputDevices.value.map((d) => ({ deviceId: d.deviceId, label: labelFor(d, 'output') })),
]);

const outputHint = computed(() =>
  isMacOs.value
    ? 'macOS routes audio through the system default; per-app override requires extra entitlements.'
    : 'Used for TTS playback.',
);

const inputHint = computed(() => {
  // Surface a quiet warning if the saved device isn't currently present —
  // the pipeline will fall back to OS default this session, but the user
  // should know nothing is broken.
  if (inputDeviceId.value === SYSTEM_DEFAULT_DEVICE) return '';
  if (inputDevices.value.length === 0) return '';
  const present = inputDevices.value.some((d) => d.deviceId === inputDeviceId.value);
  return present
    ? ''
    : 'Saved device is not currently connected — falling back to System Setting until it returns.';
});

async function refreshDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputDevices.value = all.filter((d) => d.kind === 'audioinput');
    outputDevices.value = all.filter((d) => d.kind === 'audiooutput');
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

// Re-enumerate on hot-plug (USB headset unplug/replug) so the dropdown
// reflects what's actually connected without forcing a tab switch.
function onDeviceChange(): void {
  void refreshDevices();
}

onMounted(async () => {
  void checkPermission();
  await refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
});

onBeforeUnmount(() => {
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
</style>
