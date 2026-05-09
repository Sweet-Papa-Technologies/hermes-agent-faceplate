"""WS /wake — bidirectional 16 kHz Int16 PCM in, JSON status events out."""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..backends.openwakeword_be import WakeDetector, get_detector
from ..config import get_config


router = APIRouter()
_log = logging.getLogger("faceplate_sidecar.wake.route")


@router.websocket("/wake")
async def wake_endpoint(ws: WebSocket) -> None:
    cfg = get_config()
    if not cfg.wake.enabled:
        await ws.close(code=4403, reason="wake-word disabled")
        return
    if not cfg.wake.models:
        await ws.close(code=4404, reason="no wake models configured")
        return

    # Bearer-token auth via ?token=<>
    if cfg.auth.bearer_token:
        if ws.query_params.get("token") != cfg.auth.bearer_token:
            await ws.close(code=4401, reason="invalid bearer token")
            return

    await ws.accept()
    detector: WakeDetector = get_detector(cfg.wake.models, cfg.wake.threshold)
    try:
        detector.ensure_loaded()
    except Exception as err:
        await _send(ws, {"type": "error", "message": str(err)})
        await ws.close()
        return

    await _send(ws, {"type": "ready", "models": detector.model_basenames(cfg.wake.models)})
    last_silence_ts = time.time()

    try:
        while True:
            msg = await ws.receive()
            if "bytes" in msg and msg["bytes"] is not None:
                frame: bytes = msg["bytes"]
                scores = detector.predict(frame)
                hit = detector.matches(scores)
                if hit is not None:
                    name, score = hit
                    await _send(
                        ws,
                        {
                            "type": "wake",
                            "model": name,
                            "score": score,
                            "ts": time.time(),
                        },
                    )
                    last_silence_ts = time.time()
                elif time.time() - last_silence_ts > 5:
                    last_silence_ts = time.time()
                    await _send(ws, {"type": "silence"})
            elif "text" in msg and msg["text"] is not None:
                # Initial config message — currently ignored; sample rate is
                # fixed at 16 kHz on the wire.
                _ = json.loads(msg["text"])
    except WebSocketDisconnect:
        return


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload))
