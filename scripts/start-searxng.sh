#!/usr/bin/env bash
# Bring up the SearXNG stack on 127.0.0.1:9080 and configure hermes to use
# it. Idempotent. Safe to re-run.
#
# After this finishes:
#   - SearXNG is reachable at http://127.0.0.1:9080 (host) or
#     http://host.docker.internal:9080 (from inside the hermes container).
#   - ~/.hermes/config.yaml has `web` + `browser` toolsets enabled and
#     web.search_backend pointing at the right provider (SearXNG, or
#     Tavily/Firecrawl/Exa if those keys are in ~/.hermes/.env).
#   - ~/.hermes/.env has SEARXNG_URL set so hermes' web tool can find it.
#
# You still need to:
#   make hermes-down && make hermes-up

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="$HERE/searxng/settings.yml"

# Container engine. M1 default = docker (zero behavior change). Override
# with CONTAINER_ENGINE=podman. Podman migration M5 flips this default.
CONTAINER_ENGINE="${CONTAINER_ENGINE:-docker}"

# M4: converted off `compose` to plain `run` (Decision #5 — no dependency
# on podman-compose). Faithful translation of the retired
# searxng/docker-compose.yml: a `searxng` network, valkey (aliased `redis`
# so SEARXNG_REDIS_URL=redis://redis:6379 still resolves), and searxng.
NET="searxng"
REDIS_NAME="searxng-redis"
SEARXNG_NAME="searxng"
REDIS_IMAGE="docker.io/valkey/valkey:8-alpine"
SEARXNG_IMAGE="docker.io/searxng/searxng:latest"

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || { err "$CONTAINER_ENGINE not found"; exit 1; }

if [ ! -r "$SETTINGS" ]; then
  err "$SETTINGS missing — can't start SearXNG without it."
  exit 1
fi

log "Starting SearXNG stack ($CONTAINER_ENGINE run; net=$NET)…"

# Idempotent: network (ignore "already exists"), then recreate containers.
"$CONTAINER_ENGINE" network create "$NET" >/dev/null 2>&1 || true
"$CONTAINER_ENGINE" rm -f "$SEARXNG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true

"$CONTAINER_ENGINE" run -d \
  --name "$REDIS_NAME" \
  --restart unless-stopped \
  --network "$NET" \
  --network-alias redis \
  -v searxng-redis:/data \
  "$REDIS_IMAGE" \
  valkey-server --save 30 1 --loglevel warning >/dev/null

"$CONTAINER_ENGINE" run -d \
  --name "$SEARXNG_NAME" \
  --restart unless-stopped \
  --network "$NET" \
  -p "127.0.0.1:9080:8080" \
  -v "$SETTINGS:/etc/searxng/settings.yml:ro" \
  -e "SEARXNG_BASE_URL=http://localhost:9080/" \
  -e "SEARXNG_REDIS_URL=redis://redis:6379/0" \
  "$SEARXNG_IMAGE" >/dev/null

log "Waiting for SearXNG to come up on 127.0.0.1:9080 (up to 30 s)…"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:9080/healthz"; then
    ok=1; break
  fi
  # /healthz may not exist on every searxng version; try the homepage too.
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:9080/"; then
    ok=1; break
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  err "SearXNG didn't respond in 30 s. Check logs: make searxng-logs"
  exit 1
fi
printf "${GREEN}✓${RESET} SearXNG is up\n"

log "Probing JSON search endpoint with a tiny query…"
if curl -fsS -m 10 "http://127.0.0.1:9080/search?q=test&format=json" >/dev/null 2>&1; then
  printf "${GREEN}✓${RESET} JSON endpoint responsive\n"
else
  warn "JSON endpoint didn't return 200 — maybe the engines are still warming up."
  warn "Try again in a few seconds, or check: $CONTAINER_ENGINE logs searxng"
fi

log "Configuring hermes (~/.hermes/config.yaml + ~/.hermes/.env)…"
python3 "$HERE/scripts/configure-hermes-tools.py"

cat <<DONE

${GREEN}─── SearXNG stack running ───${RESET}

  URL (host):       http://127.0.0.1:9080
  URL (container):  http://host.docker.internal:9080
  Engine:           $CONTAINER_ENGINE (network: $NET)
  Settings file:    $SETTINGS
  Stop:             make searxng-down
  Logs:             make searxng-logs

  ${YELLOW}Restart hermes so it picks up the new toolsets + env:${RESET}
    make hermes-down && make hermes-up

DONE
