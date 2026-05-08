# `DESIGN-ADDENDUM-01.md` — Resolutions for v1 Open Questions

> Status: Addendum to `DESIGN.md` v0.1
> Resolves: §13.1 Open Questions, items 1–5
> Effect: This document supersedes anything in the parent doc that conflicts with it. Sections of `DESIGN.md` that are touched are listed at the top of each item under **"Touches."**

---

## Index

| # | Open question (parent §13.1) | Decision (one-liner) |
|---|------------------------------|----------------------|
| 1 | TTS streaming inside Electron | Use **Media Source Extensions (MSE)** with chunked MP3/Opus from the sidecar; PCM/Web Audio path is dropped for v1 |
| 2 | Wayland fallback UX | A **separate "Windowed" `BrowserWindow`**; "Transparent overlay" is now an explicit toggle that doubles as the Wayland fallback |
| 3 | `pre_tool_call` rewrite semantics | **Accepted as v1 limitation.** Hook bridge observes only; tool-call captions are best-effort until the upstream PR lands |
| 4 | Paraphrase quality on tiny models | Use **`litert-community/gemma-4-E2B-it-litert-lm`** in the canonical `.litertlm` format (default INT4), via the **LiteRT-LM** runtime, served behind an OpenAI-compatible HTTP wrapper |
| 5 | Click-through-with-drag glitches on Windows | **"Transparent overlay" becomes a user-facing on/off toggle** (default ON). When OFF, the app runs in normal "windowed mode" — same window code as the Wayland fallback in #2 |

---

## 1. TTS Streaming — switch to Media Source Extensions

**Touches:** `DESIGN.md` §4.6 (Audio Pipeline), §6.2 (TTS comparison — adds a `response_format` constraint), §7.2 (Sidecar `/v1/audio/speech` endpoint), §8 (event schema — `tts.audio.start` payload gains `mime`).

### Decision

The Faceplate plays streamed TTS through the **HTML `<audio>` element backed by a `MediaSource`** with a single `SourceBuffer`, not through chained `AudioBufferSourceNode`s decoding raw PCM. The viseme driver still gets its amplitude/FFT data via a `MediaElementAudioSourceNode → AnalyserNode` tap, so lip-sync continues to work — we only change the *transport*, not the *analysis*.

### Rationale

- MSE is part of the Chromium runtime Electron already ships. No native modules, no manual sample-rate matching, no clicks at chunk boundaries.
- It supports **chunked HTTP transfer of MP3 (`audio/mpeg`)** and Opus-in-MP4/WebM (`audio/mp4; codecs="opus"`, `audio/webm; codecs="opus"`) reliably across macOS / Windows / Linux Chromium builds.
- The OpenAI `/v1/audio/speech` schema we already mandated supports `response_format ∈ {mp3, opus, aac, wav, pcm, flac}` and emits chunked transfer-encoded responses when `stream=true`. MP3 and Opus are both first-class with MSE; PCM is *not* a valid MSE byte-stream and would have required us to decode chunk-by-chunk in JS — exactly the path we wanted to retire.
- Switching transport eliminates the cross-platform glitch risk we flagged in the parent doc as the main thing to "prototype before locking in." Prototyping risk → done.

### What changes in the audio pipeline

```
sidecar /v1/audio/speech?stream=true&format=mp3
        │  Transfer-Encoding: chunked
        ▼
fetch(...).body.getReader()                         ◄── ReadableStream
        │
        ▼
SourceBuffer.appendBuffer(chunk)                    ◄── one MediaSource
        │
        ▼
<audio> element (audio.src = URL.createObjectURL(mediaSource))
        │
        ├──► speakers (default audio routing)
        │
        └──► AudioContext.createMediaElementSource(audio)
                    │
                    ▼
              AnalyserNode  ──► viseme-driver.ts (unchanged)
                    │
                    ▼
              AudioContext.destination
```

### Reference implementation sketch

