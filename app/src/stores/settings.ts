// Reactive settings store, mirrored from disk via IPC.
//
// On boot we await `window.faceplate.settings.get()` once. Subsequent
// `set()` calls go through main and the change broadcasts back via the
// onChange listener.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import {
  defaultSettings,
  type FaceplateSettings,
  type HotkeyName,
} from './settings-schema';
import type { DeepPartial } from '../../src-electron/preload-api';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<FaceplateSettings>(defaultSettings());
  const loaded = ref(false);
  let unsubscribe: (() => void) | null = null;

  async function load(): Promise<void> {
    const fp = window.faceplate;
    if (!fp) {
      // Web preview / non-Electron context — keep defaults.
      loaded.value = true;
      return;
    }
    settings.value = await fp.settings.get();
    if (!unsubscribe) {
      unsubscribe = fp.settings.onChange((s) => {
        settings.value = s;
      });
    }
    loaded.value = true;
  }

  async function patch(p: DeepPartial<FaceplateSettings>): Promise<void> {
    const fp = window.faceplate;
    if (fp) {
      settings.value = await fp.settings.set(p);
    }
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  const mode = computed(() => settings.value.avatar.mode);
  const theme = computed(() => settings.value.avatar.theme);
  const hotkey = (name: HotkeyName) => settings.value.hotkeys[name];

  return { settings, loaded, load, patch, dispose, mode, theme, hotkey };
});
