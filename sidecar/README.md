# HermesAgent Faceplate Speech Sidecar

A single FastAPI app exposing OpenAI-compatible **TTS** (Kokoro-82M),
**ASR** (faster-whisper), and **wake-word** (openWakeWord) endpoints on
`127.0.0.1:8080`. The Faceplate Electron app talks to it over plain HTTP.

The sidecar is intentionally small (one process, one venv). It does not
ship any LLM — the Faceplate routes paraphrase through your
Hermes-configured LLM directly.

## Run it

Two paths, both producing the same HTTP surface.

### Native (recommended) — the setup script

From the repo root:

```sh
bash setup/speech-sidecar.sh up
```

What it does: installs `uv` (Astral's Python package manager) if missing,
creates a venv at `~/.faceplate/sidecar-venv`, installs this package
editable, downloads the Kokoro model + voices file (~352 MB total, pinned
to v1.0) into `~/.faceplate/sidecar/voices/`, generates a bearer token at
`~/.faceplate/sidecar.token`, and starts uvicorn under `nohup`. Polls
`/health` and prints the URL + token. Subcommands: `up | down | status | logs`.

See [`../setup/speech-sidecar.sh`](../setup/speech-sidecar.sh).

### Container — for ops who prefer a container

A `Dockerfile.cpu` (and `Dockerfile.cuda` for NVIDIA) build the same FastAPI
app + entrypoint. Build + run yourself with `docker build` / `podman build`
and `docker run -p 127.0.0.1:8080:8080 -v faceplate-voices:/voices …`. The
container is no longer something the Faceplate manages — see
[`docs/v1/rescope.md`](../docs/v1/rescope.md) for the thin-client rationale.

| Tag | Size | Default ASR | Default TTS |
|---|---|---|---|
| `:cpu` | ~1.5 GB | faster-whisper int8 | Kokoro-82M (kokoro-onnx) |
| `:cuda` | ~5 GB | faster-whisper fp16 | Kokoro-82M (kokoro-onnx) |

On first start the container entrypoint downloads the same Kokoro
artifacts into the `/voices` volume (or `$FACEPLATE_VOICES_DIR` if you
override the path).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/audio/speech` | OpenAI TTS schema. `voice` = a Kokoro voice id; `model` accepts `kokoro:<voice>` (the legacy `piper:` prefix is also stripped). `stream=true` returns chunked MP3 / Opus / WAV / AAC / PCM. |
| `POST` | `/v1/audio/transcriptions` | OpenAI Whisper multipart schema. |
| `WS`   | `/wake` | Bidirectional 16 kHz Int16 PCM in, JSON `{type, model, score, ts}` out. Off until `wake.enabled=true` in config. |
| `GET`  | `/voices`, `/v1/voices` | Kokoro voice catalog (all voices ship bundled in `voices-v1.0.bin`). |
| `GET`  | `/v1/voices/catalog` | Same shape the Faceplate's Settings UI consumes. |
| `POST` | `/v1/voices/download` | Back-compat no-op — voices are bundled. |
| `GET`  | `/v1/models` | OpenAI list-models — one entry per Kokoro voice (`kokoro:<voice>`) plus the default ASR. |
| `GET`  | `/health`, `/v1/health` | `{status, build, gpu, models, ram_mb, version}`. |

## Auth

A single bearer token covers every endpoint. WebSockets accept the token via
`?token=…` (browsers can't set headers on WS upgrades). Set via the
`FACEPLATE_API_KEY` env var; an empty value disables auth (dev only).

The native setup script generates a per-machine token at
`~/.faceplate/sidecar.token`; the container reads `FACEPLATE_API_KEY` from
`-e` flags.

## Configuration

The sidecar runs with sensible defaults — no config file is required. If
you want to override defaults, write a config in YAML and point at it via
`FACEPLATE_SIDECAR_CONFIG=/path/to/config.yaml`. See
[`config.example.yaml`](./config.example.yaml). The container reads
`/etc/faceplate-sidecar/config.yaml` by default (mountable from the host).

Useful env vars:

| Variable | Default | Purpose |
|---|---|---|
| `FACEPLATE_API_KEY` | empty | Bearer token. Empty = no auth. |
| `FACEPLATE_VOICES_DIR` | `/voices` (container), `~/.faceplate/sidecar/voices` (native via setup script) | Where Kokoro model + voices live. |
| `FACEPLATE_KOKORO_MODEL` | `${VOICES_DIR}/kokoro-v1.0.onnx` | Override the model file path. |
| `FACEPLATE_KOKORO_VOICES` | `${VOICES_DIR}/voices-v1.0.bin` | Override the voices file path. |
| `FACEPLATE_SIDECAR_CONFIG` | `/etc/faceplate-sidecar/config.yaml` | Override the config file path. |
| `FACEPLATE_BUILD` | `cpu` | Reported in `/health` and shown in Settings → Voice. |
| `HF_HOME` | `~/.cache/huggingface` | faster-whisper ASR model cache. |

## Local development

Hack on the sidecar without going through the setup script:

```sh
uv pip install -e ".[dev]"
FACEPLATE_API_KEY=dev FACEPLATE_VOICES_DIR=./voices \
  uvicorn faceplate_sidecar.main:app --reload --port 8080
```

`/health` returns model statuses; backends only load on first request, so
cold start is fast. Make sure `kokoro-v1.0.onnx` + `voices-v1.0.bin` are
under `FACEPLATE_VOICES_DIR` before the first synthesis (or call
`setup/speech-sidecar.sh` once to bootstrap them).

## License

MIT (Faceplate code). Bundled model weights have their own licenses — see
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
