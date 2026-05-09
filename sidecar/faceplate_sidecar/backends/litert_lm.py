"""LiteRT-LM subprocess wrapper.

We bundle `imertz/litert-lm-api-server` (Node) which itself shells out to
the `litert_lm_main` binary. The wrapper is started in a child process at
container init and reverse-proxied by /v1/chat/completions.

Per addendum #4, the model is `gemma-4-E2B-it.litertlm` from the
`litert-community/gemma-4-E2B-it-litert-lm` HF repo.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..config import ParaphraseConfig
from . import mark_litert_lm


_log = logging.getLogger("faceplate_sidecar.litert")


class LiteRtLmProcess:
    """Tracks the spawned `litert-lm-api-server` Node process."""

    SERVER_ENTRYPOINT = "/opt/litert-lm-api-server/server.js"

    def __init__(self, cfg: ParaphraseConfig) -> None:
        self.cfg = cfg
        self.proc: subprocess.Popen[Any] | None = None

    def start(self) -> None:
        if not Path(self.SERVER_ENTRYPOINT).exists():
            _log.warning(
                "litert-lm-api-server not found at %s — skipping", self.SERVER_ENTRYPOINT
            )
            mark_litert_lm("error")
            return
        if not Path(self.cfg.binary).exists():
            _log.warning(
                "litert_lm_main not found at %s — skipping", self.cfg.binary
            )
            mark_litert_lm("error")
            return

        env = {
            **os.environ,
            "LITERT_LM_BINARY": self.cfg.binary,
            "LITERT_LM_BACKEND": self.cfg.runtime_backend,
            "LITERT_LM_MODEL_REPO": self.cfg.huggingface_repo,
            "LITERT_LM_MODEL_FILE": self.cfg.file,
            "LITERT_LM_CACHE_DIR": self.cfg.cache_dir,
            "LITERT_LM_MAX_TOKENS": str(self.cfg.max_tokens),
            "LITERT_LM_TEMPERATURE": str(self.cfg.temperature),
            "LITERT_LM_TOP_P": str(self.cfg.top_p),
            "PORT": str(self.cfg.api_server_port),
        }
        if self.cfg.api_server_key:
            env["API_KEY"] = self.cfg.api_server_key

        Path(self.cfg.cache_dir).mkdir(parents=True, exist_ok=True)
        _log.info(
            "spawning litert-lm-api-server (port=%s, backend=%s)",
            self.cfg.api_server_port,
            self.cfg.runtime_backend,
        )
        # `start_new_session` puts Node + its `litert_lm_main` grandchild in
        # their own process group. Without it SIGTERM to Node may not reach
        # the binary (Node doesn't always forward signals to spawned procs).
        popen_kwargs: dict[str, Any] = {
            "env": env,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform != "win32":
            popen_kwargs["start_new_session"] = True
        self.proc = subprocess.Popen(
            ["node", self.SERVER_ENTRYPOINT],
            **popen_kwargs,
        )
        # Best-effort flag: actual readiness is determined by /health probing
        # the upstream port from the chat route.
        mark_litert_lm("loaded")

    def stop(self) -> None:
        """Synchronous variant. Prefer `await stop_async()` from the lifespan."""
        if self.proc is None:
            return
        self._signal_pgroup(signal.SIGTERM)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._signal_pgroup(signal.SIGKILL)
            self.proc.wait()
        self.proc = None
        mark_litert_lm("idle")

    async def stop_async(self) -> None:
        """Async-safe shutdown — runs the blocking wait off the event loop."""
        if self.proc is None:
            return
        self._signal_pgroup(signal.SIGTERM)
        loop = asyncio.get_running_loop()
        try:
            await asyncio.wait_for(loop.run_in_executor(None, self.proc.wait), timeout=5.0)
        except asyncio.TimeoutError:
            self._signal_pgroup(signal.SIGKILL)
            await loop.run_in_executor(None, self.proc.wait)
        self.proc = None
        mark_litert_lm("idle")

    def _signal_pgroup(self, sig: signal.Signals) -> None:
        if self.proc is None:
            return
        try:
            if sys.platform != "win32":
                os.killpg(os.getpgid(self.proc.pid), sig)
            else:
                self.proc.send_signal(sig)
        except (ProcessLookupError, PermissionError):
            # Process already gone — nothing to do.
            pass

    def upstream_url(self) -> str:
        return f"http://127.0.0.1:{self.cfg.api_server_port}"

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None
