# HermesAgent Faceplate Speech Sidecar

A single FastAPI app exposing OpenAI-compatible TTS / ASR / wake-word /
paraphrase endpoints. The Faceplate Electron app talks to it over plain HTTP
on `127.0.0.1:8080`.

## Image variants

| Tag | Size (target) | Default ASR | Default TTS |
|-----|---------------|-------------|-------------|
| `:cpu` (default) | ~1.5 GB | faster-whisper int8 | Kokoro-82M (kokoro-onnx) |
| `:cuda` | ~5 GB | faster-whisper fp16 | Kokoro-82M (kokoro-onnx) |

## Quick start

```bash
make up   # from the repo root — runs the sidecar as a plain container
curl -fsS http://127.0.0.1:8080/health | jq .
```

`make up` is engine-agnostic (Podman by default, Docker supported); to run
the script directly: `CONTAINER_ENGINE=podman bash scripts/start-sidecar.sh`.
There is no compose anymore — the sidecar is a plain `run`, pull-first with a
`Dockerfile.<variant>` build fallback.

The first run downloads model weights into named container volumes — Podman
or Docker — (`faceplate-models`, `faceplate-voices`, `faceplate-wakewords`);
subsequent runs cache hit.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/v1/audio/speech` | OpenAI TTS schema. `stream=true` returns chunked MP3 / Opus / WAV / AAC / PCM. |
| `POST` | `/v1/audio/transcriptions` | OpenAI Whisper multipart schema. |
| `WS`   | `/wake` | Bidirectional 16 kHz Int16 PCM in, JSON `{type, model, score, ts}` out. Off until `wake.enabled=true`. |
| `POST` | `/v1/chat/completions` | Reverse-proxied to LiteRT-LM (Gemma 4 E2B). 501 on `:cpu-slim`. |
| `GET`  | `/v1/models` | OpenAI list-models. |
| `GET`  | `/voices` | Kokoro voice catalog (all voices ship bundled). |
| `GET`  | `/health`, `/v1/health` | `{status, build, gpu, models, ram_mb, version}`. |

## Auth

A single bearer token covers every endpoint. WebSockets accept the token via
`?token=…` (browsers can't set headers on WS upgrades). Set via
`FACEPLATE_API_KEY` env var; an empty value disables auth (dev only).

## Configuration

`/etc/faceplate-sidecar/config.yaml` — see `config.example.yaml`. Mountable
from the host. The Faceplate's setup wizard generates a key, writes it to
its own settings, and starts the container with `-e FACEPLATE_API_KEY=…`.

## Volume mounts

| Path | Purpose |
|------|---------|
| `/models` | faster-whisper HF model cache. |
| `/voices` | Kokoro model + voices files (`kokoro-v1.0.onnx`, `voices-v1.0.bin`). |
| `/wakewords` | openWakeWord `.onnx` files. |
| `/etc/faceplate-sidecar/config.yaml` | Runtime config. |

## Build flag

The `FACEPLATE_BUILD` env var (`cpu | cpu-slim | cuda`) is set by the
entrypoint and read at config-load time. The chat-completions route 501s
when `cpu-slim`, and `/health` reports the build verbatim so the Faceplate
can show it in the Privacy panel.

## Local development (without a container engine — no Podman / Docker)

```bash
pip install -e ".[dev]"
FACEPLATE_API_KEY=dev uvicorn faceplate_sidecar.main:app --reload --port 8080
```

`/health` returns model statuses; backends only load on first request, so
the cold start is fast.

## License

MIT (Faceplate code). Bundled model weights have their own licenses; see
`THIRD_PARTY_NOTICES.md` after building (Phase 7).
