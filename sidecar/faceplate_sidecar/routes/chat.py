"""POST /v1/chat/completions — reverse-proxy to the LiteRT-LM api server.

Skipped for the cpu-slim image (no LLM bundled). The Faceplate's paraphrase
fallback hits this only when the user-configured LLM is unreachable.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from ..auth import require_bearer
from ..config import get_config


router = APIRouter()
_log = logging.getLogger("faceplate_sidecar.chat")


@router.post("/v1/chat/completions", dependencies=[Depends(require_bearer)])
async def chat_completions(request: Request) -> Any:
    cfg = get_config()
    if cfg.build == "cpu-slim" or not cfg.paraphrase.enabled:
        raise HTTPException(
            501, detail="paraphrase fallback is disabled in this build"
        )

    upstream = f"http://127.0.0.1:{cfg.paraphrase.api_server_port}/v1/chat/completions"
    body = await request.body()
    headers = {
        "content-type": request.headers.get("content-type", "application/json"),
    }
    if cfg.paraphrase.api_server_key:
        headers["authorization"] = f"Bearer {cfg.paraphrase.api_server_key}"

    is_stream = _is_streaming_request(body)

    if not is_stream:
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                resp = await client.post(upstream, content=body, headers=headers)
            except httpx.ConnectError:
                raise HTTPException(503, "LiteRT-LM upstream unavailable")
        # Pass through the upstream status + content-type so callers can
        # surface 4xx/5xx with the upstream's error body intact.
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )

    async def proxy_stream() -> AsyncIterator[bytes]:
        # Drop the timeout — SSE is a long-poll. We rely on Starlette
        # cancelling this generator when the client disconnects, which
        # in turn cancels the inner stream context.
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=None)) as client:
            try:
                async with client.stream(
                    "POST", upstream, content=body, headers=headers
                ) as resp:
                    if resp.status_code >= 400:
                        # Preserve the upstream error body in the SSE payload.
                        text = await resp.aread()
                        yield (
                            f"event: error\ndata: {json.dumps({'status': resp.status_code, 'body': text.decode('utf-8', 'replace')[:240]})}\n\n"
                        ).encode()
                        return
                    async for chunk in resp.aiter_raw():
                        if await request.is_disconnected():
                            return
                        yield chunk
            except httpx.ConnectError:
                yield b"event: error\ndata: {\"status\":503,\"body\":\"LiteRT-LM upstream unavailable\"}\n\n"

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")


def _is_streaming_request(body: bytes) -> bool:
    """Robust stream-flag detection — JSON-parses instead of substring matching."""
    if not body:
        return False
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return False
    return bool(parsed.get("stream")) if isinstance(parsed, dict) else False
