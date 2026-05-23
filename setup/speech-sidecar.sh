#!/usr/bin/env bash
# Run the HermesAgent Faceplate speech sidecar natively — no container.
#
# Sets up a uv-managed Python venv with Kokoro-82M TTS (via kokoro-onnx) +
# faster-whisper ASR + openWakeWord, then serves the OpenAI-compatible
# /v1/audio/* surface on 127.0.0.1:8080. Point the Faceplate at the printed
# URL + token (Settings -> Speech Sidecar).
#
# Usage:
#   setup/speech-sidecar.sh up [--port PORT]   start (sets up on first run)
#   setup/speech-sidecar.sh down               stop
#   setup/speech-sidecar.sh status             running? reachable?
#   setup/speech-sidecar.sh logs               tail the log
#
# State lives under ~/.faceplate/ : the venv, voices, pid + log, token.

set -euo pipefail

cmd="${1:-up}"
if [ $# -gt 0 ]; then shift; fi

port="8080"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="${2:?--port needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sidecar_src="$repo_root/sidecar"
host="127.0.0.1"
state="$HOME/.faceplate"
venv="$state/sidecar-venv"
voices="$state/sidecar/voices"
pid_file="$state/sidecar.pid"
log_file="$state/sidecar.log"
token_file="$state/sidecar.token"

is_running() { [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file" 2>/dev/null)" 2>/dev/null; }

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

print_connect() {
  echo
  echo "Faceplate → Settings → Speech Sidecar:"
  echo "  URL:   http://$host:$port"
  echo "  Token: $(cat "$token_file")"
}

# Download the Kokoro model + voices file into the host voices dir. The
# container entrypoint does this against /voices; native runs need it on
# the host. Pinned to v1.0; ~352 MB total, one-time per machine.
bootstrap_kokoro() {
  local base="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
  local model="$voices/kokoro-v1.0.onnx"
  local vbin="$voices/voices-v1.0.bin"
  if [ -f "$model" ] && [ -f "$vbin" ]; then return 0; fi
  echo "Downloading Kokoro (~352 MB, one-time)…"
  if [ ! -f "$model" ]; then
    if ! curl -fsSL "$base/kokoro-v1.0.onnx" -o "$model.tmp"; then
      echo "⚠ Kokoro model download failed — TTS will 5xx until present"
      rm -f "$model.tmp"; return 0
    fi
    mv "$model.tmp" "$model"
  fi
  if [ ! -f "$vbin" ]; then
    if ! curl -fsSL "$base/voices-v1.0.bin" -o "$vbin.tmp"; then
      echo "⚠ Kokoro voices download failed"
      rm -f "$vbin.tmp"; return 0
    fi
    mv "$vbin.tmp" "$vbin"
  fi
}

do_up() {
  if is_running; then
    echo "· sidecar already running (pid $(cat "$pid_file"))"
    print_connect
    return 0
  fi

  if ! command -v uv >/dev/null 2>&1; then
    echo "uv not found — installing it (https://astral.sh/uv)…"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v uv >/dev/null 2>&1 || {
    echo "✗ uv still not on PATH — open a new shell and re-run" >&2
    exit 1
  }

  mkdir -p "$state" "$voices"

  if [ ! -d "$venv" ]; then
    echo "Creating Python venv at $venv …"
    uv venv "$venv"
  fi
  echo "Installing sidecar dependencies (first run downloads wheels)…"
  uv pip install --python "$venv/bin/python" -e "$sidecar_src" --quiet

  if [ ! -f "$token_file" ]; then
    gen_token > "$token_file"
    chmod 600 "$token_file"
    echo "✓ generated bearer token → $token_file"
  fi

  bootstrap_kokoro

  echo "Starting sidecar on $host:$port …"
  FACEPLATE_API_KEY="$(cat "$token_file")" \
  FACEPLATE_VOICES_DIR="$voices" \
    nohup "$venv/bin/python" -m uvicorn faceplate_sidecar.main:app \
      --host "$host" --port "$port" --no-server-header \
      >"$log_file" 2>&1 &
  echo $! > "$pid_file"

  for _ in $(seq 1 30); do
    if curl -fsS "http://$host:$port/health" >/dev/null 2>&1; then
      echo "✓ sidecar healthy"
      print_connect
      return 0
    fi
    sleep 1
  done
  echo "✗ sidecar didn't answer /health within 30s — check $log_file" >&2
  exit 1
}

do_down() {
  if is_running; then
    kill "$(cat "$pid_file")" && echo "✓ sidecar stopped"
  else
    echo "· sidecar wasn't running"
  fi
  rm -f "$pid_file"
}

case "$cmd" in
  up)     do_up ;;
  down)   do_down ;;
  status)
    if is_running; then
      echo "✓ sidecar running (pid $(cat "$pid_file")) — http://$host:$port"
    else
      echo "✗ sidecar not running"
    fi
    ;;
  logs)
    if [ -f "$log_file" ]; then tail -f "$log_file"; else echo "no log yet — run: $0 up"; fi
    ;;
  -h|--help)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown command: $cmd (use up | down | status | logs)" >&2
    exit 2
    ;;
esac
