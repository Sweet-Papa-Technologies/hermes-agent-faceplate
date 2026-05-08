<template>
  <div>
    <h2>Avatar / Theme</h2>
    <p class="muted">
      The same display switch covers the Wayland fallback and the Windows transparency-quirk escape hatch. Always-on-top works in either mode.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-select
          v-model="theme"
          :options="themeOptions"
          label="Theme"
          stack-label
          filled
          option-label="label"
          option-value="id"
          emit-value
          map-options
        />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <div>Scale ({{ Math.round(scale * 100) }}%)</div>
        <q-slider v-model="scale" :min="0.5" :max="2" :step="0.05" />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <div class="row q-col-gutter-md">
          <q-btn
            v-for="opt in modeOptions"
            :key="opt.value"
            :class="['mode-card col', mode === opt.value ? 'mode-card-active' : '']"
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
        <q-banner class="muted-banner q-mt-sm" dense>
          <template #avatar><q-icon :name="recommendIcon" /></template>
          {{ recommendation }}
        </q-banner>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Always on top</q-item-label>
            <q-item-label caption>Pin the avatar above other windows. Works in both modes.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="aot" />
          </q-item-section>
        </q-item>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Click-through (overlay only)</q-item-label>
            <q-item-label caption>Mouse events pass through transparent areas. Drag from the head's halo to move the avatar.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="clickThrough" :disable="mode !== 'overlay'" />
          </q-item-section>
        </q-item>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-select v-model="position" :options="positionOptions" label="Idle position" stack-label filled emit-value map-options />
      </q-card-section>
    </q-card>

    <h3>Test mode</h3>
    <p class="muted">
      Test mode cycles every state × every viseme so you can validate a theme without running a full agent loop. It opens in a separate window so it doesn't disturb the live avatar.
    </p>
    <q-btn outline no-caps icon="science" label="Open Test Mode" @click="openTestMode" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { useSetting } from '../../composables/use-setting';
import { listBuiltinThemes } from '../../themes/loader';

const theme = useSetting('avatar.theme');
const scale = useSetting('avatar.scale');
const mode = useSetting('avatar.mode');
const aot = useSetting('avatar.always_on_top');
const clickThrough = useSetting('avatar.click_through_default');
const position = useSetting('avatar.position');

const builtin = ref<{ id: string; name: string }[]>(listBuiltinThemes());
const userThemes = ref<{ id: string; name: string; builtin: boolean }[]>([]);

const themeOptions = computed(() => [
  ...builtin.value.map((t) => ({ id: t.id, label: `${t.name} (built-in)` })),
  ...userThemes.value.map((t) => ({ id: t.id, label: t.name })),
]);

const modeOptions = [
  {
    value: 'overlay' as const,
    label: 'Overlay',
    caption: 'Transparent, frameless, always-on-top.',
    icon: 'layers',
  },
  {
    value: 'windowed' as const,
    label: 'Windowed',
    caption: 'Regular window with title bar. Always works.',
    icon: 'desktop_windows',
  },
];

const positionOptions = [
  { label: 'Top left', value: 'top_left' },
  { label: 'Top right', value: 'top_right' },
  { label: 'Bottom left', value: 'bottom_left' },
  { label: 'Bottom right', value: 'bottom_right' },
  { label: 'Last known', value: 'last_known' },
];

const isWayland = computed(() => window.faceplate?.platform.is_wayland ?? false);
const os = computed(() => window.faceplate?.platform.os ?? 'darwin');

const recommendation = computed(() => {
  if (isWayland.value) return 'Wayland detected — Windowed mode is recommended.';
  if (os.value === 'darwin') return 'macOS — Overlay mode is recommended.';
  if (os.value === 'win32') return 'Windows — Overlay works on most machines. Switch to Windowed if you see flicker or input issues.';
  return 'Linux X11 — Overlay mode is supported.';
});
const recommendIcon = computed(() =>
  isWayland.value ? 'warning' : 'check_circle',
);

function setMode(value: 'overlay' | 'windowed'): void {
  mode.value = value;
  void window.faceplate?.window.setMode(value);
}

function openTestMode(): void {
  // Open in a new tab in the same window. The dev/prod path differs, so we
  // just navigate the current renderer; main creates a separate Settings
  // window already, so this is fine for the moment.
  window.open('#/test', '_blank', 'noopener');
}

onMounted(async () => {
  const fp = window.faceplate;
  if (!fp) return;
  try {
    userThemes.value = await fp.themes.list();
  } catch (err) {
    console.error('[settings.avatar] theme list failed:', err);
  }
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.muted-banner { background: rgba(0,0,0,0.04); border-radius: 8px; }
.mode-card {
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
