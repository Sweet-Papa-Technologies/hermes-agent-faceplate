// Cross-window event broadcaster. The renderer's event bus publishes via
// `ipcRenderer.send(IPC.events.publish, event)`; main fan-outs to every
// other renderer via `webContents.send(IPC.events.broadcast, event)`.
//
// `tts.audio.envelope` events fire ~30 Hz from the viseme driver. They're
// useful within a single renderer (lip-sync) but pointless across windows
// and would saturate IPC at 30 round-trips/sec. We drop them here.

import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import { IPC } from './preload-api';
import type { FaceplateEvent, FaceplateEventType } from '../src/hermes/event-schema';

const CROSS_WINDOW_BLOCKLIST: ReadonlySet<FaceplateEventType> = new Set<FaceplateEventType>([
  'tts.audio.envelope',
]);

export function registerEventBridgeIpc(): void {
  ipcMain.on(IPC.events.publish, (evt, event: FaceplateEvent) => {
    if (!event || typeof event.type !== 'string') return;
    if (CROSS_WINDOW_BLOCKLIST.has(event.type)) return;
    relayToOthers(evt.sender, event);
  });
}

/** Send `event` to every renderer except the originator. */
export function relayToOthers(origin: WebContents, event: FaceplateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const target = win.webContents;
    if (target === origin) continue;
    target.send(IPC.events.broadcast, event);
  }
}
