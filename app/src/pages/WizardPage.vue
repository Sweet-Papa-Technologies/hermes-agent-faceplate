<template>
  <div class="wizard-shell">
    <q-stepper
      v-model="step"
      ref="stepperRef"
      vertical
      color="primary"
      animated
      header-nav
      class="wizard-stepper"
    >
      <!-- ── Step 0: Welcome ──────────────────────────────────────── -->
      <q-step :name="0" title="Welcome" icon="celebration" :done="step > 0">
        <p>
          Welcome to <strong>HermesAgent Faceplate</strong> — a desktop avatar
          for a HermesAgent you already run.
        </p>
        <p class="muted">
          Two short steps: point us at your Hermes, and (optionally) at a
          speech service. The app is fully usable type-only — voice can stay
          off and be flipped on later.
        </p>
        <q-stepper-navigation>
          <q-btn color="primary" no-caps label="Get started" @click="goNext" />
          <q-btn flat no-caps label="Skip wizard" class="q-ml-sm" @click="finish" />
        </q-stepper-navigation>
      </q-step>

      <!-- ── Step 1: Connect to Hermes ────────────────────────────── -->
      <q-step :name="1" title="Connect to HermesAgent" icon="hub" :done="step > 1">
        <p>
          The Faceplate is a client — it talks to a HermesAgent gateway you
          run. Paste the URL and bearer token; works against any deployment
          (local Docker, native, LAN, cloud).
        </p>

        <q-input v-model="hermesUrl" label="Gateway URL" filled stack-label hint="e.g. http://127.0.0.1:8642/v1" />
        <q-input
          v-model="hermesKey"
          class="q-mt-sm"
          label="API_SERVER_KEY"
          :type="showKey ? 'text' : 'password'"
          filled
          stack-label
          hint="From your Hermes deployment's .env (API_SERVER_KEY)."
        >
          <template #append>
            <q-btn flat dense round :icon="showKey ? 'visibility_off' : 'visibility'" @click="showKey = !showKey" />
          </template>
        </q-input>

        <p class="muted q-mt-md" style="font-size: 13px;">
          Don't have Hermes yet?
          <a href="https://hermes-agent.nousresearch.com/docs/" rel="noopener noreferrer">
            HermesAgent's docs
          </a>
          have the install story (local Docker is the easiest start).
          The Faceplate doesn't install or supervise Hermes for you.
        </p>

        <p v-if="!discovery.discovery" class="muted q-mt-md">Probing…</p>
        <template v-else-if="discovery.discovery">
          <q-banner v-if="discovery.discovery.reachable" class="ok q-mt-md">
            <template #avatar><q-icon name="check_circle" color="positive" /></template>
            Reachable at <code>{{ discovery.discovery.base_url }}</code>{{ capabilityBlurb }}.
          </q-banner>
          <q-banner v-else class="warn q-mt-md">
            <template #avatar><q-icon name="warning" color="warning" /></template>
            Couldn't reach hermes at <code>{{ discovery.discovery.base_url }}</code>{{ discovery.discovery.http_status ? ` (HTTP ${discovery.discovery.http_status})` : '' }}.
            Check the URL, the token, and that hermes-agent is running with <code>API_SERVER_ENABLED=true</code>.
          </q-banner>
        </template>

        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn outline no-caps label="Re-probe" :loading="discovery.loading" class="q-ml-sm" @click="discovery.refresh()" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <!-- ── Step 2: Voice ────────────────────────────────────────── -->
      <q-step :name="2" title="Voice" icon="mic" :done="step > 2">
        <p>How do you want to interact with your agent?</p>
        <q-option-group v-model="voiceMode" :options="voiceModeOptions" type="radio" />

        <template v-if="voiceMode !== 'off'">
          <p class="muted q-mt-md" style="font-size: 13px;">
            The Faceplate connects to a speech sidecar by URL — it doesn't run
            one. Set one up with
            <code>setup/speech-sidecar.sh</code> (native Kokoro + Whisper),
            bring your own OpenAI-compatible endpoint, or point at a remote
            one. The defaults below work for a local sidecar on this machine.
          </p>
          <q-input v-model="sidecarUrl" class="q-mt-md" label="Speech sidecar URL" filled stack-label />
          <q-input
            v-model="sidecarToken"
            class="q-mt-sm"
            label="Bearer token"
            :type="showSidecarToken ? 'text' : 'password'"
            filled
            stack-label
            hint="Printed by setup/speech-sidecar.sh; empty disables auth (dev only)."
          >
            <template #append>
              <q-btn flat dense round :icon="showSidecarToken ? 'visibility_off' : 'visibility'" @click="showSidecarToken = !showSidecarToken" />
            </template>
          </q-input>

          <q-banner v-if="sidecarStatus" :class="sidecarStatus.up ? 'ok q-mt-md' : 'warn q-mt-md'" dense>
            <template #avatar>
              <q-icon :name="sidecarStatus.up ? 'check_circle' : 'pause_circle'" :color="sidecarStatus.up ? 'positive' : 'warning'" />
            </template>
            <span v-if="sidecarStatus.up">
              Sidecar reachable at <code>{{ sidecarStatus.url }}</code>.
            </span>
            <span v-else>
              Not reachable yet. You can finish the wizard and start the
              sidecar later — voice will start working as soon as it's up.
            </span>
          </q-banner>
        </template>

        <q-banner v-if="voiceMode !== 'off'" class="info q-mt-md" dense>
          Mic permission is requested when push-to-talk or wake-word fires.
          The avatar's halo shows a green LED whenever the mic is open.
        </q-banner>

        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn color="primary" no-caps label="Finish" class="q-ml-sm" @click="finish" />
        </q-stepper-navigation>
      </q-step>
    </q-stepper>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue';

