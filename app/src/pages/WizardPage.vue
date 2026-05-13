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
      <q-step :name="0" title="Welcome" icon="celebration" :done="step > 0">
        <p>
          Welcome to <strong>HermesAgent Faceplate</strong> — a tiny avatar that gives your
          local hermes-agent a face, a voice, and a microphone. This wizard
          walks through the four things we need to find on your machine.
        </p>
        <p class="muted">
          Everything below runs locally. No data is sent anywhere except to
          the LLM endpoint hermes-agent itself is configured to use.
        </p>
        <q-stepper-navigation>
          <q-btn color="primary" no-caps label="Get started" @click="goNext" />
          <q-btn flat no-caps label="Skip wizard" class="q-ml-sm" @click="finish" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="1" title="Connect to hermes-agent" icon="hub" :done="step > 1">
        <p>
          The Faceplate is a frontend — it talks to a HermesAgent gateway you run yourself. Pick how yours is set up:
        </p>
        <q-option-group v-model="hermesLocation" :options="hermesLocationOptions" type="radio" class="q-mb-md" />
        <q-banner v-if="hermesLocation === 'need_setup'" class="info q-mb-md" dense>
          <template #avatar><q-icon name="info" color="primary" /></template>
          <div>
            HermesAgent is open-source and runs anywhere — local Docker is the easiest start.
            See the official setup guide:
            <a href="https://hermes-agent.nousresearch.com/docs/" rel="noopener noreferrer">hermes-agent.nousresearch.com/docs</a>.
            Once it's running, come back here and choose "I have one running".
          </div>
        </q-banner>
        <p v-if="hermesLocation !== 'need_setup'">
          Paste the URL where hermes-agent's API server is reachable, plus the bearer token. Works against any deployment — local Docker, native, or remote.
        </p>
        <q-input v-if="hermesLocation !== 'need_setup'" v-model="hermesUrl" label="Gateway URL" filled stack-label hint="e.g. http://127.0.0.1:8642/v1" />
        <q-input
          v-if="hermesLocation !== 'need_setup'"
          v-model="hermesKey"
          class="q-mt-sm"
          label="API_SERVER_KEY"
          :type="showKey ? 'text' : 'password'"
          filled
          stack-label
          hint="Set in your hermes-agent .env. Required for non-loopback URLs."
        >
          <template #append>
            <q-btn flat dense round :icon="showKey ? 'visibility_off' : 'visibility'" @click="showKey = !showKey" />
          </template>
        </q-input>
        <p v-if="hermesLocation !== 'need_setup' && !discovery.discovery" class="muted q-mt-md">Probing…</p>
        <template v-if="hermesLocation !== 'need_setup' && discovery.discovery">
          <q-banner v-if="discovery.discovery.reachable" class="ok q-mt-md">
            <template #avatar><q-icon name="check_circle" color="positive" /></template>
            Reachable at <code>{{ discovery.discovery.base_url }}</code>{{ capabilityBlurb }}.
          </q-banner>
          <q-banner v-else class="warn q-mt-md">
            <template #avatar><q-icon name="warning" color="warning" /></template>
            <span>
              Couldn't reach hermes at <code>{{ discovery.discovery.base_url }}</code>{{ discovery.discovery.http_status ? ` (HTTP ${discovery.discovery.http_status})` : '' }}.
              Check the URL, the token, and that hermes-agent is running with <code>API_SERVER_ENABLED=true</code>.
            </span>
          </q-banner>
          <q-banner v-if="discovery.discovery.local_config_readable" class="info q-mt-sm" dense>
            <template #avatar><q-icon name="folder" color="primary" /></template>
            Local <code>~/.hermes/</code> also detected — the "Reuse hermes' LLM" paraphrase mode is available as an opt-in.
          </q-banner>
        </template>
        <q-stepper-navigation>
          <q-btn outline no-caps label="Re-probe" :loading="discovery.loading" @click="discovery.refresh()" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="2" title="Speech engine" icon="memory" :done="step > 2">
        <p>
          Pick the text-to-speech engine. The Faceplate also needs a speech-to-text + wake-word path; both come from the same sidecar.
        </p>
        <q-option-group v-model="ttsEngineChoice" :options="ttsEngineOptions" type="radio" />

        <!-- Bundled Piper sidecar lifecycle. Same "Install + start" UX as
             the Kokoro card — one button kicks off the docker-compose
             pull + up; we poll for readiness and surface the status. -->
        <q-card v-if="ttsEngineChoice === 'piper'" flat bordered class="q-mt-md wizard-action-card">
          <q-card-section>
            <div class="row items-center q-gutter-sm">
              <q-chip
                :color="sidecarChip.color"
                :icon="sidecarChip.icon"
                text-color="white"
                dense
              >
                {{ sidecarChip.label }}
              </q-chip>
              <q-chip v-if="sidecarStatus?.url" outline dense>{{ sidecarStatus.url }}</q-chip>
            </div>
            <p class="muted q-mt-sm" style="margin-bottom: 0;">
              Image: <strong>cpu-slim</strong> (recommended for v1 — Hermes handles paraphrase, no on-device LLM).
            </p>
          </q-card-section>
          <q-card-actions>
            <q-btn
              v-if="!sidecarStatus?.up"
              color="primary"
              no-caps
              icon="rocket_launch"
              :label="sidecarBusy ? 'Starting (first run pulls the image, ~2-3 min)…' : 'Start the speech sidecar'"
              :loading="sidecarBusy"
              @click="startSidecar"
            />
            <q-btn
              v-else
              outline
              no-caps
              icon="stop"
              :label="sidecarBusy ? 'Stopping…' : 'Stop the speech sidecar'"
              :loading="sidecarBusy"
              @click="stopSidecar"
            />
            <q-btn flat dense no-caps icon="refresh" label="Refresh" @click="refreshSidecar" />
          </q-card-actions>
          <q-banner v-if="sidecarError" class="warn" dense>
            <template #avatar><q-icon name="warning" color="warning" /></template>
            {{ sidecarError }}
          </q-banner>
        </q-card>

        <!-- Kokoro lifecycle card — exact same surface as Settings →
             Speech Sidecar → Engine: Kokoro. One click does pull + run. -->
        <q-card v-if="ttsEngineChoice === 'kokoro'" flat bordered class="q-mt-md wizard-action-card">
          <q-card-section>
            <div class="row items-center q-gutter-sm">
              <q-chip
                :color="kokoroChip.color"
                :icon="kokoroChip.icon"
                text-color="white"
                dense
              >
                {{ kokoroChip.label }}
              </q-chip>
              <q-chip v-if="kokoroStatus?.base_url" outline dense>{{ kokoroStatus.base_url }}</q-chip>
            </div>
            <p class="muted q-mt-sm" style="margin-bottom: 0;">
              ~340 MB Docker image. Default voice <code>af_bella</code>; switchable later.
            </p>
          </q-card-section>
          <q-card-actions>
            <q-btn
              v-if="kokoroPrimary === 'install'"
              color="primary"
              no-caps
              icon="rocket_launch"
              :label="kokoroBusy ? 'Pulling image + starting (first run takes a few minutes)…' : 'Install + start Kokoro'"
              :loading="kokoroBusy"
              @click="ensureKokoro"
            />
            <q-btn
              v-else-if="kokoroPrimary === 'start'"
              color="primary"
              no-caps
              icon="play_arrow"
              :label="kokoroBusy ? 'Starting…' : 'Start Kokoro'"
              :loading="kokoroBusy"
              @click="ensureKokoro"
            />
            <q-btn
              v-else-if="kokoroPrimary === 'stop'"
              outline
              no-caps
              icon="stop"
              :label="kokoroBusy ? 'Stopping…' : 'Stop Kokoro'"
              :loading="kokoroBusy"
              @click="stopKokoroBtn"
            />
            <q-btn flat dense no-caps icon="refresh" label="Refresh" @click="refreshKokoro" />
          </q-card-actions>
          <q-banner v-if="kokoroError" class="warn" dense>
            <template #avatar><q-icon name="warning" color="warning" /></template>
            {{ kokoroError }}
          </q-banner>
          <q-banner v-if="kokoroStatus && !kokoroStatus.docker_available" class="warn" dense>
            <template #avatar><q-icon name="warning" color="warning" /></template>
            Docker isn't installed (or isn't on PATH). Install Docker Desktop, then come back here.
          </q-banner>
        </q-card>

        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="3" title="Test endpoints" icon="network_check" :done="step > 3">
        <p>Verify the connections — anything red is fixable later in Settings.</p>
        <div class="row q-col-gutter-md">
          <div class="col-12"><TestConnectionButton target="agent" label="hermes-agent" /></div>
          <div class="col-12"><TestConnectionButton target="tts" label="TTS sidecar" /></div>
          <div class="col-12"><TestConnectionButton target="asr" label="ASR sidecar" /></div>
          <!-- LLM + Paraphrase checks removed in v1: paraphrase routes
               through hermes-agent directly (no separate LLM probe needed),
               and LiteRT is hidden so the paraphrase test is redundant
               with the agent test. -->
        </div>
        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="4" title="Voice" icon="mic" :done="step > 4">
        <p>How do you want to talk to your agent?</p>
        <q-option-group v-model="inputMode" :options="inputModeOptions" type="radio" />
        <q-banner v-if="inputMode !== 'off'" class="info q-mt-md" dense>
          Mic permission is requested when you first enable PTT or wake-word.
          The avatar's halo shows a green LED whenever the mic is open.
        </q-banner>
        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="5" title="Display" icon="layers" :done="step > 5">
        <p>Where should the avatar live?</p>
        <q-option-group v-model="avatarMode" :options="avatarModeOptions" type="radio" />
        <p class="muted q-mt-sm">
          You can flip this any time from Settings → Avatar / Theme.
          {{ recommendation }}
        </p>
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
import { useQuasar } from 'quasar';

