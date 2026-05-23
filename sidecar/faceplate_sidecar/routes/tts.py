"""POST /v1/audio/speech — OpenAI-compatible TTS.

Backend: Kokoro-82M via the kokoro-onnx package (single shared model +
voices file). Stream mode returns chunked MP3 (or another container);
non-stream mode buffers to a single Response with a content-length header.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import require_bearer
from ..backends.kokoro_tts import DEFAULT_VOICE, get_voice, synthesize_to_format


router = APIRouter()
_log = logging.getLogger("faceplate_sidecar.tts")


class TtsRequest(BaseModel):
    input: str = Field(..., max_length=8_000)
    # OpenAI clients sometimes send `voice` (e.g. 'af_bella') and sometimes
    # `model` (e.g. 'kokoro:af_bella'); either is enough to pick the voice.
    voice: str | None = None
    model: str | None = None
    response_format: str = "mp3"
    speed: float = 1.0
    stream: bool = False


@router.post("/v1/audio/speech", dependencies=[Depends(require_bearer)])
async def speech(req: TtsRequest) -> Any:
    voice_id = _resolve_voice(req.voice, req.model)
    if not voice_id:
        raise HTTPException(400, "no voice specified (set `voice` or `model`)")

    try:
        voice = get_voice(voice_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(500, str(err)) from err

    media_type = _media_type(req.response_format)

    if not req.stream:
        chunks: list[bytes] = []
        async for chunk in synthesize_to_format(
            voice, req.input, req.response_format, req.speed
        ):
            chunks.append(chunk)
        return Response(b"".join(chunks), media_type=media_type)

    return StreamingResponse(
        synthesize_to_format(voice, req.input, req.response_format, req.speed),
        media_type=media_type,
    )


def _resolve_voice(voice: str | None, model: str | None) -> str:
    """Pick the voice id. `voice='af_bella'` and `model='kokoro:af_bella'`
    are both honored; falls back to the configured default voice. The
    legacy 'piper:' prefix is also stripped so old client configs keep
    working (the suffix is treated as a voice id)."""
    if voice:
        return voice
    if model:
        for prefix in ("kokoro:", "piper:"):
            if model.startswith(prefix):
                return model[len(prefix):] or DEFAULT_VOICE
        return model
    return DEFAULT_VOICE


def _media_type(response_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "opus": "audio/ogg; codecs=opus",
        "wav": "audio/wav",
        "aac": "audio/aac",
        "pcm": "audio/L16",
        "flac": "audio/flac",
    }.get(response_format, "application/octet-stream")
