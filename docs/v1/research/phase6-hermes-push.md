# Phase 6 — Subscribing to Unprompted HermesAgent Messages

> Research brief produced 2026-05-12 to inform Phase 6 of `v1.todo.md` (BIG: unprompted agent messages). Future sessions implementing this should re-read first.

## 1. Outbound surfaces Hermes exposes

Hermes' gateway has a clean separation between **inbound API endpoints** (request/response, plus run-scoped SSE) and **outbound platform adapters** (long-lived push channels). Unprompted/agent-initiated messages are emitted exclusively through the outbound adapter layer.

- **Cron scheduler** (`/opt/hermes/cron/scheduler.py`) runs `_deliver_result()` after each fired job. It resolves a `DeliveryTarget` (`gateway/delivery.py`) and routes through `tools/send_message_tool._send_to_platform()`. Allowed targets live in `_KNOWN_DELIVERY_PLATFORMS` (telegram, discord, slack, whatsapp, signal, matrix, mattermost, homeassistant, dingtalk, feishu, wecom, sms, email, **webhook**, bluebubbles, qqbot, yuanbao) **plus** any plugin platform that registers `cron_deliver_env_var` via `gateway/platform_registry.py`.
- **Built-in platform adapters** (`/opt/hermes/gateway/platforms/*.py`) — telegram, discord, slack, etc. — are persistent connections owned by the gateway. The same `send()` method is invoked both by the agent's `send_message` tool (autonomous decision) **and** the cron scheduler (scheduled push).
- **Webhook adapter** (`gateway/platforms/webhook.py`) is bidirectional: it primarily *receives* HTTP POSTs that trigger the agent, but also supports `deliver_only` routes and is a valid cron `deliver=` target. There is **no first-class "callback URL" mechanism** in the built-in webhook adapter for outbound — it expects to deliver by reusing another platform.
- **`api_server` adapter** (port 8642) — `/v1/responses`, `/v1/chat/completions`, `/v1/runs`. It is **explicitly excluded** from outbound delivery: `notify_exclude_platforms = ("api_server", "webhook")` in `gateway/config.py:233`, and `api_server` is **not** in `_KNOWN_DELIVERY_PLATFORMS`. Its only streaming surfaces are `GET /v1/runs/{run_id}/events` (SSE, scoped to a run the client just started) and `_write_sse_responses` — neither will deliver an unprompted message.

## 2. Concrete subscription mechanism for a custom client

Three viable paths, ranked:

1. **Register a plugin platform adapter** (recommended). Per `gateway/platforms/ADDING_A_PLATFORM.md`, drop a `~/.hermes/plugins/faceplate/{plugin.yaml, adapter.py}` that subclasses `BasePlatformAdapter`, registers via `ctx.register_platform()` with `cron_deliver_env_var="FACEPLATE_HOME_CHANNEL"`, and exposes `send()`. The adapter holds an open WebSocket (or long-poll queue) that the Faceplate connects to. When cron / `send_message` calls `adapter.send(chat_id, text, …)`, the adapter pushes the payload over that socket.
2. **Webhook callback route**. Configure a `platforms.webhook.routes.faceplate_outbound` entry plus a parallel cron job whose `deliver=` writes to a custom plugin platform that POSTs to a Faceplate-hosted HTTP endpoint. Less natural — webhook is built for inbound, not outbound.
3. **Tail the cron output dir**. `~/.hermes/cron/output/*.json` is written for every job (even local). Good for audit/visibility, useless for autonomous `send_message_tool` invocations (those never hit cron output). Reject for primary path.

## 3. Message shape

Adapter `send()` receives `(chat_id, text, metadata={"thread_id": ...})` plus optional media via `send_image/send_voice/send_document/send_video/send_animation`. Cron output is wrapped (when `cron.wrap_response: true`) as:

```
Cronjob Response: <name>
(job_id: <id>)
-------------
<content>
```

Media is encoded in-text as `MEDIA:` tags and stripped by `BasePlatformAdapter.extract_media()` before send. **The shape is NOT a `/v1/responses` envelope** — it's a flat text + attachment list, identical to what Telegram/Discord adapters receive. Role is implicitly `assistant`.

## 4. Authentication

