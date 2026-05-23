#!/usr/bin/env bash
# Install the HermesAgent Faceplate "Pings" plugin into a Hermes you run.
#
# Run this ON THE MACHINE WHERE HERMES RUNS. It copies the faceplate
# platform plugin into ~/.hermes/plugins/, wires the env vars Hermes needs,
# and prints the WebSocket URL + shared key to paste into the Faceplate
# (Settings -> Notifications & Pings).
#
# Usage:
#   setup/hermes-faceplate-plugin.sh [--bind ADDR] [--port PORT] [--hermes-home DIR]
#
#   --bind ADDR      Interface the plugin's WS server listens on. 127.0.0.1
#                    (default) when Hermes and the Faceplate share a machine;
#                    0.0.0.0 (or a specific address) when the Faceplate runs
#                    on a different machine.
#   --port PORT      WS port (default 8643).
#   --hermes-home D  Hermes data dir (default $HERMES_HOME, else ~/.hermes).
#
# Re-running is safe: existing ~/.hermes/.env values are never overwritten.

set -euo pipefail

usage() { sed -n '2,19p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; }

bind="127.0.0.1"
port="8643"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"

while [ $# -gt 0 ]; do
  case "$1" in
    --bind)        bind="${2:?--bind needs a value}"; shift 2 ;;
    --port)        port="${2:?--port needs a value}"; shift 2 ;;
    --hermes-home) hermes_home="${2:?--hermes-home needs a value}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_src="$repo_root/hermes-plugin/faceplate"
plugin_dst="$hermes_home/plugins/faceplate"
env_file="$hermes_home/.env"

[ -f "$plugin_src/plugin.yaml" ] || {
  echo "✗ plugin source not found at $plugin_src" >&2
  exit 1
}

# ── copy the plugin (full replace — the dir holds only our plugin) ───────
mkdir -p "$hermes_home/plugins"
rm -rf "$plugin_dst"
cp -R "$plugin_src" "$plugin_dst"
echo "✓ plugin copied → $plugin_dst"

# ── env: append-only, never clobber an existing value ────────────────────
touch "$env_file"

env_get() { grep -E "^$1=" "$env_file" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
env_has() { grep -qE "^$1=" "$env_file" 2>/dev/null; }
env_set() { # KEY VALUE — append iff missing
  if env_has "$1"; then
    echo "· $1 already set in $env_file — left as-is"
  else
    printf '%s=%s\n' "$1" "$2" >> "$env_file"
    echo "✓ $1 added to $env_file"
  fi
}

gen_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Make sure the file ends in a newline so the first append is on its own line.
if [ -s "$env_file" ] && [ -n "$(tail -c1 "$env_file")" ]; then
  printf '\n' >> "$env_file"
fi

env_set FACEPLATE_API_KEY      "$(gen_key)"
env_set FACEPLATE_HOME_CHANNEL "default"
env_set FACEPLATE_PORT         "$port"
[ "$bind" != "127.0.0.1" ] && env_set FACEPLATE_BIND "$bind"

# Effective values (existing, or what we just appended).
eff_key="$(env_get FACEPLATE_API_KEY)"
eff_port="$(env_get FACEPLATE_PORT)"
eff_bind="$(env_get FACEPLATE_BIND)"; eff_bind="${eff_bind:-127.0.0.1}"

echo
echo "Next: restart your Hermes gateway so the plugin loader picks it up."
echo
echo "Then, in the Faceplate → Settings → Notifications & Pings:"
if [ "$eff_bind" = "127.0.0.1" ]; then
  echo "  URL:  ws://127.0.0.1:$eff_port/ws"
else
  echo "  URL:  ws://<this-host>:$eff_port/ws   (use this machine's reachable address)"
fi
echo "  Key:  $eff_key"
