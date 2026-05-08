// Shared types between the preload script and the renderer.
//
// The preload exposes a single `window.faceplate` object via contextBridge.
// This file is the contract — both sides import it. The renderer never imports
// from `electron`; the Capacitor port (v2) replaces only the preload while
// keeping this surface intact.

import type {
  FaceplateSettings,
  HotkeyName,
} from '../src/stores/settings-schema';
import type { AvatarThemeManifest } from '../src/themes/manifest-schema';
import type { FaceplateEvent } from '../src/hermes/event-schema';

export type SidecarBuild = 'cpu' | 'cpu-slim' | 'cuda';

export interface HermesDiscovery {
  found: boolean;
  config_path: string;
  api_server_enabled: boolean;
  api_server_host: string;
  api_server_port: number;
  api_key_present: boolean;
  llm: {
    provider?: string;
    base_url?: string;
    model?: string;
    api_key_present: boolean;
  };
  warnings: string[];
}

export type ConnectionTarget = 'agent' | 'llm' | 'tts' | 'asr' | 'paraphrase';

export interface TestResult {
  ok: boolean;
  latency_ms: number;
  detail?: string;
  error?: string;
}

export interface SidecarStatus {
  up: boolean;
  build: SidecarBuild;
  models?: Record<string, 'loaded' | 'idle' | 'error'>;
  ram_mb?: number;
  version?: string;
}

export interface MediaDeviceLite {
  deviceId: string;
  groupId: string;
  kind: 'audioinput' | 'audiooutput';
  label: string;
}

export type ShowHideState = 'show' | 'hide' | 'toggle';

export type RegisterResult =
  | { ok: true; accelerator: string }
  | { ok: false; reason: 'taken' | 'invalid'; tried: string[] };

export interface ThemeListing {
  id: string;
  name: string;
  builtin: boolean;
}

export interface FaceplatePreload {
  settings: {
    get(): Promise<FaceplateSettings>;
    set(patch: DeepPartial<FaceplateSettings>): Promise<FaceplateSettings>;
    onChange(cb: (s: FaceplateSettings) => void): () => void;
  };
  hermes: {
    discoverConfig(): Promise<HermesDiscovery>;
    testConnection(target: ConnectionTarget): Promise<TestResult>;
  };
  window: {
    setClickThrough(enabled: boolean): Promise<void>;
    reportHitRegion(insideAvatar: boolean): Promise<void>;
    cycleMonitor(): Promise<void>;
    showHide(state?: ShowHideState): Promise<void>;
    setMode(mode: 'overlay' | 'windowed'): Promise<void>;
  };
  hotkeys: {
    register(name: HotkeyName, accelerator: string): Promise<RegisterResult>;
    unregister(name: HotkeyName): Promise<void>;
    onPress(cb: (name: HotkeyName) => void): () => void;
  };
  audio: {
    listInputDevices(): Promise<MediaDeviceLite[]>;
    listOutputDevices(): Promise<MediaDeviceLite[]>;
  };
  sidecar: {
    status(): Promise<SidecarStatus>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  themes: {
    list(): Promise<ThemeListing[]>;
    load(id: string): Promise<AvatarThemeManifest>;
  };
  events: {
    publish(event: FaceplateEvent): void;
    subscribe(cb: (event: FaceplateEvent) => void): () => void;
  };
  platform: {
    os: 'darwin' | 'win32' | 'linux';
    is_wayland: boolean;
    app_version: string;
  };
}

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// IPC channel names — kept here so main and preload agree. Internal; not
// exposed to renderer code (renderer uses `window.faceplate.*`).
export const IPC = {
  settings: {
    get: 'faceplate:settings:get',
    set: 'faceplate:settings:set',
    changed: 'faceplate:settings:changed',
  },
  hermes: {
    discover: 'faceplate:hermes:discover',
    test: 'faceplate:hermes:test',
  },
  window: {
    setClickThrough: 'faceplate:window:set-click-through',
    reportHitRegion: 'faceplate:window:report-hit-region',
    cycleMonitor: 'faceplate:window:cycle-monitor',
    showHide: 'faceplate:window:show-hide',
    setMode: 'faceplate:window:set-mode',
  },
  hotkeys: {
    register: 'faceplate:hotkeys:register',
    unregister: 'faceplate:hotkeys:unregister',
    pressed: 'faceplate:hotkeys:pressed',
  },
  audio: {
    listInputs: 'faceplate:audio:list-inputs',
    listOutputs: 'faceplate:audio:list-outputs',
  },
  sidecar: {
    status: 'faceplate:sidecar:status',
    start: 'faceplate:sidecar:start',
    stop: 'faceplate:sidecar:stop',
  },
  themes: {
    list: 'faceplate:themes:list',
    load: 'faceplate:themes:load',
  },
  events: {
    publish: 'faceplate:events:publish',
    broadcast: 'faceplate:events:broadcast',
  },
} as const;
