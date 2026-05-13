<template>
  <div>
    <h2>Hermes Pings</h2>
    <p class="muted">
      Receive unprompted messages from Hermes — cron jobs, autonomous decisions, scheduled reminders. Requires the Hermes-side <code>faceplate</code> plugin (one-time install).
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Enable</q-item-label>
            <q-item-label caption>
              Off by default — the Faceplate works without this. Turn on after installing the plugin (instructions below).
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="enabled" />
          </q-item-section>
        </q-item>
      </q-card-section>
    </q-card>

    <q-card flat bordered class="card">
      <q-card-section :class="{ disabled: !enabled }">
        <q-input
          v-model="url"
          label="Plugin WebSocket URL"
          filled
          stack-label
          hint="Default: ws://127.0.0.1:8643/ws — change if you set FACEPLATE_PORT or are running Hermes on another host."
          :disable="!enabled"
        />
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <q-input
          v-model="apiKey"
          label="FACEPLATE_API_KEY"
          :type="showKey ? 'text' : 'password'"
          filled
          stack-label
          hint="Same value as the env var FACEPLATE_API_KEY in ~/.hermes/.env."
          :disable="!enabled"
        >
          <template #append>
            <q-btn flat dense round :icon="showKey ? 'visibility_off' : 'visibility'" @click="showKey = !showKey" />
          </template>
        </q-input>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <q-input
          v-model="chatId"
          label="Subscribe to chat_id"
          filled
          stack-label
          hint="Single channel (e.g. 'default' — matches FACEPLATE_HOME_CHANNEL) or '*' to receive everything the plugin pushes."
          :disable="!enabled"
        />
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !enabled }">
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Speak incoming pings</q-item-label>
            <q-item-label caption>Off by default — most pings are quiet "FYI" messages. Even when off, captions show + OS notification fires.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="speak" :disable="!enabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-actions :class="{ disabled: !enabled }">
        <q-btn outline no-caps icon="refresh" label="Refresh status" :loading="checking" :disable="!enabled" @click="refresh" />
      </q-card-actions>
    </q-card>

    <q-card v-if="enabled" flat bordered class="card">
      <q-card-section>
        <div class="status-row">
          <q-chip
            :color="status?.connected ? 'positive' : 'grey-6'"
            :icon="status?.connected ? 'check_circle' : 'pause_circle'"
            text-color="white"
            dense
          >
            {{ status?.connected ? 'Connected' : 'Disconnected' }}
          </q-chip>
          <q-chip v-if="status?.url" outline dense>
            {{ status.url }}
          </q-chip>
          <q-chip v-if="status?.last_frame_at" outline dense>
            Last ping {{ formatRel(status.last_frame_at) }}
          </q-chip>
        </div>
        <div v-if="status?.last_error" class="error-line q-mt-sm">
          <q-icon name="error_outline" /> {{ status.last_error }}
        </div>
      </q-card-section>
    </q-card>

    <h3>How to set up the Hermes side</h3>
    <q-card flat bordered class="card setup-card">
      <q-card-section>
        <ol class="setup-steps">
          <li>
            Copy the plugin into your Hermes config dir:
            <pre class="snippet">cp -R hermes-plugin/faceplate ~/.hermes/plugins/faceplate</pre>
          </li>
          <li>
            Add a shared secret to <code>~/.hermes/.env</code>:
            <pre class="snippet">FACEPLATE_API_KEY=<replace-with-random>
FACEPLATE_HOME_CHANNEL=default
FACEPLATE_PORT=8643</pre>
            Paste the same <code>FACEPLATE_API_KEY</code> value into the field above.
          </li>
          <li>
            Restart your Hermes container (or whatever you use to run it).
          </li>
          <li>
            Test with a one-shot cron job in <code>~/.hermes/cron/</code>:
            <pre class="snippet">name: faceplate-ping-test
cron: "*/5 * * * *"
prompt: "Say hi and tell me the time."
deliver: faceplate
chat_id: ${FACEPLATE_HOME_CHANNEL}</pre>
            Within 5 minutes you should see an OS notification + a new turn in the "Hermes pings" conversation.
          </li>
        </ol>
        <p class="muted">
          Full reference: <code>hermes-plugin/README.md</code> + <code>docs/v1/research/phase6-hermes-push.md</code>.
        </p>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';

import { useSetting } from '../../composables/use-setting';
import type { AgentPushStatus } from '../../../src-electron/preload-api';

const enabled = useSetting('agent_push.enabled');
const url = useSetting('agent_push.url');
const apiKey = useSetting('agent_push.api_key');
const chatId = useSetting('agent_push.chat_id');
const speak = useSetting('agent_push.speak');

const showKey = ref(false);
const status = ref<AgentPushStatus | null>(null);
const checking = ref(false);

async function refresh(): Promise<void> {
  if (!window.faceplate) return;
  checking.value = true;
  try {
    status.value = await window.faceplate.agentPush.status();
  } finally {
    checking.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refresh(), 3_000);
}
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(enabled, (v) => {
  if (v) {
    void refresh();
    startPolling();
  } else {
    stopPolling();
    status.value = null;
  }
});

function formatRel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  if (enabled.value) {
    void refresh();
    startPolling();
  }
});

onBeforeUnmount(stopPolling);
</script>

<style scoped>
h2 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
.muted { color: #666; margin-bottom: 16px; }
.card { margin-bottom: 16px; border-radius: 10px; }
.disabled { opacity: 0.55; pointer-events: none; }

.status-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.error-line { color: #c62828; font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace; }

.setup-card .setup-steps {
  margin: 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font: 13px/1.5 system-ui, sans-serif;
}
.snippet {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #1a1a1a;
  border-radius: 6px;
  font: 12px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
  user-select: text;
}
</style>
