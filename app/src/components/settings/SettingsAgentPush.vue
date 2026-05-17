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

    <h3>Set up the Hermes side</h3>
    <q-card flat bordered class="card setup-card">
      <q-card-section>
        <p class="setup-intro">
          One click copies the plugin into <code>~/.hermes/plugins/faceplate</code>, adds the three env vars to <code>~/.hermes/.env</code> (generating a random shared secret if you don't already have one), and writes the matching key into Faceplate settings.
        </p>
        <div class="setup-actions">
          <q-btn
            unelevated
            color="primary"
            no-caps
            icon="download_for_offline"
            label="Install plugin"
            :loading="installing"
            @click="onInstallClick"
          />
          <q-btn
            v-if="lastInstall?.ok"
            outline
            no-caps
            icon="refresh"
            label="Re-run install"
            :loading="installing"
            @click="onInstallClick"
          />
        </div>
        <div v-if="lastInstall" class="install-result q-mt-md" :class="{ 'install-error': !lastInstall.ok }">
          <q-icon :name="lastInstall.ok ? 'check_circle' : 'error_outline'" />
          <div>
            <div v-if="lastInstall.error" class="error-line">{{ lastInstall.error }}</div>
            <ul v-if="lastInstall.steps.length" class="step-list">
              <li v-for="(line, i) in lastInstall.steps" :key="i">{{ line }}</li>
            </ul>
          </div>
        </div>
        <p class="muted q-mt-md">
          After install, restart Hermes so the plugin loader picks up the new folder. If we found a running container, we'll offer to restart it for you. Test with a cron job that has <code>deliver: faceplate</code> — see <code>hermes-plugin/README.md</code> for an example.
        </p>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useSetting } from '../../composables/use-setting';
import type {
  AgentPushStatus,
  AgentPushInstallPreview,
  AgentPushInstallResult,
  HermesContainerCandidate,
} from '../../../src-electron/preload-api';

const enabled = useSetting('agent_push.enabled');
const url = useSetting('agent_push.url');
const apiKey = useSetting('agent_push.api_key');
const chatId = useSetting('agent_push.chat_id');
const speak = useSetting('agent_push.speak');

const $q = useQuasar();
const showKey = ref(false);
const status = ref<AgentPushStatus | null>(null);
const checking = ref(false);
const installing = ref(false);
const lastInstall = ref<AgentPushInstallResult | null>(null);

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

// ─── one-click install flow ──────────────────────────────────────────
//
// Three-step UX:
//   1. Preview — read-only inspection, shown in a dialog.
//   2. Install — copy + .env append; runs only after user clicks Install.
//   3. Restart — separate dialog naming the detected container, so the user
//      explicitly approves before we touch their Hermes process.

function summarisePreview(p: AgentPushInstallPreview): string {
  const lines: string[] = [];
  lines.push(`Plugin → ${p.plugin_dst}`);
  if (p.plugin_already_present) {
    lines.push('  (already present — files will be overwritten with the bundled version)');
  }
  lines.push('');
  lines.push(`Env → ${p.env_path}`);
  for (const a of p.env_additions) {
    if (a.already_set) lines.push(`  ${a.key}: already set (left untouched)`);
    else if (a.key === 'FACEPLATE_API_KEY') lines.push(`  ${a.key}: will generate a new random secret`);
    else lines.push(`  ${a.key}: will set to "${a.value}"`);
  }
  if (p.hermes_container) {
    lines.push('');
    lines.push(`Detected Hermes container: ${p.hermes_container.name} (${p.hermes_container.state}, image ${p.hermes_container.image})`);
    if (p.hermes_container.ambiguous) {
      lines.push('  Note: multiple candidates matched — verify the name is correct.');
    }
    lines.push("After install, you'll be asked whether to restart it.");
  } else {
    lines.push('');
    lines.push("No Hermes Docker container auto-detected — you'll need to restart it manually after install.");
  }
  return lines.join('\n');
}

async function onInstallClick(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  installing.value = true;
  let preview: AgentPushInstallPreview;
  try {
    preview = await fp.agentPush.installPreview();
  } catch (err) {
    installing.value = false;
    $q.notify({
      type: 'negative',
      message: `Install preview failed: ${err instanceof Error ? err.message : String(err)}`,
      timeout: 6000,
    });
    return;
  }

  $q.dialog({
    title: 'Install Hermes Pings plugin?',
    message: summarisePreview(preview),
    style: 'white-space: pre-wrap; font: 12px/1.4 \"JetBrains Mono\", ui-monospace, monospace; max-width: 720px;',
    cancel: { label: 'Cancel', flat: true, noCaps: true },
    ok: { label: 'Install', noCaps: true, color: 'primary' },
    persistent: true,
  })
    .onOk(() => { void doInstall(preview.hermes_container); })
    .onCancel(() => { installing.value = false; });
}

async function doInstall(detected: HermesContainerCandidate | null): Promise<void> {
  const fp = window.faceplate;
  if (!fp) { installing.value = false; return; }
  try {
    const result = await fp.agentPush.install();
    lastInstall.value = result;
    if (!result.ok) {
      $q.notify({ type: 'negative', message: result.error ?? 'Install failed.', timeout: 6000 });
      return;
    }
    $q.notify({
      type: 'positive',
      message: 'Plugin installed. Hermes needs to restart to load it.',
      timeout: 4000,
    });
    // Settings patch from main already flipped `enabled` on; refresh status
    // so the connection chip starts polling.
    void refresh();
    startPolling();
    const container = result.hermes_container ?? detected;
    if (container) askRestart(container);
  } finally {
    installing.value = false;
  }
}

function askRestart(container: HermesContainerCandidate): void {
  const note = container.ambiguous
    ? '\n\nNote: multiple containers matched our heuristic — double-check this name is the right one before restarting.'
    : '';
  $q.dialog({
    title: 'Restart Hermes container?',
    message:
      `About to run:\n\n  docker restart ${container.name}\n\nImage: ${container.image}\nState: ${container.state}${note}`,
    style: 'white-space: pre-wrap; font: 12px/1.4 \"JetBrains Mono\", ui-monospace, monospace; max-width: 640px;',
    cancel: { label: 'Skip', flat: true, noCaps: true },
    ok: { label: 'Restart', noCaps: true, color: 'primary' },
    persistent: true,
  }).onOk(() => { void doRestart(container.name); });
}

async function doRestart(name: string): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  const r = await fp.agentPush.restartHermes(name);
  if (r.ok) {
    $q.notify({
      type: 'positive',
      message: `Restarted ${r.container}. Pings should arrive within a few seconds.`,
      timeout: 5000,
    });
  } else {
    $q.notify({ type: 'negative', message: r.error ?? 'Restart failed.', timeout: 8000 });
  }
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

.setup-intro {
  margin: 0 0 12px;
  font: 13px/1.5 system-ui, sans-serif;
  color: #333;
}
.setup-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.install-result {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(34, 139, 34, 0.08);
  border: 1px solid rgba(34, 139, 34, 0.18);
  border-radius: 8px;
  font: 12px/1.45 system-ui, sans-serif;
  color: #1a1a1a;
}
.install-result.install-error {
  background: rgba(198, 40, 40, 0.08);
  border-color: rgba(198, 40, 40, 0.22);
}
.install-result .q-icon { font-size: 18px; flex: none; margin-top: 2px; }
.step-list {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
