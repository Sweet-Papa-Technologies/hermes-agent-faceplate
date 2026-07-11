<template>
  <div>
    <h2>Notifications &amp; Pings</h2>
    <p class="muted">
      OS-native notifications when Hermes finishes a response, plus opt-in
      "pings" — unprompted messages Hermes can send on its own (cron jobs,
      autonomous decisions, scheduled reminders).
    </p>

    <!-- ── OS notifications ────────────────────────────────────────── -->
    <h3>OS notifications</h3>
    <q-card flat bordered class="card">
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Enable notifications</q-item-label>
            <q-item-label caption>Master switch. When off, no OS notifications fire.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="notifEnabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !notifEnabled }">
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Play sound</q-item-label>
            <q-item-label caption>Off uses Electron's "silent" notification flag — OS still shows the banner.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="sound" :disable="!notifEnabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !notifEnabled }">
        <div class="q-mb-sm" style="font-size: 13px; font-weight: 600;">When to fire</div>
        <q-option-group
          v-model="notifMode"
          type="radio"
          :options="modeOptions"
          :disable="!notifEnabled"
        />
        <p class="muted q-mt-sm" style="font-size: 12px;">
          Unprompted pings (see below) always fire even in <em>backgrounded only</em> mode,
          since you may not be looking at the right window.
        </p>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !notifEnabled }">
        <div class="q-mb-sm" style="font-size: 13px; font-weight: 600;">Do-not-disturb hours</div>
        <p class="muted" style="font-size: 12px;">
          24-hour times. Equal start and end disables DND. Wraps midnight
          (e.g. 22:00 → 08:00 = quiet overnight).
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
            :disable="!notifEnabled"
          />
          <q-input
            v-model="dndEnd"
            class="col-6"
            label="End"
            mask="##:##"
            placeholder="08:00"
            filled
            stack-label
            :disable="!notifEnabled"
          />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-actions :class="{ disabled: !notifEnabled }">
        <q-btn outline no-caps icon="notifications" label="Send a test notification" :disable="!notifEnabled" @click="testNotification" />
      </q-card-actions>
    </q-card>

    <q-banner v-if="!notifSupported" class="warn q-my-md" dense>
      <template #avatar><q-icon name="warning" color="warning" /></template>
      Your OS reports no notification support. On Windows, this usually means the
      AppUserModelID isn't registered (auto-fixed in production builds). On Linux,
      install <code>libnotify</code> if missing.
    </q-banner>

    <!-- ── Hermes Pings ────────────────────────────────────────────── -->
    <h3>Hermes Pings</h3>
    <p class="muted" style="font-size: 13px;">
      Off by default. Receive unprompted messages from Hermes (cron jobs,
      autonomous decisions, scheduled reminders). Requires the Hermes-side
      <code>faceplate</code> plugin — install below for a local Hermes, or run
      <code>setup/hermes-faceplate-plugin.sh</code> on a remote Hermes host.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Enable pings</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="pingsEnabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !pingsEnabled }">
        <q-input
          v-model="pingsUrl"
          label="Plugin WebSocket URL"
          filled
          stack-label
          hint="Default: ws://127.0.0.1:8643/ws — change if you set FACEPLATE_PORT or are running Hermes on another host."
          :disable="!pingsEnabled"
        />
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !pingsEnabled }">
        <q-input
          v-model="pingsApiKey"
          label="FACEPLATE_API_KEY"
          :type="showKey ? 'text' : 'password'"
          filled
          stack-label
          hint="Same value as the env var FACEPLATE_API_KEY in ~/.hermes/.env."
          :disable="!pingsEnabled"
        >
          <template #append>
            <q-btn flat dense round :icon="showKey ? 'visibility_off' : 'visibility'" @click="showKey = !showKey" />
          </template>
        </q-input>
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !pingsEnabled }">
        <q-input
          v-model="pingsChatId"
          label="Subscribe to chat_id"
          filled
          stack-label
          hint="Single channel (matches FACEPLATE_HOME_CHANNEL) or '*' to receive everything the plugin pushes."
          :disable="!pingsEnabled"
        />
      </q-card-section>

      <q-separator />

      <q-card-section :class="{ disabled: !pingsEnabled }">
        <q-item tag="label" dense>
          <q-item-section>
            <q-item-label>Speak incoming pings</q-item-label>
            <q-item-label caption>Off by default — most pings are quiet "FYI" messages.</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="pingsSpeak" :disable="!pingsEnabled" />
          </q-item-section>
        </q-item>
      </q-card-section>

      <q-separator />

      <q-card-actions :class="{ disabled: !pingsEnabled }">
        <q-btn outline no-caps icon="refresh" label="Refresh status" :loading="checking" :disable="!pingsEnabled" @click="refresh" />
      </q-card-actions>
    </q-card>

    <q-card v-if="pingsEnabled" flat bordered class="card">
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
          <q-chip v-if="status?.url" outline dense>{{ status.url }}</q-chip>
          <q-chip v-if="status?.last_frame_at" outline dense>
            Last ping {{ formatRel(status.last_frame_at) }}
          </q-chip>
        </div>
        <div v-if="status?.last_error_hint" class="hint-line q-mt-sm">
          <q-icon name="lightbulb_outline" /> {{ status.last_error_hint }}
        </div>
        <div v-if="status?.last_error" class="error-line q-mt-sm">
          <q-icon name="error_outline" /> {{ status.last_error }}
        </div>
      </q-card-section>
    </q-card>

    <h3>Install plugin (local Hermes)</h3>
    <q-card flat bordered class="card setup-card">
      <q-card-section>
        <p class="setup-intro">
          One click copies the plugin into <code>~/.hermes/plugins/faceplate</code>,
          adds env vars to <code>~/.hermes/.env</code> (generating a random secret if
          you don't already have one), and writes the matching key into Faceplate
          settings.
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
        <p class="muted q-mt-md" style="font-size: 13px;">
          After install, restart your Hermes gateway so the plugin loader picks
          up the new folder. Running Hermes on another machine? Run
          <code>setup/hermes-faceplate-plugin.sh</code> on that host instead.
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
} from '../../../src-electron/preload-api';

