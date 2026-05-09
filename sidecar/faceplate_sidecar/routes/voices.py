"""GET /voices and GET /v1/models — discovery endpoints."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from ..auth import require_bearer
from ..config import get_config


router = APIRouter()


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


@router.get("/v1/models", dependencies=[Depends(require_bearer)])
def list_models() -> dict[str, Any]:
    cfg = get_config()
    items: list[dict[str, Any]] = []
    for m in cfg.tts_models:
        items.append({"id": m.name, "object": "model", "owned_by": "faceplate", "kind": "tts"})
    for m in cfg.asr_models:
        items.append({"id": m.name, "object": "model", "owned_by": "faceplate", "kind": "asr"})
    if cfg.paraphrase.enabled and cfg.build != "cpu-slim":
        items.append(
            {
                "id": cfg.paraphrase.file,
                "object": "model",
                "owned_by": "litert-community",
                "kind": "chat",
            }
        )
    return {"object": "list", "data": items}
