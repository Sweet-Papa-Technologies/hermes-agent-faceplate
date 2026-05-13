# Settings-only Setup — Confirmed

> Resolution to the "Things to Confirm" item in `v1.todo.md`:
> *"Ensure app can be setup by simply inputting the Hermes gateway URL and API key. WE SHOULD not need the config.YAML or anything like that at all."*

**Verdict:** Confirmed. The Faceplate works end-to-end with only two pieces of input — `hermes.base_url` and `hermes.api_key` — entered in the Settings UI or the wizard. No `~/.hermes/config.yaml` access is required.

## Where the local config IS consulted

Every place that touches `~/.hermes/config.yaml` is an **opt-in optimization**, never a hard dependency. When the file is absent or unreadable (typical for Docker / remote Hermes deployments), the feature gracefully no-ops.

| Surface | What it uses local config for | Behavior when missing |
|---|---|---|
| `paraphrase-bridge.ts` `tryHermesLlm()` | Reads `model.base_url` + `model.api_key` from local config so paraphrase can POST direct to the underlying LLM, bypassing the Hermes agent loop (which would corrupt session memory). | Falls through to `local_litert` sidecar with `fallback_reason: 'unsafe_to_bypass'`. Phase 1 hid the LiteRT UI option, so this falls back to `disabled` and TTS just speaks the full text. |
| `hermes-discovery.ts` `discoverHermes()` | Returns `local_config_readable: true/false` so the wizard + Settings can offer a contextual "we see your local config" banner. | `local_config_readable: false`. UI hides the banner. Everything still works via HTTP probe of `hermes.base_url`. |
| `hook-installer.ts` | Optional feature: writes `hermes-faceplate-hook.sh` into `~/.hermes/hooks/` + appends a `hooks:` block to `config.yaml` so non-API channels (Telegram, cron, etc.) are also voiced through the Faceplate. | Hook installer button is hidden / disabled. Feature is unavailable but app still runs. |
| `seedHermesApiKeyFromLocalEnv()` (boot) | If `settings.hermes.api_key` is empty AND local `~/.hermes/.env` has `API_SERVER_KEY`, seed it on first run so the user doesn't have to paste it twice. | No-op. User pastes the key in Settings. |

## Minimum required for a working install

1. **`hermes.base_url`** — the gateway URL (e.g. `http://127.0.0.1:8642/v1` for local Docker Hermes, or `https://hermes.your-company.com/v1` for remote).
2. **`hermes.api_key`** — `API_SERVER_KEY` from the Hermes deployment's `.env`. Required for non-loopback URLs.
3. **`speech.sidecar_url`** OR **`speech.tts.kokoro_url`** — depends on TTS engine (Phase 3). Defaults to the bundled Docker sidecar at `http://127.0.0.1:8080`.

That's it. Everything else has a sensible default.

## Architectural implication for Phase 5 onboarding

The wizard should:

1. Ask **where Hermes lives** (you have one running, you want us to help you set one up, or you want to run it on the same machine).
2. Collect **URL + API key** for the "you have one running" path.
3. For "help me set it up", link to the canonical HermesAgent docs (no embedded installer — we don't want to ship Hermes ourselves; v1 Faceplate is a frontend for HermesAgent, not a bundle).
4. Pick **TTS engine** — bundled Piper sidecar (Docker) vs Kokoro (Docker, recommended for higher-quality voices, also via `docker run ghcr.io/remsky/kokoro-fastapi-cpu:latest`) vs external URL.
5. No prompts for config.yaml path, no peeks into `~/.hermes/` beyond the opt-in optimizations above.
