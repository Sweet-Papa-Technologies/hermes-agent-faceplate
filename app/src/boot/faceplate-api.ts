// Renderer-side entry point for the preload bridge.
//
// 1. Augments `Window` with the typed `faceplate` global so renderer code is
//    fully typed.
// 2. Boots the settings store (single load on app start).
// 3. Boots the active theme.
// 4. Wires the typed event bus to the cross-window broadcast IPC.

import { boot } from 'quasar/wrappers';

import type { FaceplatePreload } from '../../src-electron/preload-api';
import { useSettingsStore } from '../stores/settings';
import { useThemeStore } from '../stores/theme';
import { eventBus, wirePreloadBridge } from './event-bus';

declare global {
  interface Window {
    faceplate?: FaceplatePreload;
  }
}

export default boot(async () => {
  const settings = useSettingsStore();
  await settings.load();

  // Wire the preload event broadcast → renderer bus before the avatar mounts.
  wirePreloadBridge(eventBus);

  const theme = useThemeStore();
  await theme.load(settings.settings.avatar.theme);
});
