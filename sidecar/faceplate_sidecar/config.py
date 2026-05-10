"""Runtime configuration loader.

Reads /etc/faceplate-sidecar/config.yaml (mountable from host). Environment
variables override the YAML values where applicable; e.g.:

  FACEPLATE_API_KEY    overrides auth.bearer_token
  FACEPLATE_BUILD      'cpu' | 'cpu-slim' | 'cuda' (set by entrypoint)
  HF_HOME              cache dir for HF model downloads

The loader expands `${VAR}` substitutions in YAML string values from the
process environment, so the example config can reference `${FACEPLATE_API_KEY}`
and have it resolve at startup rather than land as a literal token.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


DEFAULT_CONFIG_PATH = Path("/etc/faceplate-sidecar/config.yaml")
_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand_env(value: Any) -> Any:
    """Recursively replace ${VAR} substitutions in YAML string nodes."""
    if isinstance(value, str):
        def repl(match: re.Match[str]) -> str:
            return os.environ.get(match.group(1), "")
        return _ENV_PATTERN.sub(repl, value)
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    return value


@dataclass
class AsrModelEntry:
    name: str
    backend: str
    compute_type: str = "int8"
    device: str = "cpu"
    weights: str | None = None


@dataclass
class TtsModelEntry:
    name: str
    backend: str
    voice_path: str | None = None
    device: str = "cpu"


@dataclass
class WakeConfig:
    enabled: bool = False
    backend: str = "openwakeword"
    models: list[str] = field(default_factory=list)
    threshold: float = 0.5


@dataclass
class AuthConfig:
    bearer_token: str = ""
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:*", "app://."])


@dataclass
class Config:
    build: str = "cpu"
    auth: AuthConfig = field(default_factory=AuthConfig)
    asr_default: str = "faster-whisper-small.en"
    tts_default: str = "piper:en_US-amy-medium"
    asr_models: list[AsrModelEntry] = field(default_factory=list)
    tts_models: list[TtsModelEntry] = field(default_factory=list)
    wake: WakeConfig = field(default_factory=WakeConfig)


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r") as f:
        raw = yaml.safe_load(f) or {}
    return _expand_env(raw)


def load_config(path: Path | None = None) -> Config:
    """Load + apply env overrides. Missing config files use the defaults."""
    raw = _read_yaml(path or DEFAULT_CONFIG_PATH)

    auth_raw = raw.get("auth", {}) or {}
    auth = AuthConfig(
        bearer_token=os.environ.get("FACEPLATE_API_KEY")
        or auth_raw.get("bearer_token", ""),
        cors_origins=auth_raw.get("cors_origins") or AuthConfig().cors_origins,
    )

    asr_block = raw.get("asr", {}) or {}
    asr_models = [
        AsrModelEntry(
            name=m["name"],
            backend=m.get("backend", "faster-whisper"),
            compute_type=m.get("compute_type", "int8"),
            device=m.get("device", "cpu"),
            weights=m.get("weights"),
        )
        for m in asr_block.get("models", [])
    ]

    tts_block = raw.get("tts", {}) or {}
    tts_models = [
        TtsModelEntry(
            name=m["name"],
            backend=m.get("backend", "piper-onnx"),
            voice_path=m.get("voice_path"),
            device=m.get("device", "cpu"),
        )
        for m in tts_block.get("models", [])
    ]

    wake_block = raw.get("wake", {}) or {}
    wake = WakeConfig(
        enabled=wake_block.get("enabled", False),
        backend=wake_block.get("backend", "openwakeword"),
        models=list(wake_block.get("models", [])),
        threshold=wake_block.get("threshold", 0.5),
    )

    # `paraphrase_fallback` block in the YAML is intentionally ignored —
    # the paraphrase LLM lives outside the container now (host-native
    # `litert-lm serve`). Kept tolerant so old config.yaml files don't
    # break the loader.

    return Config(
        build=os.environ.get("FACEPLATE_BUILD", "cpu"),
        auth=auth,
        asr_default=asr_block.get("default_model", Config.asr_default),
        tts_default=tts_block.get("default_model", Config.tts_default),
        asr_models=asr_models,
        tts_models=tts_models,
        wake=wake,
    )


_singleton: Config | None = None


def get_config() -> Config:
    global _singleton
    if _singleton is None:
        _singleton = load_config()
    return _singleton
