<template>
  <div class="settings-page">
    <header>
      <h1>Settings</h1>
      <p>Settings GUI is implemented in Phase 4. Active settings are persisted to disk and visible to renderer code via <code>window.faceplate.settings.get()</code>.</p>
    </header>
    <section v-if="settings.loaded" class="settings-dump">
      <pre>{{ JSON.stringify(settings.settings, null, 2) }}</pre>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../stores/settings';
const settings = useSettingsStore();
</script>

<style scoped>
.settings-page {
  padding: 32px;
  font: 14px/1.5 system-ui, sans-serif;
  background: #fafafa;
  color: #1a1a1a;
  min-height: 100vh;
}

h1 {
  font-size: 22px;
  margin: 0 0 8px;
}

.settings-dump {
  margin-top: 24px;
}

pre {
  background: #0e0e10;
  color: #d8d8d8;
  padding: 16px;
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.45 'JetBrains Mono', ui-monospace, monospace;
}
</style>
