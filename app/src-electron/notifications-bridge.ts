// OS-native notifications via Electron's main-process Notification module.
//
// Renderer fires `faceplate:notify:show` → this module checks settings
// (enabled, mode, DND hours, foreground state), constructs a Notification,
// wires click + reply handlers back to the renderer, and tracks live
// notifications in a Map so a re-fire of the same id supersedes the prior.
//
// Why main-process Notification (not the renderer Web API):
//   - Full event surface (click, close, reply, action, failed)
//   - macOS `hasReply` only works via main
//   - Cross-platform `setAppUserModelId` (Windows) is set in electron-main
//     before any window — see Phase 4 research brief
//
// References:
//   - docs/v1/research/phase4-electron-notifications.md
//   - https://www.electronjs.org/docs/latest/api/notification
//   - https://www.electronjs.org/docs/latest/tutorial/notifications

import {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  type NotificationConstructorOptions,
} from 'electron';

import { IPC, type NotifyOptions } from './preload-api';
import { getSettings } from './settings-store';
import { getAvatarWindow } from './window';

const liveNotifications = new Map<string, Notification>();
let appActive = false;

/** True if any Faceplate window currently holds OS focus. Updated via
 * browser-window-focus / -blur events; polling BrowserWindow.isFocused()
 * is unreliable on Windows (issue electron/electron#20464). */
function isAppActive(): boolean {
  return appActive;
}

/** Returns true if the current local time is inside the user's DND window.
 * DND wraps midnight (e.g. 22:00 → 08:00). Equal start+end disables DND. */
function isInDnd(start: string, end: string): boolean {
  if (start === end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number) as [number, number];
  const [eh, em] = end.split(':').map(Number) as [number, number];
  if (Number.isNaN(sh) || Number.isNaN(eh)) return false;
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

function shouldFire(opts: NotifyOptions): { ok: boolean; reason?: string } {
  const cfg = getSettings().notifications;
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (isInDnd(cfg.dnd_start, cfg.dnd_end)) return { ok: false, reason: 'dnd' };
  if (cfg.mode === 'backgrounded_only' && isAppActive()) {
    // Only suppress for "transient" cues; agent-initiated messages should
    // still fire even when app is focused (Phase 6) since the user may not
    // be looking at the right window.
    if (opts.kind !== 'agent_initiated') return { ok: false, reason: 'foregrounded' };
  }
  return { ok: true };
}

function broadcastClick(id: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.notify.clicked, id);
  }
}

function broadcastReply(id: string, text: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.notify.replied, id, text);
  }
}

function focusForKind(kind: NotifyOptions['kind']): void {
  // Default routing: focus the avatar window for response_complete and
  // agent_initiated. 'system' falls through to whatever is currently
  // focused or the first available window.
  const avatar = getAvatarWindow();
  if (kind === 'response_complete' || kind === 'agent_initiated') {
    if (avatar && !avatar.isDestroyed()) {
      if (!avatar.isVisible()) avatar.show();
      avatar.focus();
      // Win32 sometimes won't raise via focus() alone — toggle alwaysOnTop
      // as a known workaround (electron/electron#4766).
      if (process.platform === 'win32') {
        avatar.setAlwaysOnTop(true);
        setTimeout(() => avatar.setAlwaysOnTop(false), 100);
      }
      return;
    }
  }
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  focused?.show();
  focused?.focus();
}

function showNotification(opts: NotifyOptions): string | null {
  if (!Notification.isSupported()) return null;
  const verdict = shouldFire(opts);
  if (!verdict.ok) {
    console.log(`[notify] suppressed ${opts.id} (${verdict.reason})`);
    return null;
  }
  // Dedup: if a notification with this id is still live, close it before
  // firing the replacement.
  liveNotifications.get(opts.id)?.close();

  const cfg = getSettings().notifications;
  const ctorOpts: NotificationConstructorOptions = {
    title: opts.title,
    body: opts.body,
    silent: !cfg.sound,
  };
  if (process.platform === 'darwin' && opts.hasReply) {
    ctorOpts.hasReply = true;
    if (opts.replyPlaceholder) ctorOpts.replyPlaceholder = opts.replyPlaceholder;
  }

  const n = new Notification(ctorOpts);
  liveNotifications.set(opts.id, n);
  n.on('click', () => {
    broadcastClick(opts.id);
    focusForKind(opts.kind);
  });
  n.on('reply', (_evt, text: string) => {
    broadcastReply(opts.id, text);
  });
  n.on('close', () => {
    if (liveNotifications.get(opts.id) === n) liveNotifications.delete(opts.id);
  });
  n.on('failed', (_evt, err) => {
    console.warn(`[notify] failed for ${opts.id}: ${err}`);
    liveNotifications.delete(opts.id);
  });
  n.show();
  return opts.id;
}

export function registerNotificationsIpc(): void {
  // Track foreground state so backgrounded_only mode can gate properly.
  app.on('browser-window-focus', () => { appActive = true; });
  app.on('browser-window-blur', () => {
    // Defer the blur — focus often briefly drops between windows during a
    // multi-window setup. If another Faceplate window grabs focus within
    // 50 ms, we stay "active." Without this debounce, mode=backgrounded_only
    // misfires every time the user clicks between Avatar / Conversations /
    // Canvas.
    setTimeout(() => {
      const anyFocused = BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && w.isFocused(),
      );
      appActive = anyFocused;
    }, 80);
  });

  ipcMain.handle(IPC.notify.show, (_evt, opts: NotifyOptions): string | null => {
    if (!opts || typeof opts.id !== 'string' || typeof opts.title !== 'string') {
      return null;
    }
    return showNotification(opts);
  });

  // Close everything we opened on quit so notifications don't outlive the
  // app on macOS.
  app.on('before-quit', () => {
    for (const n of liveNotifications.values()) {
      try {
        n.close();
      } catch {
        /* noop */
      }
    }
    liveNotifications.clear();
  });
}
