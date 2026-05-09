"""FastAPI entrypoint. Wires routes, CORS, and the lifespan hook that spawns
the LiteRT-LM subprocess (when enabled).
"""
from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .backends.litert_lm import LiteRtLmProcess
from .config import get_config
from .health import collect_status
from .routes import asr, chat, tts, voices, wake


_log = logging.getLogger("faceplate_sidecar.main")
_litert: LiteRtLmProcess | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg = get_config()
    global _litert
    if cfg.paraphrase.enabled and cfg.build != "cpu-slim":
        _litert = LiteRtLmProcess(cfg.paraphrase)
        _litert.start()
    try:
        yield
    finally:
        if _litert is not None:
            await _litert.stop_async()


def create_app() -> FastAPI:
    cfg = get_config()

    if not cfg.auth.bearer_token and os.environ.get("FACEPLATE_DEV") != "1":
        _log.warning(
            "FACEPLATE_API_KEY is empty — bearer auth is DISABLED. "
            "Set FACEPLATE_API_KEY or FACEPLATE_DEV=1 to silence this warning."
        )

    cors_kwargs = _build_cors_kwargs(cfg.auth.cors_origins)

    app = FastAPI(
        title="HermesAgent Faceplate Speech Sidecar",
        version=__import__("faceplate_sidecar").__version__,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        **cors_kwargs,
    )

    # Routes
    app.include_router(tts.router)
    app.include_router(asr.router)
    app.include_router(wake.router)
    app.include_router(chat.router)
    app.include_router(voices.router)

    # Health
    @app.get("/health")
    @app.get("/v1/health")
    def health() -> dict[str, object]:
        return collect_status()

    return app


def _build_cors_kwargs(origins: list[str]) -> dict[str, Any]:
    """Translate the user-friendly `cors_origins` list into Starlette kwargs.

    Entries with `*` (e.g. `http://localhost:*`) become a regex; literal
    origins go through as-is. We do NOT collapse to `["*"]` because that
    nullifies the design's "lock to localhost" rule (DESIGN-CORE.md §7.6).
    """
    literals: list[str] = []
    patterns: list[str] = []
    for origin in origins:
        if "*" in origin:
            # http://localhost:* → http://localhost(:\d+)?
            pattern = re.escape(origin).replace(r"\*", r"\d+")
            patterns.append(f"^{pattern}$")
        else:
            literals.append(origin)
    out: dict[str, Any] = {"allow_origins": literals}
    if patterns:
        out["allow_origin_regex"] = "|".join(patterns)
    return out


app = create_app()
