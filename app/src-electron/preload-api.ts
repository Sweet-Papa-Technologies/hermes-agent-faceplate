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

export interface HermesCapabilities {
  /** Model id hermes advertises for itself (e.g. `hermes-agent` or a profile name). */
  model?: string;
  platform?: string;
  auth_required?: boolean;
  features?: {
    chat_completions?: boolean;
    responses_api?: boolean;
    runs?: boolean;
    streaming?: boolean;
    cancellation?: boolean;
  };
  /** Raw upstream payload — kept around for debugging in the Settings UI. */
  raw?: unknown;
}

export interface HermesLocalConfig {
  config_path: string;
  api_server_enabled: boolean;
  api_server_host: string;
  api_server_port: number;
  api_key_present_in_env: boolean;
  llm: {
    provider?: string;
    base_url?: string;
    model?: string;
    api_key_present: boolean;
  };
}

/**
 * Discovery is split into two independent halves:
 *
 *   - `reachable` + `capabilities` come from an HTTP probe. Works against any
 *     hermes deployment — local, Docker, remote.
 *   - `local_config` is populated only when this machine happens to have read
 *     access to `~/.hermes/config.yaml` + `.env`. It exists solely as an
 *     opt-in optimisation for the "reuse hermes' configured LLM" paraphrase
 *     mode (which would otherwise corrupt session memory by routing
 *     paraphrase prompts through the agent loop).
 */
export interface HermesDiscovery {
  base_url: string;
  reachable: boolean;
  http_status?: number;
  capabilities?: HermesCapabilities;
  health_status?: 'ok' | 'degraded' | 'unknown';
  local_config_readable: boolean;
  local_config?: HermesLocalConfig;
  warnings: string[];
}

export type ConnectionTarget = 'agent' | 'llm' | 'tts' | 'asr' | 'paraphrase';

export interface ParaphraseResult {
  text: string;
  used: 'reuse_hermes_llm' | 'local_litert' | 'disabled' | 'skipped';
  latency_ms: number;
  /**
   * When `used` does not match the user's preferred mode, this explains why
   * we re-routed. Set when `reuse_hermes_llm` is unavailable (no local
   * config / unreachable provider) and we fell through to local_litert.
   */
  fallback_reason?: 'unsafe_to_bypass' | 'unreachable' | 'no_endpoint';
}

export interface HookPreview {
  /** Absolute path on disk where the hook script will be written. */
  script_path: string;
  /** Bash script content the user is about to write. */
  script: string;
  /** Path to ~/.hermes/config.yaml that will be edited. */
  config_path: string;
  /** YAML before our edit (empty string if file does not exist). */
  current_yaml: string;
  /** YAML after our edit. */
  merged_yaml: string;
  /** Unified-diff-style summary, additions only. */
  diff_summary: string;
  /** True if our hook keys are already present (toggle is a no-op). */
  already_installed: boolean;
}

export interface HookInstallResult {
  ok: boolean;
  config_path: string;
  script_path: string;
  listener_port: number;
  error?: string;
}

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
    paraphrase(text: string): Promise<ParaphraseResult>;
    hookPreview(): Promise<HookPreview>;
    hookInstall(): Promise<HookInstallResult>;
    hookUninstall(): Promise<HookInstallResult>;
  };
  window: {
    setClickThrough(enabled: boolean): Promise<void>;
    reportHitRegion(insideAvatar: boolean): Promise<void>;
    cycleMonitor(): Promise<void>;
    showHide(state?: ShowHideState): Promise<void>;
    setMode(mode: 'overlay' | 'windowed'): Promise<void>;
    moveBy(dx: number, dy: number): Promise<void>;
  };
  hotkeys: {
    register(name: HotkeyName, accelerator: string): Promise<RegisterResult>;
    unregister(name: HotkeyName): Promise<void>;
    onPress(cb: (name: HotkeyName) => void): () => void;
  };
  /**
   * Audio device enumeration is done in the renderer via
   * navigator.mediaDevices.enumerateDevices(). Kept on the contract so a
   * future native shim (Capacitor) can satisfy the same surface.
   */
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
    /** macOS only: returns trusted state for Accessibility (globalShortcut). */
    accessibilityTrusted(): Promise<boolean>;
    relaunch(): Promise<void>;
    /**
     * Open Chromium DevTools docked to the **calling** window. The avatar
     * window is overlay/click-through, so right-click → Inspect doesn't work
     * there; this lets the user pop DevTools open from the Settings UI.
     */
    openDevTools(target?: 'self' | 'avatar' | 'all'): Promise<void>;
  };
  typingBar: {
    /** Sent by the standalone typing window when the user hits Enter. */
    submit(text: string): void;
    /** Sent by the typing window on Esc / blur. */
    cancel(): void;
    /** Subscribe (avatar window) to forwarded typing-bar text. */
    onDispatch(cb: (text: string) => void): () => void;
    /** Subscribe (typing window) to focus-on-open events. */
    onOpened(cb: () => void): () => void;
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
    paraphrase: 'faceplate:hermes:paraphrase',
    hookPreview: 'faceplate:hermes:hook-preview',
    hookInstall: 'faceplate:hermes:hook-install',
    hookUninstall: 'faceplate:hermes:hook-uninstall',
  },
  window: {
    setClickThrough: 'faceplate:window:set-click-through',
    reportHitRegion: 'faceplate:window:report-hit-region',
    cycleMonitor: 'faceplate:window:cycle-monitor',
    showHide: 'faceplate:window:show-hide',
    setMode: 'faceplate:window:set-mode',
    moveBy: 'faceplate:window:move-by',
  },
  hotkeys: {
    register: 'faceplate:hotkeys:register',
    unregister: 'faceplate:hotkeys:unregister',
    pressed: 'faceplate:hotkeys:pressed',
  },
  // audio.listInputs/listOutputs intentionally omitted — renderer uses the
  // browser's enumerateDevices() instead. The preload still exposes stub
  // methods for the v2 Capacitor port.
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
  platform: {
    accessibilityTrusted: 'faceplate:platform:accessibility-trusted',
    relaunch: 'faceplate:platform:relaunch',
    openDevTools: 'faceplate:platform:open-devtools',
  },
  typingBar: {
    submit: 'faceplate:typing-bar:submit',
    cancel: 'faceplate:typing-bar:cancel',
    opened: 'faceplate:typing-bar:opened',
    dispatch: 'faceplate:typing-bar:dispatch',
  },
} as const;
