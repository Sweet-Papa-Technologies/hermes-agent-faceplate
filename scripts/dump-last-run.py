#!/usr/bin/env python3
"""
Pretty-print the most recent hermes session_run_*.json — the per-turn
message + tool-call history that aiohttp.access logs DON'T show.

Usage:
    scripts/dump-last-run.py [N]
        N = number of trailing messages to show (default: all)
"""
import json
import os
import sys
from glob import glob


def main() -> int:
    sessions_dir = os.path.expanduser("~/.hermes/sessions")
    runs = sorted(
        glob(os.path.join(sessions_dir, "session_run_*.json")),
        key=os.path.getmtime,
        reverse=True,
    )
    if not runs:
        print("· no completed runs yet")
        return 0

    latest = runs[0]
    print(f"▸ {latest}\n")

    with open(latest) as f:
        s = json.load(f)
    msgs = s.get("messages", [])
    print(f"{len(msgs)} messages")
    if not msgs:
        return 0

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(msgs)
    start = max(0, len(msgs) - limit)

    for i, m in enumerate(msgs[start:], start=start):
        role = m.get("role", "?")
        content = m.get("content", "")
        if isinstance(content, list):
            content = " | ".join(str(c) for c in content)
        snippet = (str(content) or "<empty>")[:200].replace("\n", " ")
        print(f"\n[{i}] {role}: {snippet}")
        for c in m.get("tool_calls") or []:
            fn = c.get("function", {}).get("name", "?")
            args = c.get("function", {}).get("arguments", "")[:150]
            print(f"    └─ tool_call: {fn}({args})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
