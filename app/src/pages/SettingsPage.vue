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
        <div class="settings-diag">
          <q-btn flat dense no-caps size="sm" icon="bug_report" label="DevTools (this window)" @click="openDevTools('self')" />
          <q-btn flat dense no-caps size="sm" icon="visibility" label="DevTools (avatar)" @click="openDevTools('avatar')" />
          <q-btn flat dense no-caps size="sm" icon="restart_alt" label="Relaunch app" @click="relaunch" />
        </div>
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
    id: 'artifacts',
    label: 'Canvas / Artifacts',
    icon: 'auto_awesome',
    load: () => import('../components/settings/SettingsArtifacts.vue'),
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

function openDevTools(target: 'self' | 'avatar'): void {
  void window.faceplate?.platform.openDevTools(target);
}
function relaunch(): void {
  void window.faceplate?.platform.relaunch();
}
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

.settings-diag {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin-bottom: 8px;
}

.settings-content {
  padding: 32px;
  overflow-y: auto;
  font: 14px/1.5 system-ui, sans-serif;
}

/*
 * Immune to Quasar's auto dark mode. Quasar's QField/QSelect/QInput inherit
 * from a CSS variable scheme that flips with body.body--dark — and the
 * framework config `dark: false` doesn't reliably win against the
 * `prefers-color-scheme: dark` cascade on macOS. Force light text + white
 * surfaces for every form control inside the Settings page.
 */
.settings-page :deep(.q-field--filled .q-field__control),
.settings-page :deep(.q-field--outlined .q-field__control) {
  background: #ffffff;
  color: #1a1a1a;
}
.settings-page :deep(.q-field__native),
.settings-page :deep(.q-field__input),
.settings-page :deep(.q-field__label),
.settings-page :deep(.q-field__prefix),
.settings-page :deep(.q-field__suffix),
.settings-page :deep(.q-field__marginal),
.settings-page :deep(.q-field__messages) {
  color: #1a1a1a;
}
.settings-page :deep(.q-field__label) {
  color: rgba(0, 0, 0, 0.6);
}
.settings-page :deep(.q-item) {
  color: #1a1a1a;
}
.settings-page :deep(.q-card) {
  background: #ffffff;
  color: #1a1a1a;
}
</style>

<!--
  Non-scoped styles for QSelect / QMenu popups. These render in a body-level
  Teleport portal, so the scoped `:deep` selectors above can't reach them.
  Without this, the popup options inherit Quasar's auto-dark colors and
  appear as white-on-white text against the white menu background.

  Scoped to `.q-menu` (any QMenu in the app) — the avatar overlay window
  doesn't open dropdown menus, so this only kicks in for the Settings UI
  in practice.
-->
<style>
.q-menu {
  background: #ffffff !important;
  color: #1a1a1a !important;
}
.q-menu .q-item {
  color: #1a1a1a !important;
}
.q-menu .q-item--active,
.q-menu .q-item.q-manual-focusable--focused {
  color: #0c5132 !important;
  background: rgba(34, 197, 94, 0.12) !important;
}
.q-menu .q-item__label {
  color: inherit !important;
}
</style>
