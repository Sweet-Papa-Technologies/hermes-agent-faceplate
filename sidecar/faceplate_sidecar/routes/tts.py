"""POST /v1/audio/speech — OpenAI-compatible TTS.

Default backend is Piper (CPU). Stream mode returns chunked-transfer-encoded
MP3 (or other format). Non-stream mode returns the buffered bytes with a
proper content-length header.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import require_bearer
from ..backends.piper_tts import get_voice, synthesize_to_format
from ..config import TtsModelEntry, get_config


router = APIRouter()
_log = logging.getLogger("faceplate_sidecar.tts")


class TtsRequest(BaseModel):
    input: str = Field(..., max_length=8_000)
    voice: str
    model: str | None = None
    response_format: str = "mp3"
    speed: float = 1.0
    stream: bool = False


@router.post("/v1/audio/speech", dependencies=[Depends(require_bearer)])
async def speech(req: TtsRequest) -> Any:
    cfg = get_config()
    model = _resolve_model(cfg.tts_models, req.model or cfg.tts_default, req.voice)
    if not model.voice_path:
        raise HTTPException(400, f"voice path missing for model {model.name}")

    voice = get_voice(model.voice_path)
    media_type = _media_type(req.response_format)

    if not req.stream:
        # Non-streaming: buffer everything and return as one Response.
        chunks: list[bytes] = []
        async for chunk in synthesize_to_format(
            voice, req.input, req.response_format, req.speed
        ):
            chunks.append(chunk)
        body = b"".join(chunks)
        return Response(body, media_type=media_type)

    return StreamingResponse(
        synthesize_to_format(voice, req.input, req.response_format, req.speed),
        media_type=media_type,
    )


def _resolve_model(
    models: list[TtsModelEntry], requested: str, voice_hint: str
) -> TtsModelEntry:
    # Prefer exact match on `name`, otherwise fall back to a model whose
    # voice_path filename starts with the requested voice.
    for m in models:
        if m.name == requested:
            return m
    for m in models:
        if m.voice_path and voice_hint in m.voice_path:
            return m
    raise HTTPException(404, f"unknown TTS model {requested!r}")


def _media_type(response_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "opus": "audio/ogg; codecs=opus",
        "wav": "audio/wav",
        "aac": "audio/aac",
        "pcm": "audio/L16",
        "flac": "audio/flac",
    }.get(response_format, "application/octet-stream")
