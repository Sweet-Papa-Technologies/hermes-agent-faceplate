<template>
  <div>
    <h2>Privacy</h2>
    <p class="muted">
      The Faceplate is designed for a local-first default. Below is a live inventory of where bytes go on a typical turn.
    </p>

    <h3>Network egress (live)</h3>
    <q-card flat bordered class="card">
      <q-list separator>
        <q-item v-for="row in egress" :key="row.id">
          <q-item-section>
            <q-item-label>{{ row.label }}</q-item-label>
            <q-item-label caption>{{ row.when }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-chip :color="row.local ? 'positive' : 'warning'" text-color="white" dense>
              {{ row.local ? 'local' : 'remote' }}
            </q-chip>
          </q-item-section>
          <q-item-section side class="endpoint">
            {{ row.endpoint }}
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <h3>Microphone</h3>
    <q-card flat bordered class="card">
      <q-item tag="label">
        <q-item-section>
          <q-item-label>Mic warning shown</q-item-label>
          <q-item-label caption>One-time banner the first time you enable PTT or wake-word.</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-toggle v-model="micWarning" />
        </q-item-section>
      </q-item>
    </q-card>

    <h3>Telemetry</h3>
    <q-card flat bordered class="card">
      <q-item tag="label">
        <q-item-section>
          <q-item-label>Send anonymous error reports</q-item-label>
          <q-item-label caption>Off by default. No telemetry is collected when this is off.</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-toggle v-model="telemetry" />
        </q-item-section>
      </q-item>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useSetting } from '../../composables/use-setting';
import { useSettingsStore } from '../../stores/settings';
import { useDiscoveryStore } from '../../stores/discovery';

const micWarning = useSetting('privacy.mic_warning_shown');
const telemetry = useSetting('privacy.telemetry');

const settings = useSettingsStore();
const discovery = useDiscoveryStore();

interface EgressRow {
  id: string;
  label: string;
  when: string;
  endpoint: string;
  local: boolean;
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

const egress = computed<EgressRow[]>(() => {
  const s = settings.settings;
  const llmUrl = discovery.discovery?.llm.base_url ?? '(not discovered)';
  return [
    {
      id: 'agent',
      label: 'hermes-agent gateway',
      when: 'On every turn',
      endpoint: s.hermes.base_url,
      local: isLocalUrl(s.hermes.base_url),
    },
    {
      id: 'llm',
      label: 'LLM provider (chosen by hermes-agent)',
      when: 'Every assistant token',
      endpoint: llmUrl,
      local: isLocalUrl(llmUrl),
    },
    {
      id: 'paraphrase',
      label: 'Paraphrase pass',
      when: `When response > ${s.paraphrase.trigger_chars} chars`,
      endpoint: s.paraphrase.model === 'sidecar_fallback' ? s.speech.sidecar_url : llmUrl,
      local: s.paraphrase.model === 'sidecar_fallback' ? isLocalUrl(s.speech.sidecar_url) : isLocalUrl(llmUrl),
    },
    {
      id: 'sidecar',
      label: `Sidecar (${s.speech.sidecar_image})`,
      when: 'TTS / ASR / wake-word',
      endpoint: s.speech.sidecar_url,
      local: isLocalUrl(s.speech.sidecar_url),
    },
    {
      id: 'updater',
      label: 'Auto-updater (deferred — Phase 6)',
      when: 'Every 4 h when running',
      endpoint: 'github.com/releases',
      local: false,
    },
  ];
});
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.endpoint {
  max-width: 280px;
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  color: #555;
  word-break: break-all;
  text-align: right;
}
</style>
