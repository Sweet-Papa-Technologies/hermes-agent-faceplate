# Quickstart — talking to your avatar in 5 minutes

The fastest path from a fresh clone to a working avatar that listens, thinks,
and speaks. For deployment variants, customisation, or troubleshooting, read
[`SETUP.md`](./SETUP.md) instead.

## Prereqs

| Tool | Why | Install |
|---|---|---|
| **GNU Make** ≥ 3.81 | Drives the convenience targets in this guide | macOS: `xcode-select --install` (ships with the Xcode CLI tools). Linux: usually preinstalled; otherwise `apt install make` / `dnf install make`. Windows: use WSL2 (recommended — Docker Desktop already runs through it) or `choco install make` |
| **Docker** with the Compose v2 plugin | Runs hermes-agent + the Faceplate speech sidecar | [Docker Desktop](https://www.docker.com/products/docker-desktop/) on macOS / Windows; engine + compose plugin on Linux. Builds native on every architecture. |
| **Python 3** + **pipx** | Runs the host-native LiteRT-LM LLM server (paraphrase) | macOS: comes with Xcode CLI tools. `python3 -m pip install --user pipx && pipx ensurepath`. The `litert-up` script will install pipx for you if missing. |
| **Node.js** ≥ 22.12 | Electron runtime | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **pnpm** ≥ 10 | Package manager | `npm install -g pnpm` |

After installing, run `make check-prereqs` to confirm Docker, pnpm, and Node
are wired up. (Make itself can't verify Make — if you can run that command
at all, you're good.)

> **No Make?** Skip to [`SETUP.md`](./SETUP.md) — every target in this
> Quickstart maps to a one- or two-line shell equivalent.

## Architecture

The Faceplate is a thin Electron client that talks to **three** local services:

```
   ┌──────────────┐         hermes-agent (Docker)
   │              │ ─8642─► full agent loop, memory, tools, skills
   │  Faceplate   │
   │  (Electron)  │ ─7860─► litert-lm serve (host-native)
   │              │         OpenAI-compatible LLM for paraphrase
   │              │
   │              │ ─8080─► faceplate-sidecar (Docker)
   └──────────────┘         TTS + ASR + wake-word
```

The five commands below set them all up.

## The five commands

```bash
git clone <this-repo> hermes-agent-faceplate
cd hermes-agent-faceplate

make hermes-up        # 1. start hermes-agent container
make litert-up        # 2. install + start host-native litert-lm OpenAI server
make setup            # 3. bootstrap Faceplate config + sidecar token + pnpm install
make up               # 4. start Faceplate sidecar (TTS/ASR/wake)
make app              # 5. launch the Electron app (wizard auto-opens on first run)
```

Or all at once: **`make all`** runs steps 1–4 in sequence, then you `make app` separately.

## What each command does

| | What it does | First-run cost |
|---|---|---|
| **1. `make hermes-up`** | Pulls `nousresearch/hermes-agent`, generates an `API_SERVER_KEY` if you don't have one in `~/.hermes/.env`, starts the container with `gateway run` and `-p 127.0.0.1:8642:8642`, polls `/v1/health` until ready, prints the key. | ~30 s on a fast connection (image pull) |
| **2. `make litert-up`** | Installs `litert-lm` via pipx if missing, imports **Gemma 4 E2B IT** (~2.6 GB) from `litert-community/gemma-4-E2B-it-litert-lm` on first run, starts `litert-lm serve --api openai --port 7860` in the background. PID file at `~/.faceplate/litert.pid`, logs at `~/.faceplate/litert.log`. Native Metal on Apple Silicon, native CUDA on NVIDIA, CPU everywhere else. | ~3–6 min on first run (model download) |
| **3. `make setup`** | Copies `sidecar/config.example.yaml` → `sidecar/config.yaml`, generates a separate `FACEPLATE_API_KEY` for the sidecar, runs `pnpm install` in `app/`. | ~30 s |
| **4. `make up`** | Builds + starts the Faceplate sidecar Docker container (TTS, ASR, wake-word — no LLM). Default Piper voice (`en_US-amy-medium`) auto-downloads on first start. | ~2–3 min on first build, ~5 s after |
| **5. `make app`** | `cd app && pnpm dev` — boots Vite + Electron. Avatar appears bottom-right; setup wizard opens. | A few seconds |

The two keys (hermes API and sidecar API) are printed to your terminal by
steps 1 and 3 — copy them somewhere; the wizard / settings ask for them.

## Walking the wizard (one-time)

| Step | What to enter |
|---|---|
| Welcome | Click "Get started" |
| Connect to hermes-agent | URL pre-fills with `http://127.0.0.1:8642/v1`. **Paste the `API_SERVER_KEY`** from `make hermes-up`. Click "Re-probe" — should turn green. |
| Speech sidecar | Mode: **Bundled Docker** is already selected. Move on. |
| Test endpoints | Click each. The first TTS / ASR test triggers model downloads (~480 MB whisper) so it takes a moment; subsequent calls are sub-second. The paraphrase test hits `127.0.0.1:7860` (litert-lm). |
| Voice | Pick **Off** to start (you can flip to PTT or wake-word later from Settings). |
| Display | **Overlay** on macOS / Windows / Linux X11. **Windowed** on Wayland. |
| Finish | Done. |

After the wizard closes, **open Settings → Speech Sidecar → Bearer token** and
paste the `FACEPLATE_API_KEY` from `make setup`. (The wizard doesn't prompt
for it because the sidecar isn't queried during the wizard flow — but TTS /
ASR will 401 without it.)

## First conversation

- `Cmd+Space` → typing bar pops up → type a question → Enter.
- Avatar transitions idle → thinking → speaking, mouth moves with the audio.
- `Cmd+.` to interrupt mid-response.

Full hotkey list in [`SETUP.md`](./SETUP.md#how-to-actually-use-it).

## When things break

| Symptom | Quick fix |
|---|---|
| `make hermes-up` fails with "image not found" | Network issue — `docker pull nousresearch/hermes-agent` manually to see the actual error |
| `make litert-up` hangs on "Pulling model" | First-time download (~1–2 GB). `tail -f ~/.faceplate/litert.log` to watch progress. |
| `make litert-up` says "litert-lm CLI not found" and pipx install fails | Install pipx manually: `python3 -m pip install --user pipx && pipx ensurepath`, open a new shell, retry. |
| Wizard says "Couldn't reach hermes" | `make verify` to see which side fails. Most often: API key mismatch — the wizard expects the value `make hermes-up` printed, not the placeholder. |
| TTS test hangs the first time | Piper voice download in progress (~60 MB). `make logs` to watch. Subsequent calls are instant. |
| TTS test 401s | Sidecar bearer token isn't pasted into Settings — see the last paragraph of "Walking the wizard" |
| Paraphrase test fails with "litert-lm not reachable" | `make litert-status` — restart with `make litert-up` if it's down. |
| Mouth doesn't move on the first response | Click the avatar once. Chromium's autoplay policy blocks AudioContext until a user gesture. |
| Global hotkeys don't fire on macOS | System Settings → Privacy & Security → Accessibility → enable HermesAgent Faceplate (or Electron in dev mode) |

## Tear-down

```bash
make down              # stop the Faceplate sidecar
make litert-down       # stop the litert-lm server
make hermes-down       # stop the hermes-agent container
# To also drop sidecar volumes (model cache, voices, wakewords):
make clean
```

## What's next

- **Want a deeper dive?** [`SETUP.md`](./SETUP.md) covers manual setup (no Make), image variants (`cpu-slim` / `cuda`), wake-word training, custom themes, the system-wide event tap, and a longer troubleshooting matrix.
- **Want a different paraphrase model?** Override all three env vars together: `LITERT_MODEL=<id> LITERT_HF_REPO=<repo> LITERT_HF_FILE=<file> make litert-up`. The default is Gemma 4 E2B IT per design addendum §4.
- **Want to use your real LLM (not local)?** Settings → Paraphrase → "Reuse hermes-agent's configured LLM" (only works if `~/.hermes/` is locally readable).
- **Running hermes on another machine?** Skip step 1 entirely. The Faceplate works against any reachable hermes URL — just paste it (and the API key) into the wizard's Connect step.
