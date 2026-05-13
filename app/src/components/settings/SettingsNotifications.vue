<template>
  <div>
    <h2>Notifications</h2>
    <p class="muted">
      OS-native notifications when Hermes finishes a response or sends an unprompted message. The bridge respects your "do-not-disturb" hours and (optionally) suppresses notifications when the Faceplate is the active window.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Enable notifications</q-item-label>
            <q-item-label caption>Master switch. When off, no OS notifications fire.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="enabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Play sound</q-item-label>
            <q-item-label caption>Off uses Electron's "silent" notification flag — OS still shows the banner.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="sound" :disable="!enabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <div class="q-mb-sm" style="font-size: 13px; font-weight: 600;">When to fire</div>
        <q-option-group
          v-model="mode"
          type="radio"
          :options="modeOptions"
          :disable="!enabled"
        />
        <p class="muted q-mt-sm" style="font-size: 12px;">
          Unprompted messages (Hermes pinging you on its own — see "Hermes Pings" tab) always fire even in <em>backgrounded only</em> mode, since you may not be looking at the right window.
        </p>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <div class="q-mb-sm" style="font-size: 13px; font-weight: 600;">Do-not-disturb hours</div>
        <p class="muted" style="font-size: 12px;">
          24-hour times. Equal start and end disables DND. Wraps midnight (e.g. 22:00 → 08:00 = quiet overnight).
        </p>
        <div class="row q-col-gutter-md q-mt-sm">
          <q-input
            v-model="dndStart"
            class="col-6"
            label="Start"
            mask="##:##"
            placeholder="22:00"
            filled
            stack-label
            :disable="!enabled"
          />
          <q-input
            v-model="dndEnd"
            class="col-6"
            label="End"
            mask="##:##"
            placeholder="08:00"
            filled
            stack-label
            :disable="!enabled"
          />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-actions :class="{ disabled: !enabled }">
        <q-btn outline no-caps icon="notifications" label="Send a test notification" :disable="!enabled" @click="testNotification" />
      </q-card-actions>
    </q-card>

    <q-banner v-if="!supported" class="warn q-mt-md" dense>
      <template #avatar><q-icon name="warning" color="warning" /></template>
      Your OS reports no notification support. On Windows, this usually means the AppUserModelID isn't registered (auto-fixed in production builds). On Linux, install <code>libnotify</code> if missing.
    </q-banner>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useSetting } from '../../composables/use-setting';

const enabled = useSetting('notifications.enabled');
const sound = useSetting('notifications.sound');
const mode = useSetting('notifications.mode');
const dndStart = useSetting('notifications.dnd_start');
const dndEnd = useSetting('notifications.dnd_end');

const $q = useQuasar();

const modeOptions = [
  { label: 'Backgrounded only — quiet when the Faceplate is in front', value: 'backgrounded_only' },
  { label: 'Always — fire even when the app is focused', value: 'always' },
];

// Capability check. The main process exposes Notification.isSupported()
// indirectly: an unsupported platform returns null from notify.show().
// We probe by firing a test on demand below; if the user is curious
// about support before then, this defaults to true so we don't scare
// people with a permanent "may not work" banner.
const supported = ref(true);

async function testNotification(): Promise<void> {
  const id = await window.faceplate?.notify.show({
    id: `test:${Date.now()}`,
    title: 'HermesAgent Faceplate',
    body: 'Test notification — if you see this, you\'re wired up correctly.',
    kind: 'system',
  });
  if (id == null) {
    supported.value = false;
    $q.notify({
      type: 'negative',
      message: 'OS rejected the test notification — see banner below.',
      timeout: 4000,
    });
    return;
  }
  $q.notify({ type: 'positive', message: 'Test sent.', timeout: 2000 });
}

onMounted(() => {
  // Best-effort capability hint — set supported.value = false if a
  // recent test failed; we have no synchronous probe.
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.disabled { opacity: 0.55; pointer-events: none; }
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
</style>
