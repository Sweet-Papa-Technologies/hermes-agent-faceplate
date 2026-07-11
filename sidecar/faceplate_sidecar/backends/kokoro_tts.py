"""Kokoro TTS backend (Kokoro-82M via the kokoro-onnx package).

Kokoro is loaded as a single shared instance — one ~325 MB ONNX model +
one ~27 MB voices file (voices-v1.0.bin) hold every voice — so per-voice
'handles' are essentially free; they just remember which embedding to use.

Synthesis returns raw int16 PCM at 24 kHz, then we pipe through ffmpeg to
produce streamable MP3 / Opus / WAV / AAC chunks. Same downstream pipeline
the Piper backend used; only the model + voice-id shape changed.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shlex
import threading
from pathlib import Path
from typing import AsyncIterator

import numpy as np

from . import mark_tts


_log = logging.getLogger("faceplate_sidecar.kokoro")

# Kokoro emits 24 kHz mono.
KOKORO_SAMPLE_RATE = 24_000

# File names the entrypoint / setup script drop into the voices dir.
_DEFAULT_MODEL_FILENAME = "kokoro-v1.0.onnx"
_DEFAULT_VOICES_FILENAME = "voices-v1.0.bin"

# Curated voice list. The full hexgrad/Kokoro-82M catalog is larger; this
# matches what the Faceplate's settings UI surfaces. Unknown voice ids are
# still passed to kokoro.create() — it'll raise if the id is invalid.
KNOWN_VOICES: list[str] = [
    "af_bella",
    "af_heart",
    "af_nicole",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bm_george",
]
DEFAULT_VOICE = "af_bella"


def _model_path() -> Path:
    """Where kokoro-v1.0.onnx lives. FACEPLATE_KOKORO_MODEL overrides; else
    it sits inside FACEPLATE_VOICES_DIR (the shared TTS asset dir)."""
    from ..config import VOICES_DIR  # local import — avoids module-load cycle
    override = os.environ.get("FACEPLATE_KOKORO_MODEL")
    return Path(override) if override else VOICES_DIR / _DEFAULT_MODEL_FILENAME


def _voices_file_path() -> Path:
    from ..config import VOICES_DIR
    override = os.environ.get("FACEPLATE_KOKORO_VOICES")
    return Path(override) if override else VOICES_DIR / _DEFAULT_VOICES_FILENAME


# Singleton kokoro_onnx.Kokoro instance. Built lazily on first synthesis so
# the sidecar can answer /health before the model is paged in.
_kokoro = None
_kokoro_lock = threading.Lock()


def _ensure_kokoro():  # -> kokoro_onnx.Kokoro
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    with _kokoro_lock:
        if _kokoro is not None:
            return _kokoro
        try:
            from kokoro_onnx import Kokoro  # type: ignore[import-not-found]
        except ImportError as err:
            raise RuntimeError(
                "kokoro-onnx is not installed in this venv. "
                "If you're running natively, re-run setup/speech-sidecar.sh; "
                "if this is the container, the image was built without it."
            ) from err
        mp = _model_path()
        vp = _voices_file_path()
        if not mp.exists():
            raise RuntimeError(
                f"Kokoro model not found at {mp}. "
                "Re-run setup/speech-sidecar.sh (or the container entrypoint) to fetch it."
            )
        if not vp.exists():
            raise RuntimeError(
                f"Kokoro voices file not found at {vp}. "
                "Re-run setup/speech-sidecar.sh (or the container entrypoint) to fetch it."
            )
        _log.info("loading Kokoro: model=%s voices=%s", mp, vp)
        _kokoro = Kokoro(str(mp), str(vp))
        return _kokoro


class KokoroVoice:
    """Per-voice handle. Cheap to construct; shares the loaded Kokoro singleton."""

    def __init__(self, voice_id: str) -> None:
        self.voice_id = voice_id
        self._loaded = False

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        _ensure_kokoro()  # global; per-voice has no extra cost beyond this
        self._loaded = True
        mark_tts(self.voice_id, "loaded")

    def sample_rate(self) -> int:
        return KOKORO_SAMPLE_RATE

    def synthesize_pcm(self, text: str, speed: float = 1.0) -> bytes:
        try:
            self.ensure_loaded()
            k = _ensure_kokoro()
            samples, _sr = k.create(
                text,
                voice=self.voice_id,
                speed=max(speed, 0.1),
                lang="en-us",
            )
            # samples: float32 numpy array roughly in [-1, 1]. Convert to
            # int16 PCM — the format ffmpeg expects on stdin (-f s16le).
            pcm = np.clip(samples * 32768.0, -32768.0, 32767.0).astype(np.int16)
            return pcm.tobytes()
        except Exception:
            mark_tts(self.voice_id, "error")
            raise


_voices_cache: dict[str, KokoroVoice] = {}
_voices_cache_lock = threading.Lock()


def get_voice(voice_id: str) -> KokoroVoice:
    voice = _voices_cache.get(voice_id)
    if voice is None:
        with _voices_cache_lock:
            voice = _voices_cache.get(voice_id)
            if voice is None:
                voice = KokoroVoice(voice_id)
                _voices_cache[voice_id] = voice
    return voice


async def synthesize_to_format(
    voice: KokoroVoice,
    text: str,
    response_format: str,
    speed: float,
    chunk_bytes: int = 16 * 1024,
) -> AsyncIterator[bytes]:
    """Synthesize raw PCM, then pipe through ffmpeg into the requested
    container. Yields chunked bytes suitable for `Transfer-Encoding:
    chunked` HTTP. Same shape the Piper backend exposed.
    """
    pcm = await asyncio.get_event_loop().run_in_executor(
        None, lambda: voice.synthesize_pcm(text, speed=speed)
    )
    sample_rate = voice.sample_rate()
    cmd = _ffmpeg_cmd(response_format, sample_rate)
    _log.info("kokoro→ffmpeg: %s", " ".join(shlex.quote(c) for c in cmd))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def feed_stdin() -> None:
        try:
            assert proc.stdin is not None
            proc.stdin.write(pcm)
            await proc.stdin.drain()
            proc.stdin.close()
            await proc.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            # Consumer disconnected; the finally block kills ffmpeg.
            pass

    feeder = asyncio.create_task(feed_stdin())
    assert proc.stdout is not None

    try:
        while True:
            chunk = await proc.stdout.read(chunk_bytes)
            if not chunk:
                break
            yield chunk
        rc = await proc.wait()
        if rc != 0:
            err = (await proc.stderr.read()).decode("utf8", "replace") if proc.stderr else ""
            raise RuntimeError(f"ffmpeg exited {rc}: {err.strip()[:240]}")
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
        if not feeder.done():
            feeder.cancel()
            try:
                await feeder
            except (asyncio.CancelledError, BrokenPipeError, ConnectionResetError):
                pass


def _ffmpeg_cmd(response_format: str, sample_rate: int) -> list[str]:
    base = [
        "ffmpeg",
        "-loglevel", "warning",
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", "-",
    ]
    if response_format == "mp3":
        base += ["-b:a", "64k", "-f", "mp3", "pipe:1"]
    elif response_format == "opus":
        base += ["-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"]
    elif response_format == "wav":
        base += ["-f", "wav", "pipe:1"]
    elif response_format == "aac":
        base += ["-c:a", "aac", "-b:a", "64k", "-f", "adts", "pipe:1"]
    elif response_format == "pcm":
        base += ["-f", "s16le", "pipe:1"]
    elif response_format == "flac":
        base += ["-f", "flac", "pipe:1"]
    else:
        raise ValueError(f"unsupported response_format: {response_format}")
    return base
