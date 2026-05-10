#!/usr/bin/env python3
"""
Idempotent hermes-agent tool configuration for Faceplate users.

  - Adds `web` and `browser` to ~/.hermes/config.yaml `toolsets:` list
    (preserving any user additions like `hermes-cli`).
  - Picks `web.search_backend` based on which API keys exist in
    ~/.hermes/.env, with SearXNG as the always-available fallback:
        TAVILY_API_KEY     → tavily
        FIRECRAWL_API_KEY  → firecrawl     (also picked for extract_backend)
        EXA_API_KEY        → exa
        else               → searxng
  - Sets `web.extract_backend` to firecrawl if the key is set, otherwise
    leaves blank so hermes uses its built-in extractor.
  - Adds `SEARXNG_URL=http://host.docker.internal:9080` to .env if missing
    (so hermes inside Docker can reach the host-side SearXNG container).
  - Writes a timestamped backup of config.yaml before any change.

Re-runnable. Safe to call any time the user reconfigures keys.
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

CONFIG = Path(os.path.expanduser("~/.hermes/config.yaml"))
ENV = Path(os.path.expanduser("~/.hermes/.env"))
SEARXNG_URL = "http://host.docker.internal:9080"


def detect_backend() -> tuple[str, str]:
    """Return (search_backend, extract_backend) from env vars in ~/.hermes/.env."""
    env_kv = read_env(ENV)
    if env_kv.get("TAVILY_API_KEY"):
        return ("tavily", env_kv.get("FIRECRAWL_API_KEY") and "firecrawl" or "")
    if env_kv.get("FIRECRAWL_API_KEY"):
        return ("firecrawl", "firecrawl")
    if env_kv.get("EXA_API_KEY"):
        return ("exa", "")
    return ("searxng", "")


def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k.strip()] = v
    return out


def ensure_env_var(path: Path, key: str, value: str) -> bool:
    """Append `key=value` to .env if `key` isn't already present. Returns True if changed."""
    existing = read_env(path)
    if key in existing:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    sep = ""
    if path.exists() and path.stat().st_size > 0:
        with path.open("rb") as f:
            f.seek(-1, 2)
            sep = "" if f.read(1) == b"\n" else "\n"
    with path.open("a") as f:
        f.write(f"{sep}{key}={value}\n")
    return True


def patch_config(cfg: dict[str, Any], search_backend: str, extract_backend: str) -> list[str]:
    """Mutate `cfg` in place. Returns list of human-readable change descriptions."""
    changes: list[str] = []

    # 1. toolsets list — add web + browser if missing, preserve order
    toolsets = cfg.setdefault("toolsets", [])
    if not isinstance(toolsets, list):
        toolsets = []
        cfg["toolsets"] = toolsets
    for needed in ("web", "browser"):
        if needed not in toolsets:
            toolsets.append(needed)
            changes.append(f"toolsets += {needed}")

    # 2. web block
    web = cfg.setdefault("web", {})
    if not isinstance(web, dict):
        web = {}
        cfg["web"] = web

    # Only set search_backend if it's currently empty — don't clobber a
    # user's manual choice.
    if not web.get("search_backend"):
        web["search_backend"] = search_backend
        changes.append(f"web.search_backend = {search_backend}")
    if extract_backend and not web.get("extract_backend"):
        web["extract_backend"] = extract_backend
        changes.append(f"web.extract_backend = {extract_backend}")

    return changes


def main() -> int:
    if not CONFIG.exists():
        print(f"✗ {CONFIG} not found. Run hermes setup first.", file=sys.stderr)
        return 1

    search_backend, extract_backend = detect_backend()
    print(f"▸ search_backend = {search_backend}", end="")
    print(f" (extract_backend = {extract_backend or 'hermes default'})")

    with CONFIG.open() as f:
        cfg = yaml.safe_load(f) or {}

    changes = patch_config(cfg, search_backend, extract_backend)

    if changes:
        backup = CONFIG.with_name(
            f"{CONFIG.name}.bak.tools.{datetime.now():%Y%m%d-%H%M%S}"
        )
        shutil.copy2(CONFIG, backup)
        with CONFIG.open("w") as f:
            yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
        print(f"▸ patched {CONFIG}:")
        for c in changes:
            print(f"    · {c}")
        print(f"▸ backup: {backup}")
    else:
        print(f"· {CONFIG} already configured — no changes")

    if search_backend == "searxng":
        if ensure_env_var(ENV, "SEARXNG_URL", SEARXNG_URL):
            print(f"▸ added SEARXNG_URL={SEARXNG_URL} to {ENV}")
        else:
            print(f"· {ENV} already has SEARXNG_URL — leaving alone")

    print()
    print("Restart hermes so it re-reads config + env:")
    print("    make hermes-down && make hermes-up")
    return 0


if __name__ == "__main__":
    sys.exit(main())
