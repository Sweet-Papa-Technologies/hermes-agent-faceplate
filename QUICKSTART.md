# Quickstart — Faceplate in 5 minutes

The fastest path from a fresh clone to a working desktop avatar for
HermesAgent. For the deeper reference (architecture, the standalone setup
scripts, remote-Hermes setups, troubleshooting), see [SETUP.md](./SETUP.md).

## What this is

A desktop avatar / overlay GUI for a **HermesAgent you already run**. The
Faceplate is a thin client — it talks to Hermes over HTTP with a URL + key
and nothing else. Voice (TTS / STT / wake-word) is optional; chat works
typing-only.

## Prereqs

| Tool | Version | Why | Install |
|---|---|---|---|
| **Node** | ≥ 22 | Electron runtime | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **pnpm** | ≥ 10 | Package manager | `npm install -g pnpm` |
| **HermesAgent** | latest | The brain (you run it, the Faceplate connects) | [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) |
| **uv** (optional) | latest | Native speech sidecar; auto-installed by the setup script if missing | n/a |

Run `make check-prereqs` to confirm Node + pnpm.

## Three commands to a working app

```sh
git clone <this-repo> hermes-agent-faceplate
cd hermes-agent-faceplate
make setup    # 1. install app deps (pnpm install)
make app      # 2. launch the Electron app (Vite + Electron dev)
```

The wizard auto-opens on first launch. Two short steps:

1. **Connect to HermesAgent** — paste the gateway URL (e.g.
   `http://127.0.0.1:8642/v1`) and `API_SERVER_KEY` from your Hermes `.env`.
   Click *Re-probe* — the chip turns green when Hermes answers `/v1/health`.
2. **Voice** — pick **Off** (type-only), **Push-to-talk**, or **Wake word**.
   Off is fine to start; flip it on later from Settings → Voice.

You're done. Open the typing bar with **Ctrl+Space** and ask something.

## Adding voice (optional)

```sh
bash setup/speech-sidecar.sh up
```

What it does, in order:

1. Installs `uv` (Astral's Python package manager) if missing — to
   `~/.local/bin`, no sudo.
2. Creates a Python venv at `~/.faceplate/sidecar-venv`.
3. Installs the sidecar package editable from `./sidecar/`.
4. Generates a bearer token at `~/.faceplate/sidecar.token`.
5. Downloads Kokoro-82M (~352 MB, pinned to v1.0) into
   `~/.faceplate/sidecar/voices/` on first run.
6. Starts the sidecar at `http://127.0.0.1:8080` under `nohup` and polls
   `/health` until it answers.
7. Prints the URL + token to paste into **Settings → Voice**.

Once Settings has the URL + token, the sidecar chip flips to *up · cpu*,
the mic LED works, and TTS plays through your selected speaker. Voices are
swappable from the dropdown — Kokoro bundles every voice in one file, no
per-voice download.

Subcommands: `up` (default), `down`, `status`, `logs`.

## Hermes Pings (optional, advanced)

Have Hermes ping you on its own — cron jobs, autonomous `send_message_tool`
calls, scheduled reminders. Two setups depending on where Hermes runs:

**Local Hermes** (same machine as the Faceplate):
- In the app: **Settings → Notifications & Pings → Install plugin.**
- Restart your Hermes gateway when prompted so the plugin loader picks it up.

**Remote Hermes** (different machine, or a container whose `~/.hermes/` the
Faceplate can't write to):

```sh
# On the Hermes host, in a clone of this repo:
bash setup/hermes-faceplate-plugin.sh --bind 0.0.0.0
```

The script copies the plugin into that host's `~/.hermes/plugins/`,
appends env vars, and prints `ws://<host>:8643/ws` + the shared key.
Restart your Hermes gateway, then paste both into **Settings → Notifications
& Pings**.

There's also `bash setup/hermes-event-hooks.sh` for an event-tap that mirrors
every Hermes lifecycle event to the Faceplate (so the avatar reacts to
activity on Telegram, cron, etc., not just its own chat) — see SETUP.md.

## Keyboard shortcuts

- **Ctrl+Space** — typing bar (literal Ctrl on every OS; Spotlight owns Cmd+Space on macOS)
- **Ctrl+.** — interrupt the avatar mid-response
- **Ctrl+Shift+H** — show / hide the avatar
- **Ctrl+Shift+J** — open Conversations panel
- **Ctrl+Shift+K** — open Canvas (charts, diagrams, code, artifacts)
- **Ctrl+Shift+G** — bring all four windows to a screen-corner layout
- **Ctrl+Shift+Space** — push-to-talk (when voice is enabled)

All rebindable in Settings → Hotkeys.

## When something doesn't work

- **Wizard probe red** — confirm `API_SERVER_HOST=0.0.0.0` and
  `API_SERVER_ENABLED=true` in your Hermes `.env`, and that the container
  is started with `-p 127.0.0.1:8642:8642`. The wizard's *Re-probe* button
  re-runs the health check.
- **Voice chip stays "down"** — confirm the sidecar URL matches what
  `setup/speech-sidecar.sh up` printed. `bash setup/speech-sidecar.sh
  status` reports running / not-running; `… logs` tails the log.
- **TTS 401** — paste the bearer token from
  `~/.faceplate/sidecar.token` into Settings → Voice → *Bearer token*.

See [SETUP.md](./SETUP.md) for the full troubleshooting tree, remote-Hermes
walkthroughs, and the standalone setup scripts in detail.