```ts
// audio/tts-client.ts
export async function speakStream(
  url: string,
  body: TtsRequest,
  signal: AbortSignal,
  onAnalyser: (a: AnalyserNode) => void
): Promise<void> {
  const audio = new Audio();
  audio.crossOrigin = 'use-credentials';

  const mime = 'audio/mpeg';                          // default; opus path = 'audio/mp4; codecs="opus"'
  if (!MediaSource.isTypeSupported(mime)) throw new Error(`Unsupported MIME: ${mime}`);

  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);

  await new Promise<void>(res => ms.addEventListener('sourceopen', () => res(), { once: true }));
  const sb = ms.addSourceBuffer(mime);
  sb.mode = 'sequence';                                // we don't care about absolute timestamps

  // Lip-sync tap — must be created BEFORE play() so the routing is set
  const ctx = new AudioContext();
  const src = ctx.createMediaElementSource(audio);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  src.connect(ctx.destination);                        // speakers
  onAnalyser(an);

  // Pump
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal,
                                 headers: { 'content-type': 'application/json',
                                            'authorization': `Bearer ${SIDECAR_TOKEN}` } });
  if (!res.ok || !res.body) throw new Error(`TTS HTTP ${res.status}`);

  const reader = res.body.getReader();
  const queue: Uint8Array[] = [];
  let draining = false;
  const drain = () => {
    if (draining || sb.updating || queue.length === 0) return;
    draining = true;
    sb.appendBuffer(queue.shift()!);
  };
  sb.addEventListener('updateend', () => { draining = false; drain(); });

  const playStarted = audio.play().catch(() => { /* user-gesture issue handled by caller */ });

  while (true) {
    if (signal.aborted) { try { ms.endOfStream('decode'); } catch {} reader.cancel(); break; }
    const { value, done } = await reader.read();
    if (done) { queue.length === 0 && !sb.updating ? ms.endOfStream() : void 0; break; }
    queue.push(value);
    drain();
  }
  await playStarted;
}
```

### Impact on the sidecar

`/v1/audio/speech` MUST support `stream=true` with `response_format=mp3` (Piper, Kokoro, Qwen3-TTS, F5-TTS via community wrappers all do). The **CPU floor** voice in the sidecar's defaults flips to:

- `tts.default_format: "mp3"` (was implicit `pcm`)
- Piper backend: pipe through `ffmpeg -f mp3 -b:a 64k` (or just use `piper-tts` with `--output-raw | lame` in the wrapper).

The `pcm` format is still allowed but the renderer ignores it. Document in the sidecar README that **`pcm` is for non-MSE clients only** (e.g. a future native iOS port).

### Event-schema delta (§8)

```ts
export interface TtsAudioStart {
  voice: string;
  sample_rate: number;
  mime: 'audio/mpeg' | 'audio/mp4; codecs="opus"' | 'audio/webm; codecs="opus"' | 'audio/wav' | 'audio/aac';
  format: 'mp3' | 'opus' | 'wav' | 'aac';
}
```

### Compatibility notes

- macOS Electron — MP3 + Opus-in-MP4 both fine.
- Windows Electron — MP3 fine; Opus-in-MP4 fine on Chromium ≥ 116 (Electron 28+).
- Linux Electron — same as Chromium; MP3 OK in Electron's bundled FFmpeg, Opus-in-WebM OK universally.
- We **do not** target Firefox parity; this app ships only as Electron.

---

## 2. Wayland fallback UX — separate Windowed-mode `BrowserWindow`

**Touches:** `DESIGN.md` §4.1 (Electron Main process), §4.3 (Renderer folder layout), §9.6 (Avatar/Theme settings).

### Decision

We define **two distinct top-level `BrowserWindow`s** in main:

1. **`OverlayWindow`** — the transparent, frameless, always-on-top, click-through-toggleable canvas that hosts `OverlayPage.vue`. This is the v0.1 design unchanged.
2. **`WindowedAvatarWindow`** — a **separate, ordinary, framed, opaque `BrowserWindow`** (resizable, draggable by titlebar, normal taskbar entry, no click-through, no transparent compositing) that hosts the same `OverlayPage.vue` rendered onto an opaque background pulled from the active theme manifest.

**Only one of them is shown at a time.** A single piece of state — `settings.avatar.mode: 'overlay' | 'windowed'` — picks which window is created at startup and which one is recreated when the user toggles it (with a "restart-to-apply" flow if recreation is risky on a given platform).

The `SettingsPage.vue` continues to live in its own dedicated normal `BrowserWindow` (this is unchanged from §4.3 — the parent doc already specifies it). Settings is **always** windowed; that's not what changed here. What's new is that the *avatar itself* now has a windowed mode.

### Why the same `OverlayPage.vue` for both

The overlay page already does its own SVG composition; the only difference between modes is whether the page is rendered onto a transparent or opaque background. We expose a CSS variable `--faceplate-bg` and a `data-mode="overlay|windowed"` attribute on the page root — themes can opt to draw a soft drop-shadow or background card only when `data-mode="windowed"`.

