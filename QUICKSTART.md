# Quickstart — talking to your avatar in 5 minutes

The fastest path from a fresh clone to a working avatar that listens, thinks, and speaks. For deployment variants, customisation, or troubleshooting, read [`SETUP.md`](./SETUP.md) instead.

> **v1 shipping note.** Configuration is settings-only — once installed, the app needs nothing beyond your Hermes URL + API key entered in the wizard. No `~/.hermes/config.yaml` edits required. **Runtime** in v1 still wants Docker for the speech sidecar (TTS / ASR / wake-word); a no-Docker path managed by `uv` is on the v1.1 roadmap. See `docs/v1/v1.todo.md` for the deferred items.

## Prereqs

| Tool | Why | Install |
|---|---|---|
| **GNU Make** ≥ 3.81 | Drives the convenience targets below | macOS: `xcode-select --install`. Linux: usually preinstalled (`apt install make` / `dnf install make`). Windows: WSL2 (recommended) or `choco install make` |
| **Docker** with Compose v2 | Runs hermes-agent + the Faceplate speech sidecar | [Docker Desktop](https://www.docker.com/products/docker-desktop/) on macOS / Windows; engine + compose plugin on Linux |
| **Node.js** ≥ 22.12 | Electron runtime | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **pnpm** ≥ 10 | Package manager | `npm install -g pnpm` |

Run `make check-prereqs` to confirm Docker, pnpm, and Node are wired up.

> **Python is no longer required.** The earlier Quickstart asked for `python3` + `pipx` for a host-native LiteRT-LM paraphrase server. v1 hides that option (the bundled Gemma-4-E2B was too small to follow the summarize prompt reliably) and routes paraphrase through your Hermes LLM directly via a memory-safe bypass. Code is still there for power-users; UI is gone.

## Architecture

The Faceplate is a thin Electron client that talks to **two** services (one was three before — paraphrase no longer needs its own server):

```
   ┌──────────────┐    ─8642─►  hermes-agent (Docker, native, or remote)
   │              │             full agent loop, memory, tools, skills.
   │  Faceplate   │             Paraphrase reuses this LLM directly.
   │  (Electron)  │
   │              │    ─8080─►  faceplate-sidecar (Docker)
   │              │             Piper TTS + Whisper ASR + wake-word
   └──────────────┘
                       (optional, if you want better voices:)
                       ─8880─►  Kokoro-FastAPI (Docker)

                       (optional, if you want Hermes-initiated pings:)
                       ─8643─►  hermes-plugin/faceplate (lives inside
                                the Hermes container — no extra port
                                from the user's perspective)
```

## The four commands

```bash
git clone <this-repo> hermes-agent-faceplate
cd hermes-agent-faceplate

make hermes-up   # 1. start hermes-agent container (skip if you have one running)
make setup       # 2. bootstrap Faceplate config + sidecar token + pnpm install
make up          # 3. start Faceplate sidecar (TTS / ASR / wake)
make app         # 4. launch the Electron app (wizard auto-opens on first run)
```

Or all at once: **`make all`** runs steps 1–3 in sequence, then `make app` separately.

## What each command does

| | What it does | First-run cost |
|---|---|---|
| **1. `make hermes-up`** | Pulls `nousresearch/hermes-agent`, generates an `API_SERVER_KEY` if `~/.hermes/.env` doesn't have one, starts the container with `gateway run` and `-p 127.0.0.1:8642:8642`, polls `/v1/health` until ready, prints the key. Skip if you're already running Hermes elsewhere. | ~30 s on a fast connection |
| **2. `make setup`** | Copies `sidecar/config.example.yaml` → `sidecar/config.yaml`, generates a separate `FACEPLATE_API_KEY` for the sidecar, runs `pnpm install` in `app/`. | ~30 s |
| **3. `make up`** | Builds + starts the Faceplate sidecar Docker container. Default Piper voice (`en_US-amy-medium`) auto-downloads on first start. | ~2–3 min on first build, ~5 s after |
| **4. `make app`** | `cd app && pnpm dev` — boots Vite + Electron. Avatar appears bottom-right; setup wizard opens. | A few seconds |

The two keys (Hermes API + sidecar bearer) are printed to your terminal by steps 1 and 2 — copy them; the wizard / settings ask for them.

## Walking the wizard (one-time)

| Step | What to enter |
|---|---|
| **Welcome** | Click "Get started" |
| **Connect to hermes-agent** | Pick **"I have a Hermes gateway running"**. URL pre-fills with `http://127.0.0.1:8642/v1`. Paste the `API_SERVER_KEY` from `make hermes-up`. Click "Re-probe" — should turn green. |
| **Speech engine** | Pick **Piper** (bundled, works out of the box) or **Kokoro** (better voices, separate sidecar — see below). Then **Bundled Docker** for the TTS/ASR/wake source, image variant **cpu-slim**. |
| **Test endpoints** | Click each. First TTS / ASR test triggers model downloads (~480 MB Whisper) so it takes a moment; subsequent calls are sub-second. |
| **Voice** | Pick **Off** to start (PTT or wake-word are flippable later from Settings). |
| **Display** | **Overlay** on macOS / Windows / Linux X11. **Windowed** on Wayland. |

After the wizard closes, **open Settings → Speech Sidecar → Bearer token** and paste the `FACEPLATE_API_KEY` from `make setup`. The wizard skips this because the sidecar isn't queried during the wizard flow — but TTS / ASR will 401 without it.

## First conversation

- **Ctrl+Space** (literal Ctrl on every OS — Spotlight owns Cmd+Space) → typing bar pops up → type a question → Enter.
- Avatar transitions idle → thinking → speaking, mouth moves with the audio.
- **Ctrl+.** to interrupt mid-response.
- **Ctrl+Shift+H** to hide / show the avatar.
- **Ctrl+Shift+J** to open the Conversations panel.
- **Ctrl+Shift+K** to open the Canvas (chart / diagram / code viewer).
- **Ctrl+Shift+G** (or triple-tap Ctrl+Space within 1 s) to bring all four windows into a screen-corner layout.

## Optional: Kokoro for higher-quality voices

Piper is fast and ships in the bundled sidecar; Kokoro is a separate container with much better prosody (one-shot it via Docker):

```bash
docker run -d -p 8880:8880 --name kokoro ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

Then in the app: **Settings → Speech Sidecar → Engine → Kokoro**. Default voice `af_bella` (other options listed in the dropdown). ~340 MB on disk, 17–22× realtime on Apple Silicon.

## Optional: Hermes Pings (unprompted messages)

Lets Hermes ping you on its own — cron jobs, autonomous decisions. Requires a one-time plugin install on the Hermes side:

```bash
# Install the plugin
cp -R hermes-plugin/faceplate ~/.hermes/plugins/faceplate

# Add to ~/.hermes/.env (replace the secret with `openssl rand -hex 32` or similar)
cat >> ~/.hermes/.env <<'EOF'
FACEPLATE_API_KEY=replace-with-a-random-secret
FACEPLATE_HOME_CHANNEL=default
FACEPLATE_PORT=8643
EOF

# Restart Hermes to pick up the plugin
docker restart hermes-personal
```

Then in the app: **Settings → Hermes Pings** → enable + paste the same `FACEPLATE_API_KEY`. Drop a cron job in `~/.hermes/cron/` with `deliver: faceplate` and you'll get an OS notification + a new turn in the dedicated **"Hermes pings"** conversation. Full reference: `hermes-plugin/README.md`.

## When things break

| Symptom | Quick fix |
|---|---|
| `make hermes-up` fails with "image not found" | Network issue — `docker pull nousresearch/hermes-agent` manually to see the actual error |
| Wizard says "Couldn't reach hermes" | `make verify` to see which side fails. Most often: API key mismatch — the wizard expects the value `make hermes-up` printed, not the placeholder. |
| TTS test hangs the first time | Piper voice download in progress (~60 MB). `make logs` to watch. Subsequent calls are instant. |
| TTS test 401s | Sidecar bearer token isn't pasted into Settings — see the last paragraph of "Walking the wizard" |
| Mouth doesn't move on the first response | Click the avatar once. Chromium's autoplay policy blocks AudioContext until a user gesture. |
| Global hotkeys don't fire on macOS | System Settings → Privacy & Security → Accessibility → enable HermesAgent Faceplate (or Electron in dev mode) |
| Hermes Pings panel says "Disconnected" | `curl http://127.0.0.1:8643/health` to confirm the plugin is running. If 404, the plugin didn't load — check `docker logs hermes-personal` for `[faceplate]` lines. |
| Chart / diagram fails to render | The auto-fix runs automatically on first error — wait a few seconds for the spinner. After two attempts the source is shown for manual inspection. |

## Tear-down

```bash
make down              # stop the Faceplate sidecar
make hermes-down       # stop the hermes-agent container
docker stop kokoro     # if you started Kokoro above
# To also drop sidecar volumes (model cache, voices, wakewords):
make clean
```

## What's next

- **Customising paraphrase / TTS / artifacts behaviour** — most surfaces have a Settings tab (Connection, Audio I/O, Speech Sidecar, Voice Input, Hotkeys, Avatar / Theme, Paraphrase, Canvas / Artifacts, Notifications, Hermes Pings, Privacy).
- **Running Hermes on another machine?** Skip step 1 entirely. The Faceplate works against any reachable Hermes URL — just paste it (and the API key) into the wizard's Connect step.
- **Production install one-liner** — `installer/install.sh` and `install.ps1` are written but not yet hosted. They'll go live with v1's first signed/notarized release.
- **Background research + design notes** live under `docs/v1/research/` (Kokoro, Electron Notifications, installer patterns, Hermes plugin platform).
