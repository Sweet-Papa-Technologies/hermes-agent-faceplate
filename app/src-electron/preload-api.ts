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

/** Frame shape pushed by the Hermes faceplate plugin's WebSocket server.
 * Mirrors hermes-plugin/faceplate/adapter.py's send-side JSON. */
export interface AgentPushFrame {
  type: 'message' | 'hello';
  chat_id: string;
  thread_id: string | null;
  text: string;
  media: Array<{ kind: string; url: string }> | null;
  ts: number;
}

export interface AgentPushStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  last_error: string | null;
  /** A short, actionable explanation of `last_error` — set when we can
   *  recognise the failure mode (e.g. ECONNREFUSED on a localhost URL while
   *  Hermes is in Docker). UI surfaces this above the raw error. */
  last_error_hint: string | null;
  last_frame_at: number | null;
}

/** Preview of what an Install Plugin click will change on disk. UI shows
 * this in a confirm dialog so the user knows exactly what's being touched. */
export interface AgentPushInstallPreview {
  /** Absolute path of the bundled plugin source (read-only). */
  plugin_src: string;
  /** Absolute path the plugin will be copied to (`~/.hermes/plugins/faceplate`). */
  plugin_dst: string;
  /** True if `plugin_dst/plugin.yaml` already exists — install will overwrite. */
  plugin_already_present: boolean;
  /** Absolute path to `~/.hermes/.env` (may not exist yet). */
  env_path: string;
  /** Vars we'll APPEND if missing. We never overwrite existing values
   *  (in case the user has a custom port / shared secret already). */
  env_additions: Array<{ key: string; value: string; already_set: boolean }>;
  /** True if the configured Hermes base_url points away from localhost — a
   *  strong signal that Hermes runs in Docker or on another machine, in which
   *  case writing to the host's ~/.hermes/ alone won't suffice. UI surfaces
   *  a warning + a pointer to setup/hermes-faceplate-plugin.sh. */
  hermes_likely_remote: boolean;
  /** The base_url the heuristic looked at, for the warning copy. */
  hermes_base_url: string;
}

export interface AgentPushInstallResult {
  ok: boolean;
  /** Same key the renderer should now show in the FACEPLATE_API_KEY field.
   *  Either freshly generated or read back from a pre-existing .env entry. */
  api_key: string;
  /** Human-readable summary lines for a "what happened" banner. */
  steps: string[];
  error?: string;
}

/** Payload for `faceplate:notify:show`. Kept tight on purpose — the main
 * process owns formatting, sound choice, click routing, and dedup. */
export interface NotifyOptions {
  /** Caller-controlled id. Used for dedup (calling show with the same id
   * closes the previous notification first) and for click/reply routing. */
  id: string;
  title: string;
  body: string;
  /** What kind of event this is — drives click-to-focus routing in main.
   *   - 'response_complete': agent finished a turn → focus the avatar
   *   - 'agent_initiated':   unprompted message (Phase 6) → focus avatar
   *   - 'system':            misc app-level alert → focus most-recent window */
  kind?: 'response_complete' | 'agent_initiated' | 'system';
  /** macOS-only: enable inline reply UI on the notification. Sends back
   * via onReplied. Ignored on Windows/Linux. */
  hasReply?: boolean;
  replyPlaceholder?: string;
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
  /** Locally detected gateway configurations. Secrets are only returned when
   * they came from this user's environment/config files and are never logged. */
  candidates: HermesConnectionCandidate[];
}

export interface HermesConnectionCandidate {
  base_url: string;
  source: 'settings' | 'environment' | 'config' | 'path';
  label: string;
  reachable: boolean;
  api_key?: string;
  config_path?: string;
}

export type ConnectionTarget = 'agent' | 'llm' | 'tts' | 'asr' | 'paraphrase';

export interface ParaphraseResult {
  text: string;
  used: 'reuse_hermes_llm' | 'disabled' | 'skipped';
  latency_ms: number;
  /**
   * When `used` does not match the user's preferred mode, this explains why:
   * `reuse_hermes_llm` was unavailable (no local config / unreachable
   * provider), so paraphrase was skipped and the full text is spoken.
   */
  fallback_reason?: 'unsafe_to_bypass' | 'unreachable' | 'no_endpoint';
}

/** Result of a paraphrase round-trip probe — used by Settings → Voice to
 *  tell the user *why* paraphrase isn't producing summaries, without
 *  waiting for the next long assistant reply. Mirrors TestResult plus
 *  details readers want: the resolved endpoint and a short hint. */
