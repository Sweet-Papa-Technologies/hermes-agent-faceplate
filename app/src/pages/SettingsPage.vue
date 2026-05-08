<template>
  <div class="settings-page">
    <aside class="settings-nav">
      <h1>Settings</h1>
      <q-list dense padding class="rounded-borders">
        <q-item
          v-for="tab in tabs"
          :key="tab.id"
          v-ripple
          clickable
          :active="activeTab === tab.id"
          active-class="settings-nav-active"
          @click="activeTab = tab.id"
        >
          <q-item-section avatar>
            <q-icon :name="tab.icon" />
          </q-item-section>
          <q-item-section>{{ tab.label }}</q-item-section>
        </q-item>
      </q-list>
      <div class="settings-meta">
        <small>v{{ appVersion }} · {{ platform }}</small>
      </div>
    </aside>

    <section class="settings-content">
      <component :is="activeComponent" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineAsyncComponent, type Component } from 'vue';

interface TabDef {
  id: string;
  label: string;
  icon: string;
  load: () => Promise<{ default: Component }>;
}

const tabs: TabDef[] = [
  {
    id: 'connection',
    label: 'Connection',
    icon: 'cable',
    load: () => import('../components/settings/SettingsConnection.vue'),
  },
  {
    id: 'audio',
    label: 'Audio I/O',
    icon: 'graphic_eq',
    load: () => import('../components/settings/SettingsAudio.vue'),
  },
  {
    id: 'sidecar',
    label: 'Speech Sidecar',
    icon: 'memory',
    load: () => import('../components/settings/SettingsSidecar.vue'),
  },
  {
    id: 'voice',
    label: 'Voice Input',
    icon: 'mic',
    load: () => import('../components/settings/SettingsVoiceInput.vue'),
  },
  {
    id: 'hotkeys',
    label: 'Hotkeys',
    icon: 'keyboard',
    load: () => import('../components/settings/SettingsHotkeys.vue'),
  },
  {
    id: 'avatar',
    label: 'Avatar / Theme',
    icon: 'face',
    load: () => import('../components/settings/SettingsAvatar.vue'),
  },
  {
    id: 'paraphrase',
    label: 'Paraphrase',
    icon: 'short_text',
    load: () => import('../components/settings/SettingsParaphrase.vue'),
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: 'privacy_tip',
    load: () => import('../components/settings/SettingsPrivacy.vue'),
  },
];

const activeTab = ref<string>('connection');

const componentCache = new Map<string, Component>();
const activeComponent = computed<Component>(() => {
  const tab = tabs.find((t) => t.id === activeTab.value) ?? tabs[0]!;
  let comp = componentCache.get(tab.id);
  if (!comp) {
    comp = defineAsyncComponent(tab.load);
    componentCache.set(tab.id, comp);
  }
  return comp;
});

const appVersion = computed(() => window.faceplate?.platform.app_version ?? '0.0.0');
const platform = computed(() => window.faceplate?.platform.os ?? 'unknown');
</script>

<style scoped>
.settings-page {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
  background: #fafafa;
  color: #1a1a1a;
}

.settings-nav {
  background: #f0f0f3;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  padding: 24px 12px 12px;
  display: flex;
  flex-direction: column;
}

.settings-nav h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 12px 16px;
}

.settings-nav-active {
  background: rgba(34, 197, 94, 0.18);
  color: #0c5132;
  border-radius: 6px;
}

.settings-meta {
  margin-top: auto;
  padding: 12px;
  color: rgba(0, 0, 0, 0.5);
}

.settings-content {
  padding: 32px;
  overflow-y: auto;
  font: 14px/1.5 system-ui, sans-serif;
}
</style>
