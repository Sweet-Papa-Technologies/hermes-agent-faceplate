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
// the activity indicator render BELOW the face plate. The avatar slot
// sizes itself square via `aspect-ratio: 1 / 1` on `.avatar-root`, so the
// remaining vertical space (default ~200px) is the captions area. The
// menu's +/− / Reset buttons resize WIDTH and HEIGHT proportionally so
// this ratio stays constant.
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

/** Snap a window back into the visible work area when the user drags or
 * resizes it mostly off-screen. Without this, dragging the title bar past
 * the screen edge or shrinking past a monitor boundary can leave the
 * window invisible — recoverable only by tray menu or relaunch. We
 * intentionally allow PARTIAL off-screen (so users can park a panel at
 * the edge) and only intervene when ≥75% of the window is hidden. */
function attachOnScreenGuard(win: BrowserWindow): void {
  const guard = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const center = {
      x: bounds.x + Math.floor(bounds.width / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
    };
    const display = screen.getDisplayNearestPoint(center);
    const work = display.workArea;
    const overlapW = Math.max(
      0,
      Math.min(bounds.x + bounds.width, work.x + work.width) - Math.max(bounds.x, work.x),
    );
    const overlapH = Math.max(
      0,
      Math.min(bounds.y + bounds.height, work.y + work.height) - Math.max(bounds.y, work.y),
    );
    const overlapArea = overlapW * overlapH;
    const windowArea = bounds.width * bounds.height;
    // Need at least 25% of the window OR an 80x80 patch visible — whichever
    // is smaller. Below that, the user has effectively lost the window.
    const minVisible = Math.min(windowArea * 0.25, 80 * 80);
    if (overlapArea >= minVisible) return;
    const newW = Math.min(bounds.width, work.width);
    const newH = Math.min(bounds.height, work.height);
    const newX = Math.max(work.x, Math.min(bounds.x, work.x + work.width - newW));
    const newY = Math.max(work.y, Math.min(bounds.y, work.y + work.height - newH));
    win.setBounds({ x: newX, y: newY, width: newW, height: newH }, false);
  };
  win.on('moved', guard);
  win.on('resized', guard);
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
    minWidth: 200,
    minHeight: 240,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    // Resize handles live on the frameless window's invisible chrome edges.
    // The Avatar SVG fills 100% of its flex slot, so it scales smoothly as
    // the user drags any corner.
    resizable: true,
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

  attachOnScreenGuard(win);
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

  attachOnScreenGuard(win);
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

// ─── menu-driven size controls ──────────────────────────────────────────
//
// The window is a fixed default size (OVERLAY_W × OVERLAY_H). Width AND
// height grow/shrink TOGETHER so the avatar:captions ratio stays constant
// — the avatar slot uses `aspect-ratio: 1 / 1` and tracks the window's
// width, with captions filling the rest. Resize via the menu's +/−/Reset
// buttons (more discoverable than hunting for invisible drag edges on a
// transparent always-on-top window). Corner-drag still works as a fallback.

const OVERLAY_W_MIN = 200;
const OVERLAY_W_MAX = 900;

export function resizeAvatarBy(deltaW: number): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const bounds = avatarWindow.getBounds();
  const nextW = Math.max(OVERLAY_W_MIN, Math.min(OVERLAY_W_MAX, bounds.width + deltaW));
  if (nextW === bounds.width) return;
  // Scale height in lockstep with the current width:height ratio so the
  // avatar slot and captions area both grow proportionally — otherwise a
  // wider window gets a giant avatar and a sliver of captions space.
  const ratio = bounds.height / Math.max(bounds.width, 1);
  const nextH = Math.round(nextW * ratio);
  avatarWindow.setBounds({ ...bounds, width: nextW, height: nextH });
}

