# HermesAgent Faceplate — Setup

End-to-end setup against a hermes-agent running locally in Docker. The
Faceplate also works against remote / LAN / cloud hermes deployments — just
swap `HERMES_URL` for the appropriate URL.

## Architecture

The Faceplate is a thin Electron client that talks to **three** local services:

| Service | Where it runs | Port | What it does |
|---|---|---|---|
| `hermes-personal` | Docker | 8642 | Full agent loop (chat, memory, tools, skills) |
| `litert-lm serve` | **Host-native** (pip-installed) | 7860 | OpenAI-compatible LLM for the paraphrase pass. Native Metal on macOS, native CUDA on NVIDIA, CPU everywhere else. |
| `faceplate-sidecar` | Docker | 8080 | TTS + ASR + wake-word only |

LiteRT-LM lives outside the container deliberately — Google ships native
binaries for macOS arm64 / Linux x86_64+arm64 / Windows x86_64, and running
it on the host gives you GPU acceleration without Rosetta or `--gpus`
contortions.

## Prerequisites

| Tool | Version | Why | Install |
|---|---|---|---|
| **GNU Make** | ≥ 3.81 | Drives the convenience targets used below. Optional — every target has a manual equivalent at the bottom of this doc. | macOS: `xcode-select --install`. Linux: usually preinstalled; else `apt install make` / `dnf install make`. Windows: WSL2 (recommended) or `choco install make`. |
| **Docker** | latest, w/ Compose v2 plugin | hermes-agent + Faceplate sidecar | Docker Desktop on macOS / Windows; engine + compose plugin on Linux. Sidecar builds native on every architecture (incl. arm64) — no Rosetta required. |
| **Python 3** + **pipx** | latest | Hosts `litert-lm` for the paraphrase LLM | macOS / Linux: `python3 -m pip install --user pipx && pipx ensurepath` (the `litert-up` script will install pipx for you if missing) |
| **Node.js** | ≥ 22.12 | Electron runtime | nodejs.org or `nvm install 22` |
| **pnpm** | ≥ 10 | Package manager | `npm install -g pnpm` |

`make check-prereqs` from the repo root verifies the bottom three (the fact
that `make` itself runs is sufficient evidence Make is installed).

---

## 1. Get hermes-agent reachable from the host

By default hermes binds its API server to `127.0.0.1` *inside the container*,
which the host can't reach through Docker port mapping. Two things to do.

### 1a. Set the API server vars in `~/.hermes/.env`

```bash
cat >> ~/.hermes/.env <<'EOF'
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=change-me-please-actually
EOF
```

