// Faceplate main-process entry. Boots a tray-only app with one avatar window
// (overlay or windowed per settings) and an on-demand settings window.

import { app } from 'electron';
import os from 'node:os';

import { applyPatch, getSettings, registerSettingsIpc } from './settings-store';
import {
  createAvatarWindow,
  createWizardWindow,
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
import { registerHermesDiscoveryIpc } from './hermes-discovery';
import { registerHermesTesterIpc } from './hermes-tester';
import { registerParaphraseIpc } from './paraphrase-bridge';
import { registerSidecarIpc } from './sidecar';
import { registerHookIpc } from './hook-installer';
import { startHookListener, stopHookListener } from './hook-listener';
import { registerEventBridgeIpc } from './event-bridge';
import { registerPlatformIpc } from './platform-bridge';

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
  registerHermesDiscoveryIpc();
  registerHermesTesterIpc();
  registerParaphraseIpc();
  registerSidecarIpc();
  registerHookIpc();
  registerEventBridgeIpc();
  registerPlatformIpc();

  // Auto-start the hook listener when the user has previously installed
  // the bridge (settings.hermes.install_shell_hook). Without this, the
  // on-disk hook script POSTs into the void after a Faceplate restart.
  if (getSettings().hermes.install_shell_hook) {
    startHookListener().catch((err) =>
      console.error('[main] hook listener failed to start:', err),
    );
  }

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

  // First-run wizard. The avatar window is still created so users see the
  // overlay immediately; the wizard sits above it on first launch and
  // applyPatch updates flow through to the live overlay as the user picks.
  if (!getSettings().wizard.completed) {
    createWizardWindow();
  }
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
  void stopHookListener();
});
