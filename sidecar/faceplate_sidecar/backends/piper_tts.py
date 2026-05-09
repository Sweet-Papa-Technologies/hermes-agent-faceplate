"""Piper TTS backend. CPU floor of the TTS tier.

Piper publishes per-voice ONNX models (~20–60 MB each). We synthesise to
raw PCM and pipe through ffmpeg to produce streamable MP3/Opus chunks per
addendum #1.
"""
from __future__ import annotations

import asyncio
import logging
import shlex
import threading
from pathlib import Path
from typing import AsyncIterator

from . import mark_tts


_log = logging.getLogger("faceplate_sidecar.piper")


_voices: dict[str, "PiperVoice"] = {}
_voices_lock = threading.Lock()


class PiperVoice:
    """Wraps a single Piper ONNX voice. Lazy-loads on first synthesis."""

    def __init__(self, voice_path: str) -> None:
        self.voice_path = Path(voice_path)
        self._voice = None  # piper.PiperVoice instance
        self._load_lock = threading.Lock()

    def ensure_loaded(self) -> None:
        if self._voice is not None:
            return
        # Double-checked locking: callers run on FastAPI worker threads via
        # run_in_executor; without the lock two concurrent first-requests
        # for the same voice both pass the None check and load the model
        # twice.
        with self._load_lock:
            if self._voice is not None:
                return
            try:
                from piper import PiperVoice as _PiperVoice  # type: ignore[import-not-found]

                self._voice = _PiperVoice.load(str(self.voice_path))
                mark_tts(self.voice_path.stem, "loaded")
            except Exception as err:
                mark_tts(self.voice_path.stem, "error")
                raise RuntimeError(f"failed to load Piper voice {self.voice_path}: {err}") from err

    def sample_rate(self) -> int:
        self.ensure_loaded()
        # piper's PiperVoice exposes config.sample_rate
        return int(self._voice.config.sample_rate)  # type: ignore[union-attr]

    def synthesize_pcm(self, text: str, speed: float = 1.0) -> bytes:
        self.ensure_loaded()
        # piper's `synthesize` writes WAV; we ask for raw bytes via its
        # `synthesize_stream_raw` generator and concatenate. Length-rate is
        # set via the synthesis args.
        chunks: list[bytes] = []
        length_scale = 1.0 / max(speed, 0.1)
        for audio_chunk in self._voice.synthesize_stream_raw(  # type: ignore[union-attr]
            text,
            length_scale=length_scale,
        ):
            chunks.append(audio_chunk)
        return b"".join(chunks)


def get_voice(voice_path: str) -> PiperVoice:
    voice = _voices.get(voice_path)
    if voice is None:
        with _voices_lock:
            voice = _voices.get(voice_path)
            if voice is None:
                voice = PiperVoice(voice_path)
                _voices[voice_path] = voice
    return voice


async def synthesize_to_format(
    voice: PiperVoice,
    text: str,
    response_format: str,
    speed: float,
    chunk_bytes: int = 16 * 1024,
) -> AsyncIterator[bytes]:
    """Pipe Piper PCM into ffmpeg → requested container.

    Yields chunked bytes suitable for `Transfer-Encoding: chunked` HTTP
    response. ffmpeg is invoked once per request — fine for short
    paragraphs; long inputs (>30 s) should pre-chunk on the caller side.
    """
    pcm = await asyncio.get_event_loop().run_in_executor(
        None, lambda: voice.synthesize_pcm(text, speed=speed)
    )
    sample_rate = voice.sample_rate()
    cmd = _ffmpeg_cmd(response_format, sample_rate)
    _log.info("piper→ffmpeg: %s", " ".join(shlex.quote(c) for c in cmd))

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
            # Consumer disconnected mid-stream; nothing to do — proc.kill()
            # below in the finally block will tear ffmpeg down.
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
        # Generator can be GC'd / cancelled (client disconnect, abort).
        # Make sure the feeder task and the subprocess actually exit so we
        # don't leak ffmpeg processes.
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
        # Pass-through: still pipe through ffmpeg so the rest of the wrapper
        # is uniform. PCM is for non-MSE clients (addendum §1).
        base += ["-f", "s16le", "pipe:1"]
    elif response_format == "flac":
        base += ["-f", "flac", "pipe:1"]
    else:
        raise ValueError(f"unsupported response_format: {response_format}")
    return base