### Wayland detection & defaults

```ts
// src-electron/window.ts
const isWayland = process.platform === 'linux' &&
                  process.env.XDG_SESSION_TYPE === 'wayland';

const userMode = settings.avatar.mode;       // user's stored preference
const mode = userMode === 'overlay' && (isWayland && !settings.linux.force_x11)
  ? 'windowed'                                // Wayland override
  : userMode;
```

Behavior:

- First-run on Wayland — Faceplate detects Wayland, surfaces a one-time toast: *"Wayland detected — starting in Windowed mode. You can try Overlay mode in Settings, but it may be limited on your compositor."* Mode is set to `windowed`.
- First-run on macOS / Windows / Linux X11 — mode defaults to `overlay`.
- "Force X11 (Linux)" toggle in Settings → Linux → on launch, sets `app.commandLine.appendSwitch('ozone-platform', 'x11')` *before* `app.whenReady()`. Requires app restart (we offer a button).

### Settings UI delta (parent §9.6)

Add to **Avatar / Theme**:

- **Display mode** — `Overlay (transparent, always-on-top)` | `Windowed (regular window)`
  - Helper text under "Overlay": *"Recommended on macOS and Windows. May not work on Wayland Linux compositors."*
  - Helper text under "Windowed": *"Always works. Use this if the overlay flickers, won't stay on top, or interferes with input."*

This is now the **single switch** that #1 (Wayland fallback) and #5 (Windows transparency-toggle) both depend on.

---

## 3. `pre_tool_call` rewrite semantics — accept the v1 limitation

**Touches:** `DESIGN.md` §5.3 (integration strategies), §13.1 #3 (closes the open question).

### Decision

We accept that the shell-hook bridge in Strategy B can **observe** lifecycle events but cannot rewrite tool calls before they execute. PR #18988 in the upstream NousResearch/hermes-agent repo proposes the `{action: 'rewrite'}` semantics; until that ships, our hook is read-only.

### Implementation rules

- The hook script we install only ever **prints `{}` on stdout** (no-op return) and writes the JSON payload to our local listener (`POST http://127.0.0.1:51789/hook`). We never return action JSON.
- The Faceplate UI renders tool-call indicators in captions strictly as *post-hoc* annotations: "💻 ran terminal: `ls -la`" *after* `post_tool_call` fires, never before. No predictive captioning.
- When the upstream rewrite PR lands, we'll add an opt-in **redaction filter** under Settings → Privacy ("Redact tool args matching regex" e.g. `(api[_-]?key|token|password)\s*[:=]\s*\S+`). Out of scope for v1; tracked as v1.1.

### What this means for users

If the user wants tool-call captions to never display sensitive arguments, they have to either (a) trust hermes-agent's logging settings, or (b) not enable the system-wide hook bridge (Strategy A — SSE-only — is unaffected because it only sees `/v1/runs/{id}/events`, which already redacts per hermes-agent's policy).

---

## 4. Paraphrase fallback — Gemma 4 E2B via LiteRT-LM

**Touches:** `DESIGN.md` §7.5 (paraphrase fallback model recommendation), §7.4 (image variants), §7.7 (volume mounts), §7.8 (sidecar config example), §14.4 (small-LLM comparison table).

### Decision

The bundled paraphrase fallback model is **`litert-community/gemma-4-E2B-it-litert-lm`** in the canonical `gemma-4-E2B-it.litertlm` file (Apache 2.0 runtime; Gemma terms for weights, commercial OK). The runtime is **LiteRT-LM** — Google's production on-device LLM runtime that ships in Chrome's "Help me write," Chromebook Plus, Pixel Watch, and the Google AI Edge Gallery. It is exposed to the rest of the Faceplate as an OpenAI-compatible `/v1/chat/completions` endpoint inside the sidecar via a thin Node wrapper.

### Why this and not Gemma 3 270M

The parent doc's pick (Gemma 3 270M IT, INT4 GGUF, ~530 MB) was chosen on a "tiny is good" axis. The user's stack already invests in LiteRT-LM (PAL/ORCA, FoFo Food Tracker), so picking the LiteRT-LM path here gives us:

