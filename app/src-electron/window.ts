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
// Window is taller than the avatar so captions, the tool-call badge, and
// any other below-avatar UI render BELOW the face plate instead of over
// it. The avatar SVG itself stays max 320x320 and is pinned to the top
// of the window via `.avatar-root` flex alignment.
const OVERLAY_H = 520;

let avatarWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let cycleIndex = 0;

export function isWayland(): boolean {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
}

function computeOverlayBounds(
  workArea: { x: number; y: number; width: number; height: number },
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const margin = 24;
  const pos = getSettings().avatar.position;
  switch (pos) {
    case 'top_left':
      return { x: workArea.x + margin, y: workArea.y + margin, width: w, height: h };
    case 'top_right':
      return { x: workArea.x + workArea.width - w - margin, y: workArea.y + margin, width: w, height: h };
    case 'bottom_left':
      return { x: workArea.x + margin, y: workArea.y + workArea.height - h - margin, width: w, height: h };
    case 'bottom_right':
    case 'last_known': // last_known is honored elsewhere; default safely
    default:
      return {
        x: workArea.x + workArea.width - w - margin,
        y: workArea.y + workArea.height - h - margin,
        width: w,
        height: h,
      };
  }
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

  // Position per `avatar.position` setting, defaulting bottom-right.
  const primary = screen.getPrimaryDisplay();
  const bounds = computeOverlayBounds(primary.workArea, OVERLAY_W, OVERLAY_H);
  win.setBounds(bounds);

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

let wizardWindow: BrowserWindow | null = null;

export function createWizardWindow(): BrowserWindow {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.focus();
    return wizardWindow;
  }
  wizardWindow = new BrowserWindow({
    width: 720,
    height: 600,
    title: 'HermesAgent Faceplate — Setup',
    frame: true,
    resizable: false,
    backgroundColor: '#0e0e10',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  void loadRoute(wizardWindow, '/wizard');
  wizardWindow.on('closed', () => {
    wizardWindow = null;
  });
  return wizardWindow;
}

export function closeWizardWindow(): void {
  if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
  wizardWindow = null;
}

// ─── typing bar ─────────────────────────────────────────────────────────
//
// A dedicated frameless transparent always-on-top window centered on the
// active display (the one with the user's cursor / focused app, NOT
// necessarily the one the avatar is on). Spotlight-style. Fires the
// hotkey → opens here → user types → on submit we forward the text to
// the avatar window's renderer via direct IPC (cross-window event-bus
// relay of user.input.* is intentionally blocklisted in event-bridge.ts
// to avoid the double-TTS bug).

let typingBarWindow: BrowserWindow | null = null;

const TYPING_W = 760;
const TYPING_H = 140;

function activeDisplay(): Electron.Display {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

export function showTypingBarWindow(): void {
  // Reuse the existing window if it's already open — second hotkey press
  // when visible should toggle (close it).
  if (typingBarWindow && !typingBarWindow.isDestroyed()) {
    if (typingBarWindow.isVisible() && typingBarWindow.isFocused()) {
      typingBarWindow.hide();
      return;
    }
    repositionTypingBar();
    typingBarWindow.show();
    typingBarWindow.focus();
    typingBarWindow.webContents.send(IPC.typingBar.opened);
    return;
  }

  const display = activeDisplay();
  const { workArea } = display;
  const x = Math.round(workArea.x + (workArea.width - TYPING_W) / 2);
  // Slightly above the optical center reads more naturally than dead-centre.
  const y = Math.round(workArea.y + workArea.height * 0.32 - TYPING_H / 2);

  typingBarWindow = new BrowserWindow({
    width: TYPING_W,
    height: TYPING_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false, // wait for content to be ready, then show + focus
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  // alwaysOnTop above floating panels (system-wide spotlight / mission-control)
  typingBarWindow.setAlwaysOnTop(true, 'pop-up-menu');
  if (typingBarWindow.setVisibleOnAllWorkspaces) {
    typingBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Note: previously we hid the window on blur, but that fights with the
  // drag-to-move flow (drag operations briefly defocus the window on some
  // window managers, which made it disappear mid-drag). Dismissal is now
  // explicit: Esc, clicking outside the card, or pressing the hotkey
  // again to toggle.
  typingBarWindow.on('closed', () => {
    typingBarWindow = null;
  });
  typingBarWindow.once('ready-to-show', () => {
    typingBarWindow?.show();
    typingBarWindow?.focus();
    typingBarWindow?.webContents.send(IPC.typingBar.opened);
  });
  void loadRoute(typingBarWindow, '/typing');
}

export function hideTypingBarWindow(): void {
  if (typingBarWindow && !typingBarWindow.isDestroyed() && typingBarWindow.isVisible()) {
    typingBarWindow.hide();
  }
}

function repositionTypingBar(): void {
  if (!typingBarWindow || typingBarWindow.isDestroyed()) return;
  const display = activeDisplay();
  const { workArea } = display;
  const bounds = typingBarWindow.getBounds();
  typingBarWindow.setBounds({
    x: Math.round(workArea.x + (workArea.width - bounds.width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.32 - bounds.height / 2),
    width: bounds.width,
    height: bounds.height,
  });
}

/** Forward a submitted typing-bar utterance to the avatar window's renderer
 * so its turn-handler picks it up via the local event bus. */
function dispatchTypingBarSubmit(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send(IPC.typingBar.dispatch, trimmed);
  }
  hideTypingBarWindow();
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

  ipcMain.on(IPC.typingBar.submit, (_evt, text: string) => {
    if (typeof text !== 'string') return;
    dispatchTypingBarSubmit(text);
  });
  ipcMain.on(IPC.typingBar.cancel, () => {
    hideTypingBarWindow();
  });

  ipcMain.handle(IPC.conversations.togglePanel, () => {
    toggleConversationPanelWindow();
  });

  ipcMain.handle(IPC.artifacts.openCanvas, (_evt, id?: string) => {
    showCanvasWindow();
    if (id) focusArtifactInCanvas(id);
  });
}

// ─── conversation panel ─────────────────────────────────────────────────
//
// A standalone Spotlight-style window that shows the conversation list +
// transcript viewer. Toggled by hotkey or tray. Like the typing bar it
// centers on the active display, ignores OS title bar, and is resizable
// (unlike the typing bar — this one needs room to read history).

let conversationPanelWindow: BrowserWindow | null = null;

const PANEL_W = 980;
const PANEL_H = 660;

export function toggleConversationPanelWindow(): void {
  if (conversationPanelWindow && !conversationPanelWindow.isDestroyed()) {
    if (conversationPanelWindow.isVisible()) {
      conversationPanelWindow.hide();
      return;
    }
    conversationPanelWindow.show();
    conversationPanelWindow.focus();
    return;
  }

  const display = activeDisplay();
  const { workArea } = display;
  const x = Math.round(workArea.x + (workArea.width - PANEL_W) / 2);
  const y = Math.round(workArea.y + (workArea.height - PANEL_H) / 2);

  conversationPanelWindow = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    minWidth: 720,
    minHeight: 480,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    title: 'HermesAgent Faceplate — Conversations',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  conversationPanelWindow.setAlwaysOnTop(true, 'pop-up-menu');
  if (conversationPanelWindow.setVisibleOnAllWorkspaces) {
    conversationPanelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  conversationPanelWindow.on('closed', () => {
    conversationPanelWindow = null;
  });
  conversationPanelWindow.once('ready-to-show', () => {
    conversationPanelWindow?.show();
    conversationPanelWindow?.focus();
  });
  void loadRoute(conversationPanelWindow, '/conversation');
}

export function hideConversationPanelWindow(): void {
  if (
    conversationPanelWindow &&
    !conversationPanelWindow.isDestroyed() &&
    conversationPanelWindow.isVisible()
  ) {
    conversationPanelWindow.hide();
  }
}

export function getConversationPanelWindow(): BrowserWindow | null {
  return conversationPanelWindow;
}

// ─── canvas window ──────────────────────────────────────────────────────
//
// A frameless transparent floater for displaying artifacts (charts,
// diagrams, images, code, etc.). Unlike the conversation panel this is
// NOT alwaysOnTop — the user often wants to glance at the canvas while
// working in another app, so we let it sit at normal z-order. They can
// still grab it via the hotkey.

let canvasWindow: BrowserWindow | null = null;

const CANVAS_W = 720;
const CANVAS_H = 560;

export function showCanvasWindow(): void {
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    if (!canvasWindow.isVisible()) canvasWindow.show();
    canvasWindow.focus();
    return;
  }

  const display = activeDisplay();
  const { workArea } = display;
  const x = Math.round(workArea.x + workArea.width - CANVAS_W - 40);
  const y = Math.round(workArea.y + 60);

  canvasWindow = new BrowserWindow({
    width: CANVAS_W,
    height: CANVAS_H,
    minWidth: 360,
    minHeight: 280,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    show: false,
    title: 'HermesAgent Faceplate — Canvas',
    icon: path.resolve(currentDir, 'icons/icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  if (canvasWindow.setVisibleOnAllWorkspaces) {
    canvasWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  canvasWindow.on('closed', () => {
    canvasWindow = null;
  });
  canvasWindow.once('ready-to-show', () => {
    canvasWindow?.show();
  });
  void loadRoute(canvasWindow, '/canvas');
}

export function toggleCanvasWindow(): void {
  if (canvasWindow && !canvasWindow.isDestroyed() && canvasWindow.isVisible()) {
    canvasWindow.hide();
    return;
  }
  showCanvasWindow();
}

export function hideCanvasWindow(): void {
  if (canvasWindow && !canvasWindow.isDestroyed() && canvasWindow.isVisible()) {
    canvasWindow.hide();
  }
}

export function getCanvasWindow(): BrowserWindow | null {
  return canvasWindow;
}

/**
 * Tell the canvas window to switch to a given artifact. Sent on every new
 * artifact creation if auto-open is enabled, and on user clicks from the
 * conversation panel transcript / gallery.
 */
export function focusArtifactInCanvas(artifactId: string): void {
  if (!canvasWindow || canvasWindow.isDestroyed()) return;
  // Ensure it's visible — the user may have hidden it.
  if (!canvasWindow.isVisible()) canvasWindow.show();
  canvasWindow.webContents.send(IPC.artifacts.focus, artifactId);
}

export function quitAll(): void {
  if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.close();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  if (conversationPanelWindow && !conversationPanelWindow.isDestroyed()) {
    conversationPanelWindow.close();
  }
  if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close();
  app.quit();
}