import TestConnectionButton from '../components/settings/TestConnectionButton.vue';
import { useSetting } from '../composables/use-setting';
import { useSettingsStore } from '../stores/settings';
import { useDiscoveryStore } from '../stores/discovery';
import type { KokoroStatus, SidecarStatus } from '../../src-electron/preload-api';

const $q = useQuasar();

const step = ref<number>(0);
const settings = useSettingsStore();
const discovery = useDiscoveryStore();

const sidecarMode = useSetting('speech.sidecar_mode');
const sidecarImage = useSetting('speech.sidecar_image');
const paraphraseMode = useSetting('paraphrase.model');
const inputMode = useSetting('input.mode');
const avatarMode = useSetting('avatar.mode');
const wizardCompleted = useSetting('wizard.completed');
const wizardStep = useSetting('wizard.last_step');

const hermesUrl = useSetting('hermes.base_url');
const hermesKey = useSetting('hermes.api_key');
const showKey = ref(false);
const ttsEngineChoice = useSetting('speech.tts.engine');

// Wizard-only state — captures the user's intent at install time. We
// don't persist this in settings.yaml (the actual hermes URL/key fields
// drive runtime behavior); it's just a branching aid for the wizard UI
// so users with no Hermes installed see a "set it up first" pointer
// instead of a fields-and-banner UX they can't fill in.
const hermesLocation = ref<'have' | 'need_setup'>('have');
const hermesLocationOptions = [
  { label: 'I have a Hermes gateway running (URL + key ready)', value: 'have' },
  { label: "I need to install Hermes first — show me where to start", value: 'need_setup' },
];