- One runtime across Faceplate-desktop and the user's mobile/extension efforts; zero new operational surface area.
- **Production-validated runtime** — LiteRT-LM ships in shipping Google products at billions of devices' scale, so the runtime stability bar is already met.
- Multimodal headroom — Gemma 4 E2B includes vision and audio paths that load on demand (the model card explicitly notes "vision and audio models are loaded as needed to further reduce memory consumption"). v2 features like "describe what's on my screen" become a config flip rather than a model swap.
- Apache 2.0 (runtime) + Gemma terms (weights) — commercial OK, no AGPL contamination.

The cost is **size**: 2.58 GB on disk (decoder ~0.79 GB weights + ~1.12 GB embeddings memory-mapped + token/audio/vision encoders). Versus 530 MB for Gemma 3 270M Q4. We accept this — the `:cpu` image grows from ~1.4 GB to ~4.0 GB, and we make the fallback model an **opt-out** in the setup wizard for users on bandwidth-constrained installs.

### Quantization / file choice

The HF repo only publishes the canonical `.litertlm` deployment file plus a `.task` file for MediaPipe-on-Web. There is no menu of GGUF Qx_K_M variants — LiteRT-LM picks the quant internally (INT4 weights, FP16 activations on CPU XNNPack, INT4/FP16 mix on GPU via ML Drift). **We use `gemma-4-E2B-it.litertlm` as published.** No quant decision required.

### Performance targets (vendor-published, model card)

| Platform | Backend | Decode (tok/s) | TTFT (s) | Mem (MB) |
|----------|--------|---------------:|---------:|---------:|
| Linux ARM 2.3–2.8 GHz | CPU (XNNPack) | 35.0 | 4.0 | 1628 |
| Linux RTX 4090 | GPU | 143.4 | 0.1 | 913 |
| MacBook Pro M4 Max | CPU | 41.6 | 1.1 | 736 |
| MacBook Pro M4 Max | GPU | 160.2 | 0.1 | 1623 |
| Windows Intel Lunar Lake | CPU | 29.8 | 2.4 | 3505 |
| Windows Intel Lunar Lake | GPU | 48.4 | 0.3 | 3540 |
| Raspberry Pi 5 16 GB | CPU | 7.6 | 7.8 | 1546 |

For a 25-word paraphrase target (~35 tokens generated, ~200 tokens prefill), worst case on a CPU-only floor laptop is ~0.5–1 s on macOS, ~1–2 s on Linux/Windows, ~5–8 s on a Pi. Acceptable as a fallback (the primary path stays "reuse hermes-agent's configured LLM" which is typically a fast cloud endpoint). The fallback only fires when the cloud path is unreachable.

### Sidecar integration

Two viable paths:

- **(A) `imertz/litert-lm-api-server`** — a Node.js Express wrapper that shells out to the `litert_lm_main` binary and exposes `POST /v1/chat/completions` (streaming), `POST /v1/completions`, `GET /v1/models`, `GET /health`. MIT-licensed, drop-in. We bundle this directly into the sidecar image.
- **(B) Roll our own FastAPI wrapper** around the `litert-lm` Python package (`pip install litert-lm`).

**Choice: (A).** It already speaks our wire format and we'd be reinventing the wheel with (B). We pin the wrapper at a tagged commit and submit upstream PRs for anything we need (auth header support is the only change we currently anticipate).

The sidecar's process tree on `:cpu` becomes:

```
sidecar-entrypoint.sh
├── uvicorn main:app  (FastAPI)              ──►  /v1/audio/transcriptions, /v1/audio/speech, /wake, /health
└── node litert-server.js  (port 7860, internal) ──►  /v1/chat/completions (paraphrase fallback)
```

FastAPI's `/v1/chat/completions` route is a thin reverse-proxy to `127.0.0.1:7860/v1/chat/completions`. Health-check aggregates both.

### Updated sidecar config (parent §7.8 delta)

```yaml
paraphrase_fallback:
  enabled: true
  backend: "litert-lm"
  runtime:
    binary: "/opt/litert-lm/litert_lm_main"
    backend: "cpu"               # cpu | gpu | npu — sidecar entrypoint sets per image variant
  model:
    huggingface_repo: "litert-community/gemma-4-E2B-it-litert-lm"
    file: "gemma-4-E2B-it.litertlm"
    cache_dir: "/models/litert-lm"
  generation:
    max_tokens: 96
    temperature: 0.4
    top_p: 0.95
  api_server:                    # imertz/litert-lm-api-server settings
    internal_port: 7860
    api_key: "${LITERT_LM_INTERNAL_KEY}"   # generated at container start; not user-facing
```

