"""openWakeWord backend. Loads each .onnx model from /wakewords on first
audio frame, then evaluates per-frame predictions."""
from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

from . import mark_wake


_log = logging.getLogger("faceplate_sidecar.wake")
_detectors: dict[tuple[tuple[str, ...], float], "WakeDetector"] = {}
_detectors_lock = threading.Lock()


def get_detector(model_paths: list[str], threshold: float) -> "WakeDetector":
    key = (tuple(sorted(model_paths)), threshold)
    d = _detectors.get(key)
    if d is None:
        with _detectors_lock:
            d = _detectors.get(key)
            if d is None:
                d = WakeDetector(model_paths, threshold)
                _detectors[key] = d
    return d


class WakeDetector:
    def __init__(self, model_paths: list[str], threshold: float) -> None:
        self.model_paths = model_paths
        self.threshold = threshold
        self._model = None

    def ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            from openwakeword.model import Model  # type: ignore[import-not-found]

            self._model = Model(
                wakeword_models=self.model_paths,
                inference_framework="onnx",
            )
            for path in self.model_paths:
                mark_wake(path, "loaded")
        except Exception as err:
            for path in self.model_paths:
                mark_wake(path, "error")
            raise RuntimeError(f"failed to load openWakeWord: {err}") from err

    def predict(self, frame_int16: bytes) -> dict[str, float]:
        self.ensure_loaded()
        # openWakeWord expects 16 kHz mono int16 numpy chunks.
        audio = np.frombuffer(frame_int16, dtype=np.int16)
        return self._model.predict(audio)  # type: ignore[union-attr]

    def matches(self, scores: dict[str, float]) -> tuple[str, float] | None:
        for name, score in scores.items():
            if score >= self.threshold:
                return name, float(score)
        return None

    @staticmethod
    def model_basenames(paths: list[str]) -> list[str]:
        return [Path(p).stem for p in paths]
