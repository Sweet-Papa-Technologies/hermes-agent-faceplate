# Faceplate plugin for HermesAgent

Lets the HermesAgent Faceplate desktop app receive **unprompted / agent-initiated** messages from Hermes — cron jobs, autonomous `send_message_tool` calls, webhook fan-out, etc.

Without this plugin, the Faceplate is response-only (it speaks when you talk to it). With it, Hermes can ping you on its own.

## Architecture in one paragraph

Hermes has no first-party `/v1/inbox` or push SSE on its API server (see `docs/v1/research/phase6-hermes-push.md`). The only sanctioned channel for outbound/agent-initiated messages is the **plugin platform** system — adapters that subclass `BasePlatformAdapter` and expose a `send()` method. The built-in Telegram, Discord, etc. adapters all work this way; cron + autonomous decisions all route through them. This plugin adds a `faceplate` platform whose `send()` fans messages out over a local WebSocket. The Faceplate (Electron) opens a persistent WS to it at startup.

## Install

```sh
# From this repo
cp -R hermes-plugin/faceplate ~/.hermes/plugins/faceplate

# Add to ~/.hermes/.env (generate a strong random key for production)
cat >> ~/.hermes/.env <<'EOF'
FACEPLATE_API_KEY=replace-me-with-a-random-secret
FACEPLATE_HOME_CHANNEL=default
FACEPLATE_PORT=8643
EOF

# Restart the Hermes gateway so the plugin loader picks up the new dir.
docker restart hermes-personal   # or however you restart yours
```

Then in the Faceplate: Settings → Notifications & Push → enable "Receive unprompted messages from Hermes", paste the same `FACEPLATE_API_KEY` value.

## Verify

```sh
# Health check (no auth required; reports subscriber counts).
curl http://127.0.0.1:8643/health
# {"ok": true, "subscribers": {"*": 1}}   (with the Faceplate connected)
```

## Send a test ping from a cron job

`~/.hermes/cron/test-faceplate-ping.yaml`:

```yaml
name: faceplate-ping-test
cron: "*/5 * * * *"
prompt: "Say a quick hello and tell me the current time."
deliver: faceplate
chat_id: ${FACEPLATE_HOME_CHANNEL}
```

Restart the gateway. Within 5 minutes, the Faceplate should pop a notification + write the message into its "Hermes pings" conversation.

## Authentication

- The WS handshake requires `Authorization: Bearer <FACEPLATE_API_KEY>`. Anything else returns 401.
- The token is read from the Hermes container's environment, never written to disk by the adapter.
- The Faceplate stores its copy in `settings.yaml` (chmod 600 by Quasar/Electron defaults).

## Wire format

Server → client (one frame per `send()` call):

```json
{
  "type":      "message",
  "chat_id":   "default",
  "thread_id": null,
  "text":      "Hello! It's 2:32 PM.",
  "media":     null,
  "ts":        1734567890123
}
```

## Limitations

- Outbound only. Inbound messages from the Faceplate (for replies via macOS notification's `hasReply`) aren't routed back through this adapter yet — replies in v1 still go via the normal `/v1/responses` chat path. Phase 6+ work could thread them through.
- Single-process. The aiohttp server lives inside the gateway process; if you scale Hermes horizontally, only one instance can bind the port. Easy to address later by moving to a Redis fan-out.
