// Preload — the only file that imports `electron` on the renderer side.
// Exposes `window.faceplate` per FaceplatePreload (preload-api.ts).
//
// Capacitor port (v2) replaces this file with a plugin shim satisfying the
// same surface; renderer code stays unchanged.

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type FaceplatePreload,
  type DeepPartial,
  type ConnectionTarget,
  type ShowHideState,
  type RegisterResult,
} from './preload-api';
import type { FaceplateSettings, HotkeyName } from '../src/stores/settings-schema';
import type { FaceplateEvent } from '../src/hermes/event-schema';
import type { AvatarThemeManifest } from '../src/themes/manifest-schema';

const settings: FaceplatePreload['settings'] = {
  get: () => ipcRenderer.invoke(IPC.settings.get),
  set: (patch) =>
    ipcRenderer.invoke(IPC.settings.set, patch as DeepPartial<FaceplateSettings>),
  onChange(cb) {
    const listener = (_e: unknown, msg: { settings: FaceplateSettings; keys: string[] }) =>
      cb(msg.settings);
    ipcRenderer.on(IPC.settings.changed, listener);
    return () => ipcRenderer.removeListener(IPC.settings.changed, listener);
  },
};

const hermes: FaceplatePreload['hermes'] = {
  discoverConfig: () => ipcRenderer.invoke(IPC.hermes.discover),
  testConnection: (target: ConnectionTarget) =>
    ipcRenderer.invoke(IPC.hermes.test, target),
};

const win: FaceplatePreload['window'] = {
  setClickThrough: (enabled) =>
    ipcRenderer.invoke(IPC.window.setClickThrough, enabled),
  reportHitRegion: (insideAvatar) =>
    ipcRenderer.invoke(IPC.window.reportHitRegion, insideAvatar),
  cycleMonitor: () => ipcRenderer.invoke(IPC.window.cycleMonitor),
  showHide: (state?: ShowHideState) =>
    ipcRenderer.invoke(IPC.window.showHide, state),
  setMode: (mode) => ipcRenderer.invoke(IPC.window.setMode, mode),
};

const hotkeys: FaceplatePreload['hotkeys'] = {
  register: (name: HotkeyName, accelerator: string): Promise<RegisterResult> =>
    ipcRenderer.invoke(IPC.hotkeys.register, name, accelerator),
  unregister: (name: HotkeyName) =>
    ipcRenderer.invoke(IPC.hotkeys.unregister, name),
  onPress(cb) {
    const listener = (_e: unknown, name: HotkeyName) => cb(name);
    ipcRenderer.on(IPC.hotkeys.pressed, listener);
    return () => ipcRenderer.removeListener(IPC.hotkeys.pressed, listener);
  },
};

// Audio device enumeration is done in the renderer via
// navigator.mediaDevices.enumerateDevices(). These stubs keep the contract
// complete for future native paths (Capacitor port).
const audio: FaceplatePreload['audio'] = {
  listInputDevices: () => Promise.resolve([]),
  listOutputDevices: () => Promise.resolve([]),
};

const sidecar: FaceplatePreload['sidecar'] = {
  status: () => ipcRenderer.invoke(IPC.sidecar.status),
  start: () => ipcRenderer.invoke(IPC.sidecar.start),
  stop: () => ipcRenderer.invoke(IPC.sidecar.stop),
};

const themes: FaceplatePreload['themes'] = {
  list: () => ipcRenderer.invoke(IPC.themes.list),
  load: (id: string): Promise<AvatarThemeManifest> =>
    ipcRenderer.invoke(IPC.themes.load, id),
};

const events: FaceplatePreload['events'] = {
  publish: (event: FaceplateEvent) => ipcRenderer.send(IPC.events.publish, event),
  subscribe(cb) {
    const listener = (_e: unknown, event: FaceplateEvent) => cb(event);
    ipcRenderer.on(IPC.events.broadcast, listener);
    return () => ipcRenderer.removeListener(IPC.events.broadcast, listener);
  },
};

const platform: FaceplatePreload['platform'] = {
  os: process.platform as 'darwin' | 'win32' | 'linux',
  is_wayland:
    process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland',
  app_version: process.env.npm_package_version ?? '0.0.0',
};

const api: FaceplatePreload = {
  settings,
  hermes,
  window: win,
  hotkeys,
  audio,
  sidecar,
  themes,
  events,
  platform,
};

contextBridge.exposeInMainWorld('faceplate', api);
