"""Faceplate platform adapter for HermesAgent.

Outbound-only platform: every ``send()`` (cron, autonomous
``send_message_tool``, webhook fan-out) is encoded as one JSON frame and
written to every connected Faceplate (Electron) client whose ``chat_id``
matches.

Wire format (server → client, one frame per call to send()):
    {
      "type":      "message",
      "chat_id":   "<routing key>",
      "thread_id": "<optional sub-thread>",
      "text":      "<the message body>",
      "media":     [...],            # optional media tags Hermes attached
      "ts":        1734567890123     # ms since epoch
    }

Auth: clients connect to ``ws://<host>:8643/ws?chat_id=...`` with header
``Authorization: Bearer <FACEPLATE_API_KEY>``. Mismatch returns HTTP 401
before the WS handshake completes.

Plugin-system contract (the version of the gateway in use as of writing
ships ``PluginContext.register_platform`` taking ``name``/``label``/
``adapter_factory``/``check_fn`` plus optional kwargs; the adapter base
class is ``BasePlatformAdapter`` with abstract ``connect``/``disconnect``/
``send``). See ``gateway.platforms.base`` and
``hermes_cli.plugins.PluginContext.register_platform``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Optional, Set

# Runtime imports — supplied by the Hermes gateway process that loads us.
# A minimal dev shim keeps the file importable for static analysis on
# machines without the Hermes venv. Each import lives in its own try so
# one missing symbol can't silently swap the WHOLE base class for a shim
# (which we did exactly once and chased through three loadFailures).
try:  # pragma: no cover - real import inside Hermes
    from gateway.platforms.base import BasePlatformAdapter  # type: ignore
except ImportError:  # pragma: no cover - dev shim
    class _BaseShim:  # minimal stand-in; methods are no-ops for type-checking
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def set_message_handler(self, _handler: Any) -> None: ...
        def _mark_connected(self) -> None: ...
        def _mark_disconnected(self) -> None: ...

    BasePlatformAdapter = _BaseShim  # type: ignore[assignment, misc]

try:  # pragma: no cover
    from gateway.platforms.base import SendResult  # type: ignore
except ImportError:  # pragma: no cover
    class _SendResultShim:
        def __init__(self, **kw: Any) -> None:
            for k, v in kw.items():
                setattr(self, k, v)

    SendResult = _SendResultShim  # type: ignore[assignment, misc]

try:  # pragma: no cover — Platform lives in gateway.config (an Enum with
    # a `_missing_` hook that creates pseudo-members for plugin platforms
    # after they're registered in platform_registry).
    from gateway.config import Platform  # type: ignore
except ImportError:  # pragma: no cover
    class _PlatformShim:
        def __init__(self, _name: str) -> None: ...

    Platform = _PlatformShim  # type: ignore[assignment, misc]

try:  # aiohttp ships with Hermes' default install.
    from aiohttp import WSMsgType, web
except ImportError as _err:  # pragma: no cover
    raise RuntimeError("aiohttp is required for the faceplate plugin") from _err

log = logging.getLogger("hermes.platforms.faceplate")

DEFAULT_PORT = 8643
HEARTBEAT_SEC = 30
PLATFORM = "faceplate"


class FaceplateAdapter(BasePlatformAdapter):  # type: ignore[misc]
    """Outbound-only platform: Hermes → Faceplate over a WebSocket.

    Instantiated by the ``adapter_factory`` passed to
    :func:`register` — receives a ``PlatformConfig`` whose ``extra`` dict
    is currently unused (we read everything from env, same shape as
    ``required_env`` declared in ``register()``).
    """

    platform_name = PLATFORM

    def __init__(self, config: Any, **_kwargs: Any) -> None:
        super().__init__(config=config, platform=Platform(PLATFORM))
        self._api_key = os.environ.get("FACEPLATE_API_KEY", "")
        self._port = int(os.environ.get("FACEPLATE_PORT", DEFAULT_PORT))
        # Listen interface. 127.0.0.1 when the Faceplate runs on the same
        # machine as Hermes; set FACEPLATE_BIND to a reachable address
        # (e.g. 0.0.0.0) when the Faceplate connects from another host.
        self._bind = os.environ.get("FACEPLATE_BIND", "127.0.0.1")
        self._home_channel = os.environ.get("FACEPLATE_HOME_CHANNEL", "default")
        # chat_id -> set of WS connections subscribed to that chat_id.
        # A "*" wildcard subscription receives every frame regardless of
        # chat_id — useful for the Faceplate's single-window UI.
        self._subscribers: Dict[str, Set[web.WebSocketResponse]] = {}
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._lock = asyncio.Lock()

    # ─── lifecycle ───────────────────────────────────────────────────

    async def connect(self) -> bool:
        """Bring up the WS server. Returns True on success.

        Called by the gateway on boot in place of the older ``start()``.
        Returning False (or letting an exception bubble) tells the
        gateway the platform failed to come online — it surfaces in
        ``hermes gateway status`` and is the right way to report
        configuration problems (missing API key, port in use, etc.).
        """
        if not self._api_key:
            log.warning("[faceplate] FACEPLATE_API_KEY not set; adapter disabled")
            return False
        try:
            app = web.Application()
            app.router.add_get("/ws", self._on_ws)
            app.router.add_get("/health", self._on_health)
            # Out-of-process delivery endpoint — POST a JSON frame and
            # have it broadcast to subscribers exactly like an in-process
            # send() would. The module-level _standalone_send() function
            # below targets this endpoint, which is what makes
            # `hermes send --to faceplate:<chat_id> "..."` work from any
            # process (CLI, separately-running cron, external scripts).
            app.router.add_post("/send", self._on_send)
            self._runner = web.AppRunner(app, access_log=None)
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, self._bind, self._port)
            await self._site.start()
            self._mark_connected()
            log.info("[faceplate] listening on ws://%s:%d/ws", self._bind, self._port)
            # Re-seed the channel directory once the gateway's own boot-time
            # rebuild has settled. The gateway calls
            # ``build_channel_directory()`` after every adapter connects, which
            # truncates plugin platforms to whatever ``_build_from_sessions()``
            # returns (always [] for us — the faceplate has no session origins
            # of its own). We patch the file back after that rewrite so
            # ``hermes send --to faceplate:<home_channel>`` resolves on the
            # CLI without the user having to memorise numeric IDs.
            asyncio.create_task(self._ensure_channel_directory_entry())
            return True
        except Exception as exc:  # noqa: BLE001 — surface as a connect failure
            log.error("[faceplate] failed to start WS server: %s", exc)
            await self._teardown_server()
            return False

    async def disconnect(self) -> None:
        """Tear down the WS server and drop every subscriber."""
        await self._teardown_server()
        async with self._lock:
            for conns in self._subscribers.values():
                for ws in list(conns):
                    try:
                        await ws.close(code=1001)
                    except Exception:  # noqa: BLE001
                        pass
            self._subscribers.clear()
        self._mark_disconnected()

    async def _ensure_channel_directory_entry(self) -> None:
        """Background task: wait for the gateway's startup directory
        rebuild to finish, then patch our home channel back in.

        Why this isn't a synchronous write in ``connect()``: the gateway
        calls ``build_channel_directory()`` *after* all adapter
        ``connect()`` calls complete, and that function writes the file
        from scratch — anything we wrote earlier is overwritten. A short
        deferred patch wins the race without us having to hook into the
        gateway's own lifecycle.

        Idempotent + restart-safe: re-checks the file each boot, only
        writes if our entry is missing. Errors are logged and swallowed
        — failure here just means the CLI's ``hermes send --to
        faceplate:<home_channel>`` route stays broken; nothing else
        cares about this file.
        """
        try:
            await asyncio.sleep(5.0)
            from pathlib import Path
            home_dir = Path(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))
            path = home_dir / "channel_directory.json"
            if not path.exists():
                log.debug("[faceplate] channel_directory.json not found (yet?) — skipping seed")
                return
            try:
                with path.open("r", encoding="utf-8") as f:
                    directory = json.load(f)
            except Exception as exc:
                log.warning("[faceplate] channel_directory.json unreadable, skipping seed: %s", exc)
                return
            platforms = directory.setdefault("platforms", {})
            entries = platforms.setdefault(PLATFORM, [])
            entry = {"id": self._home_channel, "name": self._home_channel, "type": "dm"}
            already = any(e.get("id") == entry["id"] for e in entries if isinstance(e, dict))
            if already:
                log.debug("[faceplate] channel directory already has %s — no-op", entry)
                return
            entries.append(entry)
            directory["platforms"] = platforms
            # Atomic replace via temp file in the same directory.
            tmp = path.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(directory, f, indent=2)
            os.replace(tmp, path)
            log.info("[faceplate] seeded channel_directory.json with %s", entry)
        except Exception as exc:  # noqa: BLE001 — never let this kill the gateway
            log.warning("[faceplate] _ensure_channel_directory_entry: %s", exc)

    async def _teardown_server(self) -> None:
        if self._site is not None:
            try:
                await self._site.stop()
            except Exception:  # noqa: BLE001
                pass
            self._site = None
        if self._runner is not None:
            try:
                await self._runner.cleanup()
            except Exception:  # noqa: BLE001
                pass
            self._runner = None

    # ─── send (called by cron + send_message_tool + webhook fan-out) ──

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,  # noqa: ARG002 — outbound-only, no thread state
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:  # SendResult at runtime
        """Fan out one text message to every matching WS subscriber.

        Signature mirrors ``BasePlatformAdapter.send``. Returns
        ``SendResult(success=True, ...)``  on dispatch even when no
        subscriber is currently connected — the message is consumed by
        the platform, just to nobody. (Hermes' agent loop treats the call
        as delivered regardless; we still emit a log line either way so
        operators can tell the difference between "delivered to N
        clients" and "fired but nobody listening".)
        """
        # INFO log every entry so a missing log line means Hermes never
        # called us at all (cron self-silenced via [SILENT], routed via
        # a different platform, etc.) — saves the most common
        # "where did my ping go?" debugging time.
        log.info(
            "[faceplate] send() chat_id=%s len=%d preview=%r",
            chat_id or self._home_channel,
            len(content),
            content[:80] + ("…" if len(content) > 80 else ""),
        )
        delivered = await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=content,
            metadata=metadata or {},
            media=None,
        )
        message_id = str(int(time.time() * 1000))
        return SendResult(
            success=True,
            message_id=message_id,
            raw_response={"delivered_to": delivered, "chat_id": chat_id},
        )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        delivered = await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "image", "url": image_url}],
        )
        return SendResult(
            success=True,
            message_id=str(int(time.time() * 1000)),
            raw_response={"delivered_to": delivered, "chat_id": chat_id},
        )

    async def send_voice(
        self,
        chat_id: str,
        audio_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        delivered = await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "audio", "url": audio_url}],
        )
        return SendResult(
            success=True,
            message_id=str(int(time.time() * 1000)),
            raw_response={"delivered_to": delivered, "chat_id": chat_id},
        )

    async def send_document(
        self,
        chat_id: str,
        document_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        delivered = await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "document", "url": document_url}],
        )
        return SendResult(
            success=True,
            message_id=str(int(time.time() * 1000)),
            raw_response={"delivered_to": delivered, "chat_id": chat_id},
        )

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:  # noqa: ARG002
        # No-op: the Faceplate avatar already shows a "thinking" indicator
        # driven by event hooks. A typing frame here would race that and
        # confuse the UI.
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Required by ``BasePlatformAdapter``. The Faceplate has no real
        notion of distinct chats — every connected client subscribes by
        ``chat_id`` (defaulting to ``FACEPLATE_HOME_CHANNEL``) and that's
        the entire addressing model. Hermes only reads this for display /
        logging, so we return a stable shape that matches what the other
        platforms produce."""
        resolved = chat_id or self._home_channel
        async with self._lock:
            subscriber_count = len(self._subscribers.get(resolved, set())) + len(
                self._subscribers.get("*", set())
            )
        return {
            "name": resolved,
            "type": "dm",  # the Faceplate is single-user by design
            "subscriber_count": subscriber_count,
        }

    # ─── internals ───────────────────────────────────────────────────

    async def _fanout(
        self,
        *,
        chat_id: str,
        text: str,
        metadata: Dict[str, Any],
        media,
    ) -> int:
        """Encode one frame, push it to every matching subscriber, return
        the number of clients we wrote to."""
        frame = json.dumps(
            {
                "type": "message",
                "chat_id": chat_id,
                "thread_id": metadata.get("thread_id"),
                "text": text,
                "media": media,
                "ts": int(time.time() * 1000),
            }
        )
        async with self._lock:
            direct = self._subscribers.get(chat_id, set())
            wild = self._subscribers.get("*", set())
            targets = list(direct) + list(wild)
            # Snapshot subscription map for the log so an operator can see
            # *why* a chat_id missed (e.g. subscriber to "default" while
            # Hermes sent to "abc-123").
            sub_summary = ", ".join(
                f"{k}={len(v)}" for k, v in self._subscribers.items()
            ) or "(none)"
        if not targets:
            log.warning(
                "[faceplate] _fanout: NO SUBSCRIBERS for chat_id=%s "
                "(currently subscribed: %s) — frame dropped",
                chat_id, sub_summary,
            )
            return 0
        results = await asyncio.gather(
            *(self._safe_send(ws, frame) for ws in targets),
            return_exceptions=True,
        )
        failures = sum(1 for r in results if isinstance(r, Exception))
        log.info(
            "[faceplate] _fanout: chat_id=%s delivered=%d/%d "
            "(direct=%d wild=%d failed=%d)",
            chat_id, len(targets) - failures, len(targets),
            len(direct), len(wild), failures,
        )
        return len(targets) - failures

    async def _safe_send(self, ws: web.WebSocketResponse, payload: str) -> None:
        """Push one frame to one client. Exceptions become a logged warning
        and are surfaced to ``asyncio.gather`` so ``_fanout`` can count
        partial failures rather than silently swallowing them."""
        try:
            await ws.send_str(payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("[faceplate] _safe_send: ws.send_str raised %s", exc)
            raise

    async def _on_health(self, _request: web.Request) -> web.Response:  # noqa: ARG002
        return web.json_response(
            {
                "ok": True,
                "subscribers": {k: len(v) for k, v in self._subscribers.items()},
            }
        )

    async def _on_send(self, request: web.Request) -> web.Response:
        """HTTP shim used by out-of-process callers (the CLI, separately-
        running cron processes, external scripts). Accepts the same shape
        as the in-process send() call and fans out via the same code path,
        so logs / subscriber lookup / wire format are identical to the
        gateway-internal path."""
        peer = request.remote or "?"
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {self._api_key}":
            log.warning("[faceplate] _on_send: REJECTED POST from %s (bad/missing bearer)", peer)
            raise web.HTTPUnauthorized(reason="invalid faceplate token")
        try:
            body = await request.json()
        except Exception as exc:
            log.warning("[faceplate] _on_send: bad JSON from %s: %s", peer, exc)
            raise web.HTTPBadRequest(reason="invalid JSON body") from exc
        chat_id = str(body.get("chat_id") or "").strip() or self._home_channel
        text = str(body.get("text") or "")
        media = body.get("media")  # optional list[{kind, url}]
        metadata = body.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        log.info(
            "[faceplate] _on_send: POST from %s chat_id=%s len=%d",
            peer, chat_id, len(text),
        )
        delivered = await self._fanout(
            chat_id=chat_id,
            text=text,
            metadata=metadata,
            media=media if isinstance(media, list) else None,
        )
        return web.json_response({
            "ok": True,
            "delivered_to": delivered,
            "chat_id": chat_id,
            "message_id": str(int(time.time() * 1000)),
        })

    async def _on_ws(self, request: web.Request) -> web.WebSocketResponse:
        # Auth: bearer token in Authorization header. We deliberately do
        # NOT support an `?api_key=` query param to keep the secret out
        # of access logs / routing tables. Raise instead of returning a
        # plain Response so the route signature stays WebSocketResponse.
        peer = request.remote or "?"
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {self._api_key}":
            log.warning("[faceplate] _on_ws: REJECTED handshake from %s (bad/missing bearer)", peer)
            raise web.HTTPUnauthorized(reason="invalid faceplate token")
        chat_id = request.query.get("chat_id", "*").strip() or "*"
        ws = web.WebSocketResponse(heartbeat=HEARTBEAT_SEC)
        await ws.prepare(request)
        async with self._lock:
            self._subscribers.setdefault(chat_id, set()).add(ws)
            total = sum(len(v) for v in self._subscribers.values())
        log.info(
            "[faceplate] _on_ws: client %s subscribed to chat_id=%s (total subscribers now: %d)",
            peer, chat_id, total,
        )
        try:
            await ws.send_str(
                json.dumps({"type": "hello", "chat_id": chat_id, "ts": int(time.time() * 1000)})
            )
            async for msg in ws:
                # Inbound from Faceplate is currently used only for
                # client-initiated PINGs / optional "I read this" acks.
                # Anything else is logged + ignored — this adapter is
                # outbound-only by design.
                if msg.type == WSMsgType.TEXT:
                    log.debug("[faceplate] inbound (ignored): %s", msg.data[:200])
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            async with self._lock:
                bucket = self._subscribers.get(chat_id)
                if bucket is not None:
                    bucket.discard(ws)
                    if not bucket:
                        self._subscribers.pop(chat_id, None)
                total = sum(len(v) for v in self._subscribers.values())
            log.info(
                "[faceplate] _on_ws: client %s disconnected from chat_id=%s (total subscribers now: %d)",
                peer, chat_id, total,
            )
        return ws


# ─── plugin entry points ──────────────────────────────────────────────


def check_requirements() -> bool:
    """Pre-instantiation check. Hermes calls this before constructing the
    adapter; returning False keeps the platform out of the runtime set
    (and out of ``gateway status`` as 'live'). We require the API key —
    everything else is optional with sensible defaults."""
    return bool(os.environ.get("FACEPLATE_API_KEY", ""))


def validate_config(_config: Any) -> bool:
    """Config-time validation. We don't read anything from config.yaml —
    only env vars — so the only failure mode is 'no API key', which
    ``check_requirements`` already covers."""
    return check_requirements()


def _env_enablement() -> Optional[Dict[str, Any]]:
    """Seed ``PlatformConfig.extra`` from env vars at gateway boot.

    The ``home_channel`` key is *special-cased* by
    ``gateway.config._load_plugin_platforms`` — when present, it's
    promoted to a proper ``HomeChannel`` on the platform config rather
    than being merged into ``extra``. Without it, ``hermes send --to
    faceplate "..."`` and any non-explicit chat_id (e.g. our literal
    "default") fail with "No home channel set for faceplate" because
    ``send_message_tool`` looks up the home channel via
    ``config.get_home_channel(platform)`` to determine where to route.

    Returning None tells the gateway "don't auto-enable" — for us
    that just means a missing API key, in which case the platform
    wouldn't have started anyway (``check_requirements`` would have
    returned False).
    """
    api_key = os.environ.get("FACEPLATE_API_KEY", "").strip()
    if not api_key:
        return None
    home_chat = (
        os.environ.get("FACEPLATE_HOME_CHANNEL", "").strip() or "default"
    )
    return {
        # PlatformConfig.extra fields — read by FaceplateAdapter.__init__
        # at construct time too, though env-reads there still take
        # precedence so settings stay consistent.
        "port": int(os.environ.get("FACEPLATE_PORT", DEFAULT_PORT)),
        "bind": os.environ.get("FACEPLATE_BIND", "127.0.0.1"),
        # Promoted by core to PlatformConfig.home_channel. This is what
        # `hermes send --to faceplate "..."` and send_message_tool's
        # home-channel fallback look at.
        "home_channel": {
            "chat_id": home_chat,
            "name": home_chat,
        },
    }


async def _standalone_send(
    _pconfig: Any,
    chat_id: str,
    chunk: str,
    thread_id: Optional[str] = None,
    media_files: Any = None,  # noqa: ARG001 — faceplate frames don't carry binary attachments
    force_document: bool = False,  # noqa: ARG001 — N/A for our wire format
) -> Dict[str, Any]:
    """Out-of-process delivery path. Called by ``send_message_tool`` (and
    therefore ``hermes send --to faceplate:<chat_id>``) when no live
    adapter is reachable in the calling process — i.e. anything that isn't
    the gateway itself.

    Implementation: POST a JSON frame to the running gateway's faceplate
    HTTP endpoint at ``http://<bind>:<port>/send`` using the same
    ``FACEPLATE_API_KEY`` bearer the WS handshake uses. Auth, fan-out, and
    logging then go through the same code path as in-process sends, so
    operators only need to learn one set of log lines.

    We deliberately use stdlib ``urllib.request`` (wrapped in
    ``asyncio.to_thread``) rather than aiohttp. The CLI's import path
    can pull this module in contexts where the aiohttp event loop isn't
    set up the way the gateway sets it up, and urllib avoids surprises.
    """
    import urllib.request
    import urllib.error

    api_key = os.environ.get("FACEPLATE_API_KEY", "")
    if not api_key:
        return {
            "success": False,
            "error": (
                "FACEPLATE_API_KEY not set in this process's environment. "
                "Make sure ~/.hermes/.env is loaded (the hermes CLI does "
                "this automatically; ad-hoc scripts should source it)."
            ),
        }
    port = int(os.environ.get("FACEPLATE_PORT", DEFAULT_PORT))
    # The plugin server may bind 0.0.0.0 (remote-faceplate case) but
    # standalone delivery is always intra-host: the CLI runs on the same
    # box as the gateway. Hitting 127.0.0.1 avoids the 0.0.0.0-as-target
    # gotcha on macOS and skirts firewall rules on bind-all setups.
    body = json.dumps(
        {
            "chat_id": chat_id or os.environ.get("FACEPLATE_HOME_CHANNEL", "default"),
            "text": chunk,
            **({"metadata": {"thread_id": thread_id}} if thread_id else {}),
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/send",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
    )

    def _do_post() -> Dict[str, Any]:
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                raw = resp.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {"raw": raw[:200]}
            if not parsed.get("ok"):
                return {"success": False, "error": f"plugin POST /send returned: {raw[:200]}"}
            return {
                "success": True,
                "message_id": parsed.get("message_id") or str(int(time.time() * 1000)),
                "delivered_to": parsed.get("delivered_to", 0),
            }
        except urllib.error.HTTPError as e:
            # 401: bad/missing FACEPLATE_API_KEY in this process's env.
            # 400: malformed body (shouldn't happen — we control it here).
            return {"success": False, "error": f"HTTP {e.code}: {e.reason}"}
        except urllib.error.URLError as e:
            # ECONNREFUSED → gateway isn't running, or plugin isn't loaded.
            return {
                "success": False,
                "error": (
                    f"Could not reach faceplate plugin at 127.0.0.1:{port} "
                    f"({e.reason}). Is `hermes gateway` running, and does "
                    f"`hermes plugins list` show faceplate as enabled?"
                ),
            }
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": f"Unexpected: {e}"}

    return await asyncio.to_thread(_do_post)


def register(ctx: Any) -> None:
    """Plugin entry point: called by Hermes' plugin loader at gateway boot."""
    ctx.register_platform(
        name=PLATFORM,
        label="Faceplate",
        adapter_factory=lambda cfg: FaceplateAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["FACEPLATE_API_KEY"],
        install_hint="No extra packages needed (aiohttp ships with Hermes).",
        # Cron home-channel delivery. Jobs with `deliver: faceplate` and
        # no explicit chat_id route to FACEPLATE_HOME_CHANNEL (default
        # "default").
        cron_deliver_env_var="FACEPLATE_HOME_CHANNEL",
        # Out-of-process delivery for `hermes send`, separately-running
        # cron processes, external scripts, anything that doesn't have a
        # live in-gateway adapter. POSTs to the plugin's HTTP /send
        # endpoint with the same FACEPLATE_API_KEY bearer.
        standalone_sender_fn=_standalone_send,
        # Env-driven config seeding. Tells the gateway about our home
        # channel (the key ingredient for `hermes send --to faceplate
        # "..."` to know where to route without an explicit chat_id)
        # and surfaces port/bind in `gateway status`. Without this,
        # send_message_tool errors with "No home channel set for
        # faceplate" because plugin platforms get no auto-wired home
        # channel from env vars the way built-ins do.
        env_enablement_fn=_env_enablement,
        # Display.
        emoji="🖥️",
        # No phone numbers / user-PII in faceplate frames.
        pii_safe=True,
    )
