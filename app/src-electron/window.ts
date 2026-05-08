// Window factories for the avatar.
//
// Two distinct top-level windows; only one is visible at a time. The user (or
// auto-detect) flips `settings.avatar.mode` to choose. See DESIGN.md §4.1 +
// DESIGN-ADDENDUM-01.md #2 + #5.

import {
  BrowserWindow,
  app,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IPC } from './preload-api';
import { getSettings, applyPatch } from './settings-store';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const OVERLAY_W = 320;
const OVERLAY_H = 320;

let avatarWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let cycleIndex = 0;

export function isWayland(): boolean {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
}

function preloadPath(): string {
  return path.resolve(
    currentDir,
    path.join(
      process.env.QUASAR_ELECTRON_PRELOAD_FOLDER ?? '.',
      'electron-preload' + (process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION ?? '.js'),
    ),
  );
}

function loadRoute(win: BrowserWindow, hashRoute: string): Promise<void> {
  if (process.env.DEV && process.env.APP_URL) {
    return win.loadURL(`${process.env.APP_URL}#${hashRoute}`);
  }
  return win.loadFile('index.html', { hash: hashRoute });
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    backgroundColor: '#00000000',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });

  if (process.platform === 'darwin') {
    // Float above full-screen apps and stay across spaces.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setWindowButtonVisibility(false);
  }

  // Position bottom-right of the primary display by default.
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  win.setBounds({
    x: workArea.x + workArea.width - OVERLAY_W - 24,
    y: workArea.y + workArea.height - OVERLAY_H - 24,
    width: OVERLAY_W,
    height: OVERLAY_H,
  });

  // Click-through is initially OFF; renderer turns it on once mounted and
  // reports per-pixel hit regions on mousemove (forward:true).
  win.setIgnoreMouseEvents(false);

  void loadRoute(win, '/overlay');
  return win;
}

function createWindowedAvatarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 480,
    title: 'HermesAgent Faceplate',
    frame: true,
    transparent: false,
    alwaysOnTop: getSettings().avatar.always_on_top,
    skipTaskbar: false,
    resizable: true,
    backgroundColor: '#1a1a1a',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });

  void loadRoute(win, '/overlay');
  return win;
}

export function createAvatarWindow(): BrowserWindow {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.focus();
    return avatarWindow;
  }
  const settings = getSettings();
  const mode = resolveAvatarMode(settings.avatar.mode);
  avatarWindow = mode === 'overlay' ? createOverlayWindow() : createWindowedAvatarWindow();

  // Tell the renderer which mode it's running in so it can apply the right
  // CSS variables (overlay = transparent bg; windowed = card with shadow).
  avatarWindow.webContents.on('did-finish-load', () => {
    avatarWindow?.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-mode', ${JSON.stringify(mode)});`,
    );
  });

  avatarWindow.on('closed', () => {
    avatarWindow = null;
  });
  return avatarWindow;
}

export function getAvatarWindow(): BrowserWindow | null {
  return avatarWindow;
}

function resolveAvatarMode(userMode: 'overlay' | 'windowed'): 'overlay' | 'windowed' {
  const wayland = isWayland();
  if (userMode === 'overlay' && wayland && !getSettings().linux.force_x11) {
    return 'windowed';
  }
  return userMode;
}

export function recreateAvatarWindow(): BrowserWindow {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.removeAllListeners('closed');
    avatarWindow.close();
    avatarWindow = null;
  }
  return createAvatarWindow();
}

export function showHide(state?: 'show' | 'hide' | 'toggle'): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    avatarWindow = createAvatarWindow();
    avatarWindow.show();
    return;
  }
  const visible = avatarWindow.isVisible();
  const next = state === 'toggle' || state === undefined ? !visible : state === 'show';
  if (next) avatarWindow.show();
  else avatarWindow.hide();
}

export function cycleMonitor(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return;
  cycleIndex = (cycleIndex + 1) % displays.length;
  const target = displays[cycleIndex]!;
  const { workArea } = target;
  const bounds = avatarWindow.getBounds();
  avatarWindow.setBounds({
    x: workArea.x + workArea.width - bounds.width - 24,
    y: workArea.y + workArea.height - bounds.height - 24,
    width: bounds.width,
    height: bounds.height,
  });
}

export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 640,
    title: 'HermesAgent Faceplate — Settings',
    frame: true,
    backgroundColor: '#fafafa',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  void loadRoute(settingsWindow, '/settings');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

export function registerWindowIpc(): void {
  ipcMain.handle(IPC.window.setClickThrough, (evt: IpcMainInvokeEvent, enabled: boolean) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win !== avatarWindow) return;
    if (getSettings().avatar.mode === 'windowed') return;
    win.setIgnoreMouseEvents(enabled, { forward: true });
  });

  ipcMain.handle(IPC.window.reportHitRegion, (evt: IpcMainInvokeEvent, insideAvatar: boolean) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win !== avatarWindow) return;
    if (getSettings().avatar.mode === 'windowed') return;
    win.setIgnoreMouseEvents(!insideAvatar, { forward: true });
  });

  ipcMain.handle(IPC.window.cycleMonitor, () => cycleMonitor());
  ipcMain.handle(IPC.window.showHide, (_evt, state?: 'show' | 'hide' | 'toggle') =>
    showHide(state),
  );

  ipcMain.handle(IPC.window.setMode, (_evt, mode: 'overlay' | 'windowed') => {
    applyPatch({ avatar: { mode } });
    recreateAvatarWindow();
  });

  ipcMain.handle(IPC.window.moveBy, (evt: IpcMainInvokeEvent, dx: number, dy: number) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win !== avatarWindow) return;
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x + Math.round(dx),
      y: bounds.y + Math.round(dy),
      width: bounds.width,
      height: bounds.height,
    });
  });
}

export function quitAll(): void {
  if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.close();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  app.quit();
}
