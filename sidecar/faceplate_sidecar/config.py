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
class ParaphraseConfig:
    enabled: bool = True
    backend: str = "litert-lm"
    binary: str = "/opt/litert-lm/litert_lm_main"
    runtime_backend: str = "cpu"
    huggingface_repo: str = "litert-community/gemma-4-E2B-it-litert-lm"
    file: str = "gemma-4-E2B-it.litertlm"
    cache_dir: str = "/models/litert-lm"
    api_server_port: int = 7860
    api_server_key: str | None = None
    max_tokens: int = 96
    temperature: float = 0.4
    top_p: float = 0.95


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
    paraphrase: ParaphraseConfig = field(default_factory=ParaphraseConfig)


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

    para_block = raw.get("paraphrase_fallback", {}) or {}
    runtime = (para_block.get("runtime") or {})
    model = (para_block.get("model") or {})
    api_server = (para_block.get("api_server") or {})
    generation = (para_block.get("generation") or {})
    paraphrase = ParaphraseConfig(
        enabled=para_block.get("enabled", True),
        backend=para_block.get("backend", "litert-lm"),
        binary=runtime.get("binary", ParaphraseConfig.binary),
        runtime_backend=runtime.get("backend", "cpu"),
        huggingface_repo=model.get("huggingface_repo", ParaphraseConfig.huggingface_repo),
        file=model.get("file", ParaphraseConfig.file),
        cache_dir=model.get("cache_dir", ParaphraseConfig.cache_dir),
        api_server_port=api_server.get("internal_port", 7860),
        api_server_key=os.environ.get("LITERT_LM_INTERNAL_KEY")
        or api_server.get("api_key"),
        max_tokens=generation.get("max_tokens", 96),
        temperature=generation.get("temperature", 0.4),
        top_p=generation.get("top_p", 0.95),
    )

    return Config(
        build=os.environ.get("FACEPLATE_BUILD", "cpu"),
        auth=auth,
        asr_default=asr_block.get("default_model", Config.asr_default),
        tts_default=tts_block.get("default_model", Config.tts_default),
        asr_models=asr_models,
        tts_models=tts_models,
        wake=wake,
        paraphrase=paraphrase,
    )


_singleton: Config | None = None


def get_config() -> Config:
    global _singleton
    if _singleton is None:
        _singleton = load_config()
    return _singleton
