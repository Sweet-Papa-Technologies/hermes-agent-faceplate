<template>
  <div>
    <h2>Hotkeys</h2>
    <p class="muted">
      Click any field, then press the desired key combination. The system reserves a few accelerators (e.g. Spotlight on macOS); when conflicts happen, the typing-bar hotkey falls back through <code>+Alt+Space</code> automatically.
    </p>

    <q-card flat bordered class="card">
      <q-list separator>
        <q-item v-for="row in rows" :key="row.path">
          <q-item-section>
            <q-item-label>{{ row.label }}</q-item-label>
            <q-item-label caption>{{ row.caption }}</q-item-label>
          </q-item-section>
          <q-item-section style="max-width: 320px">
            <HotkeyRecorder
              :model-value="row.value"
              label=""
              :default-value="row.default"
              @update:modelValue="row.set"
            />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-banner v-if="isMac" class="warning q-my-md" dense>
      <template #avatar><q-icon name="security" color="warning" /></template>
      macOS hotkeys require Accessibility permission. If a press doesn't reach the Faceplate, open System Settings → Privacy & Security → Accessibility and add HermesAgent Faceplate.
    </q-banner>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useSetting } from '../../composables/use-setting';
import HotkeyRecorder from './HotkeyRecorder.vue';

const showHide = useSetting('hotkeys.show_hide');
const typing = useSetting('hotkeys.typing_bar');
const ptt = useSetting('hotkeys.push_to_talk');
const captions = useSetting('hotkeys.captions');
const cycleMon = useSetting('hotkeys.cycle_monitor');
const replay = useSetting('hotkeys.replay');
const interruptKey = useSetting('hotkeys.interrupt');

interface Row {
  path: string;
  label: string;
  caption: string;
  value: string;
  default: string;
  set: (v: string) => void;
}

const rows = computed<Row[]>(() => [
  { path: 'show_hide', label: 'Show / Hide overlay', caption: 'Toggle the avatar.', value: showHide.value, default: 'CommandOrControl+Shift+H', set: (v) => (showHide.value = v) },
  { path: 'typing_bar', label: 'Spawn typing bar', caption: 'Falls back to +Alt+Space if Spotlight has Cmd+Space.', value: typing.value, default: 'CommandOrControl+Space', set: (v) => (typing.value = v) },
  { path: 'push_to_talk', label: 'Push-to-talk', caption: 'First press starts; second press sends.', value: ptt.value, default: 'CommandOrControl+Shift+Space', set: (v) => (ptt.value = v) },
  { path: 'captions', label: 'Toggle captions', caption: 'Hide/show the caption band.', value: captions.value, default: 'CommandOrControl+Shift+C', set: (v) => (captions.value = v) },
  { path: 'cycle_monitor', label: 'Cycle monitor', caption: 'Move the avatar to the next display.', value: cycleMon.value, default: 'CommandOrControl+Shift+M', set: (v) => (cycleMon.value = v) },
  { path: 'replay', label: 'Replay last response', caption: 'Speak the last assistant message again.', value: replay.value, default: 'CommandOrControl+Shift+R', set: (v) => (replay.value = v) },
  { path: 'interrupt', label: 'Interrupt', caption: 'Cancel the current turn.', value: interruptKey.value, default: 'CommandOrControl+.', set: (v) => (interruptKey.value = v) },
]);

const isMac = computed(() => window.faceplate?.platform.os === 'darwin');
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.warning { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; font: 12px/1 'JetBrains Mono', ui-monospace, monospace; }
</style>