export interface ParaphraseProbeResult {
  ok: boolean;
  /** Endpoint that was actually called (LLM base_url derived from local
   *  hermes config), or '' when nothing was discovered. */
  endpoint: string;
  /** Model id sent in the test request, when one was resolved. */
  model: string;
  latency_ms: number;
  /** Output paraphrase text (truncated to ~120 chars) when ok. */
  sample?: string;
  /** Failure category — UI maps these to friendly captions. */
  reason?:
    | 'disabled'
    | 'no_local_config'
    | 'no_model'
    | 'unreachable'
    | 'auth'
    | 'http'
    | 'empty'
    | 'timeout'
    | 'unknown';
  /** Raw underlying error message (developer-grade). */
  error?: string;
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
  /** Build tag the sidecar reports in /health (e.g. "cpu", "cuda", or
   * whatever a native/external sidecar advertises). Empty string when
   * unreachable. */
  build: string;
  /** Configured sidecar base URL (shown as a chip in the UI). */
  url: string;
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
    /** Round-trip probe — POSTs a tiny test prompt to the resolved LLM
     *  endpoint and reports back with a categorized reason on failure. */
    paraphraseProbe(): Promise<ParaphraseProbeResult>;
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
    openSettings(): Promise<void>;
    quit(): Promise<void>;
    /** Step the avatar window's width by ± deltaW pixels; height scales
     * proportionally so avatar:captions ratio stays constant. Clamped. */
    resizeBy(deltaW: number): Promise<void>;
    /** Reset the avatar window to its default size. */
    resetSize(): Promise<void>;
    /** Bring the avatar window to the front. Doesn't steal text focus by
     * default — use this when the user submits a turn so they can see the
     * response without losing typing focus elsewhere. */
    raiseAvatar(): Promise<void>;
    /** Open the floating typing bar (same window the Ctrl+Space hotkey
     * opens). Used by the Conversations panel's chat-input button. */
    openTypingBar(): Promise<void>;
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
    /** Open a URL in the user's default system browser. Schemes restricted
     * to http/https/mailto in the main-process handler — anything else is
     * silently dropped. */
    openExternal(url: string): Promise<void>;
  };
  agentPush: {
    /** Subscribe to unprompted-message frames pushed from the Hermes
     * faceplate plugin. The main process owns the WebSocket; this just
     * surfaces decoded frames to the renderer. */
    onFrame(cb: (frame: AgentPushFrame) => void): () => void;
    /** Current connection state. Polled by the Settings UI for a status chip. */
    status(): Promise<AgentPushStatus>;
    /** Dry-run inspector: report exactly which files would be written and
     *  which env vars would be added. Renderer shows this in a confirm
     *  dialog before any disk write. */
    installPreview(): Promise<AgentPushInstallPreview>;
    /** Perform the install: copy the plugin, append missing env vars,
     *  generate FACEPLATE_API_KEY if needed, write it into settings. After
     *  this, restart the Hermes gateway so the plugin loader picks it up. */
    install(): Promise<AgentPushInstallResult>;
  };
  notify: {
    /** Fire an OS notification. The main process gates on settings
     * (enabled, mode, DND hours, foregrounded suppression) — callers don't
     * need to check those themselves. Returns the notification id (the
     * caller can use it for dedup/replay). */
    show(opts: NotifyOptions): Promise<string | null>;
    /** Subscribe to click events on notifications fired by this app.
     * Receives the id passed in show(). */
    onClicked(cb: (id: string) => void): () => void;
    /** macOS-only: subscribe to the inline-reply text the user types in
     * a notification with `hasReply: true`. Phase 6 quick-reply UX. */
    onReplied(cb: (id: string, text: string) => void): () => void;
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
  conversations: {
    list(): Promise<ConversationManifestEntry[]>;
    load(id: string): Promise<ConversationFile | null>;
    getActive(): Promise<ConversationFile | null>;
    create(title?: string): Promise<ConversationFile>;
    setActive(id: string): Promise<ConversationFile | null>;
    saveActive(
      turns: PersistedTurn[],
      sessionId: string | null,
      lastResponseId?: string | null,
    ): Promise<ConversationFile | null>;
    updateTitle(id: string, title: string): Promise<ConversationFile | null>;
    archive(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    search(query: string): Promise<ConversationManifestEntry[]>;
    exportMarkdown(id: string): Promise<string>;
    /** Toggle the conversation panel window. Owned by main. */
    togglePanel(): Promise<void>;
    /** Subscribe to active-conversation changes (any window). */
    onActiveChanged(
      cb: (msg: { id: string | null; conversation: ConversationFile | null }) => void,
    ): () => void;
    /** Subscribe to per-conversation changes (saves, title edits, deletes). */
    onChanged(
      cb: (msg: { id: string; conversation: ConversationFile | null }) => void,
    ): () => void;
  };
  artifacts: {
    list(filter?: { conversation_id?: string }): Promise<ArtifactIndexEntry[]>;
    get(id: string): Promise<Artifact | null>;
    create(input: CreateArtifactInput): Promise<Artifact>;
    delete(id: string): Promise<void>;
    /** Resolve a renderable URL for file/url-stored artifacts; null for inline. */
    resolveUrl(id: string): Promise<string | null>;
    /** Open a save dialog and write the artifact body to disk. */
    download(id: string): Promise<{ ok: boolean; path?: string }>;
    /** Open the canvas window. If `id` is provided, focuses that artifact. */
    openCanvas(id?: string): Promise<void>;
    /** Replace the inline body of an existing artifact in place. Used by
     * the AI auto-fix flow when a chart/diagram fails to render and the
     * user clicks "Fix with AI" — the corrected body persists. Returns
     * the updated artifact, or null if the id wasn't found / wasn't
     * inline-stored. */
    updateBody(id: string, body: string): Promise<Artifact | null>;
    /** Subscribe to artifact create/delete broadcasts. */
    onChanged(
      cb: (msg: { id: string; artifact: Artifact | null }) => void,
    ): () => void;
    /** Canvas window subscribes to focus-this-artifact pings from main. */
    onFocus(cb: (id: string) => void): () => void;
  };
  /** AI auto-fix for broken artifacts. The main process calls the
   * underlying LLM directly (same readLlmEndpoint() bypass as paraphrase)
   * with a strict prompt: "here is broken {kind}, here is the error,
   * return ONLY the corrected raw body." Returns the corrected string
   * or null if the LLM was unreachable / returned junk. */
  artifactFix: {
    fix(input: { kind: string; body: string; error: string }): Promise<string | null>;
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
    paraphraseProbe: 'faceplate:hermes:paraphrase-probe',
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
    openSettings: 'faceplate:window:open-settings',
    quit: 'faceplate:window:quit',
    resizeBy: 'faceplate:window:resize-by',
    resetSize: 'faceplate:window:reset-size',
    raiseAvatar: 'faceplate:window:raise-avatar',
    openTypingBar: 'faceplate:window:open-typing-bar',
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
  },
  themes: {
    list: 'faceplate:themes:list',
    load: 'faceplate:themes:load',
  },
  events: {
    publish: 'faceplate:events:publish',
    broadcast: 'faceplate:events:broadcast',
  },
  notify: {
    show: 'faceplate:notify:show',
    clicked: 'faceplate:notify:clicked',
    replied: 'faceplate:notify:replied',
  },
  agentPush: {
    /** main → renderer broadcast: a Hermes plugin frame arrived. */
    received: 'faceplate:agent-push:received',
    /** renderer → main: lifecycle status query. */
    status: 'faceplate:agent-push:status',
    /** renderer → main: dry-run preview of an install. */
    installPreview: 'faceplate:agent-push:install-preview',
    /** renderer → main: copy plugin + append env vars + generate key. */
    install: 'faceplate:agent-push:install',
  },
  platform: {
    accessibilityTrusted: 'faceplate:platform:accessibility-trusted',
    relaunch: 'faceplate:platform:relaunch',
    openDevTools: 'faceplate:platform:open-devtools',
    openExternal: 'faceplate:platform:open-external',
  },
  typingBar: {
    submit: 'faceplate:typing-bar:submit',
    cancel: 'faceplate:typing-bar:cancel',
    opened: 'faceplate:typing-bar:opened',
    dispatch: 'faceplate:typing-bar:dispatch',
  },
  conversations: {
    list: 'faceplate:conversations:list',
    load: 'faceplate:conversations:load',
    getActive: 'faceplate:conversations:get-active',
    create: 'faceplate:conversations:create',
    setActive: 'faceplate:conversations:set-active',
    saveActive: 'faceplate:conversations:save-active',
    updateTitle: 'faceplate:conversations:update-title',
    archive: 'faceplate:conversations:archive',
    delete: 'faceplate:conversations:delete',
    search: 'faceplate:conversations:search',
    exportMarkdown: 'faceplate:conversations:export-markdown',
    togglePanel: 'faceplate:conversations:toggle-panel',
    activeChanged: 'faceplate:conversations:active-changed',
    changed: 'faceplate:conversations:changed',
  },
  artifacts: {
    list: 'faceplate:artifacts:list',
    get: 'faceplate:artifacts:get',
    create: 'faceplate:artifacts:create',
    delete: 'faceplate:artifacts:delete',
    resolveUrl: 'faceplate:artifacts:resolve-url',
    download: 'faceplate:artifacts:download',
    openCanvas: 'faceplate:artifacts:open-canvas',
    updateBody: 'faceplate:artifacts:update-body',
    changed: 'faceplate:artifacts:changed',
    focus: 'faceplate:artifacts:focus',
  },
  artifactFix: {
    fix: 'faceplate:artifact-fix:fix',
  },
} as const;
