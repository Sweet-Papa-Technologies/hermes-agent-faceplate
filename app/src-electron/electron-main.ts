// Faceplate main-process entry. Boots a tray-only app with one avatar window
// (overlay or windowed per settings) and an on-demand settings window.

import { app } from 'electron';
import os from 'node:os';

import { applyPatch, getSettings, registerSettingsIpc } from './settings-store';
import {
  createAvatarWindow,
  isWayland,
  registerWindowIpc,
} from './window';
import {
  registerAllFromSettings,
  registerHotkeysIpc,
  unregisterAll,
} from './shortcuts';
import { createTray, destroyTray, hideDockOnMacOs, rebuildMenu } from './tray';
import { registerThemesIpc } from './themes-store';

// Linux/Wayland: if the user has explicitly opted into "Force X11", the switch
// must be set BEFORE app.whenReady(). Settings are read synchronously here.
function applyEarlyPlatformFlags(): void {
  if (process.platform === 'linux' && isWayland()) {
    if (getSettings().linux.force_x11) {
      app.commandLine.appendSwitch('ozone-platform', 'x11');
    }
  }
}

const platform = process.platform || os.platform();

applyEarlyPlatformFlags();

void app.whenReady().then(() => {
  registerSettingsIpc();
  registerWindowIpc();
  registerHotkeysIpc();
  registerThemesIpc();

  // First-run side effect: on Wayland with no explicit user override,
  // promote mode to 'windowed' (addendum #2). One-shot — once the user picks,
  // we respect it.
  const s = getSettings();
  if (
    process.platform === 'linux' &&
    isWayland() &&
    s.avatar.mode === 'overlay' &&
    !s.linux.force_x11
  ) {
    applyPatch({ avatar: { mode: 'windowed' } });
  }

  hideDockOnMacOs();
  createTray();
  createAvatarWindow();
  registerAllFromSettings();
  rebuildMenu();
});

app.on('window-all-closed', () => {
  // Tray-only on macOS — keep the app alive when both windows are closed.
  if (platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  createAvatarWindow();
});

app.on('will-quit', () => {
  unregisterAll();
  destroyTray();
});
