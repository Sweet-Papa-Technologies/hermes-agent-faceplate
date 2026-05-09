"""POST /v1/audio/transcriptions — OpenAI-compatible Whisper schema."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

from ..auth import require_bearer
from ..backends.whisper_asr import get_model
from ..config import AsrModelEntry, get_config


router = APIRouter()
_log = logging.getLogger("faceplate_sidecar.asr")


@router.post("/v1/audio/transcriptions", dependencies=[Depends(require_bearer)])
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
) -> Any:
    cfg = get_config()
    model_name = model or cfg.asr_default
    entry = _resolve_model(cfg.asr_models, model_name)

    with tempfile.NamedTemporaryFile(
        suffix=Path(file.filename or "audio").suffix or ".bin",
        delete=False,
    ) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        engine = get_model(
            entry.name, entry.compute_type, entry.device, entry.weights
        )
        result = await engine.transcribe_path(tmp_path, language=language)
    finally:
        tmp_path.unlink(missing_ok=True)

    _ = temperature  # accepted for OpenAI compatibility; not used by faster-whisper here

    if response_format == "text":
        return PlainTextResponse(result["text"])
    if response_format == "verbose_json":
        return JSONResponse(result)
    # default 'json'
    return JSONResponse({"text": result["text"], "language": result["language"]})


def _resolve_model(models: list[AsrModelEntry], requested: str) -> AsrModelEntry:
    for m in models:
        if m.name == requested:
            return m
    raise HTTPException(
        404,
        f"unknown ASR model {requested!r}. Available: {[m.name for m in models] or '(none configured)'}",
    )
