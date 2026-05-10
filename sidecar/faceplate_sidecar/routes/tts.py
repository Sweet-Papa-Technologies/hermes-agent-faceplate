"""POST /v1/audio/speech — OpenAI-compatible TTS.

Default backend is Piper (CPU). Stream mode returns chunked-transfer-encoded
MP3 (or other format). Non-stream mode returns the buffered bytes with a
proper content-length header.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import require_bearer
from ..backends.piper_tts import get_voice, synthesize_to_format
from ..config import TtsModelEntry, get_config


VOICES_DIR = Path("/voices")


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


def _entry_usable(m: TtsModelEntry) -> bool:
    """A registered model entry is only worth returning if both the .onnx
    and matching .onnx.json actually exist on disk. Stale entries (e.g.
    the dash-vs-underscore mismatch in the example config) used to win
    the exact-name match and trigger 500s; now they're skipped so the
    auto-discovery path can take over."""
    if not m.voice_path:
        return False
    onnx = Path(m.voice_path)
    return onnx.exists() and onnx.with_suffix(onnx.suffix + ".json").exists()


def _resolve_model(
    models: list[TtsModelEntry], requested: str, voice_hint: str
) -> TtsModelEntry:
    """Find the TTS model entry to use. Resolution order:

      1. Exact `name` match on a pre-registered, on-disk-verified entry.
      2. Substring match on a pre-registered, on-disk-verified voice_path.
      3. Same as #2 with dashes ↔ underscores swapped in voice_hint
         (handles the `libritts-r` vs `libritts_r` rhasspy/piper-voices
         naming inconsistency without forcing the user to know about it).
      4. Auto-discover an .onnx file in /voices/ that matches the hint
         under the same normalize-and-compare rule. Voices downloaded via
         /v1/voices/download "just work" without re-editing config.yaml.
    """
    requested_clean = requested.removeprefix("piper:") if requested else ""
    for m in models:
        if m.name == requested and _entry_usable(m):
            return m

    candidates = [voice_hint, requested_clean] if requested_clean else [voice_hint]
    for hint in candidates:
        if not hint:
            continue
        for m in models:
            if m.voice_path and hint in m.voice_path and _entry_usable(m):
                return m
        # Try the dash↔underscore swap.
        swapped = hint.replace("-", "_") if "-" in hint else hint.replace("_", "-")
        if swapped != hint:
            for m in models:
                if m.voice_path and swapped in m.voice_path and _entry_usable(m):
                    return m

    # Auto-discover from disk — covers voices downloaded after sidecar boot
    # via /v1/voices/download. We normalize both sides (collapse dashes and
    # underscores to the same separator) so the user can ask for a voice by
    # whatever spelling they remember; the upstream rhasspy/piper-voices
    # repo mixes the two (e.g. `libritts-r` in our id list, `libritts_r` in
    # the actual filename).
    def _norm(s: str) -> str:
        return s.replace("-", "_").lower()

    if VOICES_DIR.exists():
        on_disk = {p.stem: p for p in VOICES_DIR.glob("*.onnx")}
        for hint in candidates:
            if not hint:
                continue
            target = _norm(hint)
            for stem, onnx in on_disk.items():
                if _norm(stem) != target:
                    continue
                cfg_json = onnx.with_suffix(onnx.suffix + ".json")
                if not cfg_json.exists():
                    continue
                _log.info("auto-discovered voice %s at %s (asked: %r)", stem, onnx, hint)
                return TtsModelEntry(
                    name=f"piper:{stem}",
                    backend="piper-onnx",
                    voice_path=str(onnx),
                )

    raise HTTPException(
        404,
        f"unknown TTS model {requested!r} (voice={voice_hint!r}). "
        f"Install via POST /v1/voices/download or add to cfg.tts_models.",
    )


def _media_type(response_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "opus": "audio/ogg; codecs=opus",
        "wav": "audio/wav",
        "aac": "audio/aac",
        "pcm": "audio/L16",
        "flac": "audio/flac",
    }.get(response_format, "application/octet-stream")