const capabilityBlurb = computed(() => {
  const caps = discovery.discovery?.capabilities;
  if (!caps?.model) return '';
  return ` (model: ${caps.model})`;
});

const sidecarModeOptions = [
  { label: 'Bundled Docker container (recommended)', value: 'bundled' },
  { label: 'External URL (I run my own)', value: 'external' },
  { label: 'Disabled (no TTS / ASR)', value: 'disabled' },
];

const imageOptions = [
  { label: 'cpu-slim — recommended (no on-device LLM, paraphrase via Hermes)', value: 'cpu-slim' },
  { label: 'cpu — full bundle (kept for backward compat)', value: 'cpu' },
  { label: 'cuda — GPU', value: 'cuda' },
];

const ttsEngineOptions = [
  { label: 'Piper (bundled, fast — works out of the box)', value: 'piper' },
  { label: 'Kokoro (separate sidecar — much higher voice quality, ~340 MB)', value: 'kokoro' },
];

// ─── speech sidecar (Piper) lifecycle, in-wizard ────────────────────────
//
// One-click "Start the speech sidecar" so the wizard doesn't ask the user
// to drop into a terminal. Uses the same window.faceplate.sidecar.start
// IPC that Settings → Speech Sidecar uses; first-run pulls the image
// (~1.4 GB) so the button surfaces a spinner + permissive wait.
const sidecarStatus = ref<SidecarStatus | null>(null);
const sidecarBusy = ref(false);
const sidecarError = ref<string | null>(null);
let sidecarPollTimer: ReturnType<typeof setInterval> | null = null;