Pick a real token. (The hermes docs literally use `change-me-local-dev` as a
placeholder — don't ship that.)

### 1b. Run the container with port mapping (host loopback only)

```bash
docker rm -f hermes-personal 2>/dev/null
docker run -d --name hermes-personal \
  -p 127.0.0.1:8642:8642 \
  -v ~/.hermes:/opt/data \
  --restart unless-stopped \
  nousresearch/hermes-agent gateway run
```

The trailing **`gateway run`** is required — the image's default entrypoint
is the interactive `hermes chat` REPL, which exits immediately when there's
no TTY. `gateway run` launches the persistent API server.

`make hermes-up` runs the script that does all of the above.

### 1c. Verify

```bash
curl -fsS -H "Authorization: Bearer change-me-please-actually" \
  http://127.0.0.1:8642/v1/health
# → {"status":"ok"...}
```

If that 200s, hermes is good.

---

## 2. Start the host-native LiteRT-LM server

LiteRT-LM is Google's official cross-platform LLM runtime. The Faceplate's
paraphrase pass talks to it directly at `http://127.0.0.1:7860/v1` for short
spoken-delivery rewrites — **without** burning hermes-agent's session memory.

```bash
make litert-up
```

What it does:

1. Installs `litert-lm` via pipx if missing (one-time, ~20 MB).
2. Imports the default model **Gemma 4 E2B IT** from
   `litert-community/gemma-4-E2B-it-litert-lm` via
   `litert-lm import --from-huggingface-repo …` (~2.6 GB, one-time, cached
   at `$HOME/.cache/huggingface/`). Matches DESIGN-ADDENDUM-01 §4.
3. Starts `litert-lm serve --api openai --port 7860` in the background.
   PID file: `~/.faceplate/litert.pid`. Log: `~/.faceplate/litert.log`.

Override via env: `LITERT_MODEL` + `LITERT_HF_REPO` + `LITERT_HF_FILE`
(set all three together to swap models), `LITERT_PORT`, `LITERT_HOST`,
`LITERT_BACKEND` (e.g. `LITERT_BACKEND=gpu make litert-up` on NVIDIA hosts).

Verify:

```bash
# litert-lm 0.11 `serve --api openai` exposes the Responses API only —
# /v1/chat/completions returns 404. The Faceplate's paraphrase bridge knows.
curl -fsS -X POST http://127.0.0.1:7860/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gemma-4-E2B-it","input":"hi","max_output_tokens":4}'
# → JSON with output[0].content[0].text
```

If it 200s, paraphrase will work end-to-end.

## 3. Bring up the Faceplate sidecar

The sidecar is a Docker container that exposes OpenAI-compatible TTS, ASR,
and wake-word — no LLM, no LiteRT-LM (that lives on the host). Three image
variants, all functionally identical for the audio surface:

| Tag | Size | What you get |
|---|---|---|
| `:cpu` (default) | ~1.4 GB | TTS + ASR + wake-word, native arm64 / x86_64 |
| `:cpu-slim` | ~1.4 GB | Same as `:cpu` (kept for backward compat) |
| `:cuda` | ~5 GB | NVIDIA-accelerated faster-whisper fp16 |

```bash
cd /Users/fterry/code/hermes-agent-faceplate

make setup        # one-time: copy config, generate sidecar token, pnpm install
make up           # start the sidecar in background
make logs         # watch until you see "starting on :8080"
make verify       # curls hermes + sidecar /health
```

`make setup` prints the **sidecar bearer token** at the end — you'll paste it
into Settings → Speech Sidecar in the Faceplate later.

To use a different image variant:

```bash
make up SIDECAR_VARIANT=cpu-slim
# or
make up SIDECAR_VARIANT=cuda
```

---

## 4. Launch the Faceplate app

```bash
make app          # equivalent to `cd app && pnpm dev`
```

Electron opens. Two things will happen on first launch:

- The avatar appears bottom-right of your primary display (transparent overlay).
- A separate **Setup wizard** window opens.

---

## 5. Walk the wizard (one-time)

| Step | What to do |
|---|---|
| Welcome | Click "Get started" |
| **Connect to hermes-agent** | URL: `http://127.0.0.1:8642/v1` · API_SERVER_KEY from step 1a · click "Re-probe" — should show ✅ Reachable + `model: hermes-agent`. If `~/.hermes/` is on this same machine, you'll also see "Local config also detected" |
| **Speech sidecar** | Mode: **Bundled Docker** · Image: matches what you ran with `make up` |
| **Test endpoints** | Click each: agent → 200, llm → 200 (only if local config is readable), tts → 200, asr → 200, paraphrase → 200 |
| **Voice** | Pick **Off** to start (you can flip to PTT or Wake later) |
| **Display** | Overlay (recommended on macOS) |
| Finish | Done |

Settings persist to `~/Library/Application Support/HermesAgent Faceplate/settings.yaml`
(macOS) / `~/.config/HermesAgent Faceplate/settings.yaml` (Linux) /
`%APPDATA%\HermesAgent Faceplate\settings.yaml` (Windows).

---

## 6. Two things the wizard doesn't ask for

### 6a. Sidecar bearer token

The wizard asks for the *hermes* token but not the *sidecar* one. Open
**Settings → Speech Sidecar → Bearer token** and paste the value
`make setup` printed (also in `sidecar/.faceplate-api-key`). Without this,
TTS / ASR calls 401.

### 6b. macOS Accessibility (only if you want global hotkeys)

System Settings → Privacy & Security → Accessibility → toggle
**HermesAgent Faceplate** (or **Electron** while in dev mode).
Settings → Hotkeys shows a green "Accessibility granted" banner once done.

---

## What gets downloaded automatically?

| Component | Auto-download? | Where it lives |
|---|---|---|
| **LiteRT-LM CLI** (`litert-lm`, ~20 MB) | ✅ via pipx by `make litert-up` | pipx venv (`~/.local/pipx/venvs/litert-lm/`) |
| **Gemma 4 E2B IT** (`gemma-4-E2B-it.litertlm`, ~2.6 GB) | ✅ on first `litert-lm import` (called by `make litert-up`) | HuggingFace cache (`~/.cache/huggingface/`) |
| **Piper voice** (`en_US-amy-medium.onnx`, ~60 MB) | ✅ on first sidecar start (entrypoint.sh pulls from `rhasspy/piper-voices`) | `faceplate-voices` Docker volume |
| **faster-whisper-small.en** (~480 MB int8) | ✅ on first transcription request | `faceplate-models` volume → `HF_HOME` |
| **openWakeWord model** (`hey_hermes.onnx`) | ❌ NOT shipped — wake-word is off by default. Drop your own `.onnx` into the `faceplate-wakewords` volume to enable. See `sidecar/wakewords/README.md` | `faceplate-wakewords` volume |
| **Custom Piper voices** | ❌ — pull manually if you want a non-default voice | `faceplate-voices` volume |

First cold-start is slow because LiteRT-LM downloads the model (~1–2 GB),
Piper downloads its voice (~60 MB), and faster-whisper downloads its weights
(~480 MB) on first use. After that, restarts hit cache and are sub-second.

---

## How to actually use it

| Action | How |
|---|---|
| Type at the avatar | `Cmd+Space` → typing bar → Enter |
| Push to talk | Settings → Voice Input → Push-to-talk. Hotkey defaults to `Cmd+Shift+Space`. First press starts recording, second press sends. |
| Wake word ("Hey Hermes") | Settings → Voice Input → Wake word. **You must drop your own `.onnx` into the `faceplate-wakewords` volume first** — see `sidecar/wakewords/README.md` |
| Stop the avatar mid-response | `Cmd+.` |
| Move the avatar | Drag from anywhere inside the circle |
| Cycle to a different monitor | `Cmd+Shift+M` |
| Replay last response | `Cmd+Shift+R` |
| Toggle captions | `Cmd+Shift+C` |
| Show/hide overlay | `Cmd+Shift+H` |
| Quit | Tray icon → Quit |

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| `curl /v1/health` from host returns "connection refused" | hermes is bound to 127.0.0.1 *inside* the container — re-do step 1b with `API_SERVER_HOST=0.0.0.0` and `-p 127.0.0.1:8642:8642` |
| Wizard says "Couldn't reach hermes" with HTTP 401 | API key mismatch — check that the value you pasted matches `~/.hermes/.env` exactly |
| Sidecar "Test TTS" fails with HTTP 401 | Paste `FACEPLATE_API_KEY` (`cat sidecar/.faceplate-api-key`) into Settings → Speech Sidecar → Bearer token |
| Sidecar "Test TTS" fails with connection refused | `make logs` — is the sidecar container actually up? |
| "Test TTS" hangs the first time | Piper voice download in progress (~60 MB). `make logs` to watch progress. |
| TTS plays but mouth doesn't move | Click the avatar once after the first response (Chromium autoplay policy needs a user gesture before AudioContext can start) |
| Global hotkeys do nothing on macOS | Grant Accessibility permission — see step 5b |
| Wake-word can't connect | Default `wake.enabled: false` — see `sidecar/wakewords/README.md` to ship your own model |
| Sidecar logs say "Piper voice download failed" | Network blocked? Drop the `.onnx` + `.onnx.json` into the `faceplate-voices` volume manually. |
| Paraphrase test says "unsafe_to_bypass" | You picked "Reuse hermes' LLM" but local `~/.hermes/` isn't readable from this machine. Either run hermes locally with file mounts, or stick with "Sidecar fallback" (default — works in any topology). |

---

## Tear-down

```bash
make down                         # stop the sidecar
make litert-down                  # stop the host-native litert-lm server
make hermes-down                  # stop the hermes-agent container
make clean                        # also drop sidecar volumes (models cache, voices, wakewords)
```

---

## Next steps after first run

- **Try a different voice**: drop a Piper `.onnx` + `.onnx.json` into the
  `faceplate-voices` volume, then in Settings → Speech Sidecar → Voice click
  "Refresh from sidecar".
- **Train a custom wake word**: ~30 minutes via openWakeWord's Piper-synthetic
  pipeline. See `sidecar/wakewords/README.md`.
- **Install the system-wide event tap**: Settings → Connection → "Install
  shell-hook bridge" lets the avatar voice Telegram / cron / etc. turns too.
  You'll see a YAML diff before anything's written to `~/.hermes/config.yaml`.
- **Pick a different theme**: Settings → Avatar / Theme. Three built-ins ship
  (`default-svg`, `minimal-mono`, `neon`). User-supplied themes drop into
  `~/Library/Application Support/HermesAgent Faceplate/themes/<id>/`.

---

## Appendix: without Make

Every `make` target above is just a thin wrapper. If you can't (or don't
want to) install Make, run these instead.

