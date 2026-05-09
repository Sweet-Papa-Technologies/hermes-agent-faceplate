#!/usr/bin/env bash
# Faceplate sidecar entrypoint. Sets the build flag from the image variant
# and execs uvicorn so signals reach the FastAPI app cleanly.

set -euo pipefail

: "${FACEPLATE_BUILD:=cpu}"
: "${FACEPLATE_API_KEY:=}"

# Ensure model + voice + wakeword cache dirs exist (volumes may be empty on
# first run).
mkdir -p /models /voices /wakewords /etc/faceplate-sidecar /models/litert-lm

# Persist the LiteRT-LM internal token across container restarts. Without
# this the chat-completions reverse proxy reads a stale value from a config
# snapshot taken at the previous startup.
KEY_FILE="/models/litert-lm/internal-key"
if [ -z "${LITERT_LM_INTERNAL_KEY:-}" ]; then
  if [ -f "${KEY_FILE}" ]; then
    LITERT_LM_INTERNAL_KEY="$(cat "${KEY_FILE}")"
  else
    LITERT_LM_INTERNAL_KEY="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p)"
    printf '%s' "${LITERT_LM_INTERNAL_KEY}" > "${KEY_FILE}"
    chmod 600 "${KEY_FILE}"
  fi
fi
export FACEPLATE_BUILD FACEPLATE_API_KEY LITERT_LM_INTERNAL_KEY

# Print startup banner so docker-compose logs are interpretable.
echo "[faceplate-sidecar] build=${FACEPLATE_BUILD} starting on :8080"

exec uvicorn faceplate_sidecar.main:app \
  --host 0.0.0.0 \
  --port 8080 \
  --proxy-headers \
  --no-server-header