const sidecarChip = computed(() => {
  const s = sidecarStatus.value;
  if (!s) return { label: 'Checking…', icon: 'hourglass_top', color: 'grey-6' };
  if (s.up) return { label: `Running · ${s.build ?? 'cpu-slim'}`, icon: 'check_circle', color: 'positive' };
  return { label: 'Not running', icon: 'pause_circle', color: 'grey-6' };
});

async function refreshSidecar(): Promise<void> {
  if (!window.faceplate) return;
  try {
    sidecarStatus.value = await window.faceplate.sidecar.status();
  } catch (err) {
    console.warn('[wizard] sidecar.status threw:', err);
  }
}

async function startSidecar(): Promise<void> {
  if (!window.faceplate || sidecarBusy.value) return;
  // Make sure the chosen image is persisted before we boot the container.
  if (sidecarImage.value !== 'cpu-slim') sidecarImage.value = 'cpu-slim';
  if (sidecarMode.value !== 'bundled') sidecarMode.value = 'bundled';
  sidecarBusy.value = true;
  sidecarError.value = null;
  try {
    await window.faceplate.sidecar.start();
    $q.notify({ type: 'positive', message: 'Speech sidecar started.', timeout: 3000 });
  } catch (err) {
    sidecarError.value = err instanceof Error ? err.message : String(err);
    $q.notify({ type: 'negative', message: sidecarError.value, timeout: 6000 });
  } finally {
    sidecarBusy.value = false;
    void refreshSidecar();
  }
}

async function stopSidecar(): Promise<void> {
  if (!window.faceplate || sidecarBusy.value) return;
  sidecarBusy.value = true;
  sidecarError.value = null;
  try {
    await window.faceplate.sidecar.stop();
  } catch (err) {
    sidecarError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sidecarBusy.value = false;
    void refreshSidecar();
  }
}

// ─── Kokoro lifecycle, in-wizard ────────────────────────────────────────
//
// Same UX as Settings → Speech Sidecar's Kokoro card. Polled every 3s
// while the user is on this step and Kokoro is selected.
const kokoroStatus = ref<KokoroStatus | null>(null);
const kokoroBusy = ref(false);
const kokoroError = ref<string | null>(null);
let kokoroPollTimer: ReturnType<typeof setInterval> | null = null;

const kokoroPrimary = computed<'install' | 'start' | 'stop' | 'none'>(() => {
  const s = kokoroStatus.value;
  if (!s) return 'none';
  if (!s.docker_available) return 'none';
  if (s.reachable && s.container_state === 'missing') return 'none';
  if (s.container_state === 'missing') return 'install';
  if (s.container_state === 'exited') return 'start';
  return 'stop';
});

const kokoroChip = computed(() => {
  const s = kokoroStatus.value;
  if (!s) return { label: 'Checking…', icon: 'hourglass_top', color: 'grey-6' };
  if (!s.docker_available) return { label: 'Docker not found', icon: 'block', color: 'grey-6' };
  if (s.reachable) return { label: 'Reachable', icon: 'check_circle', color: 'positive' };
  if (s.container_state === 'running') return { label: 'Container up, not yet ready', icon: 'sync', color: 'orange' };
  if (s.container_state === 'exited') return { label: 'Container stopped', icon: 'pause_circle', color: 'grey-6' };
  return { label: 'Not installed', icon: 'download', color: 'grey-6' };
});

async function refreshKokoro(): Promise<void> {
  if (!window.faceplate) return;
  try {
    kokoroStatus.value = await window.faceplate.kokoro.status();
  } catch (err) {
    console.warn('[wizard] kokoro.status threw:', err);
  }
}

async function ensureKokoro(): Promise<void> {
  if (!window.faceplate || kokoroBusy.value) return;
  kokoroBusy.value = true;
  kokoroError.value = null;
  try {
    kokoroStatus.value = await window.faceplate.kokoro.ensure();
    $q.notify({ type: 'positive', message: 'Kokoro is up and reachable.', timeout: 3000 });
  } catch (err) {
    kokoroError.value = err instanceof Error ? err.message : String(err);
    $q.notify({ type: 'negative', message: kokoroError.value, timeout: 6000 });
  } finally {
    kokoroBusy.value = false;
    void refreshKokoro();
  }
}

async function stopKokoroBtn(): Promise<void> {
  if (!window.faceplate || kokoroBusy.value) return;
  kokoroBusy.value = true;
  kokoroError.value = null;
  try {
    kokoroStatus.value = await window.faceplate.kokoro.stop();
  } catch (err) {
    kokoroError.value = err instanceof Error ? err.message : String(err);
  } finally {
    kokoroBusy.value = false;
  }
}

