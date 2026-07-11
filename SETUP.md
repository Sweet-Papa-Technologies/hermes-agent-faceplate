# HermesAgent Faceplate — Setup

The deeper setup guide. For the 3-command happy path, start with
[QUICKSTART.md](./QUICKSTART.md). For the "why" behind the architecture,
see [`docs/v1/rescope.md`](./docs/v1/rescope.md).

## What this is, in one sentence

A desktop avatar / overlay GUI for a **HermesAgent you already run**, with
optional voice. The Faceplate is a client — it does not install, build, or
supervise any backend service. Backends are reached over the network by
URL + key; anything that has to live on a host is shipped as a standalone
script in [`setup/`](./setup/) that you run on that host.

## Architecture — three planes

| Plane | What it is | Who runs it | How the app reaches it |
|---|---|---|---|
| **The app** | Electron GUI: hotkeys, type bar, chat window, canvas, avatar, conversations. | You install the packaged app (or `make app` for dev). | n/a — it *is* the app |
| **HermesAgent** | The agent brain. | You (Hermes's own Docker workflow, bare metal, or cloud — see [HermesAgent docs](https://hermes-agent.nousresearch.com/docs/)). | HTTP, `hermes.base_url` + `hermes.api_key` |
| **Speech** *(optional)* | TTS + ASR + wake-word, OpenAI-compatible. | You (one of the options under [§ Speech setup](#speech-setup)). | HTTP/WS, `speech.sidecar_url` + token |

The app's only hard dependency is **plane 2 reachable by URL**. Plane 3 is
optional — chat works typing-only with voice off.

```
   ┌──────────────┐    ─8642─►  HermesAgent
   │              │             (your URL + key)
   │  Faceplate   │
   │  (Electron)  │
   │              │    ─8080─►  Speech sidecar (optional)
   │              │             Kokoro TTS + faster-whisper ASR + openWakeWord
   └──────────────┘
                       ─8643─►  Hermes Pings plugin (optional)
                                inside your Hermes process
```

## Quick install

Prereqs: Node ≥ 22, pnpm ≥ 10, a running HermesAgent. See
[QUICKSTART.md](./QUICKSTART.md) for install commands per OS.

```sh
git clone <this-repo> hermes-agent-faceplate
cd hermes-agent-faceplate
make setup    # one-time: pnpm install
make app      # launch the Electron dev build
```

The wizard auto-opens and asks for your Hermes URL + key. Done.

## Speech setup

Three ways to satisfy plane 3. The app doesn't care which one you pick —
Settings just wants a URL + bearer token.

### Option 1 (recommended): run the Faceplate sidecar natively

```sh
bash setup/speech-sidecar.sh up
```

What it does:

| Step | Effect |
|---|---|
| 1 | If `uv` (Astral's Python package manager) is missing, downloads + installs it to `~/.local/bin` (no sudo). |
| 2 | Creates a Python venv at `~/.faceplate/sidecar-venv`. |
| 3 | `uv pip install -e ./sidecar` — installs Kokoro-82M (via `kokoro-onnx`), faster-whisper, openWakeWord. |
| 4 | Generates a bearer token at `~/.faceplate/sidecar.token`. |
| 5 | Downloads the Kokoro model + voices file (~352 MB total, pinned to v1.0) into `~/.faceplate/sidecar/voices/`. |
| 6 | Starts uvicorn under `nohup`, pidfile `~/.faceplate/sidecar.pid`, log `~/.faceplate/sidecar.log`. |
| 7 | Polls `http://127.0.0.1:8080/health` for ≤ 30 s, then prints the URL + token. |

Re-runs are idempotent (existing venv / token / model preserved). Other
subcommands:

```sh
bash setup/speech-sidecar.sh down    # stop the sidecar
bash setup/speech-sidecar.sh status  # is it running?
bash setup/speech-sidecar.sh logs    # tail the log
```

Then in the app: **Settings → Voice → Enable voice** (master toggle) and
paste the URL + token. The chip flips to *up · cpu* once the sidecar is
reachable; voices are swappable from the dropdown.

### Option 2: bring your own Kokoro-FastAPI server

If you already run [Kokoro-FastAPI](https://github.com/remsky/kokoro-fastapi)
or another OpenAI-compatible TTS/ASR endpoint somewhere on your network:

- In the app: **Settings → Voice → Sidecar URL** = your URL (e.g.
  `http://10.0.0.5:8880`).
- Paste a bearer token if your endpoint requires one (empty if not).
- Wake-word requires the Faceplate sidecar's `/wake` WebSocket protocol —
  bring-your-own is fine for TTS + ASR (PTT) but doesn't ship wake-word.

### Option 3: keep voice off

The Faceplate is fully usable type-only. Set **Settings → Voice → Enable
voice = off** and ignore the rest. Toggle on later.

## Connecting to Hermes

The app's only hard dependency. The wizard collects this on first launch;
afterwards live in **Settings → Connection**.

```
Gateway URL:  http://127.0.0.1:8642/v1     (or your remote / LAN URL)
API key:      <your API_SERVER_KEY>
```

For a local Hermes-in-Docker, that means in your Hermes `~/.hermes/.env`:

```sh
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0       # the container reaches its own loopback;
                              # 0.0.0.0 lets the host reach it via port-map
API_SERVER_PORT=8642
API_SERVER_KEY=<pick a strong secret>
```

And the container is run with `-p 127.0.0.1:8642:8642`. (Hermes's own docs
have the full container `docker run` line.)

The Faceplate **does not install or manage Hermes** — it expects Hermes to
be running and reachable when you point at it. See [HermesAgent
docs](https://hermes-agent.nousresearch.com/docs/) for the upstream setup.

### Local vs remote Hermes — what changes

Everything in the core product (chat, canvas/artifacts, voice, conversations,
notifications) works against any Hermes you can reach by URL — **local,
LAN, or cloud**. The artifact protocol is injected into every request as an
`ephemeral_system_prompt` via the `instructions` field, so the canvas works
against a remote Hermes with zero filesystem access.

Two **optional** features need Hermes-side install (so they're easier when
Hermes is local):

- **Hermes Pings** — unprompted messages, see § below.
- **Event hooks** — the avatar reacts to lifecycle events on every channel
  (cron, Telegram, etc.), not just its own chat window.

## Hermes Pings

A Hermes-side plugin that opens a WebSocket the Faceplate subscribes to.
Every `send_message_tool` call, cron job with `deliver: faceplate`, and
autonomous fan-out routes through it.

### Hermes runs directly on this machine (no sandbox)

In the app: **Settings → Notifications & Pings → Install plugin.** A
preview dialog shows exactly what files will be touched. Click *Install*.
Restart your Hermes gateway so the plugin loader picks up the new folder.
Done.

### Every other setup (remote, sandboxed, containerised, different user)

Run on the machine and under the user that owns the Hermes process. SSH
to it (or open a shell into the sandbox / container) and:

```sh
bash setup/hermes-faceplate-plugin.sh --bind 0.0.0.0 [--port 8643]
```

The script:

1. Copies `hermes-plugin/faceplate/` into that host's `~/.hermes/plugins/faceplate/`.
2. Appends `FACEPLATE_API_KEY` (random), `FACEPLATE_HOME_CHANNEL=default`,
   `FACEPLATE_PORT`, and `FACEPLATE_BIND` to `~/.hermes/.env` — **never**
   overwriting an existing value.
3. Runs `hermes plugins enable faceplate`. Hermes ships user plugins
   *disabled* by default — without this step `hermes plugins list`
   shows the row but the adapter never starts on boot.
4. Prints the WebSocket URL (`ws://<host>:<port>/ws`) + key.

Restart your Hermes gateway. Then in the Faceplate: **Settings →
Notifications & Pings → Enable pings** and paste both. Verify on the
Hermes side with `hermes plugins list` (the `faceplate` row should say
*enabled*).

**One thing the Faceplate genuinely can't help with**: the WS port has to
be reachable from wherever the Faceplate runs. If Hermes lives behind a
firewall / sandbox / port-restricted runtime, expose the port per that
runtime's docs. (The Faceplate has no opinion about which runtime.)

### Testing

`~/.hermes/cron/test-faceplate-ping.yaml`:

```yaml
name: faceplate-ping-test
cron: "*/5 * * * *"
prompt: "Say a quick hello and tell me the current time."
deliver: faceplate
chat_id: ${FACEPLATE_HOME_CHANNEL}
```

Restart Hermes. Within 5 minutes you'll get an OS notification + a new
turn in the dedicated "Hermes pings" conversation.

## Event hooks (advanced)

Mirror every Hermes lifecycle event (pre/post LLM call, pre/post tool call,
session start/end, etc.) to the Faceplate's hook listener so the avatar
reacts to activity on every channel, not just its own chat window.

### Local Hermes

In the app: **Settings → Connection → System-wide event tap → toggle on.**
A preview dialog shows the script + the `hooks:` block being merged into
`~/.hermes/config.yaml`. Click *Install*.

### Remote Hermes

```sh
# On the Hermes host:
bash setup/hermes-event-hooks.sh --callback-url http://<faceplate-machine>:51789
```

The script writes the hook forwarder script into `~/.hermes/hooks/` and
either appends a clean `hooks:` block to `~/.hermes/config.yaml` (if none
exists) or prints the lines for you to merge by hand (if your config
already has a `hooks:` key — it never corrupts hand-edited YAML).

Restart Hermes. The Faceplate's local listener is on `127.0.0.1:51789`; for
a remote Hermes, that needs to be a reachable address from the Hermes host.

## Settings reference

Six panes after the M4 consolidation:

| Pane | What it controls |
|---|---|
| **Connection** | Hermes URL + key, capabilities probe, local-config discovery, canvas eagerness, optional shell-hook bridge. |
| **Voice** | Master enable, input mode (off / PTT / wake), PTT hotkey, wake-word config (advanced), mic + speaker pickers, sidecar URL + token, voice picker, rate, paraphrase toggle + trigger length. |
| **Avatar & Display** | Theme, scale, overlay vs windowed, position, always-on-top, click-through. |
| **Hotkeys** | All 10 global accelerators, rebindable. |
| **Notifications & Pings** | OS notifications (enabled/sound/mode/DND) and Hermes Pings (URL + key + chat_id + speak + in-app installer). |
| **Privacy** | Live network-egress table; telemetry toggle (off by default); mic-warning reset. |

`~/.hermes/config.yaml` is **never required** — every place the app
consults local Hermes config is an opt-in optimisation that gracefully
no-ops when the file isn't readable (e.g. remote Hermes). See
[`docs/v1/settings-only-setup.md`](./docs/v1/settings-only-setup.md) for the
detailed breakdown.

## Developer workflow

The Makefile is intentionally tiny — 6 dev targets:

```
make help            list targets
make check-prereqs   verify node + pnpm
make setup           pnpm install (one-time)
make app             quasar dev -m electron
make typecheck       vue-tsc --noEmit
make build           production build
make clean           remove app/dist
```

`setup/` scripts cover everything that used to be Makefile targets for
backend services.

## Troubleshooting

**Wizard probe red / `Couldn't reach hermes`.**
Verify Hermes is running and the API server is enabled:
```sh
curl -fsS -H "Authorization: Bearer $YOUR_KEY" http://127.0.0.1:8642/v1/health
# → {"status":"ok"...}
```
Common misses: `API_SERVER_HOST` defaults to `127.0.0.1` *inside* the container
(unreachable through port-map); set `API_SERVER_HOST=0.0.0.0` in
`~/.hermes/.env`. `API_SERVER_ENABLED=true` is also required.

**Voice chip stays "down".**
`bash setup/speech-sidecar.sh status` — running? If not, `… up`. If yes,
`… logs` to see why `/health` isn't answering. Confirm the URL in
**Settings → Voice** matches what the script printed.

**TTS / ASR returns HTTP 401.**
Bearer-token mismatch. Read the live one from
`cat ~/.faceplate/sidecar.token` and paste it into **Settings → Voice →
Bearer token**.

**`uv` install fails.**
The setup script runs `curl -LsSf https://astral.sh/uv/install.sh | sh`. If
your machine blocks that, install `uv` manually (e.g. `brew install uv`)
and re-run the script.

**Kokoro model download fails partway.**
The script writes to `*.tmp` first and only renames on success — a partial
download is left as `*.tmp` and the script will retry on next `up`. You
can also `rm ~/.faceplate/sidecar/voices/*.tmp` and try again.

**Pings WebSocket won't connect.**
Three questions, in order:

1. *Is the plugin **enabled**?* On the Hermes host: `hermes plugins list`.
   The `faceplate` row should say **enabled**. Hermes ships user plugins
   disabled by default — if it says *not enabled*, run
   `hermes plugins enable faceplate` and restart the gateway. The setup
   script + in-app installer both attempt this automatically, but it can
   fail silently if the `hermes` CLI isn't on the launcher's PATH.
2. *Is the plugin loaded?* From the Hermes host, hit its `/health`:
   `curl http://127.0.0.1:8643/health` → `{"ok": true, "subscribers": {...}}`.
   If this fails *on the Hermes host itself* after #1, check the gateway
   boot log for a `[faceplate]` line and a `register_platform` error.
3. *Is the port reachable from the Faceplate-host?* From the Faceplate
   machine, hit the same URL using the Hermes host's address. If `/health`
   answers on the Hermes host but not from here, the port is firewalled
   or sandboxed — open it per your Hermes runtime's docs. The Faceplate
   has no opinion about how (it's a port-reachability problem, not a
   Faceplate problem).

## What's NOT in scope (by design)

The re-scope to a thin client deliberately drops:

- **App-managed container engines** — no Podman install, no `podman machine`
  lifecycle, no Hermes container build / start / stop. Run Hermes per
  Hermes's own docs.
- **LiteRT-LM / Gemma** — the on-device paraphrase model. Paraphrase
  routes through your Hermes-configured LLM directly (bypassing the agent
  loop so session memory isn't corrupted).
- **SearXNG, LLM-tunnel, configure-hermes-tools** — those configure
  Hermes's tools, not the Faceplate's. Configure your Hermes per Hermes's
  docs.

See [`docs/v1/rescope.md`](./docs/v1/rescope.md) for the full rationale.