import { useSetting } from '../composables/use-setting';
import { useSettingsStore } from '../stores/settings';
import { useDiscoveryStore } from '../stores/discovery';
import type { SidecarStatus } from '../../src-electron/preload-api';

const step = ref<number>(0);
const settings = useSettingsStore();
const discovery = useDiscoveryStore();

// Persisted settings the wizard reads/writes.
const hermesUrl = useSetting('hermes.base_url');
const hermesKey = useSetting('hermes.api_key');
const speechEnabled = useSetting('speech.enabled');
const inputMode = useSetting('input.mode');
const sidecarUrl = useSetting('speech.sidecar_url');
const sidecarToken = useSetting('speech.sidecar_token');
const wizardCompleted = useSetting('wizard.completed');
const wizardStep = useSetting('wizard.last_step');

const showKey = ref(false);
const showSidecarToken = ref(false);

// Voice mode unifies the master speech.enabled toggle with input.mode so the
// wizard offers a single tidy radio. 'off' → speech.enabled=false (no TTS,
// no STT); PTT/wake → speech.enabled=true + input.mode=ptt|wake.
type VoiceMode = 'off' | 'push_to_talk' | 'wake_word';
const voiceMode = computed<VoiceMode>({
  get: () => (speechEnabled.value ? (inputMode.value as VoiceMode) : 'off'),
  set: (next) => {
    if (next === 'off') {
      speechEnabled.value = false;
      inputMode.value = 'off';
    } else {
      speechEnabled.value = true;
      inputMode.value = next;
    }
  },
});
const voiceModeOptions = [
  { label: 'Off — type only', value: 'off' },
  { label: 'Push-to-talk hotkey', value: 'push_to_talk' },
  { label: 'Wake word — "Hey Hermes" hands-free', value: 'wake_word' },
];

const capabilityBlurb = computed(() => {
  const caps = discovery.discovery?.capabilities;
  if (!caps?.model) return '';
  return ` (model: ${caps.model})`;
});

