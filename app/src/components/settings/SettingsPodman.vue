<template>
  <div>
    <h2>Container Engine</h2>
    <p class="muted">
      Hermes Agent and the speech sidecar run in containers. Podman is the
      recommended engine — rootless, free, and managed for you here. Docker
      stays fully supported if you already use it.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <div class="row items-center q-gutter-sm">
          <q-chip
            :color="status?.engine === 'podman' ? 'primary' : 'grey-7'"
            text-color="white"
            dense
          >
            Active engine: {{ status?.engine ?? '…' }}
          </q-chip>
          <q-chip v-if="status?.installed" color="positive" text-color="white" dense>
            Podman {{ status.version }}
          </q-chip>
          <q-chip v-else color="grey-7" text-color="white" dense>
            Podman not installed
          </q-chip>
          <q-chip
            v-if="status?.machine?.applicable"
            :color="status.machine.running ? 'positive' : 'warning'"
            text-color="white"
            dense
          >
            VM: {{ status.machine.running ? 'running' : status.machine.exists ? 'stopped' : 'not created' }}
          </q-chip>
          <q-space />
          <q-btn
            flat
            dense
            no-caps
            icon="refresh"
            label="Refresh"
            :loading="checking"
            @click="refresh"
          />
        </div>
        <p class="muted q-mt-sm" style="margin-bottom: 0;">
          {{ engineHint }}
        </p>
      </q-card-section>

      <q-separator />

      <q-card-section class="row q-gutter-sm">
        <q-btn
          no-caps
          color="primary"
          icon="download"
          label="Install Podman"
          :loading="installing"
          :disable="status?.installed === true"
          @click="onInstall"
        />
        <q-btn
          v-if="status?.installed && status?.machine?.applicable"
          no-caps
          outline
          icon="play_arrow"
          :label="status.machine.running ? 'Machine running' : status.machine.exists ? 'Start machine' : 'Create + start machine'"
          :loading="machineBusy"
          :disable="status.machine.running"
          @click="onEnsureMachine"
        />
        <q-btn
          v-if="status?.installed && status?.machine?.applicable && status?.machine?.running"
          no-caps
          flat
          icon="stop"
          label="Stop machine"
          :loading="machineBusy"
          @click="onStopMachine"
        />
      </q-card-section>

      <q-card-section v-if="lastSteps.length" class="steps">
        <div v-for="(s, i) in lastSteps" :key="i" class="step">▸ {{ s }}</div>
      </q-card-section>
    </q-card>

    <q-banner v-if="manualCommand" dense class="bg-grey-9 text-white q-mt-sm">
      Run this in a terminal, then click Refresh:
      <pre class="cmd">{{ manualCommand }}</pre>
    </q-banner>

    <h2 class="q-mt-lg">Hermes Agent</h2>
    <p class="muted">
      Don't have Hermes Agent yet? Install + run it in a container here. If
      you already run Hermes yourself (any engine), this auto-detects it —
      just use the Connection tab and skip the install.
    </p>

    <q-card flat bordered class="card">
      <q-card-section>
        <div class="row items-center q-gutter-sm">
          <q-chip
            v-if="agent?.reachable"
            color="positive"
            text-color="white"
            dense
          >
            Reachable at {{ agent.base_url }}
          </q-chip>
          <q-chip v-else color="grey-7" text-color="white" dense>
            Not reachable
          </q-chip>
          <q-chip
            v-if="agent && agent.container_state !== 'missing'"
            :color="agent.container_state === 'running' ? 'positive' : 'warning'"
            text-color="white"
            dense
          >
            Container: {{ agent.container_state }}
          </q-chip>
          <q-chip v-if="agent?.image_built" color="grey-8" text-color="white" dense>
            browser image built
          </q-chip>
          <q-space />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="row q-gutter-sm">
        <q-btn
          no-caps
          color="primary"
          icon="rocket_launch"
          :label="agent?.reachable ? 'Reinstall / recreate' : 'Install Hermes Agent'"
          :loading="hermesBusy"
          @click="onInstallHermes"
        />
        <q-btn
          v-if="agent && agent.container_state !== 'missing'"
          no-caps
          flat
          icon="delete"
          label="Remove container"
          :loading="hermesBusy"
          @click="onStopHermes"
        />
      </q-card-section>

      <q-card-section v-if="hermesSteps.length" class="steps">
        <div v-for="(s, i) in hermesSteps" :key="i" class="step">▸ {{ s }}</div>
      </q-card-section>
    </q-card>

    <p class="muted q-mt-md">
      First machine creation downloads a ~1&nbsp;GB VM image and the Hermes
      image is ~6&nbsp;GB — keep at least 20&nbsp;GB free. Default engine is
      Docker until the migration completes; set
      <code>FACEPLATE_CONTAINER_ENGINE=podman</code> to try Podman now.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useQuasar } from 'quasar';

