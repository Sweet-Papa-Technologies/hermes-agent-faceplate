# HermesAgent Faceplate

> A desktop avatar / overlay GUI for a HermesAgent you already run, with
> optional voice.

A thin Electron client for [HermesAgent](https://hermes-agent.nousresearch.com/).
Hotkey-driven typing bar, chat window, canvas for charts / diagrams / code
artifacts, transparent always-on-top avatar, optional Kokoro TTS and
push-to-talk / wake-word. Connects to Hermes by URL + key — the app does
not install or manage Hermes.

**Audience:** developers and technical users comfortable running a shell
command. See [`docs/v1/rescope.md`](./docs/v1/rescope.md) for the design
rationale (the "why we don't install Hermes for you" doc).

## Get started

Three commands and a Hermes URL. Full quickstart:
**[QUICKSTART.md](./QUICKSTART.md)**.

```sh
git clone <this-repo> hermes-agent-faceplate
cd hermes-agent-faceplate
make setup    # pnpm install
make app      # launch the Electron dev build
```

The wizard auto-opens — paste your Hermes URL + `API_SERVER_KEY` and pick
voice on/off. Done.

For the deeper guide (architecture, standalone setup scripts for remote
Hermes, Hermes Pings, event hooks, troubleshooting) see
**[SETUP.md](./SETUP.md)**.

## What's in this repo

```
app/                  Electron app (Vue 3 + Quasar + TypeScript)
sidecar/              Optional speech sidecar — FastAPI: Kokoro TTS +
                      faster-whisper ASR + openWakeWord
hermes-plugin/        Hermes-side plugin for "Pings" (unprompted messages)
setup/                Standalone scripts you run on whatever host a
                      backend service should live on:
                        speech-sidecar.sh           — TTS / ASR / wake
                        hermes-faceplate-plugin.sh  — Pings (run on Hermes host)
                        hermes-event-hooks.sh       — lifecycle event tap
installer/            curl/irm installer scripts for the packaged Electron
                      app (separate from the dev workflow above)
docs/                 Design docs + the v1 re-scope plan
```

## Status

v1 is in active development on `main`. The `rescope-thin-client` branch
holds the M2–M5 simplification work; see
[`docs/v1/rescope.md`](./docs/v1/rescope.md) for the milestone table.

## License

MIT — see [LICENSE](./LICENSE). Bundled / linked model weights have their
own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