// Live sidecar reachability for the voice step. Polls every 3 s while the
// user is on that step so the chip flips green as soon as they bring up
// their sidecar in a terminal.
const sidecarStatus = ref<SidecarStatus | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function refreshSidecar(): Promise<void> {
  if (!window.faceplate) return;
  try {
    sidecarStatus.value = await window.faceplate.sidecar.status();
  } catch (err) {
    console.warn('[wizard] sidecar.status threw:', err);
  }
}

watch(
  () => step.value,
  (s) => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (s !== 2) return;
    void refreshSidecar();
    pollTimer = setInterval(() => void refreshSidecar(), 3_000);
  },
);

onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); });

function goNext(): void {
  step.value = Math.min(step.value + 1, 2);
  wizardStep.value = step.value;
}
function goBack(): void {
  step.value = Math.max(step.value - 1, 0);
  wizardStep.value = step.value;
}

async function finish(): Promise<void> {
  wizardCompleted.value = true;
  // Apply the chosen avatar mode (electron-main owns the window factory).
  // Display mode is auto-detected on first run (Wayland → windowed); the
  // user can still flip it later from Settings → Avatar & Display.
  await window.faceplate?.window.setMode(settings.settings.avatar.mode);
  window.close();
}

onMounted(async () => {
  if (!discovery.discovery) await discovery.refresh();
  // Clamp any persisted step from an older wizard (which had more steps).
  step.value = Math.min(settings.settings.wizard.last_step ?? 0, 2);
});
</script>

<style scoped>
.wizard-shell {
  min-height: 100vh;
  padding: 24px;
  background: #0e0e10;
  color: #e6e6e6;
  font: 14px/1.5 system-ui, sans-serif;
}
.wizard-stepper {
  background: transparent;
  color: inherit;
}
.muted { color: rgba(230, 230, 230, 0.6); }
code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
  font: 12px/1 'JetBrains Mono', ui-monospace, monospace;
}
a { color: #7fdcff; }
.ok { background: rgba(34, 197, 94, 0.12); border-radius: 8px; }
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
.info { background: rgba(59, 130, 246, 0.12); border-radius: 8px; }

/* Wizard runs on a dark background; force readable text in Quasar inputs. */
.wizard-shell :deep(.q-field--filled .q-field__control) {
  background: rgba(255, 255, 255, 0.06);
}
.wizard-shell :deep(.q-field--filled .q-field__control:hover) {
  background: rgba(255, 255, 255, 0.09);
}
.wizard-shell :deep(.q-field--filled .q-field__control:before) {
  background: transparent;
}
.wizard-shell :deep(.q-field__native),
.wizard-shell :deep(.q-field__input),
.wizard-shell :deep(.q-field__prefix),
.wizard-shell :deep(.q-field__suffix) {
  color: #f4f5f8;
}
.wizard-shell :deep(.q-field__label) {
  color: rgba(244, 245, 248, 0.6);
}
.wizard-shell :deep(.q-field--focused .q-field__label),
.wizard-shell :deep(.q-field--float .q-field__label) {
  color: rgba(127, 220, 255, 0.85);
}
.wizard-shell :deep(.q-field__messages) {
  color: rgba(244, 245, 248, 0.55);
}
.wizard-shell :deep(.q-radio__label),
.wizard-shell :deep(.q-checkbox__label),
.wizard-shell :deep(.q-toggle__label),
.wizard-shell :deep(.q-item__label) {
  color: #f4f5f8;
}
.wizard-shell :deep(.q-radio__bg) {
  color: rgba(255, 255, 255, 0.6);
}
.wizard-shell :deep(.q-radio--checked .q-radio__bg) {
  color: #7fdcff;
}
.wizard-shell :deep(.q-radio__check) {
  color: #7fdcff;
  fill: #7fdcff;
}
.wizard-shell :deep(.q-radio__inner) {
  color: rgba(255, 255, 255, 0.7);
}
</style>
