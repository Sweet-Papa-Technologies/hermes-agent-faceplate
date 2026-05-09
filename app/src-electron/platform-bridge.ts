// Platform-specific helpers exposed to the renderer.

import { app, ipcMain, systemPreferences } from 'electron';

import { IPC } from './preload-api';

export function registerPlatformIpc(): void {
  ipcMain.handle(IPC.platform.accessibilityTrusted, () => {
    if (process.platform !== 'darwin') return true;
    // false → user has not granted Accessibility. The settings tab uses
    // this to surface a contextual warning instead of an unconditional one.
    return systemPreferences.isTrustedAccessibilityClient(false);
  });
  ipcMain.handle(IPC.platform.relaunch, () => {
    app.relaunch();
    app.exit(0);
  });
}
