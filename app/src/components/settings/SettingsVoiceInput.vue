<template>
  <div>
    <h2>Voice Input</h2>
    <p class="muted">
      Push-to-talk and wake-word are <strong>off by default</strong>. The mic LED in the avatar's halo is hardcoded to light up whenever the mic stream is open — themes cannot suppress it.
    </p>

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
    </q-card>

    <q-banner v-if="firstEnable" class="warning q-my-md" dense>
      <template #avatar><q-icon name="info" color="warning" /></template>
      The microphone will open whenever this mode is active. The avatar's halo shows a green LED while the mic is live.
    </q-banner>

    <h3>Push-to-talk</h3>
    <q-card flat bordered class="card">
      <q-card-section>
        <q-input v-model="pttHotkey" filled stack-label label="PTT hotkey accelerator" hint="Format: CommandOrControl+Shift+Space" />
      </q-card-section>
    </q-card>

    <h3>Wake word</h3>
    <q-card flat bordered class="card">
      <q-card-section class="row q-col-gutter-md">
        <q-input v-model="wakePath" class="col-12" label="Model file path (.onnx)" filled stack-label />
        <div class="col-12">
          <div>Detection threshold ({{ wakeThreshold.toFixed(2) }})</div>
          <q-slider v-model="wakeThreshold" :min="0.1" :max="0.95" :step="0.01" />
        </div>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useSetting } from '../../composables/use-setting';

const mode = useSetting('input.mode');
const pttHotkey = useSetting('input.ptt_hotkey');
const wakePath = useSetting('input.wake.model_path');
const wakeThreshold = useSetting('input.wake.threshold');
const micWarningShown = useSetting('privacy.mic_warning_shown');

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
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.warning { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
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
