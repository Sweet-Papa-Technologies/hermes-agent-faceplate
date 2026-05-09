"""Health endpoint helpers. Reports per-model load status without forcing
loads. The Faceplate's Settings → Test buttons hit this."""
from __future__ import annotations

import os
import resource
from typing import Literal

from .config import Config, get_config


ModelStatus = Literal["loaded", "idle", "error"]


def collect_status() -> dict[str, object]:
    cfg = get_config()
    from . import backends  # imported here to avoid heavy init at module load

    models: dict[str, ModelStatus] = {}
    for m in cfg.tts_models:
        models[f"tts.{m.name}"] = backends.tts_status(m.name)
    for m in cfg.asr_models:
        models[f"asr.{m.name}"] = backends.asr_status(m.name)
    for w in cfg.wake.models:
        models[f"wake.{os.path.basename(w)}"] = backends.wake_status(w)
    if cfg.paraphrase.enabled and cfg.build != "cpu-slim":
        models[f"paraphrase.{cfg.paraphrase.file}"] = backends.litert_lm_status()

    ram_mb = _resident_ram_mb()
    return {
        "status": "ok",
        "build": cfg.build,
        "gpu": _gpu_present(),
        "models": models,
        "ram_mb": ram_mb,
        "version": _version(),
    }


def _resident_ram_mb() -> int:
    """Current RSS in MB. Prefers /proc on Linux for live values; falls back
    to ru_maxrss (peak) elsewhere."""
    proc_status = "/proc/self/status"
    if os.path.exists(proc_status):
        try:
            with open(proc_status) as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        kb = int(line.split()[1])
                        return kb // 1024
        except Exception:
            pass
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # On Linux ru_maxrss is KB; on macOS it's bytes.
        if os.uname().sysname == "Darwin":
            return int(usage.ru_maxrss / (1024 * 1024))
        return int(usage.ru_maxrss / 1024)
    except Exception:
        return 0


def _gpu_present() -> str | None:
    val = os.environ.get("NVIDIA_VISIBLE_DEVICES")
    if val and val != "void" and os.path.exists("/dev/nvidia0"):
        return val
    return None


def _version() -> str:
    from . import __version__
    return __version__


def healthcheck_for(_cfg: Config | None = None) -> dict[str, object]:
    return collect_status()