### Updated image variants (parent §7.4 delta)

| Image | Size (target) | LLM runtime | Paraphrase model |
|-------|---------------|-------------|------------------|
| `faceplate-sidecar:cpu` | ~4.0 GB | LiteRT-LM CPU (XNNPack) | Gemma 4 E2B IT |
| `faceplate-sidecar:cpu-slim` *(new)* | ~1.4 GB | none | none — paraphrase falls back to "reuse hermes-agent's LLM" only |
| `faceplate-sidecar:cuda` | ~7.0 GB | LiteRT-LM GPU (ML Drift / DirectX Compiler on Windows) | Gemma 4 E2B IT |

The `:cpu-slim` variant is an explicit opt-out for users who want a small image and never need offline paraphrase. The setup wizard offers a checkbox: *"Bundle on-device paraphrase model (+2.6 GB) — recommended."*

### Volume-mount delta (parent §7.7)

```
- ./models/litert-lm:/models/litert-lm     # gemma-4-E2B-it.litertlm cached here
```

### Comparison-table delta (parent §14.4)

Replace the existing row with:

| Model | Params | License | CPU sub-second on M4 Max? | Recommendation |
|-------|-------:|---------|:-------------------------:|----------------|
| **Gemma 4 E2B IT (LiteRT-LM)** | 2 B effective | Gemma + Apache 2.0 (runtime) | ✅ (~1.1 s TTFT, 41 tok/s decode) | **Default for `:cpu` image when paraphrase fallback is enabled** |
| Gemma 3 270M IT (INT4 GGUF) | 270 M | Gemma | ✅ | retained as note for ultra-constrained installs only |
| Qwen3 0.6B / 1.7B | 0.6/1.7 B | Apache 2.0 | ✅ at 0.6B | Alternative for non-LiteRT environments |
| Phi-4-mini | 3.8 B | MIT | borderline | `:cuda` if not using LiteRT-LM |

### Multimodal future

Gemma 4 E2B's vision and audio encoders are loaded on demand — they are *not* loaded by default for paraphrase work. This keeps memory honest. v2 can flip them on for the "describe my screen" / "what did I just say" features without changing the deployment shape.

---

## 5. Transparency as an explicit user toggle

**Touches:** `DESIGN.md` §4.1 (Electron Main), §4.3 (Renderer), §9.6 (Settings → Avatar/Theme), §13.1 #5 (closes).

### Decision

The transparent overlay is now a **first-class user setting**, not an architectural assumption. The setting is the same `settings.avatar.mode` from item #2:

- `mode: 'overlay'` → transparent, frameless, click-through, always-on-top `OverlayWindow` (the original v0.1 behavior).
- `mode: 'windowed'` → opaque, framed, draggable, normal-z-order `WindowedAvatarWindow`.

**Defaults**:

