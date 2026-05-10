#!/usr/bin/env bash
# Start hermes-agent in Docker with the env vars + port mapping the
# Faceplate needs. Idempotent: re-runnable safely.
#
#   - Creates ~/.hermes/.env if missing.
#   - Adds API_SERVER_ENABLED / HOST / PORT / KEY only if absent (preserves
#     any value you've already set — never overwrites).
#   - Stops + removes any existing container with the same name.
#   - Pulls the image if it's not local.
#   - Starts the container with -p 127.0.0.1:8642:8642 (host loopback only),
#     volume mount to ~/.hermes, restart=unless-stopped.
#   - Polls /v1/health until 200 (60 s timeout) and prints the API key.
#
# Override-able env vars:
#   HERMES_BASE_IMAGE  (default: nousresearch/hermes-agent — the upstream base)
#   HERMES_LOCAL_TAG   (default: hermes-faceplate:browser — what we run)
#   HERMES_NAME        (default: hermes-personal)
#   HERMES_PORT        (default: 8642)
#   HERMES_HOME        (default: $HOME/.hermes)
#   HERMES_BIND        (default: 127.0.0.1 — host side of the port mapping)
#   HERMES_SKIP_BUILD  (default: unset; set to "1" to skip the local build
#                       and run the base image directly — browser tools
#                       won't work but startup is faster)

set -euo pipefail

# Two image identifiers:
#   - BASE: what we pull from the registry (upstream)
#   - LOCAL_TAG: what we actually run (BASE + browser tooling baked in)
HERMES_BASE_IMAGE="${HERMES_BASE_IMAGE:-${HERMES_IMAGE:-nousresearch/hermes-agent}}"
HERMES_LOCAL_TAG="${HERMES_LOCAL_TAG:-hermes-faceplate:browser}"
HERMES_NAME="${HERMES_NAME:-hermes-personal}"
HERMES_PORT="${HERMES_PORT:-8642}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_BIND="${HERMES_BIND:-127.0.0.1}"
ENV_FILE="$HERMES_HOME/.env"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE_DIR="$SCRIPT_DIR/hermes"

# ANSI-C quoting ($'...') puts the actual ESC byte in the variable, so the
# colors render correctly in both `printf` AND `cat <<HEREDOC` blocks.
# Tput-style detection: skip colors when stdout isn't a TTY (e.g. piping
# the script's output to a file or another process).
if [ -t 1 ]; then
  GREEN=$'\033[1;32m'
  YELLOW=$'\033[1;33m'
  RED=$'\033[1;31m'
  RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ─── prereqs ──────────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
command -v curl   >/dev/null 2>&1 || { err "curl not found";   exit 1; }

# ─── ~/.hermes/.env ───────────────────────────────────────────────────────

mkdir -p "$HERMES_HOME"

# Read existing values (if file exists) so we never clobber a key the user
# already chose.
get_existing() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'
}

ensure_var() {
  local key="$1" default="$2"
  local existing
  existing="$(get_existing "$key")"
  if [ -n "$existing" ]; then
    printf "%s" "$existing"
    return 0
  fi
  # Append (creating file if needed). The trailing newline matters because
  # `cat >>` doesn't add one.
  if [ ! -f "$ENV_FILE" ]; then : > "$ENV_FILE"; fi
  if [ -s "$ENV_FILE" ] && [ -z "$(tail -c 1 "$ENV_FILE" 2>/dev/null)" ] || [ ! -s "$ENV_FILE" ]; then
    printf "%s=%s\n" "$key" "$default" >> "$ENV_FILE"
  else
    printf "\n%s=%s\n" "$key" "$default" >> "$ENV_FILE"
  fi
  printf "%s" "$default"
}

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | xxd -p | tr -d '\n'
  fi
}

log "Ensuring $ENV_FILE has the API server vars (preserves any you already set)…"
ENABLED="$(ensure_var API_SERVER_ENABLED "true")"
HOST="$(ensure_var API_SERVER_HOST "0.0.0.0")"
PORT="$(ensure_var API_SERVER_PORT "$HERMES_PORT")"
KEY="$(ensure_var API_SERVER_KEY "$(generate_key)")"

