# HermesAgent Faceplate — Requirements & Design (`DESIGN.md`)

> Status: Draft v0.1 — engineering design doc
> Audience: Senior engineer (self / small team), 2–3 weekend implementation budget
> Stack pre-decided: Quasar v2 + Vue 3 + TypeScript + Electron (desktop), Capacitor (future mobile)
> Companion repo target path: `/DESIGN.md`

---

## 1. Project Overview, Goals & Non-Goals

### 1.1 What is the HermesAgent Faceplate?

The HermesAgent Faceplate is a lightweight desktop **avatar overlay** that gives the Nous Research [`hermes-agent`](https://github.com/NousResearch/hermes-agent) — an autonomous, multi-platform AI agent with persistent memory, skills, and a built-in OpenAI-compatible API server on port `8642` — a **face, a voice, and a microphone**. It is a thin client: the agent's brain stays exactly where it lives today (`hermes gateway`, talking to whatever LLM the user has configured via `hermes model`). The Faceplate adds:

- A small, transparent, always-on-top SVG avatar with a 6-viseme mouth state machine driven by Web Audio API amplitude analysis.
- A speech pipeline (TTS out, STT in, optional wake-word) that defaults to a local Docker sidecar but can also point at any OpenAI-compatible audio endpoint.
- A spawnable typing bar (`Cmd/Ctrl+Space`), push-to-talk hotkey, and a tray menu for show/hide, monitor cycle, replay, and settings.
- A **paraphrase pass** that shortens long agent responses for spoken delivery, executed against the same LLM endpoint that hermes-agent itself uses (discovered by reading hermes-agent's `~/.hermes/config.yaml`).

### 1.2 Goals

1. **Faceplate is a "dumb terminal."** All cognition lives in hermes-agent. The Electron app renders, animates, captures audio, and routes events. It does not store conversation state independently; hermes-agent's session DB is canonical.
2. **CPU-only must work, end-to-end.** The default Docker bundle ships CPU-friendly TTS/ASR (Piper + faster-whisper int8 / Moonshine ONNX) so the app runs on any laptop. GPU paths are tiers above the floor, not requirements.
3. **OpenAI-compatible everywhere.** Every external endpoint the Faceplate touches — hermes-agent's chat completions, the bundled TTS/ASR sidecar, the paraphrase fallback — speaks the OpenAI schema. No bespoke wire formats.
4. **Visible, swappable avatar.** SVG-only v1, JSON-manifested themes, deterministic viseme schedule, no proprietary 3D dependency.
5. **Two-to-three weekend implementable.** No exotic native modules; models live out-of-process inside the sidecar container; the Electron tree is mostly TypeScript and Vue.
6. **Don't paint ourselves into a corner for mobile.** Electron `main`/`preload`/`renderer` boundaries mirror Capacitor's plugin/web split so a mobile target later is mostly a glue exercise.

### 1.3 Non-Goals (v1)

- Multi-agent orchestration. One Faceplate, one hermes-agent gateway. (Multiple agents → v2.)
- 3D / VRM avatars. SVG only in v1. (VRM → v2 roadmap.)
- Built-in LLM. We never ship a chat model; we always reuse hermes-agent's configured one and only ship a tiny *paraphrase fallback* model (≤2 B parameters).
- Modifying hermes-agent itself. The integration is strictly external — config file read, OpenAI API client, optional `pre_llm_call`/`post_llm_call` shell hook for richer event taps.
- Voice cloning, mic-always-on by default, telemetry, or any cloud-required path. All defaults are local and opt-in.

---

## 2. User Stories

| ID | As a… | I want… | So that… |
|----|------|---------|---------|
| US-1 | Knowledge worker | A small floating face on my desktop that stays out of the way until I summon it | I can talk to hermes-agent without alt-tabbing to a terminal |
| US-2 | User on a laptop with no GPU | The default install to work without a GPU | I'm not blocked by hardware |
| US-3 | Power user | To press `Cmd/Ctrl+Space`, type a question, and get a spoken answer back | I can stay on the keyboard |
| US-4 | Privacy-aware user | Push-to-talk by default, no mic-always-on unless I opt in | I trust the app |
| US-5 | Hands-free user | An opt-in wake word ("Hey Hermes") | I can talk while cooking, driving the mouse, etc. |
| US-6 | Agent operator | Long agent responses to be paraphrased for speech but the full transcript visible in captions | Speech is fast, screen text is complete |
| US-7 | Theme tinkerer | A "test mode" that exercises every viseme + every state | I can build new themes without running a full agent loop |
| US-8 | Multi-monitor user | A hotkey to cycle the avatar between monitors | The avatar lives on whichever screen I'm using |
| US-9 | User mid-sentence | An interrupt key that stops TTS and lets me redirect the agent | I can barge in like a human conversation |
| US-10 | Reviewer | A "replay last response" hotkey | I can hear what I missed |
| US-11 | Distro author | A single Docker image that exposes OpenAI-compatible TTS/ASR/wake/fallback | Deployment is one `docker compose up` |
| US-12 | Wayland Linux user | An honest fallback when click-through-transparent isn't supported | The app degrades gracefully |

---

## 3. System Architecture

```
                            ┌─────────────────────────────────────────────────┐
                            │                       USER                     │
                            └──────┬────────────────────────────────┬─────────┘
                                   │ mic / keys                     │ ears / eyes
                                   ▼                                ▲
   ┌──────────────────────────────────────────────────────────────────────────────────┐
   │                           HermesAgent Faceplate (Electron)                       │
   │                                                                                  │
   │  ┌───────────────────────┐  IPC   ┌──────────────────────────────────────────┐  │
   │  │  Main process         │◄──────►│ Renderer (Vue 3 + Quasar + Pinia)        │  │
   │  │  • tray icon          │        │ • Avatar SVG + viseme driver             │  │
   │  │  • globalShortcut     │        │ • Audio pipeline (Web Audio Analyser)    │  │
   │  │  • BrowserWindow      │        │ • Captions overlay                       │  │
   │  │    (transparent,      │        │ • Settings GUI                           │  │
   │  │    always-on-top,     │        │ • Typing bar (Cmd/Ctrl+Space spawn)      │  │
   │  │    click-through      │        └──────────────────┬───────────────────────┘  │
   │  │    toggle)            │                           │ WebSocket / fetch         │
   │  │  • multi-monitor      │                           ▼                           │
   │  │  • auto-update        │     ┌──────────────────────────────────────────┐     │
   │  │  • config IO          │     │ Event Bus / Adapter (TypeScript)         │     │
   │  └──────────┬────────────┘     │ • subscribes to hermes lifecycle events  │     │
   │             │                  │ • normalises to FaceplateEvent schema    │     │
   │             ▼                  └──┬───────────────────────────────────┬───┘     │
   │  ┌──────────────────┐              │                                   │         │
   │  │ Preload (typed   │              │ HTTP/WS                          │ HTTP    │
   │  │ IPC bindings)    │              │                                   │         │
   │  └──────────────────┘              ▼                                   ▼         │
   └──────────────────────────────────────────────────────────────────────────────────┘
                                       │                                   │
                                       │                                   │
              ┌────────────────────────┴────────┐         ┌────────────────┴─────────────────┐
              │  hermes-agent gateway           │         │  Faceplate Speech Sidecar         │
              │  (NousResearch/hermes-agent)    │         │  (Docker, OpenAI-compatible)      │
              │                                 │         │                                   │
              │  • OpenAI API server :8642      │         │  • /v1/audio/transcriptions  (ASR)│
              │    /v1/chat/completions         │         │  • /v1/audio/speech          (TTS)│
              │    /v1/responses                │         │  • /wake                     (WW) │
              │    /v1/runs (SSE)               │         │  • /v1/chat/completions  (parafall)│
              │    /v1/runs/{id}/events         │         │  • /health                        │
              │  • shell hooks (pre/post_llm)   │         │  • /v1/models                     │
              │  • ~/.hermes/config.yaml        │         │                                   │
              │  • ~/.hermes/.env               │         │  Image variants:                  │
              │  • SQLite session DB            │         │  • :cpu  (default, no CUDA)       │
              │                                 │         │  • :cuda (8 GB+ VRAM)             │
              └────────────┬────────────────────┘         └──────────────┬────────────────────┘
                           │ HTTP                                        │
                           ▼                                             │
              ┌──────────────────────────────┐                            │
              │  External LLM (provider)     │◄───────── paraphrase ─────┘
              │  configured by `hermes model`│           (when reachable)
              │  e.g. OpenRouter, Nous       │
              │  Portal, Ollama, vLLM, …     │
              └──────────────────────────────┘
```

Key invariants:

- **Faceplate never talks to the LLM directly for the conversation itself.** All user turns flow through hermes-agent so memory, skills, and tool calls work as designed. Faceplate only talks to the LLM directly for the *paraphrase pass*, reusing whatever endpoint hermes-agent reads from `config.yaml`.
- **The Speech Sidecar is optional.** If the user already runs Whisper/Piper elsewhere, they paste a URL into Settings and the bundled container is skipped.
- **The Event Bus is the only place that knows about hermes-agent's wire format.** Renderer and main process see normalised `FaceplateEvent`s.

---

## 4. Component Breakdown

### 4.1 Electron Main process (`src-electron/electron-main.ts`)

Responsibilities:

- Create the `BrowserWindow` (`transparent: true`, `frame: false`, `alwaysOnTop: true`, `hasShadow: false`, `skipTaskbar: true`, `backgroundColor: '#00000000'`, `webPreferences: { sandbox: true, contextIsolation: true, preload }`).
- On macOS: `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, `win.setWindowButtonVisibility(false)`, panel-style window via `BaseWindow` `type: 'panel'` semantics where possible.
- Toggle click-through with `win.setIgnoreMouseEvents(ignore, { forward: true })`. The renderer reports per-pixel hit testing of the avatar bounding circle and posts `setIgnoreMouseEvents` decisions through IPC (this is the standard "polling-on-mousemove via `forward: true`" pattern, since Electron transparent windows do not click-through transparent regions automatically — see `electron/electron#1335`, still-open as of mid-2026).
- Register global shortcuts via `globalShortcut.register`:
  - `CommandOrControl+Space` (typing bar, configurable) — only registered if not already taken; falls back to `CommandOrControl+Alt+Space`.
  - PTT, captions toggle, monitor cycle, show/hide, replay, interrupt — all user-rebindable.
- Tray icon (`Tray`) with menu: Show/Hide, Push-to-talk on/off, Wake-word on/off, Captions, Settings, Quit.
- Multi-monitor cycle: `screen.getAllDisplays()` → cycle index → `win.setBounds()`.
- Spawn / monitor the optional Docker sidecar via `child_process` (`docker compose up -d` from a bundled compose file in `resources/sidecar/`).
- Auto-update via `electron-updater` (`provider: github` or `generic`).
- IPC bridge for: read/write Faceplate settings, read hermes-agent `config.yaml`, fire test events.

Wayland note: On Linux/Wayland, `alwaysOnTop`, programmatic move/resize, and `transparent` are flaky — Electron docs explicitly warn that "it is generally not possible to programmatically resize windows after creation, or to position, move, focus, or blur windows without user input" on Wayland. Mitigations:

1. Detect Wayland (`process.env.XDG_SESSION_TYPE === 'wayland'`) and surface a warning in the tray ("Running under Wayland — overlay features may be limited").
2. Offer an opt-in flag that re-launches under Xwayland: `app.commandLine.appendSwitch('ozone-platform', 'x11')` (set on main process before `app.whenReady()` if user enables "Force X11 (Linux)" in Settings).
3. If neither works, fall back to a regular bordered window mode where the avatar is a normal Quasar app window and the click-through illusion is dropped. Document this clearly.

### 4.2 Preload (`src-electron/electron-preload.ts`)

Exposes a single typed object via `contextBridge.exposeInMainWorld('faceplate', api)`:

```ts
// preload.d.ts
export interface FaceplatePreload {
  settings: {
    get(): Promise<FaceplateSettings>;
    set(patch: Partial<FaceplateSettings>): Promise<void>;
    onChange(cb: (s: FaceplateSettings) => void): () => void;
  };
  hermes: {
    discoverConfig(): Promise<HermesDiscovery>;
    testConnection(target: 'agent' | 'llm' | 'tts' | 'asr' | 'paraphrase'): Promise<TestResult>;
  };
  window: {
    setClickThrough(enabled: boolean): Promise<void>;
    cycleMonitor(): Promise<void>;
    showHide(state?: 'show' | 'hide' | 'toggle'): Promise<void>;
  };
  hotkeys: {
    register(name: HotkeyName, accelerator: string): Promise<boolean>;
    unregister(name: HotkeyName): Promise<void>;
    onPress(cb: (name: HotkeyName) => void): () => void;
  };
  audio: {
    listInputDevices(): Promise<MediaDeviceInfo[]>;
    listOutputDevices(): Promise<MediaDeviceInfo[]>;
  };
  sidecar: {
    status(): Promise<SidecarStatus>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}
```

The preload is the **only** file that imports `electron`. Renderer imports nothing from `node_modules/electron`; Capacitor port replaces this preload with a Capacitor plugin shim that satisfies the same interface.

### 4.3 Renderer (Vue 3 + Quasar + Pinia)

Folder layout (Quasar v2 conventions; `quasar.config.ts` is the source of truth):

```
hermes-faceplate/
├── package.json
├── quasar.config.ts
├── electron-builder.yml          # for `quasar build -m electron --bundler builder`
├── src/
│   ├── App.vue
│   ├── boot/
│   │   ├── faceplate-api.ts      # types & registration of window.faceplate
│   │   ├── pinia.ts              # auto-generated by Quasar
│   │   └── event-bus.ts          # opens WS to hermes, fans out FaceplateEvents
│   ├── stores/
│   │   ├── settings.ts           # mirrored to disk via IPC
│   │   ├── agent.ts              # state machine: idle|listening|thinking|speaking|error
│   │   ├── conversation.ts       # captions + transcript ring buffer
│   │   └── theme.ts              # active manifest, viseme map
│   ├── components/
│   │   ├── Avatar.vue            # SVG host, viseme animation
│   │   ├── VisemeMouth.vue       # the SVG <g> swapped per viseme
│   │   ├── StateRing.vue         # outer halo color/animation per state
│   │   ├── Captions.vue          # bottom-screen subtitle band
│   │   ├── TypingBar.vue         # Cmd/Ctrl+Space spawn target
│   │   └── TestMode.vue          # cycles all visemes/states/themes
│   ├── pages/
│   │   ├── OverlayPage.vue       # the only page on the transparent window
│   │   └── SettingsPage.vue      # opened in a separate, normal BrowserWindow
│   ├── audio/
│   │   ├── analyser.ts           # Web Audio AnalyserNode → amplitude → spring
│   │   ├── viseme-driver.ts      # amplitude + phoneme hints → viseme schedule
│   │   ├── tts-client.ts         # OpenAI /v1/audio/speech client (streaming)
│   │   ├── asr-client.ts         # OpenAI /v1/audio/transcriptions client
│   │   └── wake-client.ts        # WS to /wake on the sidecar
│   ├── hermes/
│   │   ├── hermes-client.ts      # OpenAI client pointed at :8642 + run SSE
│   │   ├── paraphrase.ts         # uses hermes-agent's LLM endpoint reused
│   │   └── event-schema.ts       # the TS interfaces in §8
│   └── router/                   # Quasar default
└── src-electron/
    ├── electron-main.ts
    ├── electron-preload.ts
    ├── tray.ts
    ├── window.ts                 # transparent overlay + settings window factories
    ├── shortcuts.ts
    ├── sidecar.ts                # docker compose lifecycle
    └── update.ts                 # electron-updater wiring
```

### 4.4 Avatar Engine

- **Renderer**: a single `<svg>` with at minimum a `<g id="head">` and a `<g id="mouth-slot">`. The `mouth-slot` is replaced at frame time by the active viseme `<g>` from the loaded theme manifest.
- **State ring**: a stroked circle behind the head whose `stroke`, `stroke-dasharray`, and animation are derived from the agent state machine. Default palette:
  - `idle` — soft grey, gentle 4 s pulse.
  - `listening` — saturated cyan, "breathing" 2 s pulse, mic glyph fade-in.
  - `thinking` — amber, rotating dashed arc.
  - `speaking` — green, no pulse (movement carried by the mouth).
  - `error` — red, single 200 ms shake then steady.

### 4.5 Viseme Driver

Following the standard 6-shape reduction (an industry-common compression of the ~40 English phonemes; Disney's classic 12 → 6 simplification works well for stylised SVGs and matches the broad "8–12 visemes is standard" consensus in animation literature):

| Code | Mouth shape | Phonemes (rough) | Trigger source |
|------|-------------|------------------|----------------|
| `A` | Wide open | /a/, /æ/, /ɑ/ | Amplitude > T_high |
| `B` | Mid open, neutral | /e/, /ɛ/, /ʌ/ | T_mid ≤ amp ≤ T_high |
| `C` | Lips rounded | /o/, /u/, /w/ | T_low ≤ amp < T_mid + low-frequency dominance (FFT bin 0–500 Hz heavy) |
| `D` | Wide-thin smile | /i/, /ɪ/, /j/ | Mid-band dominance |
| `E` | Lips closed | /m/, /b/, /p/ | Sub-threshold amp + transient detection |
| `F` | Lower-lip-on-teeth | /f/, /v/ | High-frequency hiss + low amplitude |
| `X` | Silence | — | amp < T_silence for ≥ 80 ms |

Because we are generally **not** parsing phonemes (TTS endpoints rarely return them), the v1 driver is purely amplitude- and FFT-band-driven, with optional phoneme hints if the chosen TTS exposes them (e.g. Kokoro-FastAPI's word-timestamp feature, or Piper's eSpeak phonemizer if we run it in-tree).

```ts
// audio/viseme-driver.ts (sketch)
export function drive(node: AnalyserNode, onViseme: (v: VisemeCode) => void) {
  const buf = new Uint8Array(node.fftSize);
  const freq = new Uint8Array(node.frequencyBinCount);
  let openness = 0; // spring-physics value 0..1
  const k = 18, c = 6; // spring constants

  function tick() {
    node.getByteTimeDomainData(buf);
    node.getByteFrequencyData(freq);
    const amp = rms(buf);
    const lo = avg(freq, 0, 8);    // ~0–500 Hz
    const mid = avg(freq, 8, 32);  // ~500 Hz–2 kHz
    const hi = avg(freq, 64, 128); // ~4 kHz+
    // spring towards target derived from amp
    const target = clamp01(amp * 4);
    const a = k * (target - openness) - c * /*velocity*/ 0;
    openness += a * (1 / 60);
    const v = classify(openness, lo, mid, hi); // returns A..F or X
    onViseme(v);
    requestAnimationFrame(tick);
  }
  tick();
}
```

Visemes are mapped to SVG fragments via the theme manifest (§9).

### 4.6 Audio Pipeline

```
mic → MediaStream → (PTT gate) → MediaRecorder → POST /v1/audio/transcriptions
                                                         │
                                                         ▼ partial text
                                          POST /v1/chat/completions  (hermes-agent :8642)
                                                         │
                                                         ▼ assistant text (streamed)
                                          [optional paraphrase] (LLM, same as hermes')
                                                         │
                                                         ▼ shortened text
                                          POST /v1/audio/speech (stream=true, response_format=pcm)
                                                         │
                                                         ▼ ArrayBuffer chunks
                                          decoded by AudioContext → AnalyserNode → speakers
                                                                              │
                                                                              ▼
                                                                        viseme driver
```

Barge-in: any of (PTT key down, wake-word fired, click on avatar with click-through off, "Stop" tray item) calls `audioCtx.suspend()` + aborts the TTS HTTP stream + sends `POST /v1/runs/{id}/stop` to hermes-agent (or `DELETE` on the active stream). Clears caption tail.

### 4.7 Settings store (Pinia, mirrored to disk)

Settings are persisted to `~/.config/hermes-faceplate/settings.json` (XDG on Linux, `app.getPath('userData')` everywhere). Structure in §8 / §9.

---

## 5. HermesAgent Integration Spec

This is the load-bearing section. Findings below are derived from hermes-agent's public docs and source as of v0.12.x (April 2026).

### 5.1 What hermes-agent actually exposes

- **Config**: YAML at `~/.hermes/config.yaml`. The schema is large and version-evolving; the keys we depend on are `model.default`, `model.provider`, `model.base_url`, `model.api_key` (and via `.env`: provider-specific `*_API_KEY`s). For platform sub-configs the project uses a quirky `extra:` nesting (see issue [#10206](https://github.com/NousResearch/hermes-agent/issues/10206)) — top-level platform keys are silently dropped if not nested under `extra:`. We do not write to this file; we only read it.
- **API server**: OpenAI-compatible server on **`127.0.0.1:8642`**, gated on `API_SERVER_ENABLED=true` in `~/.hermes/.env` plus `API_SERVER_KEY=…` for bearer auth. Endpoints:
  - `POST /v1/chat/completions` (streamed via SSE)
  - `POST /v1/responses`
  - `GET /v1/models`
  - `POST /v1/runs` + `GET /v1/runs/{id}/events` (SSE) + `POST /v1/runs/{id}/stop`
  - `GET /health`, `GET /v1/health`, `GET /v1/capabilities`
  This is the cleanest tap point we have. Streaming responses include incremental tool-call indicators so the UI can show "💻 ls -la" or similar.
- **Hooks**: shell-script lifecycle hooks declared in `config.yaml` under `hooks:` — `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `subagent_stop`. Each hook gets a JSON payload on stdin and may return JSON on stdout. There is no native event WebSocket.
- **Webhook adapter**: hermes-agent has a webhook *inbound* adapter (`platforms.webhook.extra.routes`), but it triggers agent runs from external HTTP POSTs. It's not a useful event-out tap.
- **Plugins**: full Python plugin surface registering hooks and CLI subcommands. Out of scope for v1 (we don't want to bind ourselves to Python).

### 5.2 Honest assessment

> hermes-agent does **not** ship a native, structured event-stream WebSocket for external clients. The closest things are (a) the `/v1/runs/{id}/events` SSE on the API server and (b) shell hooks that invoke arbitrary scripts at lifecycle points.

This means the Faceplate must construct its own event stream from these primitives. We propose three integration strategies and pick one.

### 5.3 Three integration strategies

| Strategy | How it works | Pros | Cons |
|----------|--------------|------|------|
| **A. SSE-only client** (recommended for v1) | Faceplate calls `POST /v1/runs` for each turn and subscribes to `/v1/runs/{id}/events`. State transitions are inferred client-side from event types (`token`, `tool_call`, `final`, `error`). | Zero installation on the agent side. Works with stock hermes-agent. Survives `hermes update`. | Per-turn bound; no observability of background cron, kanban, or messaging-platform turns. |
| **B. Shell-hook bridge** | A small Bash script `hermes-faceplate-hook.sh` is added to `~/.hermes/config.yaml` under `pre_llm_call`, `post_llm_call`, `on_session_start`, `on_session_end`. It POSTs the JSON payload to a local endpoint (`http://127.0.0.1:51789/hook`) the Faceplate listens on. | Captures every agent turn regardless of platform (Telegram, cron, CLI, etc.). Simple. Officially supported extension point. | Requires writing one line into `config.yaml` (with consent prompt — see [hooks consent model](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)). One-time per machine. Hook output payload may not include final assistant text on `post_llm_call` for non-streaming providers. |
| **C. Sidecar proxy** | Faceplate stands up a tiny FastAPI proxy that re-exposes hermes-agent's `:8642` on `:8642p`, mirroring requests/responses to a WebSocket the renderer subscribes to. User points hermes' messaging gateway to itself; Faceplate sees everything. | Full bidirectional visibility. Could also enforce per-channel auth. | Significant complexity. Risk of breaking when upstream API changes. Not worth it for v1. |

**Decision**: Default to **A**, with **B** offered as an opt-in checkbox in Settings ("Enable system-wide event tap (writes one line to ~/.hermes/config.yaml)") for users who want their Telegram/Slack turns voiced too. **C** is explicitly v2.

### 5.4 Config discovery flow (Faceplate side)

```
on app start:
  hermesHome = $HERMES_HOME ?? ~/.hermes
  cfg = readYaml(hermesHome/config.yaml)
  env = parseDotenv(hermesHome/.env)   # for API_SERVER_KEY
  llmEndpoint = {
    base_url: cfg.model.base_url ?? defaultForProvider(cfg.model.provider),
    api_key: cfg.model.api_key ?? env[providerKeyName(cfg.model.provider)],
    model:   cfg.model.default
  }
  agentEndpoint = {
    base_url: `http://${env.API_SERVER_HOST ?? '127.0.0.1'}:${env.API_SERVER_PORT ?? '8642'}/v1`,
    api_key: env.API_SERVER_KEY
  }
  if !env.API_SERVER_ENABLED: surface a "Setup wizard: enable the hermes API server"
```

The Settings GUI shows discovered values pre-filled, with **Test connection** buttons that hit `/v1/models` and `/v1/chat/completions` (for the LLM) and `/health` (for the agent), and the ASR/TTS endpoints similarly.

### 5.5 Recommended event schema

See §8.

---

## 6. Speech Stack — Recommended Models per Tier

All numbers below are from the cited public sources (HF Open ASR Leaderboard, model cards, vendor benchmarks). Where conflicts existed I noted them.

### 6.1 ASR comparison

| Model | Params | Avg WER (Open ASR) | RTFx | Streaming | Languages | License | CPU-friendly | Notes |
|-------|-------:|-------------------:|-----:|:---------:|:---------:|---------|:------------:|-------|
| **Moonshine v2 Base** | 27 M | ~10–11% (En) | very fast (~50 ms TTFT Tiny, fixed via SWA) | ✅ native | En only | MIT | ✅✅ | Edge-built; ~5–43× faster than Whisper at matched accuracy. |
| **whisper.cpp** (large-v3 q5) | 1.5 B | 7.44% | 146 (RTFx, GPU); CPU varies | partial | 99 | MIT | ✅ | Reference CPU runner; q5 ~2 GB RAM. |
| **faster-whisper (CT2)** large-v3 | 1.5 B | 7.44% | up to 4× over `openai/whisper`; int8 ~1.5 GB RAM | ✅ via batched pipeline | 99 | MIT | ✅ | int8 CPU is the safe default. ~52 s for 13-min audio on i7-12700K (8 threads). |
| **distil-whisper-large-v3.5** | ~756 M | 7.21% | 202 | ✅ | 1 (En) | MIT | ✅ | ~50% Whisper's params, +~1% WER. |
| **NVIDIA Parakeet-TDT 0.6B v3** | 600 M | ~6.34% (multilingual) | 749+ (Canary 1B v2 reference); v3 similar high throughput | ✅ via NeMo / ONNX | 25 EU langs | CC-BY-4.0 | ⚠️ ONNX INT8 CPU works (community FastAPI port), GPU recommended | Currently top of multilingual track. |
| **NVIDIA Canary-Qwen 2.5B** | 2.5 B | **5.63%** (top of leaderboard for English short-form) | slower (LLM decoder) | ❌ | En + analysis modes | CC-BY-4.0 | ❌ GPU only realistically | Best accuracy if you have a GPU. |
| **IBM Granite 4.1 2B** | ~2 B | **5.33%** (mean Open ASR, Apr 2026) | normal AR | partial | En, Fr, De, Es, Pt, Ja | Apache 2.0 | ⚠️ feasible on CPU but slow | Punctuation, capitalization, KW-biasing. |
| **IBM Granite 4.1 2B-NAR** | ~2 B | similar | **RTFx ~1820** on H100 (batch 128) | ❌ | 5 langs (no Ja) | Apache 2.0 | ❌ GPU | Non-autoregressive editing of CTC hypothesis. |
| **Voxtral Mini 4B Realtime** | 4 B | competitive on FLEURS | <500 ms streaming, configurable down to 240 ms | ✅✅ native | 13 (En, Zh, Hi, Es, Ar, Fr, Pt, Ru, De, Ja, Ko, It, Nl) | Apache 2.0 | ⚠️ 16 GB+ for vLLM bf16; CPU via `voxtral.c` (slow) | Best streaming UX, needs ~16 GB GPU memory. |
| **Voxtral Mini Transcribe V2 (API)** | 3 B | "lowest WER claimed" by Mistral | ~$0.003/min | n/a | 13 | API only | n/a | Closed weights; included for completeness. |
| **Qwen2-Audio** | 8 B | n/a (not on leaderboard) | n/a | ❌ | 8 | Apache 2.0 (weights) | ❌ | Audio-LLM, more useful for QA-from-audio than pure ASR. |
| **wav2vec2 / SeamlessM4T** | varies | wav2vec2 baseline only ranks ~52nd; SeamlessM4T is broader speech-to-anything | varies | partial | 1k+ (MMS) | varies (Seamless: CC-BY-NC for v2) | ⚠️ | Mostly relevant if many languages matter more than English WER. |

**Recommendations:**

| Tier | Pick | Why |
|------|------|-----|
| **CPU-only floor** (default) | **faster-whisper `small` int8** *or* **Moonshine Base ONNX** | small-int8 weighs ~480 MB, runs ~2× real-time on a modern x86 CPU, supports 99 languages. Moonshine Base is faster and English-only — good for laptops and edge. The Docker image will let users pick. |
| **4 GB VRAM** | **faster-whisper `large-v3-turbo` fp16** | ~3.5 GB VRAM, Open ASR ~7.4% WER, and the de-facto standard wrapped by many OpenAI-compatible servers (`fedirz/faster-whisper-server`, etc.). |
| **6 GB+ VRAM** | **NVIDIA Parakeet-TDT 0.6B v3 (multilingual) or Granite 4.1 2B (best WER/ratio)** | Both fit, both have community OpenAI-compatible wrappers. Pick Parakeet for highest throughput/multilingual; Granite for highest single-model quality at this size. |
| **Streaming-first** | **Voxtral Realtime 4B** (16 GB+ class GPUs) or **Moonshine v2 Streaming** (CPU) | Configurable sub-500 ms latency. |

### 6.2 TTS comparison

| Model | Params | Latency / RTF | Streaming | Cloning | Languages | License | CPU-friendly | Notes |
|-------|-------:|---------------|:---------:|:-------:|:---------:|---------|:------------:|-------|
| **Piper** | ~20 MB / voice | extremely fast (real-time on Pi) | ✅ chunked | ❌ | 35 | MIT | ✅✅✅ | The CPU floor. Voices included via `rhasspy/piper-voices`. |
| **Kokoro-82M** | 82 M | RTF ~0.03 on A100; <2 GB VRAM; runs on CPU | ✅ via Kokoro-FastAPI / Kokoros (Rust) | ❌ | 8 | Apache 2.0 | ✅ | Best quality-per-size; OpenAI-compatible Docker image (`ghcr.io/remsky/kokoro-fastapi-cpu`) is the easiest path. |
| **Coqui XTTS-v2** | ~750 M | RTF ~0.2 on GPU | partial | ✅ (6 s sample) | 17 | CPML (commercial-restricted; original company shut down, community-maintained) | ⚠️ | Voice cloning if you need it. License is murky for redistribution. |
| **F5-TTS** | ~330 M | sub-7 s on 200-word inputs | ❌ (diffusion) | ✅ zero-shot | 1 → cross-lingual via forks | MIT (code) | ⚠️ | Excellent quality; flow-matching DiT. Hallucinates >1000 chars. |
| **StyleTTS2** | ~150 M | very fast | partial | partial | En | MIT | ✅ | Mature; widely deployed before Kokoro. |
| **Parler-TTS** | varies (mini ~880 M) | moderate | partial | ✅ via natural-language voice spec | En | Apache 2.0 | ⚠️ | Voice control via prompts. |
| **MeloTTS** | ~52 M | very fast | partial | ❌ | 5 | MIT | ✅ | Good CPU multilingual baseline. |
| **OpenVoice v2** | small | fast | ✅ | ✅ | many | MIT | ✅ | Lightweight cloning. |
| **Mars5** | mid | moderate | ❌ | ✅ | En | AGPL | ⚠️ | AGPL — careful if you ship commercially. |
| **Chatterbox** | 0.5 B (Llama-based) | fast | ✅ | ✅ | En | MIT | ⚠️ (smaller GPU OK) | Reportedly beats ElevenLabs in blind A/B at 63.75% preference (Resemble AI benchmark). Quality leader among open. |
| **Qwen3-TTS** | 0.6 B / 1.7 B | first packet ~97 ms; streaming | ✅ | ✅ | 10 | Apache 2.0 | ⚠️ GPU recommended | Strong streaming TTS; OpenAI-compatible community wrappers. |
| **Orpheus-3B** | 3 B | needs llama.cpp host | ✅ | ✅ | many | varies | ⚠️ | LLM-style TTS via Llama backbone. |

**Recommendations:**

| Tier | Pick | Why |
|------|------|-----|
| **CPU-only floor** (default) | **Piper** (`en_US-amy-medium` default voice) | Real-time on Raspberry Pi 4. Tiny models (~20–60 MB). ONNX runtime. Trivial to embed. |
| **CPU "premium"** | **Kokoro-82M via Kokoro-FastAPI CPU** | Order-of-magnitude better naturalness than Piper, still runs on CPU at acceptable latency, OpenAI-compatible out of the box. |
| **4 GB VRAM** | **Kokoro-82M (GPU build)** | RTF ~0.03 on consumer cards; this is the sweet spot. |
| **6 GB+ VRAM (cloning desired)** | **Chatterbox** *or* **F5-TTS** | Chatterbox if highest naturalness preferred; F5-TTS if Apache-2.0-style code license matters and you want zero-shot cloning. |
| **Streaming-first** | **Qwen3-TTS** or **Kokoros (Rust)** | Both deliver sub-second time-to-first-audio. |

### 6.3 Wake-word comparison

| Engine | License | Custom WW | Quality (FRR @ 1 FA/h) | Latency | Notes |
|--------|---------|-----------|------------------------|---------|-------|
| **openWakeWord** | Apache 2.0 | ✅ (synthetic Piper-generated training) | comparable to Porcupine at default models; community reports it edges Porcupine on the prepared "Alexa" set | low (RPi 3 runs 15–20 models in real-time) | Default for HA. Safe for OSS shipping. |
| **Picovoice Porcupine** | Free tier requires AccessKey + ≤3 active users for personal/commercial small projects; enterprise-priced for production | ✅ via web console (no ML required) | published benchmark leader for English on Picovoice's own dataset | very low (runs on MCUs, 18 KB RAM) | Best DX, but the AccessKey + ≤3 user constraint blocks "ship to many users" without an enterprise deal. |
| **microWakeWord** | Apache 2.0 | ✅ | esp32-class | very low | Good for embedded; we don't need it. |
| **Mycroft Precise** | unmaintained | n/a | n/a | n/a | Skip. |
| **Snowboy** | archived 2022 | n/a | n/a | n/a | Skip. |
| **Pocketsphinx** | ancient | ✅ | weak | low | Skip. |

**Recommendation**: **openWakeWord** as default (Apache 2.0, no service dependency, good accuracy, runs on CPU); allow **Porcupine** as an opt-in plugin where the user supplies their own AccessKey via Settings. Default wake word: `"hey_hermes"` model trained via openWakeWord's Piper-synthetic pipeline (we ship a pre-trained model in the Docker image; users can drop their own `.onnx` into a mounted directory). Wake-word is **off by default**.

---

## 7. Docker Container Spec ("Faceplate Speech Sidecar")

### 7.1 Goals

- One image, two tags: `:cpu` (default) and `:cuda` (NVIDIA 8 GB+).
- Lazy-load models so cold start fits under ~1 GB resident if only one capability is used.
- All endpoints OpenAI-compatible.
- Health endpoint that reports per-model load status.
- Mountable model cache so re-pulls don't refetch weights.

### 7.2 Endpoints

| Method | Path | Spec | Notes |
|--------|------|------|-------|
| `POST` | `/v1/audio/transcriptions` | OpenAI Whisper-format multipart (`file`, `model`, `language`, `response_format`, `temperature`) | Returns `{text, segments?, language}`. Streaming via `stream=true` returns SSE chunks (mirroring `gpt-4o-mini-transcribe` shape) when supported by backend. |
| `POST` | `/v1/audio/speech` | OpenAI TTS format (`input`, `voice`, `model`, `response_format` ∈ {mp3, wav, opus, flac, pcm}, `speed`, `stream`) | When `stream=true`, returns chunked transfer-encoded PCM/MP3 chunks. |
| `WS`  | `/wake` | Bidirectional. Client sends 16 kHz mono PCM 16-bit chunks (frame size negotiated on connect). Server emits `{type:'wake', model, score, ts}` on detection and `{type:'silence'}` periodically. | openWakeWord backend. |
| `POST` | `/v1/chat/completions` | OpenAI chat-completions; only used as paraphrase fallback. | Routed to a tiny local LLM (see §7.5). Supports streaming. |
| `GET`  | `/v1/models` | OpenAI list-models | Reports loaded + available models. |
| `GET`  | `/health` | `{status, gpu, models: { tts: 'loaded'\|'idle', asr: '...', wake: '...', llm: '...' }, ram_mb, vram_mb}` | Used by Faceplate test buttons. |
| `GET`  | `/voices` | List of installed TTS voices | Convenience for Settings dropdown. |

### 7.3 Framework choice

**FastAPI + Uvicorn** as the HTTP shell — small, async, well-trodden by the community OpenAI-compatible servers we'd otherwise be cloning (`Kokoro-FastAPI`, `groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai`, `fedirz/faster-whisper-server`, etc.). Use `litellm` only if/when we want to chain multiple paraphrase LLM providers; for v1 the paraphrase route just calls the user's hermes-agent LLM directly when it's reachable, and only uses the in-container fallback model when it isn't.

### 7.4 Image variants

```
faceplate-sidecar:cpu     ~1.4 GB   no CUDA, ONNX Runtime CPU, faster-whisper int8, Piper, openWakeWord, Gemma 3 270M GGUF (paraphrase fallback)
faceplate-sidecar:cuda    ~5.5 GB   PyTorch + CUDA 12.4, faster-whisper fp16, Kokoro-FastAPI, openWakeWord, Phi-4 mini (paraphrase fallback)
```

### 7.5 Paraphrase fallback model recommendation

Constraint: ≤2 B params, sub-second on CPU, Apache-2.0 or comparable, English summarisation/paraphrase quality acceptable.

| Candidate | Params | License | CPU sub-second? | Notes |
|-----------|-------:|---------|:---------------:|-------|
| **Gemma 3 270M (instruct, INT4)** | 270 M | Gemma terms (commercial OK) | ✅ ~529 MB on disk; trivial CPU | Strong IFEval for size; explicit "specialise via fine-tune" framing fits paraphrase well. |
| **Qwen3 0.6B / 1.7B** | 0.6 B / 1.7 B | Apache 2.0 | ✅ at 0.6B; OK at 1.7B | Dual-mode (thinking/non-thinking). Strong multilingual. |
| **Phi-4-mini (instruct)** | 3.8 B | MIT | borderline; needs Q4 quant | Higher quality but overshoots the "tiny" bar; reserve for the CUDA image. |
| **SmolLM3-3B** | 3 B | Apache 2.0 | borderline | Fully open weights+data. Reserve. |
| **Llama 3.2 3B** | 3 B | Llama 3 license | borderline | Not v1 default. |

**Recommendation**: Ship **Gemma 3 270M IT (INT4 GGUF)** in the `:cpu` image as the default paraphrase fallback (~530 MB, sub-second on CPU, more than capable of "Summarise this in 25 words for spoken delivery"); ship **Qwen3 1.7B Q4** in the `:cuda` image for richer paraphrasing. The fallback only fires when hermes-agent's configured LLM is unreachable — which should be rare.

### 7.6 Auth model

- Single bearer token for all endpoints, set via env `FACEPLATE_API_KEY`. Generated by the Faceplate setup wizard if not provided. Stored in Faceplate settings + injected into the container on `docker compose up`.
- CORS: by default `http://localhost:*` only.

### 7.7 Volume mounts

```
- ./models:/models                # model cache (whisper, kokoro, piper voices, openWakeWord)
- ./voices:/voices                # user-supplied Piper/Kokoro voices
- ./wakewords:/wakewords          # user-supplied openWakeWord .onnx files
- ./config.yaml:/etc/faceplate-sidecar/config.yaml
```

### 7.8 Example sidecar config

```yaml
# config.yaml — Faceplate Speech Sidecar
auth:
  bearer_token: "${FACEPLATE_API_KEY}"
  cors_origins:
    - "http://localhost:9080"
    - "app://."        # Electron file://-style origin

asr:
  default_model: "faster-whisper-small.en"       # CPU floor
  models:
    - name: "faster-whisper-small.en"
      backend: "faster-whisper"
      compute_type: "int8"
      device: "cpu"
    - name: "faster-whisper-large-v3-turbo"
      backend: "faster-whisper"
      compute_type: "float16"
      device: "cuda"        # only loaded if CUDA available
    - name: "moonshine-base"
      backend: "moonshine-onnx"
      device: "cpu"

tts:
  default_model: "piper:en_US-amy-medium"
  models:
    - name: "piper:en_US-amy-medium"
      backend: "piper-onnx"
      voice_path: "/voices/en_US-amy-medium.onnx"
    - name: "kokoro:af_bella"
      backend: "kokoro"
      device: "auto"

wake:
  enabled: false
  backend: "openwakeword"
  models:
    - "/wakewords/hey_hermes.onnx"
  threshold: 0.5

paraphrase_fallback:
  enabled: true
  backend: "llama-cpp"
  model_path: "/models/gemma-3-270m-it-q4_k_m.gguf"
  max_tokens: 96
  temperature: 0.4

healthcheck:
  port: 8080
  path: "/health"
```

### 7.9 Health check

```http
GET /health
200 OK
{
  "status": "ok",
  "gpu": null,
  "models": {
    "asr.faster-whisper-small.en": "loaded",
    "tts.piper:en_US-amy-medium": "loaded",
    "wake.hey_hermes": "idle",
    "paraphrase.gemma-3-270m": "loaded"
  },
  "ram_mb": 612,
  "version": "0.1.0",
  "build": "cpu"
}
```

---

## 8. WebSocket Event Schema

The Faceplate exposes one internal event bus that the renderer subscribes to. The bus is fed by:

1. SSE from `hermes-agent` (`/v1/runs/{id}/events`)
2. (Optional) shell-hook bridge on `:51789`
3. Local audio pipeline events (TTS playback, ASR partials, wake fires)
4. UI events (hotkey presses, monitor cycle)

All events conform to a single discriminated union:

```ts
// hermes/event-schema.ts

export type FaceplateEventType =
  | 'state.transition'      // idle | listening | thinking | speaking | error
  | 'agent.thinking'        // first token / tool call started
  | 'agent.token'           // streaming token delta
  | 'agent.tool_call'       // tool call indicator
  | 'agent.response'        // final assistant message complete
  | 'agent.interrupt'       // we asked hermes to stop OR hermes acknowledged stop
  | 'agent.error'
  | 'user.input.text'       // typed via TypingBar
  | 'user.input.voice'      // ASR final transcript
  | 'user.input.partial'    // ASR partial
  | 'user.interrupt'        // PTT pressed mid-speak
  | 'user.wake'             // wake word fired
  | 'tts.audio.envelope'    // amplitude+freq frame for lip-sync
  | 'tts.audio.start'
  | 'tts.audio.chunk'       // base64 PCM (renderer-internal only; not crossed over IPC for perf)
  | 'tts.audio.end'
  | 'system.config_changed'
  | 'system.sidecar_status';

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface BaseEvent<T extends FaceplateEventType, P> {
  type: T;
  ts: number;                // epoch ms
  session_id?: string;       // hermes-agent session id when known
  turn_id?: string;          // synthetic turn id (uuid)
  payload: P;
}

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  reason?: string;
}

export interface AgentToken {
  delta: string;
  index: number;
  is_reasoning?: boolean;    // hermes-agent reasoning content
}

export interface AgentToolCall {
  tool: string;              // e.g. "terminal", "web_search"
  args_preview: string;      // 80-char preview, full args not surfaced
  status: 'started' | 'completed' | 'failed';
}

export interface AgentResponse {
  text: string;              // full final assistant message
  paraphrase?: string;       // shortened for TTS, when applicable
  finished_reason: 'stop' | 'length' | 'tool_call' | 'interrupt';
}

export interface UserInputText {
  text: string;
  source: 'typingbar' | 'tray' | 'api';
}

export interface UserInputVoice {
  text: string;
  language?: string;
  duration_ms: number;
  confidence?: number;
}

export interface UserInputPartial {
  text: string;
  is_final: false;
}

export interface UserWake {
  model: string;             // wake-word model name
  score: number;
}

export interface TtsAudioEnvelope {
  // 60 Hz frames of analyser data; renderer-only event, but defined here
  // so that an external client could replay it for remote avatar mirrors.
  amp: number;               // 0..1 RMS
  bands: [number, number, number, number]; // low, mid-low, mid, high
}

export type FaceplateEvent =
  | BaseEvent<'state.transition', StateTransition>
  | BaseEvent<'agent.thinking', { tool?: string }>
  | BaseEvent<'agent.token', AgentToken>
  | BaseEvent<'agent.tool_call', AgentToolCall>
  | BaseEvent<'agent.response', AgentResponse>
  | BaseEvent<'agent.interrupt', { initiator: 'user' | 'agent' | 'system' }>
  | BaseEvent<'agent.error', { code: string; message: string }>
  | BaseEvent<'user.input.text', UserInputText>
  | BaseEvent<'user.input.voice', UserInputVoice>
  | BaseEvent<'user.input.partial', UserInputPartial>
  | BaseEvent<'user.interrupt', { reason: 'ptt' | 'click' | 'tray' | 'hotkey' }>
  | BaseEvent<'user.wake', UserWake>
  | BaseEvent<'tts.audio.envelope', TtsAudioEnvelope>
  | BaseEvent<'tts.audio.start', { voice: string; sample_rate: number }>
  | BaseEvent<'tts.audio.end', { reason: 'natural' | 'interrupt' | 'error' }>
  | BaseEvent<'system.config_changed', { keys: string[] }>
  | BaseEvent<'system.sidecar_status', { up: boolean; build: 'cpu' | 'cuda' }>;

export interface ClientCommand {
  // Renderer → bus → hermes/sidecar, the only outbound shapes.
  type:
    | 'send.text'                  // user typed
    | 'send.voice_blob'             // raw audio for ASR
    | 'cancel.current_turn'         // barge-in
    | 'replay.last'
    | 'tts.speak'                   // direct TTS without going through hermes
    | 'set.state';
  payload: unknown;
}
```

---

## 9. Settings GUI Spec

The settings window is a normal (non-transparent) Quasar page opened from the tray menu. Sections:

### 9.1 Connection

- **HermesAgent URL** (default `http://127.0.0.1:8642/v1`)
- **HermesAgent API key** (auto-filled from `~/.hermes/.env` if `API_SERVER_KEY` is set; otherwise blank with helper text "Set `API_SERVER_ENABLED=true` and `API_SERVER_KEY=…` in `~/.hermes/.env`")
- **Hermes config path** (default `~/.hermes/config.yaml`; rediscover button)
- **Discovered LLM** (read-only): provider, base URL, model, with **Test connection** button
- **Optional: install shell-hook bridge** (checkbox; on save, opens a confirm dialog showing exactly the YAML diff to be written)

### 9.2 Audio I/O

- Input device dropdown (`navigator.mediaDevices.enumerateDevices()` filtered to `audioinput`)
- Output device dropdown
- Input gain slider
- Voice activity threshold (silence trim)

### 9.3 Speech Sidecar

- **Mode**: "Bundled Docker (recommended)" / "External URL" / "Disabled"
- **Sidecar URL** + bearer token
- **TTS model** (populated from `/v1/models`)
- **TTS voice** (populated from `/voices`)
- **Speaking rate** slider
- **ASR model** (populated)
- **ASR language** ("auto" + list)
- **Test TTS** / **Test ASR** buttons
- Sidecar lifecycle: Start/Stop/Restart, GPU/CPU image toggle, image pull progress

### 9.4 Voice input

- Mode: "Push-to-talk" / "Wake-word" / "Off"
- PTT hotkey
- Wake word model file
- Wake threshold

### 9.5 Hotkeys

- Show/Hide overlay
- Spawn typing bar (`Cmd/Ctrl+Space` default; falls back to `Cmd/Ctrl+Alt+Space` if taken)
- Push-to-talk
- Captions toggle
- Cycle monitor
- Replay last
- Interrupt
- (macOS warning if Accessibility permission not granted)

### 9.6 Avatar / Theme

- Theme dropdown (loads from `themes/*.json`)
- Scale slider (50–200%)
- Idle position (top-right / bottom-right / etc., or last-known)
- Click-through default
- "Test mode" launcher

### 9.7 Paraphrase

- Enabled / Disabled
- Threshold (paraphrase responses longer than _N_ characters)
- Target length (words for spoken delivery)
- Model: "Reuse hermes' LLM" / "Use sidecar fallback" / "Disabled"
- System prompt textarea (default: `"Rewrite the following assistant message as natural spoken English in <= 25 words. Preserve meaning, drop code blocks and URLs."`)

### 9.8 Privacy

- Mic permission status (one-click open OS settings on macOS if denied)
- "Mic always-on warning shown" toggle
- "Sidecar internet egress" status (should be 'none' for the bundled CPU image)
- "Send anonymous error reports" — **off by default**

Each top-level section has a single "Test connection" button bound to the relevant `/health` or `/models` call. The button shows latency and the JSON of `/health` on success, and the raw error on failure.

### 9.9 Settings file shape

```yaml
# ~/.config/hermes-faceplate/settings.yaml (or platform equivalent)
hermes:
  base_url: "http://127.0.0.1:8642/v1"
  api_key: "${API_SERVER_KEY}"      # may be substituted at load time
  config_path: "~/.hermes/config.yaml"
  install_shell_hook: false

paraphrase:
  enabled: true
  trigger_chars: 280
  target_words: 25
  model: "reuse_hermes_llm"         # or "sidecar_fallback" or "disabled"
  system_prompt: "Rewrite the following ..."

speech:
  sidecar_mode: "bundled"            # bundled | external | disabled
  sidecar_url: "http://127.0.0.1:8080"
  sidecar_token: "${FACEPLATE_API_KEY}"
  tts:
    model: "piper:en_US-amy-medium"
    voice: "en_US-amy-medium"
    rate: 1.0
  asr:
    model: "faster-whisper-small.en"
    language: "auto"

input:
  mode: "push_to_talk"               # push_to_talk | wake_word | off
  ptt_hotkey: "CommandOrControl+Shift+Space"
  wake:
    model_path: "/wakewords/hey_hermes.onnx"
    threshold: 0.5

hotkeys:
  show_hide:    "CommandOrControl+Shift+H"
  typing_bar:   "CommandOrControl+Space"
  captions:     "CommandOrControl+Shift+C"
  cycle_monitor:"CommandOrControl+Shift+M"
  replay:       "CommandOrControl+Shift+R"
  interrupt:    "CommandOrControl+."

avatar:
  theme: "default-svg"
  scale: 1.0
  position: "bottom_right"
  click_through_default: true

privacy:
  telemetry: false
  mic_warning_shown: false

linux:
  force_x11: false                   # only effective if Wayland session detected
```

---

## 10. Theme / Avatar Manifest Spec

Themes are self-contained JSON files (or directories with a `manifest.json`) that the renderer can load at runtime.

```ts
// theme.ts
export interface AvatarThemeManifest {
  schema_version: 1;
  id: string;                            // unique slug
  name: string;
  author?: string;
  license?: string;

  canvas: {
    width: number;                       // viewBox width
    height: number;
    bg: string | 'transparent';
  };

  // SVG fragments inlined or referenced.
  // If `inline_svg` is provided it is used as-is; otherwise `src` points to a sibling file.
  layers: {
    head: { inline_svg?: string; src?: string };
    eyes?: { inline_svg?: string; src?: string;
             blink?: { rate_min_s: number; rate_max_s: number; duration_ms: number } };
    state_ring?: { inline_svg?: string; src?: string;
                   tint_per_state: Record<AgentState, string> };
    extras?: Array<{ id: string; inline_svg?: string; src?: string }>;
  };

  // Map of viseme code → SVG <g> markup for the mouth slot.
  visemes: {
    A: string; B: string; C: string; D: string; E: string; F: string; X: string; // X = silence/closed
  };

  // Optional smoothing parameters override
  driver?: {
    spring_k?: number;          // default 18
    spring_c?: number;          // default 6
    silence_ms?: number;        // default 80
    thresholds?: { high: number; mid: number; low: number; silence: number };
  };

  // Caption styling
  captions?: {
    font_family?: string;
    font_size_px?: number;
    color?: string;
    background?: string;        // CSS rgba()
    align?: 'left' | 'center' | 'right';
    bottom_offset_px?: number;
  };

  // Asset bundle (relative paths resolved against manifest dir)
  assets?: {
    [key: string]: string;       // logical name → path
  };
}
```

Example minimal theme:

```json
{
  "schema_version": 1,
  "id": "default-svg",
  "name": "Default SVG Hermes",
  "author": "HermesAgent Faceplate",
  "license": "MIT",
  "canvas": { "width": 256, "height": 256, "bg": "transparent" },
  "layers": {
    "head": { "src": "head.svg" },
    "state_ring": {
      "src": "ring.svg",
      "tint_per_state": {
        "idle":      "#888888",
        "listening": "#06b6d4",
        "thinking":  "#f59e0b",
        "speaking":  "#22c55e",
        "error":     "#ef4444"
      }
    }
  },
  "visemes": {
    "A": "<g id=\"viseme-A\"><ellipse cx=\"128\" cy=\"170\" rx=\"22\" ry=\"18\" fill=\"#1a1a1a\"/></g>",
    "B": "<g id=\"viseme-B\"><ellipse cx=\"128\" cy=\"170\" rx=\"18\" ry=\"10\" fill=\"#1a1a1a\"/></g>",
    "C": "<g id=\"viseme-C\"><ellipse cx=\"128\" cy=\"170\" rx=\"10\" ry=\"12\" fill=\"#1a1a1a\"/></g>",
    "D": "<g id=\"viseme-D\"><rect x=\"108\" y=\"166\" width=\"40\" height=\"6\" rx=\"3\" fill=\"#1a1a1a\"/></g>",
    "E": "<g id=\"viseme-E\"><rect x=\"112\" y=\"170\" width=\"32\" height=\"3\" rx=\"1.5\" fill=\"#1a1a1a\"/></g>",
    "F": "<g id=\"viseme-F\"><rect x=\"112\" y=\"168\" width=\"32\" height=\"5\" rx=\"2\" fill=\"#1a1a1a\"/><line x1=\"110\" y1=\"166\" x2=\"146\" y2=\"166\" stroke=\"#fff\" stroke-width=\"1\"/></g>",
    "X": "<g id=\"viseme-X\"><line x1=\"110\" y1=\"170\" x2=\"146\" y2=\"170\" stroke=\"#1a1a1a\" stroke-width=\"3\" stroke-linecap=\"round\"/></g>"
  }
}
```

The renderer validates the manifest with [Zod](https://zod.dev/) at load time (`AvatarThemeManifest.safeParse`), refuses any theme with `<script>` or `on*=` attributes inside SVG fragments (DOMPurify pass), and shows a "Theme rejected: …" error inline.

---

## 11. Build / Install / Distribution Plan

### 11.1 Local dev

```
git clone <repo>
cd hermes-faceplate
pnpm i
pnpm quasar dev -m electron       # HMR for renderer; main restarts on change
# in another shell:
docker compose -f sidecar/compose.cpu.yml up
```

### 11.2 Production build

`quasar build -m electron --bundler builder` with `electron-builder.yml` producing:

- macOS: signed, notarised `.dmg` + `.zip` (universal2). Notarisation via `@electron/notarize` in `afterSign`.
- Windows: NSIS `.exe` installer, signed via Azure Trusted Signing or a cloud HSM (e.g. DigiCert KeyLocker). Squirrel.Windows is not supported by electron-builder for auto-update; NSIS is.
- Linux: AppImage + `.deb`. No code signing; AppImage update channel via electron-updater.

Each build embeds the *Faceplate Speech Sidecar* `compose.cpu.yml` and a one-click "Install sidecar" action that runs `docker compose pull && up -d`.

### 11.3 Auto-update

`electron-updater` with `provider: github` (or `generic` for self-hosted). Update check on app start (only when `app.isPackaged`), retried every 4 h. On macOS, updates require code-signed + notarised builds; otherwise updater silently fails.

### 11.4 Code signing notes

- macOS: Developer ID Application certificate. `entitlements.mac.plist` must include `com.apple.security.cs.allow-jit`, `com.apple.security.device.audio-input`, `com.apple.security.network.client`, and `com.apple.security.cs.disable-library-validation` (Electron requirement). `gatekeeperAssess: false` and use `notarytool` via `@electron/notarize` in `afterSign`.
- Windows: any cloud HSM (Azure Trusted Signing is the cheapest path for US/CA orgs/individuals as of late 2025) wired through `windowsSign`.
- Linux: out of scope (AppImage isn't typically signed).

### 11.5 First-run wizard

1. Detect hermes-agent install (`~/.hermes/`); if absent, link to install instructions.
2. Detect API server enabled; if not, generate a snippet to paste into `~/.hermes/.env` and offer to write it (with consent prompt).
3. Detect Docker; if absent, link to Docker Desktop / podman; offer "external URL" mode as a skip.
4. Pull `:cpu` image (or skip if external).
5. Test all four endpoints (LLM, agent, ASR, TTS).
6. Pick wake-word mode (off / PTT / wake).
7. Pick microphone, speakers, voice.
8. Done — overlay shows.

---

## 12. Security & Privacy

### 12.1 Microphone

- **PTT off by default**, wake-word **off by default**. Both surface a banner the first time they're enabled.
- A persistent **green LED** (small green dot in the avatar's halo) is shown whenever the mic stream is open, regardless of state. Hardcoded; not theme-overridable.
- macOS: explicit `NSMicrophoneUsageDescription` in `Info.plist`. Linux: PipeWire respected. Windows: standard mic permission.
- Audio buffers are not persisted to disk by the Faceplate. The sidecar may keep transcription temp files for debugging — disabled by default; explicit opt-in in sidecar `config.yaml`.

### 12.2 Network egress

| Component | Default destination | When |
|-----------|---------------------|------|
| Faceplate Electron | `127.0.0.1:8642` (hermes), `127.0.0.1:8080` (sidecar) | On every turn |
| Hermes-agent itself | LLM provider (OpenRouter/Nous/etc.) configured in `config.yaml` | On every turn |
| Faceplate paraphrase | Same LLM endpoint as hermes-agent | When response > threshold |
| Sidecar `:cpu` | None outbound (all models bundled) | — |
| Sidecar `:cuda` | None outbound (all models bundled) | — |
| Auto-updater | GitHub release feed | Every 4 h |

The Settings → Privacy panel surfaces this inventory live (renderer makes a "leak test" sweep with httptoolkit-style inspection on `localhost`).

### 12.3 Model provenance

- All bundled models are pinned by SHA-256 in the Dockerfile. The image's `/health` returns the pinned hashes alongside the load-status fields.
- `Piper`, `faster-whisper`, `Moonshine`, and `openWakeWord` are MIT/Apache. Kokoro-82M is Apache 2.0. **Beware the Kokoro phishing/typosquatting issue**: model is hosted at `huggingface.co/hexgrad/Kokoro-82M`; Hexgrad's model card explicitly flags `kokorottsai_com` and `kokorotts_net` as unrelated scam domains. We pin by HF revision hash.
- Parakeet TDT v3 is **CC-BY-4.0** (commercial OK with attribution); Granite 4.1 is Apache 2.0; Voxtral Realtime is Apache 2.0; Voxtral Mini Transcribe V2 is API-only. Canary-Qwen 2.5B is CC-BY-4.0.
- A `THIRD_PARTY_NOTICES.md` is generated at build time listing model+hash+license.

### 12.4 Hermes config writes

The Faceplate **never silently writes** to `~/.hermes/config.yaml`. The "install shell-hook bridge" toggle shows the exact YAML diff and asks for confirmation; first invocation of the hook also goes through hermes' first-use consent allowlist (`~/.hermes/shell-hooks-allowlist.json`).

### 12.5 Threat model

- **Malicious theme** — sandboxed via DOMPurify + Zod manifest validation; SVG fragments rendered with `v-html` only after sanitisation; no remote URL fetches from manifests in v1.
- **Malicious sidecar URL** — bearer token required; if the user points "External URL" at an attacker, the cost is leaked transcripts. Settings panel warns when `sidecar_url` is non-loopback.
- **Hermes-agent compromise** — out of scope for the Faceplate; hermes-agent's own pre/post tool-call hooks and security wave (v0.13's "Tenacity Release") are the right place.

---

## 13. Open Questions and v2 Roadmap

### 13.1 Open questions (v1)

1. **TTS streaming inside Electron**: Electron's `MediaSource` + `<audio>` reliably handles MP3/Opus chunked streams; PCM streams require Web Audio buffering. The current plan is "PCM via AudioBufferSourceNode chained per chunk" but a quick prototype is needed to confirm this stays glitch-free across macOS/Win/Linux.
2. **Wayland fallback UX**: Should the "windowed mode" be a separate quasar page, or just a less-styled overlay? Pending UX call.
3. **`pre_tool_call` rewrite semantics in hermes-agent**: PR #18988 proposes `{action:'rewrite'}` semantics; until merged, our shell-hook bridge can only observe, not redact tool calls before display in captions. Acceptable for v1.
4. **Paraphrase quality on tiny models**: Gemma 3 270M is unproven for "preserve meaning at 25 words" specifically. We may want to evaluate against Qwen3 0.6B.
5. **Click-through-with-drag**: Electron's click-through interaction with drag-and-drop is buggy under transparent windows on Windows; we rely on a `mousemove` polling + `setIgnoreMouseEvents(true, {forward: true})` reset, but pen/tablet events may be lost. Prototype.

### 13.2 v2 roadmap

- **Mobile via Capacitor**: replace `src-electron/electron-preload.ts` with a Capacitor plugin (`@capacitor/voice`, `@capacitor/local-notifications`); mic permissions via Capacitor APIs; sidecar runs in the cloud or on a desktop the phone connects to.
- **VRM / 3D avatars**: behind a feature flag, swap the SVG host for a Three.js + `pixiv/three-vrm` host. Visemes → BlendShapeGroup proxy targets (ARKit-style A/I/U/E/O).
- **Agent-side spoken-stream upgrade**: contribute a `tts: enabled` block upstream so hermes-agent can emit token-bound TTS hints (e.g. word-level phonemes) directly. Or contribute a first-class WS event stream to NousResearch/hermes-agent.
- **Multi-agent**: the Faceplate gets an "agent picker" tray menu (multiple gateway URLs), each with its own theme. Use case: a personal hermes + a work hermes side by side.
- **Local agent mode**: bundle a tiny on-device agent (no LLM) for offline FAQs.
- **Captions translation**: pipe captions through a translation model when `--language` differs from the user's locale.
- **Plugin surface**: a JSON-RPC hook so third-party Quasar plugins can decorate the avatar (e.g. weather wreath, GitHub PR badge).

---

## 14. Appendix

### 14.1 ASR consolidated comparison (recommended picks bolded)

| Tier | Model | Params | License | RAM/VRAM | OpenAI-compatible Docker available |
|------|-------|-------:|---------|----------|:----------------------------------:|
| CPU floor | **faster-whisper-small int8** | ~244 M | MIT | ~600 MB RAM | ✅ `fedirz/faster-whisper-server` |
| CPU floor (En, edge) | **Moonshine v2 Base ONNX** | 27 M | MIT | ~150 MB | ✅ ONNX-Runtime FastAPI |
| 4 GB | **faster-whisper-large-v3-turbo fp16** | 809 M | MIT | ~3.5 GB | ✅ |
| 6 GB+ multilingual | **Parakeet-TDT 0.6B v3** | 600 M | CC-BY-4.0 | ~2 GB | ✅ `groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai` |
| 6 GB+ accuracy | **Granite 4.1 2B** | 2 B | Apache 2.0 | ~5 GB bf16 | ⚠️ vLLM-served |
| Streaming | Voxtral Realtime 4B | 4 B | Apache 2.0 | ~16 GB | vLLM |
| Top of leaderboard | Canary-Qwen 2.5B | 2.5 B | CC-BY-4.0 | ~8 GB | NeMo |

### 14.2 TTS consolidated comparison

| Tier | Model | Params | License | OpenAI-compatible Docker | Voice cloning |
|------|-------|-------:|---------|:------------------------:|:-------------:|
| CPU floor | **Piper** | per-voice ~20–60 MB | MIT | community | ❌ |
| CPU premium | **Kokoro-82M** | 82 M | Apache 2.0 | ✅ `ghcr.io/remsky/kokoro-fastapi-cpu` | ❌ |
| 4 GB GPU | **Kokoro-82M (GPU)** | 82 M | Apache 2.0 | ✅ `kokoro-fastapi-gpu` | ❌ |
| 6 GB+ cloning | **Chatterbox** | 0.5 B | MIT | community | ✅ |
| 6 GB+ quality | **F5-TTS** | ~330 M | MIT | community | ✅ zero-shot |
| Streaming-first | Qwen3-TTS 0.6B/1.7B | 0.6/1.7 B | Apache 2.0 | ✅ community | ✅ |

### 14.3 Wake-word consolidated comparison

| Engine | License | Custom WW DX | Notes |
|--------|---------|--------------|-------|
| **openWakeWord** | Apache 2.0 | Train via Piper synthetic data, ~30 min | Default v1 pick |
| Picovoice Porcupine | Free tier ≤3 active users; commercial AccessKey beyond | Web console, seconds | Best-of-class accuracy/DX, but licensing collides with shipping to N users |
| microWakeWord | Apache 2.0 | ESP32 / Android | For embedded only |

### 14.4 Small LLM consolidated comparison (paraphrase fallback)

| Model | Params | License | CPU sub-second? | Recommendation |
|-------|-------:|---------|:---------------:|----------------|
| **Gemma 3 270M IT (INT4)** | 270 M | Gemma | ✅ ~530 MB on disk | Default for `:cpu` image |
| Qwen3 0.6B / 1.7B | 0.6/1.7 B | Apache 2.0 | ✅ at 0.6B | Alternative |
| Phi-4-mini | 3.8 B | MIT | borderline | `:cuda` image |
| SmolLM3-3B | 3 B | Apache 2.0 | borderline | `:cuda` image |
| Llama 3.2 3B | 3 B | Llama 3 community | borderline | not preferred (license complexity) |

### 14.5 License summary (shippable bundle)

| Component | License | Compatible with MIT-licensed Faceplate? |
|-----------|---------|:--------------------------------------:|
| Quasar / Vue / Pinia / Electron / TypeScript | MIT (and BSD-style) | ✅ |
| Piper voices (`rhasspy/piper-voices`) | MIT (per-voice CC-BY for some) | ✅ with attribution |
| Kokoro-82M | Apache 2.0 | ✅ |
| faster-whisper / CTranslate2 | MIT | ✅ |
| Moonshine | MIT | ✅ |
| openWakeWord | Apache 2.0 | ✅ |
| Gemma 3 270M | Gemma terms (commercial OK) | ✅ |
| Parakeet-TDT v3 / Canary-Qwen 2.5B | CC-BY-4.0 | ✅ with attribution |
| Granite 4.1 / Voxtral Realtime | Apache 2.0 | ✅ |
| Picovoice Porcupine | Apache 2.0 SDK + AccessKey usage limits | ⚠️ — opt-in, user supplies key |
| Mars5 | AGPL | ❌ — exclude from bundle |
| Coqui XTTS-v2 | CPML | ⚠️ — non-default; community-maintained |

### 14.6 References (informational; not a bibliography)

- NousResearch/hermes-agent — repo, AGENTS.md, config.yaml example, releases (v0.10–v0.13), api-server docs, hooks docs.
- Hugging Face Open ASR Leaderboard (paper + interactive Space, March/April 2026 snapshots).
- IBM Granite 4.1 release blog and HF model cards for `granite-speech-4.1-2b` / `2b-plus` / `2b-nar`.
- NVIDIA Parakeet-TDT 0.6B v3 model card; Canary-1B-v2 and Canary-Qwen 2.5B HF pages.
- Mistral Voxtral and Voxtral Transcribe 2 announcements; Voxtral-Mini-4B-Realtime-2602 model card.
- Moonshine v0.0.49 / Moonshine v2 paper (arXiv 2602.12241).
- Hexgrad/Kokoro-82M HF card (with explicit phishing-site warning); `remsky/Kokoro-FastAPI`; `lucasjinreal/Kokoros`.
- `rhasspy/piper-voices` HF; `OHF-Voice/piper1-gpl` (project's current home).
- `dscripka/openWakeWord` README & Home Assistant integration.
- Picovoice Porcupine SDK readme + free-tier policy (CNX Software 2021 launch piece + Picovoice pricing page 2026).
- Inferless "12 Best Open-Source TTS Models" 2025 comparison; Resemble AI Chatterbox claims (use with the caveat that those are vendor-supplied).
- Electron docs: `BrowserWindow`, `globalShortcut`, custom-window-styles (transparency caveats), Wayland section; electron/electron#1335 (still open, click-through-of-transparent-pixels).
- electron-builder code-signing & macOS notarisation docs; `electron-updater`.
- Quasar v2 docs: Electron mode, preload, Pinia integration, boot files.

---

*End of `DESIGN.md` v0.1. Implementable in ~3 weekends if (a) we stay disciplined about scope, (b) we lean on the community Docker images cited in §14 instead of writing our own from scratch, and (c) we accept the shell-hook bridge as the system-wide tap rather than chasing a custom hermes-agent fork.*