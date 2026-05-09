"""Bearer-token auth.

Single shared token; the Faceplate setup wizard either generates one or
accepts a user-supplied value. Empty token short-circuits to "no auth"
(useful for dev-mode docker-compose runs without a settings file).
"""
from __future__ import annotations

from fastapi import HTTPException, Request, status

from .config import get_config


async def require_bearer(request: Request) -> None:
    cfg = get_config()
    if not cfg.auth.bearer_token:
        return
    header = request.headers.get("authorization", "")
    # Allow query-param token for WebSocket clients that can't set headers.
    if not header.startswith("Bearer "):
        token = request.query_params.get("token", "")
    else:
        token = header[len("Bearer "):]
    if token != cfg.auth.bearer_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing bearer token",
        )
