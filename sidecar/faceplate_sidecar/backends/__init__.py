"""Lazy-loaded backend factories. Module-level state tracks which models are
currently resident so /health can report without forcing a load."""
from __future__ import annotations

from typing import Literal

ModelStatus = Literal["loaded", "idle", "error"]


_tts_status: dict[str, ModelStatus] = {}
_asr_status: dict[str, ModelStatus] = {}
_wake_status: dict[str, ModelStatus] = {}


def tts_status(name: str) -> ModelStatus:
    return _tts_status.get(name, "idle")


def asr_status(name: str) -> ModelStatus:
    return _asr_status.get(name, "idle")


def wake_status(path: str) -> ModelStatus:
    return _wake_status.get(path, "idle")


def mark_tts(name: str, status: ModelStatus) -> None:
    _tts_status[name] = status


def mark_asr(name: str, status: ModelStatus) -> None:
    _asr_status[name] = status


def mark_wake(path: str, status: ModelStatus) -> None:
    _wake_status[path] = status
