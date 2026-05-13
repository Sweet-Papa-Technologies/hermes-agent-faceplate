"""Faceplate platform adapter for HermesAgent.

Subclasses :class:`BasePlatformAdapter` and exposes a tiny aiohttp
WebSocket server. Every call to :meth:`send` is fanned out as a JSON frame
to every connected Faceplate client whose chat_id matches.

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
``Authorization: Bearer <FACEPLATE_API_KEY>``. Mismatch closes the socket
with code 4401.

Reference:
  - /opt/hermes/gateway/platforms/ADDING_A_PLATFORM.md
  - /opt/hermes/gateway/platforms/base.py
  - docs/v1/research/phase6-hermes-push.md
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Optional, Set

# These imports come from the running Hermes gateway. They aren't on the
# Faceplate's host PYTHONPATH — the file is loaded by Hermes' plugin
# loader inside the container. The dev shim below keeps the file
# importable for static analysis without pulling in the gateway runtime.
try:  # pragma: no cover - runtime import inside Hermes
    from gateway.platforms.base import BasePlatformAdapter, SessionSource  # type: ignore
except ImportError:  # pragma: no cover - dev shim
    class _BaseShim:
        def __init__(self, ctx: Any) -> None:
            self.ctx = ctx

    class _SessionSourceShim:
        def __init__(self, **_kwargs: Any) -> None:
            pass

    BasePlatformAdapter = _BaseShim  # type: ignore[assignment, misc]
    SessionSource = _SessionSourceShim  # type: ignore[assignment, misc]

try:  # aiohttp ships with Hermes' default container.
    from aiohttp import WSMsgType, web
except ImportError as _err:  # pragma: no cover
    raise RuntimeError("aiohttp is required for the faceplate plugin") from _err

log = logging.getLogger("hermes.platforms.faceplate")

DEFAULT_PORT = 8643
HEARTBEAT_SEC = 30
PLATFORM = "faceplate"


class FaceplateAdapter(BasePlatformAdapter):  # type: ignore[misc]
    """Outbound-only platform: Hermes → Faceplate over a WebSocket."""

    platform_name = PLATFORM

    def __init__(self, ctx: Any) -> None:
        super().__init__(ctx)
        self._api_key = os.environ.get("FACEPLATE_API_KEY", "")
        self._port = int(os.environ.get("FACEPLATE_PORT", DEFAULT_PORT))
        self._home_channel = os.environ.get("FACEPLATE_HOME_CHANNEL", "default")
        # chat_id -> set of WS connections subscribed to that chat_id.
        # A "*" wildcard subscription receives every frame regardless of
        # chat_id — useful for the Faceplate's single-window UI.
        self._subscribers: Dict[str, Set[web.WebSocketResponse]] = {}
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._lock = asyncio.Lock()

    # ─── lifecycle ───────────────────────────────────────────────────

    async def start(self) -> None:  # noqa: D401 - hermes calls this on boot
        if not self._api_key:
            log.warning("[faceplate] FACEPLATE_API_KEY not set; adapter disabled")
            return
        app = web.Application()
        app.router.add_get("/ws", self._on_ws)
        app.router.add_get("/health", self._on_health)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, "127.0.0.1", self._port)
        await self._site.start()
        log.info("[faceplate] listening on ws://127.0.0.1:%d/ws", self._port)

    async def stop(self) -> None:
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        async with self._lock:
            for conns in self._subscribers.values():
                for ws in list(conns):
                    await ws.close(code=1001)
            self._subscribers.clear()

    # ─── send (called by cron + send_message_tool + webhook fan-out) ──

    async def send(
        self,
        chat_id: str,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=text,
            metadata=metadata or {},
            media=None,
        )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "image", "url": image_url}],
        )

    async def send_voice(
        self,
        chat_id: str,
        audio_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "audio", "url": audio_url}],
        )

    async def send_document(
        self,
        chat_id: str,
        document_url: str,
        caption: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        await self._fanout(
            chat_id=chat_id or self._home_channel,
            text=caption or "",
            metadata=metadata or {},
            media=[{"kind": "document", "url": document_url}],
        )

    # ─── conversation linkage ────────────────────────────────────────

    def build_source(
        self, chat_id: str, thread_id: Optional[str] = None
    ) -> Any:  # SessionSource at runtime
        # Real SessionSource (gateway/platforms/base.py) accepts these
        # kwargs at runtime inside Hermes.
        return SessionSource(
            platform=PLATFORM,
            chat_id=chat_id or self._home_channel,
            thread_id=thread_id,
        )

    # ─── internals ───────────────────────────────────────────────────

    async def _fanout(
        self,
        *,
        chat_id: str,
        text: str,
        metadata: Dict[str, Any],
        media,
    ) -> None:
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
            targets = list(self._subscribers.get(chat_id, set()))
            targets += list(self._subscribers.get("*", set()))
        if not targets:
            log.info(
                "[faceplate] dropping send to chat_id=%s — no subscribers", chat_id
            )
            return
        await asyncio.gather(
            *(self._safe_send(ws, frame) for ws in targets),
            return_exceptions=True,
        )

    async def _safe_send(self, ws: web.WebSocketResponse, payload: str) -> None:
        try:
            await ws.send_str(payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("[faceplate] send failed: %s", exc)

    async def _on_health(self, _request: web.Request) -> web.Response:  # noqa: ARG002
        return web.json_response(
            {
                "ok": True,
                "subscribers": {k: len(v) for k, v in self._subscribers.items()},
            }
        )

    async def _on_ws(self, request: web.Request) -> web.WebSocketResponse:
        # Auth: bearer token in Authorization header. We deliberately do
        # NOT support an `?api_key=` query param to keep the secret out
        # of access logs / routing tables. Raise instead of returning a
        # plain Response so the route signature stays WebSocketResponse.
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {self._api_key}":
            raise web.HTTPUnauthorized(reason="invalid faceplate token")
        chat_id = request.query.get("chat_id", "*").strip() or "*"
        ws = web.WebSocketResponse(heartbeat=HEARTBEAT_SEC)
        await ws.prepare(request)
        async with self._lock:
            self._subscribers.setdefault(chat_id, set()).add(ws)
        log.info("[faceplate] client subscribed to chat_id=%s", chat_id)
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
            log.info("[faceplate] client disconnected from chat_id=%s", chat_id)
        return ws


def register(ctx: Any) -> None:
    """Hermes' plugin loader calls this once at gateway startup."""
    ctx.register_platform(
        name=PLATFORM,
        adapter_cls=FaceplateAdapter,
        cron_deliver_env_var="FACEPLATE_HOME_CHANNEL",
    )
