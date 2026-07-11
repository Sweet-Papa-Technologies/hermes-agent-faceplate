#!/usr/bin/env bash
# Faceplate sidecar entrypoint. Sets the build flag from the image variant,
# bootstraps the Kokoro model + voices on first run, then execs uvicorn so
# signals reach the FastAPI app cleanly.

set -euo pipefail

: "${FACEPLATE_BUILD:=cpu}"
: "${FACEPLATE_API_KEY:=}"
export FACEPLATE_BUILD FACEPLATE_API_KEY

# Ensure model + voice + wakeword cache dirs exist (volumes may be empty on
# first run).
mkdir -p /models /voices /wakewords /etc/faceplate-sidecar

# Kokoro release artifacts (thewh1teagle/kokoro-onnx, pinned to v1.0).
# Model is ~325 MB, voices file ~27 MB. faster-whisper auto-pulls ASR
# models from HF on first request; only TTS needs explicit bootstrap.
KOKORO_RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_MODEL="/voices/kokoro-v1.0.onnx"
KOKORO_VOICES="/voices/voices-v1.0.bin"

bootstrap_kokoro() {
  if [ -f "${KOKORO_MODEL}" ] && [ -f "${KOKORO_VOICES}" ]; then
    return 0
  fi
  echo "[faceplate-sidecar] bootstrapping Kokoro (~352 MB, one-time)…"
  if [ ! -f "${KOKORO_MODEL}" ]; then
    if ! curl -fsSL "${KOKORO_RELEASE}/kokoro-v1.0.onnx" -o "${KOKORO_MODEL}.tmp"; then
      echo "[faceplate-sidecar] WARN: failed to download kokoro-v1.0.onnx — TTS will 5xx until present."
      rm -f "${KOKORO_MODEL}.tmp"
      return 0
    fi
    mv "${KOKORO_MODEL}.tmp" "${KOKORO_MODEL}"
  fi
  if [ ! -f "${KOKORO_VOICES}" ]; then
    if ! curl -fsSL "${KOKORO_RELEASE}/voices-v1.0.bin" -o "${KOKORO_VOICES}.tmp"; then
      echo "[faceplate-sidecar] WARN: failed to download voices-v1.0.bin"
      rm -f "${KOKORO_VOICES}.tmp"
      return 0
    fi
    mv "${KOKORO_VOICES}.tmp" "${KOKORO_VOICES}"
  fi
  echo "[faceplate-sidecar] Kokoro ready at ${KOKORO_MODEL}"
}

bootstrap_kokoro

# Print startup banner so container logs are interpretable.
echo "[faceplate-sidecar] build=${FACEPLATE_BUILD} starting on :8080"

exec uvicorn faceplate_sidecar.main:app \
  --host 0.0.0.0 \
  --port 8080 \
  --proxy-headers \
  --no-server-header
