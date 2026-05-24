# Re-scope — Faceplate as a thin client for HermesAgent

Status: **proposed — supersedes `podman-migration-plan.md`, reshapes `v1.todo.md`**
Date: 2026-05-21
Origin: review of the v1 setup/onboarding surface + a deliberate audience pivot.

---

## 1. Why re-scope

The app drifted. It was scoped for "most anyone," so it grew machinery to make
infrastructure invisible: app-managed Podman, a `podman machine` VM lifecycle,
a one-click Hermes container installer, SearXNG/LLM-tunnel orchestration, a
host-native LiteRT-LM server. Two of the project's own docs now contradict
each other on whether Python/LiteRT is even required, and the just-completed
Podman migration locked a decision — *"we never install or facilitate
bare-metal Hermes; the container is a security boundary"* — that exists only
to protect a non-technical user who was never going to use this app.

The honest read: that user left. The real audience is **developers and
technical users** comfortable running a shell command. For them, every piece
of "make infrastructure invisible" machinery is now a liability — code to
maintain forever, settings panes that confuse, and a brittle coupling to
HermesAgent's container internals (image, UID 10000, `gateway run`
entrypoint) that breaks every time Hermes changes.

This document re-scopes the app to what it actually is, and it picks up a
sharper distribution model proposed during the review: **ship the optional
backend pieces as standalone setup scripts**, so even a fully remote Hermes
can use every feature.

## 2. The product, in one sentence

> **A desktop avatar/overlay GUI for a HermesAgent you already run, with
> optional voice.**

Primary interface: the **type bar** (Ctrl+Space), the **chat window**, and
the **canvas/artifact window**. The avatar is the app's charm and a status
presence — kept, not demoted. Voice (TTS/STT/wake-word) is **optional**; the
app is fully usable type-only.

Audience: developers and technical users. We assume the user can run a shell
command and knows what a URL and an API key are. We do **not** assume they
want us to install or babysit infrastructure for them.

## 3. The governing principle

One rule resolves the entire mess:

> **The Faceplate is a client. It never installs, builds, pulls, or
> supervises a service lifecycle. It reaches every backend over the network
> by URL + key. Anything that must be installed on a host is shipped as a
> standalone setup script, run by the user on the host where that service
> lives — and each script ends by printing the URL + key to paste into
> Settings.**

Consequences:

- No container engine is the app's concern. Docker, Podman, bare metal,
  remote, cloud — the app does not know or care. It has a URL.
- Backends become **location-independent**. Hermes on this laptop, Hermes on
  a homelab box, Hermes in the cloud — identical from the app's side.
- Every backend piece is independently installable. You only run the script
  for the pieces you want, on the machine you want them on.

## 4. The three planes

