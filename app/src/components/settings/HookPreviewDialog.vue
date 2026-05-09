<template>
  <q-dialog ref="dialogRef" persistent>
    <q-card class="hook-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Install shell-hook bridge</div>
        <q-space />
        <q-btn icon="close" flat round dense @click="cancel" />
      </q-card-section>
      <q-card-section v-if="!preview">
        <q-spinner-dots /> Building preview…
      </q-card-section>
      <template v-else>
        <q-card-section>
          <p class="muted">
            This writes <code>{{ preview.script_path }}</code> and adds these <code>hooks:</code> entries to <code>{{ preview.config_path }}</code>. The bridge is observe-only — your agent flow is untouched.
          </p>
        </q-card-section>
        <q-tabs v-model="tab" align="left" dense class="bg-grey-2 text-primary">
          <q-tab name="diff" label="config.yaml diff" />
          <q-tab name="merged" label="merged config.yaml" />
          <q-tab name="script" label="hermes-faceplate-hook.sh" />
        </q-tabs>
        <q-tab-panels v-model="tab" animated>
          <q-tab-panel name="diff">
            <pre class="code-block diff">{{ preview.diff_summary }}</pre>
          </q-tab-panel>
          <q-tab-panel name="merged">
            <pre class="code-block">{{ preview.merged_yaml }}</pre>
          </q-tab-panel>
          <q-tab-panel name="script">
            <pre class="code-block">{{ preview.script }}</pre>
          </q-tab-panel>
        </q-tab-panels>
        <q-banner v-if="preview.already_installed" class="q-ma-md banner-info" dense>
          The bridge is already installed at this path; confirming will refresh the script and overwrite the hook entries.
        </q-banner>
      </template>
      <q-card-actions align="right">
        <q-btn flat label="Cancel" no-caps @click="cancel" />
        <q-btn
          color="positive"
          label="Confirm install"
          no-caps
          :loading="loading"
          :disable="!preview"
          @click="confirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useDialogPluginComponent } from 'quasar';

import type { HookPreview, HookInstallResult } from '../../../src-electron/preload-api';

defineEmits([...useDialogPluginComponent.emits]);
const { dialogRef, onDialogOK, onDialogCancel } = useDialogPluginComponent();

const preview = ref<HookPreview | null>(null);
const tab = ref<'diff' | 'merged' | 'script'>('diff');
const loading = ref(false);

onMounted(async () => {
  const fp = window.faceplate;
  if (!fp) return;
  preview.value = await fp.hermes.hookPreview();
});

async function confirm(): Promise<void> {
  const fp = window.faceplate;
  if (!fp) return;
  loading.value = true;
  try {
    const result: HookInstallResult = await fp.hermes.hookInstall();
    onDialogOK(result);
  } finally {
    loading.value = false;
  }
}

function cancel(): void {
  onDialogCancel();
}
</script>

<style scoped>
.hook-dialog {
  width: min(820px, 90vw);
  max-width: 90vw;
}
.muted { color: #666; margin: 0; }
.code-block {
  margin: 0;
  padding: 12px;
  background: #0e0e10;
  color: #d8d8d8;
  border-radius: 6px;
  font: 12px/1.45 'JetBrains Mono', ui-monospace, monospace;
  white-space: pre-wrap;
  max-height: 360px;
  overflow: auto;
}
.code-block.diff {
  background: #0a1f10;
  color: #b6f0c8;
}
.banner-info {
  background: rgba(59, 130, 246, 0.12);
  border-radius: 8px;
}
code {
  background: rgba(0,0,0,0.05);
  padding: 1px 4px;
  border-radius: 3px;
  font: 12px/1 'JetBrains Mono', ui-monospace, monospace;
}
</style>