// Watch the step + engine choice — only poll while the user is on step 2
// (speech engine) AND the relevant card is visible. Stops the timers
// when the user clicks Back or moves forward so we don't burn cycles
// polling for a panel they're not looking at.
watch(
  () => [step.value, ttsEngineChoice.value] as const,
  ([s, engine]) => {
    if (sidecarPollTimer) { clearInterval(sidecarPollTimer); sidecarPollTimer = null; }
    if (kokoroPollTimer)  { clearInterval(kokoroPollTimer);  kokoroPollTimer  = null; }
    if (s !== 2) return;
    if (engine === 'piper') {
      void refreshSidecar();
      sidecarPollTimer = setInterval(() => void refreshSidecar(), 3_000);
    } else if (engine === 'kokoro') {
      void refreshKokoro();
      kokoroPollTimer = setInterval(() => void refreshKokoro(), 3_000);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (sidecarPollTimer) clearInterval(sidecarPollTimer);
  if (kokoroPollTimer)  clearInterval(kokoroPollTimer);
});

const inputModeOptions = [
  { label: 'Off — type only', value: 'off' },
  { label: 'Push-to-talk hotkey', value: 'push_to_talk' },
  { label: '"Hey Hermes" wake word', value: 'wake_word' },
];

const avatarModeOptions = [
  { label: 'Overlay — transparent, always-on-top', value: 'overlay' },
  { label: 'Windowed — regular window', value: 'windowed' },
];

const recommendation = computed(() => {
  const fp = window.faceplate;
  if (!fp) return '';
  if (fp.platform.is_wayland) return 'Wayland detected — Windowed is more reliable.';
  if (fp.platform.os === 'darwin') return 'macOS — Overlay works great.';
  if (fp.platform.os === 'win32') return 'Windows — Overlay usually works; flip to Windowed if input feels off.';
  return 'Linux X11 — Overlay supported.';
});

function goNext(): void {
  step.value = Math.min(step.value + 1, 5);
  wizardStep.value = step.value;
}

function goBack(): void {
  step.value = Math.max(step.value - 1, 0);
  wizardStep.value = step.value;
}

async function finish(): Promise<void> {
  wizardCompleted.value = true;
  // Tell main to apply the chosen mode (it owns the window factory).
  await window.faceplate?.window.setMode(settings.settings.avatar.mode);
  window.close();
}

onMounted(async () => {
  if (!discovery.discovery) await discovery.refresh();
  step.value = settings.settings.wizard.last_step ?? 0;
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
.snippet,
.wizard-code {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.4);
  color: #d8d8d8;
  border-radius: 4px;
  font: 12px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
  user-select: text;
}
.ok { background: rgba(34, 197, 94, 0.12); border-radius: 8px; }
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
.info { background: rgba(59, 130, 246, 0.12); border-radius: 8px; }

/* In-wizard action cards (start sidecar, install kokoro). Keeps the
 * primary CTA visually contained against the dark wizard background. */
.wizard-action-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}

/* The wizard runs on a dark background but Quasar's `filled` inputs
 * default to a near-black surface with dark grey text — unreadable
 * against our #0e0e10 shell. Force a slightly lighter input fill +
 * explicit light text color across all q-inputs / q-selects in the
 * wizard. :deep is required because q-input renders its native
 * <input> deep inside scoped slots. */
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
/* Radio / checkbox labels too — q-option-group items render with the
 * same default near-black text color. */
.wizard-shell :deep(.q-radio__label),
.wizard-shell :deep(.q-checkbox__label),
.wizard-shell :deep(.q-toggle__label),
.wizard-shell :deep(.q-item__label) {
  color: #f4f5f8;
}

/* Radio circle visibility. Quasar paints the inactive ring + the
 * checked-state dot in `currentColor` of an inner `<svg>` — on a dark
 * surface both default colours collapse to invisible. Force a light ring
 * for the unchecked state and a clear cyan fill for the checked state. */
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
/* Same fix for checkboxes (no places use them in the wizard today,
 * but kept here so future additions don't break). */
.wizard-shell :deep(.q-checkbox__bg) {
  border-color: rgba(255, 255, 255, 0.6);
}
.wizard-shell :deep(.q-checkbox--checked .q-checkbox__bg) {
  background: #7fdcff;
  border-color: #7fdcff;
}
.wizard-shell :deep(.q-checkbox__svg) {
  color: #0e0e10;
}
</style>
