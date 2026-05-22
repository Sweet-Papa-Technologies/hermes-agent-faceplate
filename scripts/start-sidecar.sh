#!/usr/bin/env bash
# Start the Faceplate speech sidecar as a plain container (M4 — converted
# off `docker compose`, Decision #5). Bash mirror of app/src-electron/
# sidecar.ts so `make up` and the GUI behave identically. Idempotent.
#
# Override-able env vars:
#   CONTAINER_ENGINE   (default: docker — set to 'podman'. M5 flips default)
#   SIDECAR_VARIANT    (cpu | cpu-slim | cuda; default: cpu)
#   FACEPLATE_API_KEY  (bearer the sidecar requires; passed through)

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR_DIR="$HERE/sidecar"

# Engine (M5 default): Podman if installed, else Docker. Override with
# CONTAINER_ENGINE=docker|podman.
CONTAINER_ENGINE="${CONTAINER_ENGINE:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}"
SIDECAR_VARIANT="${SIDECAR_VARIANT:-cpu}"
FACEPLATE_API_KEY="${FACEPLATE_API_KEY:-}"

NAME="faceplate-sidecar"

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || { err "$CONTAINER_ENGINE not found"; exit 1; }

case "$SIDECAR_VARIANT" in
  cpu)
    DOCKERFILE="Dockerfile.cpu"
    IMAGE="ghcr.io/nousresearch/hermes-faceplate-sidecar:cpu"
    START_PERIOD="20s"; GPU=0 ;;
  cpu-slim)
    DOCKERFILE="Dockerfile.cpu-slim"
    IMAGE="ghcr.io/nousresearch/hermes-faceplate-sidecar:cpu-slim"
    START_PERIOD="20s"; GPU=0 ;;
  cuda)
    DOCKERFILE="Dockerfile.cuda"
    IMAGE="ghcr.io/nousresearch/hermes-faceplate-sidecar:cuda"
    START_PERIOD="30s"; GPU=1 ;;
  *)
    err "unknown SIDECAR_VARIANT '$SIDECAR_VARIANT' (cpu | cpu-slim | cuda)"; exit 1 ;;
esac

# Pull-first, build-fallback (mirrors sidecar.ts): the prebuilt image is on
# ghcr; building is the offline/dev path.
if ! "$CONTAINER_ENGINE" image inspect "$IMAGE" >/dev/null 2>&1; then
  log "Pulling $IMAGE…"
  if ! "$CONTAINER_ENGINE" pull "$IMAGE" >/dev/null 2>&1; then
    log "Pull failed — building $IMAGE from $DOCKERFILE (one-time)…"
    "$CONTAINER_ENGINE" build -f "$SIDECAR_DIR/$DOCKERFILE" -t "$IMAGE" "$SIDECAR_DIR"
  fi
fi

"$CONTAINER_ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true

RUN_ARGS=(
  run -d
  --name "$NAME"
  --restart unless-stopped
  -p "127.0.0.1:8080:8080"
  -v faceplate-models:/models
  -v faceplate-voices:/voices
  -v faceplate-wakewords:/wakewords
)
# config.yaml is optional; only bind when present (podman errors on a
# missing bind source — strictly better than the old compose footgun).
if [ -f "$SIDECAR_DIR/config.yaml" ]; then
  RUN_ARGS+=( -v "$SIDECAR_DIR/config.yaml:/etc/faceplate-sidecar/config.yaml:ro" )
fi
RUN_ARGS+=( -e "FACEPLATE_API_KEY=$FACEPLATE_API_KEY" -e "FACEPLATE_BUILD=$SIDECAR_VARIANT" )
if [ "$GPU" = "1" ]; then
  RUN_ARGS+=( -e "LITERT_LM_BACKEND=gpu" -e "NVIDIA_VISIBLE_DEVICES=all" -e "NVIDIA_DRIVER_CAPABILITIES=compute,utility" )
  if [ "$CONTAINER_ENGINE" = "podman" ]; then
    RUN_ARGS+=( --device nvidia.com/gpu=all )
  else
    RUN_ARGS+=( --gpus all )
  fi
fi
RUN_ARGS+=(
  --health-cmd "curl -fsS http://127.0.0.1:8080/health"
  --health-interval 30s
  --health-timeout 5s
  --health-start-period "$START_PERIOD"
  --health-retries 3
  "$IMAGE"
)

log "Starting $NAME ($CONTAINER_ENGINE, variant=$SIDECAR_VARIANT)…"
"$CONTAINER_ENGINE" "${RUN_ARGS[@]}" >/dev/null

printf "${GREEN}✓${RESET} sidecar started — health at http://127.0.0.1:8080/health\n"
