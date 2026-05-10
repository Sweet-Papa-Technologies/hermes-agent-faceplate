#!/usr/bin/env bash
# Tunnel a LAN LLM (e.g. LM Studio at 192.168.1.99:8080) into the Docker
# container that runs hermes-agent.
#
# Why: Docker Desktop on macOS bridges the container off a private subnet
# whose default route doesn't include arbitrary LAN IPs. From inside the
# container, `192.168.1.99:8080` times out even though the host can reach
# it instantly. The container CAN reach the host via `host.docker.internal`,
# so we run socat ON THE HOST as a TCP proxy: container ─► host.docker.internal:18080
# ─► macOS network stack ─► 192.168.1.99:8080.
#
# Idempotent. Re-runnable. Edits ~/.hermes/config.yaml the first time
# (with a timestamped backup) so hermes points at the tunnel.
#
# Override-able env vars:
#   LLM_TUNNEL_PORT   (default: 18080)
#   LITERT_HOME       (default: $HOME/.faceplate — pid + log live here)

set -euo pipefail

LLM_TUNNEL_PORT="${LLM_TUNNEL_PORT:-18080}"
HOME_DIR="${LITERT_HOME:-$HOME/.faceplate}"
PID_FILE="$HOME_DIR/llm-tunnel.pid"
LOG_FILE="$HOME_DIR/llm-tunnel.log"
HERMES_CONFIG="$HOME/.hermes/config.yaml"

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

mkdir -p "$HOME_DIR"

# ─── ensure socat ─────────────────────────────────────────────────────────

if ! command -v socat >/dev/null 2>&1; then
  log "socat not found — installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    err "Homebrew not found. Install socat manually (or 'brew install socat')."
    exit 1
  fi
  brew install socat
fi

# ─── parse current LLM target from hermes config ──────────────────────────

if [ ! -r "$HERMES_CONFIG" ]; then
  err "$HERMES_CONFIG missing or unreadable. Run hermes setup first."
  exit 1
fi

target="$(python3 - <<'PY'
import sys, yaml
from urllib.parse import urlparse
import os
cfg_path = os.path.expanduser('~/.hermes/config.yaml')
with open(cfg_path) as f:
    cfg = yaml.safe_load(f) or {}
url = (cfg.get('model') or {}).get('base_url', '')
if not url:
    print('NO_URL', file=sys.stderr); sys.exit(1)
u = urlparse(url)
host = u.hostname
port = u.port or 80
if not host:
    print('NO_HOST', file=sys.stderr); sys.exit(1)
if host == 'host.docker.internal':
    print(f'ALREADY_TUNNELED:{port}', file=sys.stderr); sys.exit(2)
print(f'{host}:{port}')
PY
)" || {
  rc=$?
  if [ "$rc" -eq 2 ]; then
    warn "hermes config already points at host.docker.internal — tunnel will be reused, but the original LAN target is unknown. If you need to retarget, restore the backup at ~/.hermes/config.yaml.bak.tunnel.* first."
  else
    err "Couldn't parse model.base_url from $HERMES_CONFIG."
    exit 1
  fi
}

# ─── stop existing socat ──────────────────────────────────────────────────

if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE")"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "Stopping existing socat tunnel (pid $old_pid)…"
    kill "$old_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# ─── start the new tunnel ─────────────────────────────────────────────────

if [ -n "${target:-}" ]; then
  log "Starting socat tunnel: 127.0.0.1:$LLM_TUNNEL_PORT  →  $target"
  nohup socat \
    "TCP-LISTEN:$LLM_TUNNEL_PORT,bind=127.0.0.1,fork,reuseaddr" \
    "TCP:$target" \
    >>"$LOG_FILE" 2>&1 &
  new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  sleep 1
  if ! kill -0 "$new_pid" 2>/dev/null; then
    err "socat exited immediately. Last 20 lines of $LOG_FILE:"
    tail -n 20 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
fi

# ─── update hermes config to use the tunnel ───────────────────────────────

if [ -n "${target:-}" ]; then
  backup="$HERMES_CONFIG.bak.tunnel.$(date +%Y%m%d-%H%M%S)"
  cp "$HERMES_CONFIG" "$backup"
  python3 - <<PY
import yaml, os
p = os.path.expanduser('~/.hermes/config.yaml')
with open(p) as f:
    cfg = yaml.safe_load(f) or {}
cfg.setdefault('model', {})['base_url'] = 'http://host.docker.internal:$LLM_TUNNEL_PORT/v1'
with open(p, 'w') as f:
    yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
PY
  log "Patched hermes model.base_url → http://host.docker.internal:$LLM_TUNNEL_PORT/v1"
  log "Backup: $backup"
fi

# ─── verify reachability from inside the hermes container ─────────────────

if docker ps --format '{{.Names}}' | grep -q '^hermes-personal$'; then
  log "Probing tunnel from inside hermes-personal container…"
  if docker exec hermes-personal curl -sS -m 5 -o /dev/null \
       -w 'http=%{http_code}\nconnect=%{time_connect}s\n' \
       "http://host.docker.internal:$LLM_TUNNEL_PORT/v1/models"; then
    printf "${GREEN}✓${RESET} container can reach the tunneled LLM\n"
  else
    warn "container probe failed — check $LOG_FILE and that the upstream LLM is up."
  fi
fi

cat <<DONE

${GREEN}─── socat tunnel running ───${RESET}

  Listen:    127.0.0.1:$LLM_TUNNEL_PORT
  Target:    ${target:-(reusing existing tunnel)}
  PID:       $(cat "$PID_FILE" 2>/dev/null || echo '?') (file: $PID_FILE)
  Log:       $LOG_FILE

  hermes container reaches it as: http://host.docker.internal:$LLM_TUNNEL_PORT/v1

  Restart hermes so it picks up the config change:
    ${YELLOW}make hermes-down && make hermes-up${RESET}

DONE