// ─── OS notifications ────────────────────────────────────────────────────
const notifEnabled = useSetting('notifications.enabled');
const sound = useSetting('notifications.sound');
const notifMode = useSetting('notifications.mode');
const dndStart = useSetting('notifications.dnd_start');
const dndEnd = useSetting('notifications.dnd_end');

const $q = useQuasar();

const modeOptions = [
  { label: 'Backgrounded only — quiet when the Faceplate is in front', value: 'backgrounded_only' },
  { label: 'Always — fire even when the app is focused', value: 'always' },
];

const notifSupported = ref(true);

async function testNotification(): Promise<void> {
  const id = await window.faceplate?.notify.show({
    id: `test:${Date.now()}`,
    title: 'HermesAgent Faceplate',
    body: 'Test notification — if you see this, you\'re wired up correctly.',
    kind: 'system',
  });
  if (id == null) {
    notifSupported.value = false;
    $q.notify({
      type: 'negative',
      message: 'OS rejected the test notification — see banner below.',
      timeout: 4000,
    });
    return;
  }
  $q.notify({ type: 'positive', message: 'Test sent.', timeout: 2000 });
}

// ─── Hermes Pings ────────────────────────────────────────────────────────
const pingsEnabled = useSetting('agent_push.enabled');
const pingsUrl = useSetting('agent_push.url');
const pingsApiKey = useSetting('agent_push.api_key');
const pingsChatId = useSetting('agent_push.chat_id');
const pingsSpeak = useSetting('agent_push.speak');

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

watch(pingsEnabled, (v) => {
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

// ─── Plugin install flow (local Hermes) ──────────────────────────────────
//
// Two-step UX:
//   1. Preview — read-only inspection, shown in a confirm dialog.
//   2. Install — copy + .env append; runs only after the user clicks Install.
// The user then restarts their Hermes gateway themselves. For a remote
// Hermes, setup/hermes-faceplate-plugin.sh on the Hermes host does the same.

function summarisePreview(p: AgentPushInstallPreview): string {
  const lines: string[] = [];
  if (p.hermes_likely_remote) {
    lines.push('⚠  This button only fits one case: Hermes runs directly on THIS');
    lines.push('   machine, reading THIS user\'s ~/.hermes/. Your Hermes is');
    lines.push('   configured at:');
    lines.push('');
    lines.push(`     ${p.hermes_base_url}`);
    lines.push('');
    lines.push('   For any setup where Hermes lives somewhere else, run this on');
    lines.push('   the Hermes host instead:');
    lines.push('');
    lines.push('     bash setup/hermes-faceplate-plugin.sh --bind 0.0.0.0');
    lines.push('');
    lines.push('   It prints the WebSocket URL + key for you to paste into this');
    lines.push('   panel. The Faceplate doesn\'t care what runtime is on the other');
    lines.push('   side — only that the port is reachable.');
    lines.push('');
    lines.push('   --- cancel below unless you really do want to write into this');
    lines.push('   --- user\'s local ~/.hermes/ ---');
    lines.push('');
  }
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
  lines.push('');
  lines.push('Also run (or this installer will try to do it for you):');
  lines.push('    hermes plugins enable faceplate');
  lines.push('Hermes ships user plugins disabled by default — without enabling,');
  lines.push('it sees the files but never starts the adapter.');
  lines.push('');
  lines.push('After install + enable, restart your Hermes gateway so the loader');
  lines.push('picks up the new folder. The plugin opens a WebSocket on port');
  lines.push('FACEPLATE_PORT (default 8643); the Faceplate connects to it.');
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
    .onOk(() => { void doInstall(); })
    .onCancel(() => { installing.value = false; });
}

async function doInstall(): Promise<void> {
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
      message: 'Plugin installed. Restart your Hermes gateway to load it.',
      timeout: 5000,
    });
    void refresh();
    startPolling();
  } finally {
    installing.value = false;
  }
}

onMounted(() => {
  if (pingsEnabled.value) {
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
.warn { background: rgba(245, 158, 11, 0.12); border-radius: 8px; }

.status-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.error-line { color: #c62828; font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace; }
.hint-line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: 8px 10px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 6px;
  color: #7c4a03;
  font: 12px/1.5 system-ui, sans-serif;
}
.hint-line .q-icon { font-size: 16px; flex: none; margin-top: 1px; color: #b8860b; }

.setup-intro {
  margin: 0 0 12px;
  font: 13px/1.5 system-ui, sans-serif;
  color: #333;
}
.setup-actions { display: flex; gap: 10px; flex-wrap: wrap; }
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