if [ "$ENABLED" != "true" ]; then
  warn "API_SERVER_ENABLED is '$ENABLED' (not 'true'). Edit $ENV_FILE manually if you want the server on."
fi
if [ "$HOST" = "127.0.0.1" ]; then
  warn "API_SERVER_HOST is 127.0.0.1 inside the container — host won't reach it through Docker port mapping."
  warn "Set API_SERVER_HOST=0.0.0.0 in $ENV_FILE for Docker to work."
fi

# ─── recreate container ───────────────────────────────────────────────────

if docker ps -a --format '{{.Names}}' | grep -qx "$HERMES_NAME"; then
  log "Removing existing container '$HERMES_NAME' (volume at $HERMES_HOME is preserved)…"
  docker rm -f "$HERMES_NAME" >/dev/null
fi

if ! docker image inspect "$HERMES_BASE_IMAGE" >/dev/null 2>&1; then
  log "Pulling $HERMES_BASE_IMAGE (one-time)…"
  docker pull "$HERMES_BASE_IMAGE"
fi

# Build the local image that bakes in agent-browser + chromium so the
# `browser_navigate` / `browser_get_images` / etc. tools work out of the
# box. Cheap when cached — Docker reuses layers unless the base image's
# digest changed. Skipped if HERMES_SKIP_BUILD=1.
HERMES_RUN_IMAGE="$HERMES_LOCAL_TAG"
if [ "${HERMES_SKIP_BUILD:-}" = "1" ]; then
  warn "HERMES_SKIP_BUILD=1 set — running base image; browser tools won't work."
  HERMES_RUN_IMAGE="$HERMES_BASE_IMAGE"
elif [ ! -f "$DOCKERFILE_DIR/Dockerfile" ]; then
  warn "No Dockerfile at $DOCKERFILE_DIR — running base image; browser tools won't work."
  HERMES_RUN_IMAGE="$HERMES_BASE_IMAGE"
else
  log "Building $HERMES_LOCAL_TAG on top of $HERMES_BASE_IMAGE (browser + agent-browser CLI)…"
  docker build \
    --build-arg "HERMES_BASE=$HERMES_BASE_IMAGE" \
    -t "$HERMES_LOCAL_TAG" \
    "$DOCKERFILE_DIR" >/dev/null
fi

log "Starting $HERMES_NAME on $HERMES_BIND:$PORT (mount $HERMES_HOME → /opt/data)…"
# `gateway run` is REQUIRED — without an explicit command the image's default
# entrypoint is the interactive `hermes chat` REPL, which exits immediately
# under -d (no TTY). `gateway run` launches the persistent API server.
# Source: https://hermes-agent.nousresearch.com/docs/user-guide/docker
docker run -d \
  --name "$HERMES_NAME" \
  --restart unless-stopped \
  -p "$HERMES_BIND:$PORT:$PORT" \
  -v "$HERMES_HOME:/opt/data" \
  "$HERMES_RUN_IMAGE" gateway run >/dev/null

# ─── wait for health ──────────────────────────────────────────────────────

log "Waiting for /v1/health to respond (up to 60 s)…"
for i in $(seq 1 60); do
  if curl -fsS -m 2 -H "Authorization: Bearer $KEY" \
       "http://$HERMES_BIND:$PORT/v1/health" >/dev/null 2>&1; then
    printf "${GREEN}✓${RESET} hermes-agent is up\n"
    break
  fi
  if [ "$i" = "60" ]; then
    err "hermes-agent didn't pass /v1/health in 60 s. Check 'docker logs $HERMES_NAME'."
    exit 1
  fi
  sleep 1
done

# ─── done ─────────────────────────────────────────────────────────────────

cat <<DONE

${GREEN}─── hermes-agent running ───${RESET}

  URL:        http://$HERMES_BIND:$PORT/v1
  Container:  $HERMES_NAME
  Image:      $HERMES_RUN_IMAGE  (base: $HERMES_BASE_IMAGE)
  Env file:   $ENV_FILE

  ${YELLOW}API_SERVER_KEY${RESET} (paste this into the Faceplate wizard):

    ${GREEN}$KEY${RESET}

  Logs:    docker logs -f $HERMES_NAME
  Stop:    docker rm -f $HERMES_NAME
  Restart: $0

DONE
