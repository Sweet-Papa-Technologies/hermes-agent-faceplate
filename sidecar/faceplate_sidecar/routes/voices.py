"""GET /voices, GET /v1/models — Kokoro voice listings.

Kokoro bundles every voice into a single voices-v1.0.bin file, so there's
nothing to install on a per-voice basis: every voice in KNOWN_VOICES is
reported as installed once the sidecar is set up. The legacy
/v1/voices/download endpoint stays as a no-op for back-compat with older
Faceplate builds that still poke at it.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_bearer
from ..backends.kokoro_tts import DEFAULT_VOICE, KNOWN_VOICES


_log = logging.getLogger("faceplate_sidecar.voices")

router = APIRouter()


def _voice_meta(voice_id: str) -> dict[str, Any]:
    # Lightweight metadata from the Kokoro voice-id naming convention
    # (hexgrad/Kokoro-82M VOICES.md): first char = accent (a=American,
    # b=British), second char = gender (f=female, m=male), then '_<name>'.
    accent_char = voice_id[:1]
    gender_char = voice_id[1:2]
    accent = {"a": "American", "b": "British"}.get(accent_char, "")
    gender = {"f": "female", "m": "male"}.get(gender_char, "")
    speaker = voice_id.split("_", 1)[1] if "_" in voice_id else voice_id
    language = (
        "en-US" if accent == "American"
        else "en-GB" if accent == "British"
        else "en"
    )
    descriptor = f"{accent} {gender}".strip()
    label = f"{voice_id} — {descriptor}" if descriptor else voice_id
    return {
        "id": voice_id,
        "voice": voice_id,
        "language": language,
        "speaker": speaker,
        "label": label,
        "quality": "kokoro",
        "size_mb": 0,           # voices are bundled, no per-voice download
        "installed": True,
        "default": voice_id == DEFAULT_VOICE,
    }


@router.get("/voices", dependencies=[Depends(require_bearer)])
@router.get("/v1/voices", dependencies=[Depends(require_bearer)])
async def list_voices() -> dict[str, Any]:
    return {"data": [_voice_meta(v) for v in KNOWN_VOICES]}


@router.get("/v1/voices/catalog", dependencies=[Depends(require_bearer)])
async def voices_catalog() -> dict[str, Any]:
    """Same shape the Faceplate's Settings → Speech Sidecar voice catalog
    consumes. All voices report installed=true because Kokoro bundles
    every embedding inside voices-v1.0.bin."""
    return {"data": [_voice_meta(v) for v in KNOWN_VOICES]}


class _DownloadReq(BaseModel):
    voice: str


@router.post("/v1/voices/download", dependencies=[Depends(require_bearer)])
async def download_voice(req: _DownloadReq) -> dict[str, Any]:
    """Back-compat no-op for older Faceplate builds. Kokoro voices ship
    bundled — there is no per-voice download. Known voices return 200 with
    a `note`; unknowns return 404."""
    if req.voice in KNOWN_VOICES:
        return {"ok": True, "voice": req.voice, "note": "bundled with Kokoro — already installed"}
    raise HTTPException(404, f"unknown voice {req.voice!r}; see /v1/voices for the list")


@router.get("/v1/models", dependencies=[Depends(require_bearer)])
async def list_models() -> dict[str, Any]:
    """OpenAI-shaped /v1/models. One TTS entry per Kokoro voice plus the
    default ASR — the Faceplate's Settings UI filters by the `kind` field."""
    tts = [{"id": f"kokoro:{v}", "object": "model", "kind": "tts"} for v in KNOWN_VOICES]
    asr = [{"id": "faster-whisper-small.en", "object": "model", "kind": "asr"}]
    return {"object": "list", "data": tts + asr}
