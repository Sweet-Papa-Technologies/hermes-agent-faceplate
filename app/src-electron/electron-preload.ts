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
import type {
  ConversationFile,
  ConversationManifestEntry,
  PersistedTurn,
} from '../src/stores/conversation-types';
import type {
  Artifact,
  ArtifactIndexEntry,
  CreateArtifactInput,
} from '../src/stores/artifact-types';

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
  paraphrase: (text: string) => ipcRenderer.invoke(IPC.hermes.paraphrase, text),
  hookPreview: () => ipcRenderer.invoke(IPC.hermes.hookPreview),
  hookInstall: () => ipcRenderer.invoke(IPC.hermes.hookInstall),
  hookUninstall: () => ipcRenderer.invoke(IPC.hermes.hookUninstall),
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
  moveBy: (dx, dy) => ipcRenderer.invoke(IPC.window.moveBy, dx, dy),
  openSettings: () => ipcRenderer.invoke(IPC.window.openSettings),
  quit: () => ipcRenderer.invoke(IPC.window.quit),
  resizeBy: (deltaW: number) => ipcRenderer.invoke(IPC.window.resizeBy, deltaW),
  resetSize: () => ipcRenderer.invoke(IPC.window.resetSize),
  raiseAvatar: () => ipcRenderer.invoke(IPC.window.raiseAvatar),
  openTypingBar: () => ipcRenderer.invoke(IPC.window.openTypingBar),
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
  accessibilityTrusted: () => ipcRenderer.invoke(IPC.platform.accessibilityTrusted),
  relaunch: () => ipcRenderer.invoke(IPC.platform.relaunch),
  openDevTools: (target = 'self') => ipcRenderer.invoke(IPC.platform.openDevTools, target),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.platform.openExternal, url),
};

const kokoro: FaceplatePreload['kokoro'] = {
  status: () => ipcRenderer.invoke(IPC.kokoro.status),
  ensure: () => ipcRenderer.invoke(IPC.kokoro.ensure),
  stop: () => ipcRenderer.invoke(IPC.kokoro.stop),
};

const agentPush: FaceplatePreload['agentPush'] = {
  onFrame: (cb) => {
    const listener = (
      _e: unknown,
      frame: import('./preload-api').AgentPushFrame,
    ) => cb(frame);
    ipcRenderer.on(IPC.agentPush.received, listener);
    return () => ipcRenderer.removeListener(IPC.agentPush.received, listener);
  },
  status: () => ipcRenderer.invoke(IPC.agentPush.status),
};

const notify: FaceplatePreload['notify'] = {
  show: (opts) => ipcRenderer.invoke(IPC.notify.show, opts),
  onClicked: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on(IPC.notify.clicked, listener);
    return () => ipcRenderer.removeListener(IPC.notify.clicked, listener);
  },
  onReplied: (cb) => {
    const listener = (_e: unknown, id: string, text: string) => cb(id, text);
    ipcRenderer.on(IPC.notify.replied, listener);
    return () => ipcRenderer.removeListener(IPC.notify.replied, listener);
  },
};

const typingBar: FaceplatePreload['typingBar'] = {
  submit: (text: string) => ipcRenderer.send(IPC.typingBar.submit, text),
  cancel: () => ipcRenderer.send(IPC.typingBar.cancel),
  onDispatch: (cb) => {
    const listener = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on(IPC.typingBar.dispatch, listener);
    return () => ipcRenderer.removeListener(IPC.typingBar.dispatch, listener);
  },
  onOpened: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.typingBar.opened, listener);
    return () => ipcRenderer.removeListener(IPC.typingBar.opened, listener);
  },
};

const conversations: FaceplatePreload['conversations'] = {
  list: (): Promise<ConversationManifestEntry[]> =>
    ipcRenderer.invoke(IPC.conversations.list),
  load: (id: string): Promise<ConversationFile | null> =>
    ipcRenderer.invoke(IPC.conversations.load, id),
  getActive: (): Promise<ConversationFile | null> =>
    ipcRenderer.invoke(IPC.conversations.getActive),
  create: (title?: string): Promise<ConversationFile> =>
    ipcRenderer.invoke(IPC.conversations.create, title),
  setActive: (id: string): Promise<ConversationFile | null> =>
    ipcRenderer.invoke(IPC.conversations.setActive, id),
  saveActive: (
    turns: PersistedTurn[],
    sessionId: string | null,
    lastResponseId?: string | null,
  ) =>
    ipcRenderer.invoke(IPC.conversations.saveActive, turns, sessionId, lastResponseId),
  updateTitle: (id: string, title: string) =>
    ipcRenderer.invoke(IPC.conversations.updateTitle, id, title),
  archive: (id: string) => ipcRenderer.invoke(IPC.conversations.archive, id),
  delete: (id: string) => ipcRenderer.invoke(IPC.conversations.delete, id),
  search: (query: string) => ipcRenderer.invoke(IPC.conversations.search, query),
  exportMarkdown: (id: string) =>
    ipcRenderer.invoke(IPC.conversations.exportMarkdown, id),
  togglePanel: () => ipcRenderer.invoke(IPC.conversations.togglePanel),
  onActiveChanged: (cb) => {
    const listener = (
      _e: unknown,
      msg: { id: string | null; conversation: ConversationFile | null },
    ) => cb(msg);
    ipcRenderer.on(IPC.conversations.activeChanged, listener);
    return () =>
      ipcRenderer.removeListener(IPC.conversations.activeChanged, listener);
  },
  onChanged: (cb) => {
    const listener = (
      _e: unknown,
      msg: { id: string; conversation: ConversationFile | null },
    ) => cb(msg);
    ipcRenderer.on(IPC.conversations.changed, listener);
    return () =>
      ipcRenderer.removeListener(IPC.conversations.changed, listener);
  },
};

const artifacts: FaceplatePreload['artifacts'] = {
  list: (filter?: { conversation_id?: string }): Promise<ArtifactIndexEntry[]> =>
    ipcRenderer.invoke(IPC.artifacts.list, filter),
  get: (id: string): Promise<Artifact | null> =>
    ipcRenderer.invoke(IPC.artifacts.get, id),
  create: (input: CreateArtifactInput): Promise<Artifact> =>
    ipcRenderer.invoke(IPC.artifacts.create, input),
  delete: (id: string) => ipcRenderer.invoke(IPC.artifacts.delete, id),
  resolveUrl: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.artifacts.resolveUrl, id),
  download: (id: string) => ipcRenderer.invoke(IPC.artifacts.download, id),
  openCanvas: (id?: string) => ipcRenderer.invoke(IPC.artifacts.openCanvas, id),
  updateBody: (id: string, body: string) =>
    ipcRenderer.invoke(IPC.artifacts.updateBody, id, body),
  onChanged: (cb) => {
    const listener = (
      _e: unknown,
      msg: { id: string; artifact: Artifact | null },
    ) => cb(msg);
    ipcRenderer.on(IPC.artifacts.changed, listener);
    return () => ipcRenderer.removeListener(IPC.artifacts.changed, listener);
  },
  onFocus: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on(IPC.artifacts.focus, listener);
    return () => ipcRenderer.removeListener(IPC.artifacts.focus, listener);
  },
};

const artifactFix: FaceplatePreload['artifactFix'] = {
  fix: (input) => ipcRenderer.invoke(IPC.artifactFix.fix, input),
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
  notify,
  agentPush,
  kokoro,
  typingBar,
  conversations,
  artifacts,
  artifactFix,
};

contextBridge.exposeInMainWorld('faceplate', api);
