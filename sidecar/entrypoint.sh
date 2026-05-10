#!/usr/bin/env bash
# Faceplate sidecar entrypoint. Sets the build flag from the image variant
# and execs uvicorn so signals reach the FastAPI app cleanly.

set -euo pipefail

: "${FACEPLATE_BUILD:=cpu}"
: "${FACEPLATE_API_KEY:=}"
export FACEPLATE_BUILD FACEPLATE_API_KEY

# Ensure model + voice + wakeword cache dirs exist (volumes may be empty on
# first run).
mkdir -p /models /voices /wakewords /etc/faceplate-sidecar

# Bootstrap the default Piper voice on first start. faster-whisper auto-pulls
# from HF on first request, but Piper voices have to be present at synthesis
# time — there's no lazy fetch. Skip if the voice is already in the volume.
bootstrap_piper_voice() {
  local voice="${PIPER_DEFAULT_VOICE:-en_US-amy-medium}"
  local onnx="/voices/${voice}.onnx"
  local config="/voices/${voice}.onnx.json"
  if [ -f "${onnx}" ] && [ -f "${config}" ]; then
    return 0
  fi
  # Map voice id → HF subpath. Format is rhasspy/piper-voices/<lang>/<locale>/<speaker>/<quality>/<voice>.onnx
  # The default 'en_US-amy-medium' lives under en/en_US/amy/medium/.
  local lang locale speaker quality
  lang="${voice%%_*}"           # en
  locale="${voice%-*}"          # en_US-amy
  locale="${locale%-*}"         # en_US
  speaker_quality="${voice#*-}" # amy-medium
  speaker="${speaker_quality%-*}"  # amy
  quality="${speaker_quality##*-}" # medium
  local hf_base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${locale}/${speaker}/${quality}"
  echo "[faceplate-sidecar] bootstrapping Piper voice: ${voice}"
  if ! curl -fsSL "${hf_base}/${voice}.onnx" -o "${onnx}.tmp"; then
    echo "[faceplate-sidecar] WARN: failed to download ${voice}.onnx — TTS will fail until you drop one into the faceplate-voices volume."
    rm -f "${onnx}.tmp"
    return 0
  fi
  mv "${onnx}.tmp" "${onnx}"
  if ! curl -fsSL "${hf_base}/${voice}.onnx.json" -o "${config}.tmp"; then
    echo "[faceplate-sidecar] WARN: failed to download ${voice}.onnx.json"
    rm -f "${config}.tmp"
    return 0
  fi
  mv "${config}.tmp" "${config}"
  echo "[faceplate-sidecar] Piper voice ready at ${onnx}"
}

bootstrap_piper_voice

# Print startup banner so docker-compose logs are interpretable.
echo "[faceplate-sidecar] build=${FACEPLATE_BUILD} starting on :8080"

exec uvicorn faceplate_sidecar.main:app \
  --host 0.0.0.0 \
  --port 8080 \
  --proxy-headers \
  --no-server-header