import type {
  PodmanStatus,
  HermesAgentStatus,
} from '../../../src-electron/preload-api';

const $q = useQuasar();
const status = ref<PodmanStatus | null>(null);
const checking = ref(false);
const installing = ref(false);
const machineBusy = ref(false);
const lastSteps = ref<string[]>([]);
const manualCommand = ref<string | null>(null);

const agent = ref<HermesAgentStatus | null>(null);
const hermesBusy = ref(false);
const hermesSteps = ref<string[]>([]);

const engineHint = computed(() => {
  const s = status.value;
  if (!s) return 'Checking…';
  if (s.engine !== 'podman') {
    return `Currently using "${s.engine}". Podman is not the active engine yet (the default flips later in the migration).`;
  }
  if (!s.installed) return 'Podman is selected but not installed — install it below.';
  if (s.machine?.applicable && !s.machine.running) {
    return 'Podman installed; the VM is not running. Start it below.';
  }
  return s.ready ? 'Podman is ready.' : 'Podman selected.';
});

async function refresh(): Promise<void> {
  if (!window.faceplate) return;
  checking.value = true;
  try {
    const [p, a] = await Promise.all([
      window.faceplate.podman.status(),
      window.faceplate.hermes.agentStatus(),
    ]);
    status.value = p;
    agent.value = a;
  } finally {
    checking.value = false;
  }
}

async function onInstallHermes(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  hermesBusy.value = true;
  hermesSteps.value = [];
  try {
    const r = await fp.hermes.installAgent();
    hermesSteps.value = r.steps;
    if (r.ok) {
      $q.notify({ type: 'positive', message: 'Hermes Agent is up.', timeout: 5000 });
    } else {
      $q.notify({ type: 'negative', message: r.error ?? 'Install failed.', timeout: 9000 });
    }
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : String(err),
      timeout: 9000,
    });
  } finally {
    hermesBusy.value = false;
    void refresh();
  }
}

async function onStopHermes(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  hermesBusy.value = true;
  try {
    await fp.hermes.stopAgent();
  } finally {
    hermesBusy.value = false;
    void refresh();
  }
}

async function onInstall(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  installing.value = true;
  manualCommand.value = null;
  try {
    const r = await fp.podman.install();
    lastSteps.value = r.steps;
    if (r.ok) {
      $q.notify({ type: 'positive', message: 'Podman installed.', timeout: 4000 });
    } else {
      if (r.manual_command) manualCommand.value = r.manual_command;
      $q.notify({
        type: 'negative',
        message: r.error ?? 'Install failed.',
        timeout: 8000,
        ...(r.help_url
          ? {
              actions: [
                {
                  label: 'Open download',
                  color: 'white',
                  handler: () => void fp.platform.openExternal(r.help_url!),
                },
              ],
            }
          : {}),
      });
    }
  } finally {
    installing.value = false;
    void refresh();
  }
}

async function onEnsureMachine(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  machineBusy.value = true;
  try {
    await fp.podman.ensureMachine();
    $q.notify({ type: 'positive', message: 'Podman machine is up.', timeout: 4000 });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : String(err),
      timeout: 9000,
    });
  } finally {
    machineBusy.value = false;
    void refresh();
  }
}

async function onStopMachine(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  machineBusy.value = true;
  try {
    await fp.podman.stopMachine();
  } finally {
    machineBusy.value = false;
    void refresh();
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => void refresh(), 5_000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.card {
  margin-top: 12px;
}
.steps {
  font: 12px/1.5 'JetBrains Mono', ui-monospace, monospace;
  opacity: 0.85;
}
.step {
  white-space: pre-wrap;
}
.cmd {
  margin: 6px 0 0;
  font: 12px/1.4 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
}
</style>
