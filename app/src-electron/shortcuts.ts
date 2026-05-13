// Global shortcut registration. Uses Electron's globalShortcut.
//
// Conflict fallback: Cmd/Ctrl+Space is the typing-bar default but is also
// often bound by Spotlight/Search. If register() returns false we try the
// configured fallback (typically Cmd/Ctrl+Alt+Space) and report which one
// actually took.

import { BrowserWindow, globalShortcut, ipcMain } from 'electron';

import {
  HotkeyNames,
  type FaceplateSettings,
  type HotkeyName,
} from '../src/stores/settings-schema';
import { IPC, type RegisterResult } from './preload-api';
import { getSettings } from './settings-store';
import {
  cycleMonitor,
  getAvatarWindow,
  showHide,
  showTypingBarWindow,
  toggleConversationPanelWindow,
  toggleCanvasWindow,
  showAllWindows,
} from './window';

interface FallbackPlan {
  primary: string;
  fallbacks: string[];
}

const FALLBACKS: Partial<Record<HotkeyName, string[]>> = {
  typing_bar: ['CommandOrControl+Alt+Space', 'CommandOrControl+Shift+Space'],
};

const registered = new Map<HotkeyName, string>();

// Triple-tap detector for the `typing_bar` hotkey: 3 fires within 1 second
// trigger the "show everything" layout. Each fire still also opens the
// typing bar (non-destructive — the bar gets repositioned by showAllWindows
// on the third fire). Resets when the gap exceeds the window.
const TRIPLE_TAP_WINDOW_MS = 1_000;
const TRIPLE_TAP_COUNT = 3;
let typingBarPressTimes: number[] = [];

function maybeFireTripleTap(): boolean {
  const now = Date.now();
  typingBarPressTimes = typingBarPressTimes.filter((t) => now - t <= TRIPLE_TAP_WINDOW_MS);
  typingBarPressTimes.push(now);
  if (typingBarPressTimes.length >= TRIPLE_TAP_COUNT) {
    typingBarPressTimes = [];
    showAllWindows();
    return true;
  }
  return false;
}

function defaultHandler(name: HotkeyName): () => void {
  return () => {
    switch (name) {
      case 'show_hide':
        showHide('toggle');
        return;
      case 'cycle_monitor':
        cycleMonitor();
        return;
      case 'typing_bar':
        // Triple-tap → show all windows. Single/double tap → just open the
        // typing bar as usual. The triple-tap path also calls
        // showAllWindows which re-shows + repositions the typing bar in
        // the center, so the user gets visual continuity.
        if (maybeFireTripleTap()) return;
        showTypingBarWindow();
        return;
      case 'conversation_panel':
        toggleConversationPanelWindow();
        return;
      case 'canvas':
        toggleCanvasWindow();
        return;
      case 'show_all':
        showAllWindows();
        return;
      default:
        broadcastPress(name);
    }
  };
}

function broadcastPress(name: HotkeyName): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.hotkeys.pressed, name);
    }
  }
  // Also wake the avatar window if a renderer-handled press came in while it
  // was hidden — barge-in / replay should re-show.
  if (name === 'replay' || name === 'interrupt') {
    const w = getAvatarWindow();
    if (w && !w.isVisible()) w.show();
  }
}

function tryRegister(name: HotkeyName, accelerator: string): RegisterResult {
  const plan: FallbackPlan = {
    primary: accelerator,
    fallbacks: FALLBACKS[name] ?? [],
  };
  const tried: string[] = [];
  for (const acc of [plan.primary, ...plan.fallbacks]) {
    tried.push(acc);
    if (globalShortcut.isRegistered(acc)) continue;
    const ok = globalShortcut.register(acc, defaultHandler(name));
    if (ok) {
      registered.set(name, acc);
      return { ok: true, accelerator: acc };
    }
  }
  return { ok: false, reason: 'taken', tried };
}

export function unregisterHotkey(name: HotkeyName): void {
  const acc = registered.get(name);
  if (acc) {
    globalShortcut.unregister(acc);
    registered.delete(name);
  }
}

export function registerAllFromSettings(s: FaceplateSettings = getSettings()): void {
  for (const name of HotkeyNames) {
    unregisterHotkey(name);
    const accelerator = s.hotkeys[name];
    tryRegister(name, accelerator);
  }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll();
  registered.clear();
}

export function registerHotkeysIpc(): void {
  ipcMain.handle(
    IPC.hotkeys.register,
    (_evt, name: HotkeyName, accelerator: string): RegisterResult => {
      unregisterHotkey(name);
      return tryRegister(name, accelerator);
    },
  );
  ipcMain.handle(IPC.hotkeys.unregister, (_evt, name: HotkeyName) => {
    unregisterHotkey(name);
  });
}
