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
COMPOSE="$HERE/searxng/docker-compose.yml"

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "docker compose plugin not installed"; exit 1; }

log "Starting SearXNG stack (compose file: $COMPOSE)…"
docker compose -f "$COMPOSE" up -d

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
  warn "Try again in a few seconds, or check: docker logs searxng"
fi

log "Configuring hermes (~/.hermes/config.yaml + ~/.hermes/.env)…"
python3 "$HERE/scripts/configure-hermes-tools.py"

cat <<DONE

${GREEN}─── SearXNG stack running ───${RESET}

  URL (host):       http://127.0.0.1:9080
  URL (container):  http://host.docker.internal:9080
  Compose:          $COMPOSE
  Settings file:    $HERE/searxng/settings.yml
  Stop:             make searxng-down
  Logs:             make searxng-logs

  ${YELLOW}Restart hermes so it picks up the new toolsets + env:${RESET}
    make hermes-down && make hermes-up

DONE