Plugin adapters are loaded inside the gateway process — no external auth is needed for cron→adapter. The Faceplate↔adapter socket auth is **the plugin author's responsibility**: pick a token (e.g. `FACEPLATE_API_KEY`) read from env in `env_enablement_fn`, and require it on the WebSocket handshake. Per-user authorization piggybacks on `_is_user_authorized()` (`gateway/run.py`) via `FACEPLATE_ALLOWED_USERS` / `FACEPLATE_ALLOW_ALL_USERS` env vars.

## 5. Conversation linkage

Each adapter constructs a `SessionSource` via `self.build_source(...)` (platform + chat_id + optional thread_id). The gateway maps that to a Hermes session ID; cron jobs created with `deliver=origin` route back to the originating `SessionSource`. For the Faceplate, treat each `useConversationStore` conversation as a `chat_id` (e.g. UUID of the conversation) and pass it on every inbound user message; unprompted pushes will arrive tagged with the same `chat_id`, so routing into the right store entry is a dictionary lookup.

## 6. Example traffic — Telegram cron path (3 bullets)

- `cron/scheduler.py:tick()` fires due jobs → runs the agent → `_deliver_result(job, content)`.
- `_resolve_delivery_targets(job)` returns `{"platform": "telegram", "chat_id": "<TELEGRAM_HOME_CHANNEL>"}`; `_deliver_result` looks up the live `TelegramAdapter` from the gateway's `adapters` dict and calls `runtime_adapter.send(chat_id, cleaned_delivery_content, metadata={"thread_id": …})` via `asyncio.run_coroutine_threadsafe`.
- If the live adapter is missing/fails, it falls back to standalone `_send_to_platform(Platform.TELEGRAM, pconfig, chat_id, content, …)` in `tools/send_message_tool.py`, which spins up a one-shot `python-telegram-bot` Bot just to push the message and exit.

## 7. Recommended approach for the Faceplate

Build a **`faceplate` plugin platform** in `~/.hermes/plugins/faceplate/`:

- `plugin.yaml` declares `FACEPLATE_API_KEY`, `FACEPLATE_HOME_CHANNEL`, `FACEPLATE_PORT`.
- `adapter.py` runs an aiohttp WebSocket server (e.g. `ws://localhost:8643/ws`). On `send()`, it pushes a JSON frame `{type:"message", chat_id, text, media:[…], thread_id, ts}` to all connected sockets matching `chat_id`.
- Set `cron_deliver_env_var="FACEPLATE_HOME_CHANNEL"` so cron `deliver=faceplate` works without core edits.
- Faceplate (Electron) opens a single persistent WS at app startup, authenticates with the API key, and dispatches frames to `useConversationStore` keyed by `chat_id`.
- For symmetry, the Faceplate keeps using `/v1/responses` for user-initiated turns (no change to existing flow), but tags each user turn with the same `chat_id` so unprompted pushes route correctly.

This avoids forking Hermes core, gives you the same delivery semantics as Telegram/Discord, supports cron + autonomous `send_message_tool` + webhook fan-out for free, and uses the documented extension point.

## Citations

Local container paths and URLs:
- `/opt/hermes/gateway/platforms/ADDING_A_PLATFORM.md` (plugin contract, all 16 integration points)
- `/opt/hermes/gateway/platforms/api_server.py` (lines 11-15, 600-603, 3060-3110 — confirms api_server is request/response + per-run SSE only, no outbound push)
- `/opt/hermes/gateway/platforms/webhook.py` (deliver_only, inbound-first design)
- `/opt/hermes/gateway/platforms/base.py` (`BasePlatformAdapter` send/send_image/build_source)
- `/opt/hermes/cron/scheduler.py` lines 86-93 (`_KNOWN_DELIVERY_PLATFORMS`), 480-640 (`_deliver_result`)
- `/opt/hermes/gateway/delivery.py` (`DeliveryTarget`, `DeliveryRouter`)
- `/opt/hermes/gateway/config.py:233` (`notify_exclude_platforms = ("api_server", "webhook")`)
- `/opt/hermes/tools/send_message_tool.py` (`_send_to_platform`, `_send_telegram`)
- https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters (plugin system, `cron_deliver_env_var`, `standalone_sender_fn`)
- https://github.com/NousResearch/hermes-agent — reference plugins under `plugins/platforms/{irc,teams,google_chat}/`

## Genuinely undocumented / not-findable

There is **no first-party `/v1/inbox`, `/v1/notifications`, or persistent SSE feed for unprompted messages** on api_server. The plugin-platform path is the only sanctioned channel; everything else (tailing `cron/output/`, scraping `state.db`, hijacking `/v1/runs/*/events`) is brittle.
