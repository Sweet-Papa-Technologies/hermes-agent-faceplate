"""HermesAgent Faceplate speech sidecar.

Single FastAPI app exposing OpenAI-compatible TTS / ASR / wake-word /
paraphrase endpoints. Three image variants:

  - :cpu       full bundle (Piper + faster-whisper + openWakeWord + LiteRT-LM)
  - :cpu-slim  no LLM     (drops paraphrase-fallback + LiteRT-LM)
  - :cuda      GPU paths  (Kokoro-fastapi + faster-whisper fp16 + LiteRT-LM GPU)

See sidecar/README.md and DESIGN-CORE.md §7.
"""

__version__ = "0.1.0"
