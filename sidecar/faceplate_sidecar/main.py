"""FastAPI entrypoint. Wires routes + CORS.

The sidecar exposes only the audio/wake-word surface. The LLM (paraphrase
fallback) runs OUTSIDE the container as host-native `litert-lm serve` —
see scripts/start-litert.sh. The Faceplate's paraphrase pass talks to
the host LiteRT-LM URL directly (default http://127.0.0.1:7860/v1).
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_config
from .health import collect_status
from .routes import asr, tts, voices, wake


_log = logging.getLogger("faceplate_sidecar.main")


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
    )
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        **cors_kwargs,
    )

    # Routes — audio + wake only. /v1/chat/completions intentionally absent
    # (use the host litert-lm at 127.0.0.1:7860 directly).
    app.include_router(tts.router)
    app.include_router(asr.router)
    app.include_router(wake.router)
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
            pattern = re.escape(origin).replace(r"\*", r"\d+")
            patterns.append(f"^{pattern}$")
        else:
            literals.append(origin)
    out: dict[str, Any] = {"allow_origins": literals}
    if patterns:
        out["allow_origin_regex"] = "|".join(patterns)
    return out


app = create_app()