- macOS / Windows / Linux X11 → `overlay`
- Linux Wayland → `windowed` (with override available; see #2)
- **Windows where the user reports input issues** → user can flip to `windowed` themselves; first-run wizard surfaces a help link to the toggle.

### Why this is the right shape

The original doc had two implicit fallback paths (Wayland degradation, Windows click-through-with-drag bugs). Making them the *same* user-visible toggle reduces the design to one switch with three jobs:

1. Privacy/UX preference for users who want a "real window."
2. Fallback for Wayland.
3. Escape hatch for Windows transparent-overlay quirks (HiDPI, pen/tablet input, GPU driver oddities).

We don't need to build platform-conditional flow logic for each — there's one path, and the user (or our auto-detect) flips one switch.

### Keeping "always-on-top" available in windowed mode

`mode: 'windowed'` does NOT lose `alwaysOnTop`. Users who want the avatar in a normal-looking window but still pinned above other apps get that. Implementation: `windowedWindow.setAlwaysOnTop(settings.avatar.always_on_top, 'floating')` — independent setting, default ON in windowed mode too, user can disable. The toggle lives in Settings → Avatar/Theme as a sibling to the mode picker.

### Settings UI final shape (replaces §9.6)

```
Avatar / Theme
─────────────────────────────────────────────────────────
Theme           [ default-svg ▾ ]
Scale           [▬▬▬▬●▬▬▬▬]    (50%–200%)
Display mode    ( ) Overlay (transparent, always-on-top)
                ( ) Windowed (regular window)
                ↳ Detected: macOS — Overlay recommended
Always on top   [✓]   (applies in both modes)
Click-through   [✓]   (overlay mode only — disabled in windowed)
Idle position   [ Bottom-right ▾ ]
                [ Test mode → ]
```

### Renderer-side rule

`OverlayPage.vue` reads `data-mode` (set by main on the page root via `webContents.executeJavaScript` during `did-finish-load`) and applies:

```css
:root[data-mode="overlay"]   { --faceplate-bg: transparent; --faceplate-card: none; }
:root[data-mode="windowed"]  { --faceplate-bg: var(--faceplate-theme-bg, #1a1a1a);
                                --faceplate-card: 0 12px 32px rgba(0,0,0,.35); }
```

Themes that want to render a card background only in windowed mode key off `:root[data-mode="windowed"] svg.head { filter: drop-shadow(...); }` etc. The default theme ships with sensible windowed-mode styling.

### Click-through-with-drag, finalised

Per the parent doc's note on Electron's still-open `setIgnoreMouseEvents` quirks under transparent windows:

- In **overlay mode**, click-through follows the per-pixel hit-test described in §4.1 of the parent doc. Drag-to-move is a dedicated drag handle (the head's halo region) — we do not rely on mouse-events-on-transparent-pixels for dragging.
- In **windowed mode**, click-through does not exist. Drag is handled by the OS title bar (or a custom `-webkit-app-region: drag` strip). All input quirks evaporate.

This means: if Windows transparent-overlay quirks ever block a user, the *one-click escape* is "Settings → Display mode → Windowed" — they don't lose the avatar, the lip-sync, the always-on-top, or any conversational feature; they just gain a frame.

---

## Cross-cutting change log

### Settings file delta (full)

```yaml
avatar:
  theme: "default-svg"
  scale: 1.0
  mode: "overlay"                        # NEW: 'overlay' | 'windowed'
  always_on_top: true                    # NEW: independent of mode
  click_through_default: true            # overlay mode only
  position: "bottom_right"

paraphrase:
  enabled: true
  trigger_chars: 280
  target_words: 25
  model: "reuse_hermes_llm"              # 'reuse_hermes_llm' | 'sidecar_fallback' | 'disabled'
  system_prompt: "Rewrite the following ..."

speech:
  sidecar_mode: "bundled"                # bundled | external | disabled
  sidecar_url: "http://127.0.0.1:8080"
  sidecar_token: "${FACEPLATE_API_KEY}"
  sidecar_image: "cpu"                   # NEW: 'cpu' | 'cpu-slim' | 'cuda'
  tts:
    model: "piper:en_US-amy-medium"
    voice: "en_US-amy-medium"
    rate: 1.0
    format: "mp3"                        # NEW: pinned to 'mp3' for v1 (MSE)
  asr:
    model: "faster-whisper-small.en"
    language: "auto"

linux:
  force_x11: false                       # only effective if Wayland session detected
```

### Open-questions table (final v1 status)

| # | Question | Status |
|---|----------|--------|
| 1 | TTS streaming approach | **Closed** — MSE / chunked MP3 |
| 2 | Wayland fallback UX | **Closed** — windowed mode is a separate `BrowserWindow` |
| 3 | `pre_tool_call` rewrite | **Closed (accepted limitation)** — observe-only until upstream PR |
| 4 | Paraphrase model | **Closed** — Gemma 4 E2B (LiteRT-LM), default in `:cpu` image |
| 5 | Click-through-with-drag on Windows | **Closed** — user-toggleable transparency, same switch as #2 |

### Net additions to v1 scope

- One new sidecar variant: `:cpu-slim` (no LLM, smaller image).
- One bundled binary: `litert_lm_main` (LiteRT-LM CLI) + `imertz/litert-lm-api-server` Node wrapper.
- One model file: `gemma-4-E2B-it.litertlm` (~2.58 GB, downloaded on first run unless image baked).
- One `BrowserWindow` factory: `WindowedAvatarWindow`.
- One settings field with cross-cutting effect: `avatar.mode`.

### Net deletions from v1 scope

- The "PCM-via-AudioBufferSourceNode chained per chunk" prototype task. Gone.
- Wayland-specific UX prototyping. Subsumed by the windowed-mode path that already exists for #5.
- Gemma 3 270M GGUF + llama.cpp inside the sidecar. Replaced by LiteRT-LM.

---

*End of `DESIGN-ADDENDUM-01.md`. Apply on top of `DESIGN.md` v0.1; the two documents are read together for v1 implementation.*
