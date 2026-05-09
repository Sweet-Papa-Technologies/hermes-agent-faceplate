"""faster-whisper backend (int8 CPU floor; fp16 GPU on the :cuda image)."""
from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path

from . import mark_asr


_log = logging.getLogger("faceplate_sidecar.whisper")
_models: dict[str, "FasterWhisper"] = {}
_models_lock = threading.Lock()


class FasterWhisper:
    def __init__(self, name: str, compute_type: str, device: str, weights: str | None) -> None:
        self.name = name
        self.compute_type = compute_type
        self.device = device
        self.weights = weights
        self._model = None
        self._load_lock = threading.Lock()

    def ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            try:
                from faster_whisper import WhisperModel  # type: ignore[import-not-found]

                # Allow either an absolute path to local weights or a HF repo id.
                model_id = self.weights or self._infer_size_from_name(self.name)
                self._model = WhisperModel(
                    model_id,
                    device=self.device,
                    compute_type=self.compute_type,
                )
                mark_asr(self.name, "loaded")
            except Exception as err:
                mark_asr(self.name, "error")
                raise RuntimeError(f"failed to load whisper {self.name}: {err}") from err

    @staticmethod
    def _infer_size_from_name(name: str) -> str:
        # `faster-whisper-small.en` → `Systran/faster-whisper-small.en`-style
        # ID. We use Systran's pre-converted CT2 builds.
        return f"Systran/{name}"

    async def transcribe_path(
        self, path: Path, language: str | None
    ) -> dict[str, object]:
        self.ensure_loaded()

        def _run() -> dict[str, object]:
            assert self._model is not None
            segments, info = self._model.transcribe(
                str(path),
                language=language if language and language != "auto" else None,
                vad_filter=True,
            )
            text_parts: list[str] = []
            seg_records: list[dict[str, object]] = []
            for seg in segments:
                text_parts.append(seg.text)
                seg_records.append({
                    "start": seg.start,
                    "end": seg.end,
                    "text": seg.text,
                })
            return {
                "text": "".join(text_parts).strip(),
                "language": info.language,
                "segments": seg_records,
            }

        return await asyncio.get_event_loop().run_in_executor(None, _run)


def get_model(
    name: str, compute_type: str, device: str, weights: str | None
) -> FasterWhisper:
    m = _models.get(name)
    if m is None:
        with _models_lock:
            m = _models.get(name)
            if m is None:
                m = FasterWhisper(name, compute_type, device, weights)
                _models[name] = m
    return m