| Make target | Raw equivalent |
|---|---|
| `make hermes-up` | `bash scripts/start-hermes.sh` (works as-is — POSIX shell, no Make required) |
| `make hermes-down` | `docker rm -f hermes-personal` |
| `make hermes-logs` | `docker logs -f hermes-personal` |
| `make litert-up` | `bash scripts/start-litert.sh` (POSIX shell) |
| `make litert-down` | `kill $(cat ~/.faceplate/litert.pid) && rm ~/.faceplate/litert.pid` |
| `make litert-logs` | `tail -f ~/.faceplate/litert.log` |
| `make setup` | `cp sidecar/config.example.yaml sidecar/config.yaml && openssl rand -hex 32 > sidecar/.faceplate-api-key && chmod 600 sidecar/.faceplate-api-key && cd app && pnpm install` |
| `make up` | `FACEPLATE_API_KEY=$(cat sidecar/.faceplate-api-key) docker compose -f sidecar/compose.cpu.yml up -d --build` |
| `make down` | `docker compose -f sidecar/compose.cpu.yml down` |
| `make restart` | `make down` + `make up` |
| `make logs` | `docker compose -f sidecar/compose.cpu.yml logs -f sidecar` |
| `make app` | `cd app && pnpm dev` |
| `make verify` | `curl http://127.0.0.1:8642/v1/health` + `curl http://127.0.0.1:8080/health` + TCP probe of `127.0.0.1:7860` |
| `make clean` | `docker compose -f sidecar/compose.cpu.yml down -v` |
| `make all` | `make hermes-up && make litert-up && make setup && make up` (four commands in sequence) |

For a different image variant, swap `compose.cpu.yml` for
`compose.cpu-slim.yml` or `compose.cuda.yml`.
