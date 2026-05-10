#!/usr/bin/env bash
# Start the official google-ai-edge LiteRT-LM CLI as a host-native HTTP
# server speaking the OpenAI Chat Completions API. The Faceplate's
# paraphrase pass talks to this on 127.0.0.1:7860 for short, low-latency
# rewrites without burning hermes-agent's session memory.
#
# Idempotent. Re-runnable. Leaves a PID file at $HOME/.faceplate/litert.pid.
#
# Override-able env vars:
#   LITERT_PORT        (default: 7860)
#   LITERT_HOST        (default: 127.0.0.1)
#   LITERT_MODEL       (default: gemma-4-E2B-it — see DESIGN-ADDENDUM-01 §4)
#   LITERT_HF_REPO     (default: litert-community/gemma-4-E2B-it-litert-lm)
#   LITERT_HF_FILE     (default: gemma-4-E2B-it.litertlm)
#   LITERT_BACKEND     (default: cpu — "gpu" or "npu" if your platform supports it)
#   LITERT_HOME        (default: $HOME/.faceplate — pid + log live here)

set -euo pipefail

# Defaults match DESIGN-ADDENDUM-01.md §4 — Gemma 4 E2B IT via LiteRT-LM.
# Override LITERT_MODEL/LITERT_HF_REPO/LITERT_HF_FILE together to swap to a
# different model (e.g. `gemma-3n-e2b-it` from `litert-community/gemma-3n-...`).
LITERT_PORT="${LITERT_PORT:-7860}"
LITERT_HOST="${LITERT_HOST:-127.0.0.1}"
LITERT_MODEL="${LITERT_MODEL:-gemma-4-E2B-it}"
LITERT_HF_REPO="${LITERT_HF_REPO:-litert-community/gemma-4-E2B-it-litert-lm}"
LITERT_HF_FILE="${LITERT_HF_FILE:-gemma-4-E2B-it.litertlm}"
LITERT_BACKEND="${LITERT_BACKEND:-cpu}"
LITERT_HOME="${LITERT_HOME:-$HOME/.faceplate}"
PID_FILE="$LITERT_HOME/litert.pid"
LOG_FILE="$LITERT_HOME/litert.log"

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
log()  { printf "${GREEN}▸${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

mkdir -p "$LITERT_HOME"

# ─── ensure litert-lm CLI exists ──────────────────────────────────────────

ensure_litert_lm() {
  if command -v litert-lm >/dev/null 2>&1; then
    return 0
  fi
  log "litert-lm CLI not found — installing via pipx…"
  if ! command -v pipx >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      log "Installing pipx via Homebrew…"
      brew install pipx
      pipx ensurepath
    elif command -v python3 >/dev/null 2>&1; then
      log "Installing pipx via pip --user…"
      python3 -m pip install --user pipx
      python3 -m pipx ensurepath
    else
      err "Need pipx (or brew, or python3 to bootstrap). Install one and re-run."
      exit 1
    fi
    # Refresh PATH for this session — pipx ensurepath only edits shell rc.
    export PATH="$HOME/.local/bin:$PATH"
  fi
  pipx install litert-lm
  # PATH refresh in case pipx put litert-lm somewhere new.
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v litert-lm >/dev/null 2>&1; then
    err "litert-lm install completed but the command isn't on PATH. Open a new shell or rerun."
    exit 1
  fi
}

ensure_litert_lm

# ─── ensure model is pulled ───────────────────────────────────────────────

ensure_model() {
  if litert-lm list 2>/dev/null | grep -qE "(^| )$LITERT_MODEL( |$)"; then
    log "Model '$LITERT_MODEL' already imported"
    return 0
  fi
  log "Importing '$LITERT_MODEL' from HuggingFace ($LITERT_HF_REPO/$LITERT_HF_FILE, one-time, ~2.6 GB)…"
  if ! litert-lm import \
       --from-huggingface-repo "$LITERT_HF_REPO" \
       "$LITERT_HF_FILE" \
       "$LITERT_MODEL"; then
    err "Failed to import '$LITERT_MODEL' from $LITERT_HF_REPO."
    err "If the repo is gated, run \`huggingface-cli login\` first."
    exit 1
  fi
}

ensure_model

# ─── stop existing instance ───────────────────────────────────────────────

if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE")"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "Stopping existing litert-lm serve (pid $old_pid)…"
    kill "$old_pid" 2>/dev/null || true
    # Give it 5 seconds to exit cleanly
    for _ in $(seq 1 5); do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# ─── start ────────────────────────────────────────────────────────────────

log "Starting litert-lm serve on $LITERT_HOST:$LITERT_PORT (api=openai, backend=$LITERT_BACKEND, model=$LITERT_MODEL)…"
nohup litert-lm serve \
  --host "$LITERT_HOST" \
  --port "$LITERT_PORT" \
  --api openai \
  >>"$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"

# ─── wait for readiness ───────────────────────────────────────────────────

log "Waiting for /v1/responses to respond (up to 90 s — first run loads the model)…"
for i in $(seq 1 90); do
  if ! kill -0 "$new_pid" 2>/dev/null; then
    err "litert-lm serve exited unexpectedly. Last 40 lines of $LOG_FILE:"
    tail -n 40 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  # A simple TCP probe — the OpenAI /v1/responses endpoint may need a real
  # POST to validate, so we just check that the port is accepting connections.
  if (echo > /dev/tcp/"$LITERT_HOST"/"$LITERT_PORT") >/dev/null 2>&1; then
    printf "${GREEN}✓${RESET} litert-lm is up\n"
    break
  fi
  if [ "$i" = "90" ]; then
    err "litert-lm didn't open port $LITERT_PORT in 90 s. Last 40 lines of log:"
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

cat <<DONE

${GREEN}─── litert-lm serve running ───${RESET}

  URL:        http://$LITERT_HOST:$LITERT_PORT/v1
  API:        OpenAI Chat Completions
  Model:      $LITERT_MODEL  (HF: $LITERT_HF_REPO)
  Backend:    $LITERT_BACKEND
  PID:        $new_pid (file: $PID_FILE)
  Log:        $LOG_FILE

  Logs:       tail -f $LOG_FILE
  Stop:       kill \$(cat $PID_FILE) && rm $PID_FILE
  Restart:    $0

DONE