| Plane | What it is | Who runs it | How the app reaches it |
|---|---|---|---|
| **The app** | Electron GUI — hotkeys, type bar, chat, canvas, avatar, conversations. | User installs the packaged app (one-line `curl`/`irm`). | n/a — it is the app |
| **HermesAgent** | The agent brain. The user runs it however they like (Hermes's own Docker workflow, bare metal, cloud). Hermes has its own install story; **we link to it, we do not own it.** | User | HTTP, `hermes.base_url` + `hermes.api_key` |
| **Speech** *(optional)* | TTS + ASR + wake-word. | User — three acquisition paths, §5.3 | HTTP/WS, `speech.url` + token |

The app's only hard dependency is **plane 2 reachable by URL**. Plane 3 is
optional. Everything else the repo currently ships (Podman management, Hermes
lifecycle, SearXNG, the tunnel, LiteRT) is **not a plane** — it is us bundling
other people's infrastructure, and it goes.

## 5. The `setup/` scripts

A new top-level `setup/` directory holds small, self-contained scripts. Each
is **run on the host where the service should live**, has minimal
dependencies, is idempotent, and **prints the URL + key to paste into
Faceplate Settings** as its last line.

### 5.1 `setup/hermes-faceplate-plugin.sh` — Hermes Pings

Run **on the Hermes host**. Installs the `faceplate` platform plugin into that
host's `~/.hermes/plugins/faceplate/`, appends `FACEPLATE_API_KEY` /
`FACEPLATE_HOME_CHANNEL` / `FACEPLATE_PORT` to `~/.hermes/.env` (generating a
key if absent, never clobbering), and tells the user to restart their Hermes
gateway. Takes a `--bind` argument (default `127.0.0.1`; set a reachable
interface for a remote Hermes). Prints `ws://<host>:8643` + the key.

Then: Settings → Notifications & Pings → paste URL + key. **This makes
remote-Hermes Pings possible** — previously impossible because the app could
only write to a local `~/.hermes/`.

### 5.2 `setup/hermes-event-hooks.sh` — event tap

Run **on the Hermes host**. Installs `hermes-faceplate-hook.sh` into
`~/.hermes/hooks/` and merges the `hooks:` block into `config.yaml`. Takes a
`--callback-url` argument so the hook posts back to the Faceplate machine's
reachable address (not blind loopback) — enabling the remote case.

### 5.3 `setup/speech-sidecar.sh` — voice

Run **wherever you want the speech service**. Sets up the Faceplate speech
sidecar as a **native `uv`-managed Python venv** (Piper TTS + faster-whisper
ASR + openWakeWord) and supervises nothing — it just starts it and prints the
URL + bearer token. No Docker, no Podman, no image variants.

Three ways a user can satisfy plane 3 — Settings just wants a URL:

1. **Bring your own** OpenAI-compatible TTS/ASR endpoint — paste its URL.
   (Note: wake-word needs the Faceplate sidecar's `/wake` WS protocol; a
   plain bring-your-own TTS/ASR endpoint supports PTT but not wake-word.)
2. **Run our sidecar** via `setup/speech-sidecar.sh`.
3. **DIY** — docs link out to Kokoro-FastAPI / Whisper projects with setup
   pointers; run it yourself, paste the URL.

## 6. End-to-end walkthroughs

**All-in-one (one machine).** Install the app. Run Hermes per Hermes's docs.
`setup/speech-sidecar.sh` if you want voice. Open the app → wizard → paste
Hermes URL+key → paste speech URL → done.

**Remote Hermes, core features.** Install the app. Point Settings at
`https://hermes.example.com/v1` + key. Chat, canvas/artifacts, and voice all
work — the canvas protocol is injected per-request (§7), so it needs nothing
installed on the Hermes side.

**Remote Hermes + Pings + hooks.** As above, then SSH to the Hermes box and
run `setup/hermes-faceplate-plugin.sh --bind 0.0.0.0` and
`setup/hermes-event-hooks.sh --callback-url http://<your-machine>:<port>`.
Paste the two printed URLs into Settings. Every feature now works against a
Hermes you don't share a filesystem with.

## 7. What the Faceplate still does *with* Hermes

Re-scoping does **not** sever the app from Hermes. It keeps a small,
well-isolated relationship — and drops only the container lifecycle:

- **Reads** `~/.hermes/config.yaml` when present (discovery banner) —
  opt-in, read-only, no-ops when absent.
- **Injects** the artifact/canvas protocol into every request via the
  `instructions` field (`ephemeral_system_prompt`) on `/v1/responses` and
  `/v1/runs`, or a `system` message on `/v1/chat/completions`. This already
  works (`canvas-instructions.ts` + `turn-handler.ts`) and is the *correct*
  channel — it needs no filesystem access and works against any Hermes.
- **Connects** over HTTP (chat) and WS (Pings) by URL + key.
- **Optionally installs** plugin/hooks — locally via the in-app button, or
  remotely via the `setup/` scripts. File copies into `~/.hermes/`, no
  container engine.
- **Never** installs, builds, starts, stops, or restarts the Hermes
  container. "Bring your own Hermes" is the only mode.

## 8. Cut / keep / change — file by file

### Cut

| File | Why |
|---|---|
| `app/src-electron/container-runtime.ts` | Engine abstraction — app no longer touches an engine |
| `app/src-electron/podman-installer.ts` | App no longer installs Podman |
| `app/src-electron/podman-machine.ts` | App no longer manages the Podman VM |
| `app/src-electron/hermes-lifecycle.ts` | App no longer manages the Hermes container |
| `app/src-electron/kokoro-lifecycle.ts` | Kokoro is bring-your-own-URL or a setup script |
| `app/src-electron/canvas-skill-installer.ts` | **Redundant** — protocol already injected per-request (§7) |
| `scripts/hermes/Dockerfile` | App no longer builds a Hermes image |
| `scripts/start-hermes.sh` | App no longer runs Hermes |
| `scripts/start-litert.sh` | LiteRT is dead — model too small, paraphrase routes through Hermes |
| `scripts/start-searxng.sh`, `searxng/` | Hermes tool config — not the Faceplate's job |
| `scripts/start-llm-tunnel.sh` | Hermes networking — not the Faceplate's job |
| `scripts/configure-hermes-tools.py` | Hermes config — move to a docs note |
| `app/src/components/settings/SettingsPodman.vue` | Container Engine pane — gone with the abstraction |

### Change

| File | Change |
|---|---|
| `app/src-electron/sidecar.ts` | Strip container lifecycle; keep only a URL health probe |
| `app/src-electron/agent-push-installer.ts` | Drop `restartHermesContainer` + the container-name guessing; keep the file-install half. Local install → "restart your Hermes" instruction; remote → the setup script |
| `app/src-electron/paraphrase-bridge.ts` | Remove the LiteRT path; paraphrase = via-Hermes-LLM or off |
| `electron-main.ts`, `electron-preload.ts`, `preload-api.ts` | Unwire IPC for every cut module |
| `app/src/stores/settings-schema.ts` | Drop `infra.container_engine`, LiteRT fields, sidecar image variant; ~74 fields → ~25 |
| `Makefile` | 31 targets → ~6 (dev-only: setup, app, typecheck, build, lint, clean) |
| `installer/install.sh` + `install.ps1` | Becomes **the** user path — fetch + place the packaged app. No second path. |

### Keep

`hermes-env.ts` (used by plugin/hook installers + the setup scripts),
`hook-installer.ts` + `hook-listener.ts` (local-Hermes convenience path),
`hermes-discovery.ts` (read-only), `hermes-tester.ts`, `canvas-instructions.ts`
(the correct canvas channel), `agent-push-bridge.ts` (WS client),
`hermes-plugin/faceplate/` (the payload the setup script installs), plus all
UI/window/store modules unrelated to infrastructure.

## 9. Settings — ~13 panes → 6

| New pane | Absorbs |
|---|---|
| **Connection** | Hermes URL + key + probe; artifact eagerness |
| **Voice** | old Audio I/O + Speech Sidecar + Voice Input + Paraphrase — collapsed to: on/off, speech URL + token, voice picker, PTT/wake mode, devices. No image variants, no mode radio, no container lifecycle, no LiteRT, no system-prompt textarea |
| **Avatar & Display** | theme, scale, overlay/windowed, position |
| **Hotkeys** | unchanged |
| **Notifications & Pings** | OS notifications + Hermes Pings (URL + key) |
| **Privacy** | egress table, telemetry |

Gone: **Container Engine**. Target: ~25 user-facing fields, the rest sane
defaults.

## 10. Onboarding — 6 steps → 3

1. **Welcome.**
2. **Connect to Hermes** — URL + key + probe. *"Don't have Hermes yet?"* →
   link to HermesAgent's own docs. No install-for-you branch.
3. **Voice** — Off / PTT / Wake. If on: paste a speech URL + token, or
   *"set one up"* → `setup/speech-sidecar.sh` instructions.

Display mode is auto-detected (overlay default; windowed on Wayland) and
changeable later in Settings — it does not need a wizard step.

## 11. Install & build

- **Users:** one packaged app, fetched by `installer/install.sh` /
  `install.ps1`. That is the only user-facing install path.
- **Contributors:** a ~6-target Makefile (`setup`, `app`, `typecheck`,
  `build`, `lint`, `clean`).
- **Optional backends:** the `setup/` scripts, run as needed.

## 12. Milestones

| M | Status | Scope |
|---|---|---|
| **M1** | ✅ done | This doc — review + sign-off. |
| **M2** | ✅ done | Cut the runtime layer: deleted the §8 "Cut" files, unwired IPC, stripped LiteRT from `paraphrase-bridge.ts`, shrunk the Makefile from 31 → 7 dev targets. Typecheck green. (~31 files, +165 / −4,582 lines.) |
| **M3** | ✅ done | Authored the `setup/` scripts (§5) — `speech-sidecar.sh`, `hermes-faceplate-plugin.sh`, `hermes-event-hooks.sh`. Patched `adapter.py` for `FACEPLATE_BIND`. Parameterized sidecar paths (`VOICES_DIR` env override) so native runs work without root. |
| **M3.5** | ✅ done | (Not in the original plan — added by user pivot.) Swapped Piper → Kokoro inside the bundled sidecar. New `backends/kokoro_tts.py`, rewrote `routes/tts.py` + `routes/voices.py`, `pyproject.toml` drops `piper-tts` for `kokoro-onnx` + `misaki[en]`. Entrypoint + setup script bootstrap Kokoro model + voices instead of a Piper voice. App schema `speech.tts.engine` collapses to single 'kokoro' value with `z.preprocess` migration from old 'piper' values. |
| **M4** | ✅ done | Settings 11 → 6 panes (Connection, Voice, Avatar & Display, Hotkeys, Notifications & Pings, Privacy); wizard 6 → 3 steps. Schema cleanup dropped 7 dead fields, added `speech.enabled` master switch. ~19 files, +590 / −1,687 lines. |
| **M5** | ✅ done | QUICKSTART / SETUP / sidecar README rewritten to the thin-client model; root README created; podman-migration-plan banner-marked as superseded; v1.todo trimmed. |

## 13. Open decisions

1. **Speech sidecar runtime** — native `uv` venv (recommended; this doc
   assumes it) vs. keep a Docker option. Native is the cleaner default; a
   Dockerfile can stay in-repo as a documented alternative, not an app path.
2. **In-app local installers** — keep the in-app buttons for plugin/hooks
   when Hermes is local (nice UX), with the `setup/` scripts covering remote?
   Or scripts only, for one code path? This doc assumes **keep both**.
3. **LiteRT** — delete outright (recommended) vs. quarantine. "Keep it
   disabled" is how the current mess accumulated; recommend delete.
4. **Avatars** — ship the three proper avatars (`v1.todo.md`) and remove the
   test ones before this lands.

## 14. Relationship to existing docs

- `podman-migration-plan.md` — **superseded.** The M0–M6 work was a competent
  execution of a goal this re-scope retires. Kept in git history; a
  "consumer edition" could revive it.
- `v1.todo.md` — items survive selectively: artifact/chart bugs, caption
  pacing, UI polish, push notifications all stay. The "install everything for
  the user," "app-managed Podman," SearXNG, and LiteRT items are dropped or
  satisfied by this re-scope. Its line-37 "make app NOT need Docker" and
  line-41 "Docker should be optional" are now **realised**, not deferred.
- `settings-only-setup.md` — still valid and reinforced: the app needs only
  `hermes.base_url` + `hermes.api_key`.