export function resetAvatarSize(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const bounds = avatarWindow.getBounds();
  avatarWindow.setBounds({ ...bounds, width: OVERLAY_W, height: OVERLAY_H });
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
  attachOnScreenGuard(settingsWindow);
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
  attachOnScreenGuard(wizardWindow);
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

  ipcMain.handle(IPC.window.openSettings, () => {
    createSettingsWindow();
  });
  ipcMain.handle(IPC.window.quit, () => {
    quitAll();
  });

  ipcMain.handle(IPC.window.resizeBy, (_evt: IpcMainInvokeEvent, deltaW: number) => {
    resizeAvatarBy(deltaW);
  });

  ipcMain.handle(IPC.window.resetSize, () => {
    resetAvatarSize();
  });

  ipcMain.handle(IPC.window.openTypingBar, () => {
    showTypingBarWindow();
  });

  ipcMain.handle(IPC.window.raiseAvatar, () => {
    const win = avatarWindow;
    if (!win || win.isDestroyed()) return;
    // Don't steal text focus — overlay-mode avatars are click-through and
    // shouldn't grab keyboard input from whatever the user is typing into.
    // moveTop raises the z-order; if the window isn't visible (user
    // dismissed it), bring it back inactive.
    if (!win.isVisible()) win.showInactive();
    else win.moveTop();
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
  attachOnScreenGuard(conversationPanelWindow);
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
    // showInactive() raises the window to the front WITHOUT stealing keyboard
    // focus from whatever the user is typing into. Per UX spec: canvas
    // appears when the agent generates an artifact mid-conversation, but
    // shouldn't pull the user out of their text editor / terminal / typing
    // bar. The user can click into the canvas if they want focus.
    if (!canvasWindow.isVisible()) canvasWindow.showInactive();
    else canvasWindow.moveTop();
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
    // Same no-steal-focus rule on first appearance.
    canvasWindow?.showInactive();
  });
  attachOnScreenGuard(canvasWindow);
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

/**
 * "Bring everything to view." Position all four windows on the active
 * display in the layout from the v1 spec:
 *   - Avatar:       top-left
 *   - Canvas:       top-right
 *   - Conversations: bottom-center
 *   - TypingBar:    dead center
 * Triggered by the `show_all` hotkey or by triple-tapping `typing_bar`
 * within a 1-second window. Each window is shown if hidden, then nudged
 * into its slot. The typing bar is the only one that gets focus (since the
 * user just summoned the constellation to type something).
 */
export function showAllWindows(): void {
  const display = activeDisplay();
  const { workArea } = display;
  const margin = 24;
  const halfW = Math.floor(workArea.width / 2);
  const halfH = Math.floor(workArea.height / 2);

  // Avatar — keep its current size; just position. Create if needed (the
  // user may have quit it).
  const avatar = avatarWindow ?? createAvatarWindow();
  if (avatar && !avatar.isDestroyed()) {
    if (!avatar.isVisible()) avatar.show();
    const ab = avatar.getBounds();
    avatar.setBounds({
      x: workArea.x + margin,
      y: workArea.y + margin,
      width: ab.width,
      height: ab.height,
    });
  }

  // Canvas — top-right quadrant.
  if (!canvasWindow || canvasWindow.isDestroyed()) showCanvasWindow();
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    if (!canvasWindow.isVisible()) canvasWindow.showInactive();
    const w = Math.min(CANVAS_W, halfW - margin * 2);
    const h = Math.min(CANVAS_H, halfH - margin * 2);
    canvasWindow.setBounds({
      x: workArea.x + workArea.width - w - margin,
      y: workArea.y + margin,
      width: w,
      height: h,
    });
  }

  // Conversations — bottom-center.
  if (!conversationPanelWindow || conversationPanelWindow.isDestroyed()) {
    toggleConversationPanelWindow();
  }
  if (conversationPanelWindow && !conversationPanelWindow.isDestroyed()) {
    if (!conversationPanelWindow.isVisible()) conversationPanelWindow.showInactive();
    const w = Math.min(PANEL_W, workArea.width - margin * 2);
    const h = Math.min(PANEL_H, halfH - margin * 2);
    conversationPanelWindow.setBounds({
      x: workArea.x + Math.floor((workArea.width - w) / 2),
      y: workArea.y + workArea.height - h - margin,
      width: w,
      height: h,
    });
  }

  // Typing bar — dead center, focused. The user invoked this to bring
  // everything to view, presumably to type something next.
  showTypingBarWindow();
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
