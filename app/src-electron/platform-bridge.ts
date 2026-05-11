// Platform-specific helpers exposed to the renderer.

import { app, BrowserWindow, ipcMain, shell, systemPreferences, webContents } from 'electron';

import { IPC } from './preload-api';

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

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
  ipcMain.handle(IPC.platform.openDevTools, (evt, target: 'self' | 'avatar' | 'all' = 'self') => {
    const opts = { mode: 'detach' as const };
    if (target === 'self') {
      const wc = webContents.fromId(evt.sender.id);
      wc?.openDevTools(opts);
      return;
    }
    if (target === 'all') {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.openDevTools(opts);
      }
      return;
    }
    // 'avatar' — find the overlay window (it's the click-through one). We
    // pick the first window whose URL contains "overlay" or fall back to
    // the focused window.
    const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const avatar = all.find((w) => /overlay/i.test(w.webContents.getURL()));
    (avatar ?? BrowserWindow.getFocusedWindow() ?? all[0])?.webContents.openDevTools(opts);
  });
  ipcMain.handle(IPC.platform.openExternal, async (_evt, url: string) => {
    if (typeof url !== 'string' || url.length === 0) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!SAFE_SCHEMES.has(parsed.protocol)) return;
    await shell.openExternal(parsed.toString());
  });
}
