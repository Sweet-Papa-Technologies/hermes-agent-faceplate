<template>
  <div>
    <h2>Connection</h2>
    <p class="muted">
      The Faceplate routes every conversation through hermes-agent's local API
      server. The discovered LLM is shown read-only — it's pulled from your
      <code>~/.hermes/config.yaml</code>.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-input v-model="baseUrl" label="HermesAgent URL" filled stack-label hint="Default: http://127.0.0.1:8642/v1" />
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-input
          v-model="apiKey"
          label="HermesAgent API key"
          filled
          stack-label
          :type="showKey ? 'text' : 'password'"
          :hint="apiKeyHint"
        >
          <template #append>
            <q-btn flat dense round :icon="showKey ? 'visibility_off' : 'visibility'" @click="showKey = !showKey" />
          </template>
        </q-input>
      </q-card-section>
      <q-separator />
      <q-card-section>
        <q-input v-model="configPath" label="Hermes config path" filled stack-label />
        <div class="row q-mt-sm q-gutter-sm">
          <q-btn outline no-caps icon="refresh" :loading="discovery.loading" label="Re-discover" @click="discovery.refresh()" />
        </div>
      </q-card-section>
    </q-card>

    <h3>Hermes capabilities</h3>
    <q-card flat bordered class="card">
      <q-list>
        <q-item>
          <q-item-section>
            <q-item-label>Reachable</q-item-label>
            <q-item-label caption>HTTP probe against {{ d?.base_url ?? '—' }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-icon
              :name="d?.reachable ? 'check_circle' : 'cancel'"
              :color="d?.reachable ? 'positive' : 'negative'"
            />
          </q-item-section>
        </q-item>
        <q-item v-if="d?.capabilities?.model">
          <q-item-section><q-item-label>Hermes model id</q-item-label></q-item-section>
          <q-item-section side>{{ d.capabilities.model }}</q-item-section>
        </q-item>
        <q-item v-if="d?.capabilities?.platform">
          <q-item-section><q-item-label>Platform</q-item-label></q-item-section>
          <q-item-section side>{{ d.capabilities.platform }}</q-item-section>
        </q-item>
        <q-item v-if="featureChips.length">
          <q-item-section><q-item-label>Features</q-item-label></q-item-section>
          <q-item-section side>
            <div class="row q-gutter-xs">
              <q-chip v-for="f in featureChips" :key="f" dense size="sm">{{ f }}</q-chip>
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <h3>Local config (optional)</h3>
    <q-card flat bordered class="card">
      <q-card-section v-if="!d?.local_config_readable" class="muted">
        <q-icon name="info" /> Local <code>~/.hermes/</code> not readable from this machine. Faceplate runs in HTTP-only mode — chat works against any remote / Docker hermes. The "Reuse hermes' LLM" paraphrase option is unavailable; the sidecar fallback is used instead (zero-config and session-safe).
      </q-card-section>
      <q-list v-else>
        <q-item>
          <q-item-section><q-item-label>Provider</q-item-label></q-item-section>
          <q-item-section side>{{ d?.local_config?.llm.provider ?? '—' }}</q-item-section>
        </q-item>
        <q-item>
          <q-item-section><q-item-label>LLM base URL</q-item-label></q-item-section>
          <q-item-section side>{{ d?.local_config?.llm.base_url ?? '—' }}</q-item-section>
        </q-item>
        <q-item>
          <q-item-section><q-item-label>LLM model</q-item-label></q-item-section>
          <q-item-section side>{{ d?.local_config?.llm.model ?? '—' }}</q-item-section>
        </q-item>
        <q-item>
          <q-item-section><q-item-label>LLM API key present</q-item-label></q-item-section>
          <q-item-section side>
            <q-icon :name="d?.local_config?.llm.api_key_present ? 'check_circle' : 'cancel'" :color="d?.local_config?.llm.api_key_present ? 'positive' : 'negative'" />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-banner v-for="warn in d?.warnings ?? []" :key="warn" class="warning q-my-md" dense>
      <template #avatar><q-icon name="warning" color="warning" /></template>
      {{ warn }}
    </q-banner>

    <h3>Connectivity</h3>
    <div class="test-row">
      <TestConnectionButton target="agent" label="Test hermes-agent" />
      <TestConnectionButton target="llm" label="Test LLM" />
    </div>

    <h3>System-wide event tap</h3>
    <q-item tag="label" class="card-row">
      <q-item-section>
        <q-item-label>Install shell-hook bridge</q-item-label>
        <q-item-label caption>
          Writes <code>hermes-faceplate-hook.sh</code> into <code>~/.hermes/hooks/</code> and adds a <code>hooks:</code> block to <code>~/.hermes/config.yaml</code>, so Telegram, cron, and other channels are voiced too. Observe-only — no rewrite.
        </q-item-label>
      </q-item-section>
      <q-item-section side>
        <q-toggle :model-value="installShellHook" :loading="hookBusy" @update:model-value="onHookToggle" />
      </q-item-section>
    </q-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useQuasar } from 'quasar';

import { useSetting } from '../../composables/use-setting';
import { useDiscoveryStore } from '../../stores/discovery';
import TestConnectionButton from './TestConnectionButton.vue';
import HookPreviewDialog from './HookPreviewDialog.vue';
import type { HookInstallResult } from '../../../src-electron/preload-api';

const baseUrl = useSetting('hermes.base_url');
const apiKey = useSetting('hermes.api_key');
const configPath = useSetting('hermes.config_path');
const installShellHook = useSetting('hermes.install_shell_hook');

const showKey = ref(false);
const hookBusy = ref(false);
const $q = useQuasar();
const discovery = useDiscoveryStore();
const d = computed(() => discovery.discovery);

const apiKeyHint = computed(() => {
  if (apiKey.value) return 'Present.';
  return 'Paste your API_SERVER_KEY here. (Local installs can also leave this blank if it\'s already set in ~/.hermes/.env.)';
});

const featureChips = computed(() => {
  const f = d.value?.capabilities?.features;
  if (!f) return [];
  const out: string[] = [];
  if (f.chat_completions) out.push('chat_completions');
  if (f.responses_api) out.push('responses_api');
  if (f.runs) out.push('runs');
  if (f.streaming) out.push('streaming');
  if (f.cancellation) out.push('cancellation');
  return out;
});

function onHookToggle(value: boolean): void {
  if (value) installFlow();
  else uninstallFlow();
}

function installFlow(): void {
  hookBusy.value = true;
  $q.dialog({ component: HookPreviewDialog })
    .onOk((result: HookInstallResult) => {
      hookBusy.value = false;
      if (result.ok) {
        $q.notify({
          type: 'positive',
          message: `Bridge installed (listener on :${result.listener_port}).`,
          timeout: 4000,
        });
      } else {
        $q.notify({ type: 'negative', message: result.error ?? 'Install failed.', timeout: 6000 });
      }
    })
    .onCancel(() => {
      hookBusy.value = false;
    });
}

async function uninstallFlow(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  hookBusy.value = true;
  try {
    const result = await fp.hermes.hookUninstall();
    if (result.ok) {
      $q.notify({ type: 'positive', message: 'Bridge removed.', timeout: 3000 });
    } else {
      $q.notify({ type: 'negative', message: result.error ?? 'Uninstall failed.', timeout: 6000 });
    }
  } finally {
    hookBusy.value = false;
  }
}
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.card-row { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; }
.warning { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }
.test-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; font: 12px/1 'JetBrains Mono', ui-monospace, monospace; }
</style>
