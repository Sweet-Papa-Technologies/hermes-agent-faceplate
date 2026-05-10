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
} from './window';

interface FallbackPlan {
  primary: string;
  fallbacks: string[];
}

const FALLBACKS: Partial<Record<HotkeyName, string[]>> = {
  typing_bar: ['CommandOrControl+Alt+Space', 'CommandOrControl+Shift+Space'],
};

const registered = new Map<HotkeyName, string>();

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
        // Owned by main: open the standalone centered typing window on the
        // active display. Toggle if already visible (show again-> hide).
        showTypingBarWindow();
        return;
      case 'conversation_panel':
        toggleConversationPanelWindow();
        return;
      case 'canvas':
        toggleCanvasWindow();
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
