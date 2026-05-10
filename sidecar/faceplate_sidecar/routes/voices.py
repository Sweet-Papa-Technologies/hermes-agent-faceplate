"""GET /voices, GET /v1/models — discovery; POST /v1/voices/download — fetch."""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_bearer
from ..config import get_config


_log = logging.getLogger("faceplate_sidecar.voices")

router = APIRouter()

VOICES_DIR = Path("/voices")
HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Hand-curated subset of rhasspy/piper-voices that's known to be reliable
# and small enough to download in seconds. The Settings UI surfaces these
# as one-click installs; advanced users can still POST /v1/voices/download
# with any voice id from the upstream repo.
KNOWN_VOICES = [
    {"id": "en_US-amy-medium",        "language": "en-US", "speaker": "amy",        "quality": "medium", "size_mb": 60,  "default": True},
    {"id": "en_US-ryan-high",         "language": "en-US", "speaker": "ryan",       "quality": "high",   "size_mb": 109},
    {"id": "en_US-libritts_r-medium", "language": "en-US", "speaker": "libritts_r", "quality": "medium", "size_mb": 75},
    {"id": "en_US-lessac-high",       "language": "en-US", "speaker": "lessac",     "quality": "high",   "size_mb": 109},
    {"id": "en_US-hfc_female-medium", "language": "en-US", "speaker": "hfc_female", "quality": "medium", "size_mb": 60},
    {"id": "en_US-hfc_male-medium",   "language": "en-US", "speaker": "hfc_male",   "quality": "medium", "size_mb": 60},
    {"id": "en_GB-alan-medium",       "language": "en-GB", "speaker": "alan",       "quality": "medium", "size_mb": 60},
    {"id": "en_GB-northern_english_male-medium", "language": "en-GB", "speaker": "northern_english_male", "quality": "medium", "size_mb": 60},
    {"id": "es_ES-davefx-medium",     "language": "es-ES", "speaker": "davefx",     "quality": "medium", "size_mb": 60},
    {"id": "fr_FR-siwis-medium",      "language": "fr-FR", "speaker": "siwis",      "quality": "medium", "size_mb": 60},
    {"id": "de_DE-thorsten-medium",   "language": "de-DE", "speaker": "thorsten",   "quality": "medium", "size_mb": 60},
    {"id": "it_IT-paola-medium",      "language": "it-IT", "speaker": "paola",      "quality": "medium", "size_mb": 60},
]


class DownloadRequest(BaseModel):
    voice: str = Field(
        ...,
        pattern=r"^[a-z]{2,4}_[A-Z]{2}-[a-z0-9_-]+-(low|medium|high|x_low)$",
        description="Piper voice id, e.g. 'en_US-amy-medium'.",
    )


def _parse_voice_id(voice: str) -> tuple[str, str, str, str]:
    """en_US-amy-medium → ('en', 'en_US', 'amy', 'medium')."""
    m = re.fullmatch(r"([a-z]{2,4})_([A-Z]{2})-(.+)-(low|medium|high|x_low)", voice)
    if not m:
        raise ValueError(f"unrecognised piper voice id: {voice!r}")
    lang, country, speaker, quality = m.groups()
    locale = f"{lang}_{country}"
    return lang, locale, speaker, quality


@router.get("/voices", dependencies=[Depends(require_bearer)])
@router.get("/v1/voices", dependencies=[Depends(require_bearer)])
def list_voices() -> dict[str, list[dict[str, Any]]]:
    cfg = get_config()
    voices: list[dict[str, Any]] = []
    for m in cfg.tts_models:
        if not m.voice_path:
            continue
        path = Path(m.voice_path)
        voices.append(
            {
                "id": m.name,
                "voice": path.stem,
                "backend": m.backend,
                "device": m.device,
                "exists": path.exists(),
            }
        )
    return {"data": voices}


@router.get("/v1/voices/catalog", dependencies=[Depends(require_bearer)])
def voice_catalog() -> dict[str, Any]:
    """Recommended Piper voices users can install with one click. The
    `installed` flag reflects whether the .onnx + .onnx.json pair already
    exist in the voices volume."""
    out: list[dict[str, Any]] = []
    for v in KNOWN_VOICES:
        onnx = VOICES_DIR / f"{v['id']}.onnx"
        cfg = VOICES_DIR / f"{v['id']}.onnx.json"
        out.append({**v, "installed": onnx.exists() and cfg.exists()})
    return {"data": out, "voices_dir": str(VOICES_DIR)}


@router.post("/v1/voices/download", dependencies=[Depends(require_bearer)])
async def download_voice(req: DownloadRequest) -> dict[str, Any]:
    """Download a Piper voice (.onnx + .onnx.json) from
    huggingface.co/rhasspy/piper-voices into /voices. Idempotent: if both
    files already exist the call returns immediately."""
    try:
        lang, locale, speaker, quality = _parse_voice_id(req.voice)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    onnx = VOICES_DIR / f"{req.voice}.onnx"
    cfg = VOICES_DIR / f"{req.voice}.onnx.json"
    if onnx.exists() and cfg.exists():
        return {"voice": req.voice, "status": "already_installed", "path": str(onnx)}

    base = f"{HF_BASE}/{lang}/{locale}/{speaker}/{quality}"
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    _log.info("downloading piper voice %s from %s", req.voice, base)

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        for src, dst in [
            (f"{base}/{req.voice}.onnx", onnx),
            (f"{base}/{req.voice}.onnx.json", cfg),
        ]:
            tmp = dst.with_suffix(dst.suffix + ".tmp")
            try:
                async with client.stream("GET", src, follow_redirects=True) as r:
                    if r.status_code != 200:
                        if tmp.exists():
                            tmp.unlink()
                        raise HTTPException(
                            status_code=502,
                            detail=f"upstream HTTP {r.status_code} for {src}",
                        )
                    with tmp.open("wb") as f:
                        async for chunk in r.aiter_bytes(chunk_size=64 * 1024):
                            f.write(chunk)
                tmp.replace(dst)
            except httpx.HTTPError as e:
                if tmp.exists():
                    tmp.unlink()
                raise HTTPException(status_code=502, detail=f"download failed: {e}")
    _log.info("voice %s installed at %s", req.voice, onnx)
    return {
        "voice": req.voice,
        "status": "downloaded",
        "path": str(onnx),
        "size_bytes": onnx.stat().st_size,
    }


@router.get("/v1/models", dependencies=[Depends(require_bearer)])
def list_models() -> dict[str, Any]:
    cfg = get_config()
    items: list[dict[str, Any]] = []
    for m in cfg.tts_models:
        items.append({"id": m.name, "object": "model", "owned_by": "faceplate", "kind": "tts"})
    for m in cfg.asr_models:
        items.append({"id": m.name, "object": "model", "owned_by": "faceplate", "kind": "asr"})
    return {"object": "list", "data": items}
