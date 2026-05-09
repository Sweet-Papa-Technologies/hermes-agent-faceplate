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

      <q-step :name="1" title="Find hermes-agent" icon="hub" :done="step > 1">
        <p v-if="!discovery.discovery">Looking for <code>~/.hermes/config.yaml</code>…</p>
        <template v-else>
          <q-banner v-if="discovery.discovery.found" class="ok">
            <template #avatar><q-icon name="check_circle" color="positive" /></template>
            Found at <code>{{ discovery.discovery.config_path }}</code>.
          </q-banner>
          <q-banner v-else class="warn">
            <template #avatar><q-icon name="warning" color="warning" /></template>
            <span>
              No hermes-agent config detected.
              <a href="https://github.com/NousResearch/hermes-agent" target="_blank">Install hermes-agent</a>,
              then click Re-discover.
            </span>
          </q-banner>
          <q-list bordered class="q-mt-md">
            <q-item>
              <q-item-section><q-item-label>API server enabled</q-item-label></q-item-section>
              <q-item-section side>
                <q-icon
                  :name="discovery.discovery.api_server_enabled ? 'check_circle' : 'cancel'"
                  :color="discovery.discovery.api_server_enabled ? 'positive' : 'negative'"
                />
              </q-item-section>
            </q-item>
            <q-item>
              <q-item-section><q-item-label>API key present</q-item-label></q-item-section>
              <q-item-section side>
                <q-icon
                  :name="discovery.discovery.api_key_present ? 'check_circle' : 'cancel'"
                  :color="discovery.discovery.api_key_present ? 'positive' : 'negative'"
                />
              </q-item-section>
            </q-item>
            <q-item v-if="discovery.discovery.llm.model">
              <q-item-section><q-item-label>Discovered LLM</q-item-label></q-item-section>
              <q-item-section side>{{ discovery.discovery.llm.model }} ({{ discovery.discovery.llm.provider ?? 'custom' }})</q-item-section>
            </q-item>
          </q-list>
          <q-banner
            v-if="!discovery.discovery.api_server_enabled || !discovery.discovery.api_key_present"
            class="warn q-mt-md"
            dense
          >
            Add to <code>~/.hermes/.env</code>:
            <pre class="snippet">API_SERVER_ENABLED=true
API_SERVER_KEY=&lt;a long random string&gt;</pre>
            Then restart hermes-agent and re-discover.
          </q-banner>
        </template>
        <q-stepper-navigation>
          <q-btn outline no-caps label="Re-discover" :loading="discovery.loading" @click="discovery.refresh()" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="2" title="Speech sidecar" icon="memory" :done="step > 2">
        <p>
          The bundled Docker sidecar exposes TTS, ASR, wake-word, and an
          on-device paraphrase model. If you'd rather point at an external
          OpenAI-compatible URL, switch in Settings → Speech Sidecar later.
        </p>
        <q-option-group v-model="sidecarMode" :options="sidecarModeOptions" type="radio" />
        <div v-if="sidecarMode === 'bundled'" class="q-mt-md">
          <p class="muted">
            Image variant: choose <strong>cpu</strong> for the full bundle (paraphrase included),
            or <strong>cpu-slim</strong> if you'd rather not download the on-device LLM (~2.6 GB saved).
          </p>
          <q-option-group v-model="sidecarImage" :options="imageOptions" type="radio" inline />
          <q-banner class="q-mt-md info">
            Run from a terminal once: <code>docker compose -f sidecar/compose.{{ sidecarImage }}.yml up -d</code>.
            The Faceplate auto-starts it from this point on.
          </q-banner>
        </div>
        <q-stepper-navigation>
          <q-btn flat no-caps label="Back" @click="goBack" />
          <q-btn color="primary" no-caps label="Continue" class="q-ml-sm" @click="goNext" />
        </q-stepper-navigation>
      </q-step>

      <q-step :name="3" title="Test endpoints" icon="network_check" :done="step > 3">
        <p>Verify the connections — anything red is fixable later in Settings.</p>
        <div class="row q-col-gutter-md">
          <div class="col-12"><TestConnectionButton target="agent" label="hermes-agent" /></div>
          <div class="col-12"><TestConnectionButton target="llm" label="LLM" /></div>
          <div class="col-12"><TestConnectionButton target="tts" label="TTS sidecar" /></div>
          <div class="col-12"><TestConnectionButton target="asr" label="ASR sidecar" /></div>
          <div class="col-12"><TestConnectionButton target="paraphrase" label="Paraphrase" /></div>
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
import { ref, computed, onMounted } from 'vue';

import TestConnectionButton from '../components/settings/TestConnectionButton.vue';
import { useSetting } from '../composables/use-setting';
import { useSettingsStore } from '../stores/settings';
import { useDiscoveryStore } from '../stores/discovery';

const step = ref<number>(0);
const settings = useSettingsStore();
const discovery = useDiscoveryStore();

const sidecarMode = useSetting('speech.sidecar_mode');
const sidecarImage = useSetting('speech.sidecar_image');
const inputMode = useSetting('input.mode');
const avatarMode = useSetting('avatar.mode');
const wizardCompleted = useSetting('wizard.completed');
const wizardStep = useSetting('wizard.last_step');

const sidecarModeOptions = [
  { label: 'Bundled Docker container (recommended)', value: 'bundled' },
  { label: 'External URL (I run my own)', value: 'external' },
  { label: 'Disabled (no TTS / ASR)', value: 'disabled' },
];

const imageOptions = [
  { label: 'cpu — full', value: 'cpu' },
  { label: 'cpu-slim — no on-device LLM', value: 'cpu-slim' },
  { label: 'cuda — GPU', value: 'cuda' },
];

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
.snippet {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.4);
  color: #d8d8d8;
  border-radius: 4px;
  font: 12px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
}
.ok { background: rgba(34, 197, 94, 0.12); border-radius: 8px; }
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
.info { background: rgba(59, 130, 246, 0.12); border-radius: 8px; }
</style>
