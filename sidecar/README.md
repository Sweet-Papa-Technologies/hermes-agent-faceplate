# HermesAgent Faceplate Speech Sidecar

A single FastAPI app exposing OpenAI-compatible TTS / ASR / wake-word /
paraphrase endpoints. The Faceplate Electron app talks to it over plain HTTP
on `127.0.0.1:8080`.

## Image variants

| Tag | Size (target) | LLM runtime | Default ASR | Default TTS |
|-----|---------------|-------------|-------------|-------------|
| `:cpu` (default) | ~4 GB | LiteRT-LM CPU + Gemma 4 E2B | faster-whisper int8 | Piper |
| `:cpu-slim` | ~1.4 GB | none — paraphrase falls back to hermes' LLM only | faster-whisper int8 | Piper |
| `:cuda` | ~7 GB | LiteRT-LM GPU + Gemma 4 E2B | faster-whisper fp16 | Kokoro / Piper |

## Quick start

```bash
docker compose -f compose.cpu.yml up -d
curl -fsS http://127.0.0.1:8080/health | jq .
```

The first run downloads model weights into named Docker volumes
(`faceplate-models`, `faceplate-voices`, `faceplate-wakewords`); subsequent
runs cache hit.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/v1/audio/speech` | OpenAI TTS schema. `stream=true` returns chunked MP3 / Opus / WAV / AAC / PCM. |
| `POST` | `/v1/audio/transcriptions` | OpenAI Whisper multipart schema. |
| `WS`   | `/wake` | Bidirectional 16 kHz Int16 PCM in, JSON `{type, model, score, ts}` out. Off until `wake.enabled=true`. |
| `POST` | `/v1/chat/completions` | Reverse-proxied to LiteRT-LM (Gemma 4 E2B). 501 on `:cpu-slim`. |
| `GET`  | `/v1/models` | OpenAI list-models. |
| `GET`  | `/voices` | Installed Piper voices. |
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
| `/models` | HF + LiteRT-LM model cache. |
| `/voices` | Piper `.onnx` voices. |
| `/wakewords` | openWakeWord `.onnx` files. |
| `/etc/faceplate-sidecar/config.yaml` | Runtime config. |

## Build flag

The `FACEPLATE_BUILD` env var (`cpu | cpu-slim | cuda`) is set by the
entrypoint and read at config-load time. The chat-completions route 501s
when `cpu-slim`, and `/health` reports the build verbatim so the Faceplate
can show it in the Privacy panel.

## Local development (without Docker)

```bash
pip install -e ".[dev]"
FACEPLATE_API_KEY=dev uvicorn faceplate_sidecar.main:app --reload --port 8080
```

`/health` returns model statuses; backends only load on first request, so
the cold start is fast.

## License

MIT (Faceplate code). Bundled model weights have their own licenses; see
`THIRD_PARTY_NOTICES.md` after building (Phase 7).
