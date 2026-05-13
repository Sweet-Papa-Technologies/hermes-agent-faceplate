# Phase 3 — Kokoro TTS Integration Research

> Research brief produced 2026-05-12 to inform Phase 3 of `v1.todo.md`. Future sessions implementing Kokoro TTS should re-read this before designing changes.

## 1. What is Kokoro

[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is an open-weight StyleTTS2-derived model from `hexgrad`, released late 2024 and iterated through 2025. At **82M parameters** it is tiny but punches far above its weight: it took **#1 in the TTS Spaces Arena** above XTTS v2 (467M) and Fish Speech (~500M), with reported MOS ~4.2. Compared to Piper, voices are noticeably more natural and prosodic; Piper still wins on pure CPU throughput for low-end hardware (Pi-class), but on a modern Mac/Linux desktop Kokoro is the clear quality upgrade. Apache 2.0 licensed weights.

## 2. Runtimes, hardware, latency

- **[kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI)** — Dockerized FastAPI wrapper, ONNX on CPU / PyTorch on CUDA. Most production-ready.
- **[kokoro-onnx](https://pypi.org/project/kokoro-onnx/)** — pip package, embeddable, CoreML/CUDA/CPU EPs.
- **[hexgrad/kokoro](https://github.com/hexgrad/kokoro)** — reference PyTorch package.
- **[Kokoros (Rust)](https://github.com/lucasjinreal/Kokoros)** and **[KokoroSharp (.NET)](https://www.nuget.org/packages/KokoroSharp/)** — language ports.
- **[mattmireles/kokoro-coreml](https://huggingface.co/mattmireles/kokoro-coreml)** / **[FluidInference/kokoro-82m-coreml](https://huggingface.co/FluidInference/kokoro-82m-coreml)** — ANE-targeted.

**Footprint:** ONNX weights ~310 MB + voice pack ~27 MB; RAM ~500 MB–1 GB resident.
**Latency:**
- Apple Silicon CoreML: ~100 ms first-token, **17–22× realtime** on M1+ ([benchmarks](https://www.jud.me/kokoro-coreml/)).
- Apple Silicon ONNX (CPU): ~300 ms first-token after warm load ([dev.to writeup](https://dev.to/xadenai/building-a-local-voice-ai-stack-whisper-ollama-kokoro-tts-on-apple-silicon-eo0)).
- Linux x86 CPU, no GPU: typically 0.5–1.0× realtime per stream depending on threads; first chunk in ~400–800 ms with `ONNX_NUM_THREADS=8`.

## 3. OpenAI-compat surface

Yes — **kokoro-fastapi natively implements `/v1/audio/speech`** with model name aliasing (`tts-1`, `tts-1-hd` map onto Kokoro), OpenAI voice aliases (`alloy`, `nova`, …), and the standard `response_format` set (`mp3`, `opus`, `wav`, `flac`, `pcm`, `m4a`) ([README](https://github.com/remsky/Kokoro-FastAPI), [OpenWebUI integration](https://docs.openwebui.com/features/chat-conversations/audio/text-to-speech/Kokoro-FastAPI-integration/)). Default base URL: `http://localhost:8880/v1`. Sample body is identical to OpenAI's: `{"model":"kokoro","voice":"af_bella","input":"Hello","response_format":"mp3","stream":true}`. **This is a true drop-in for our existing TTS client** — only `baseUrl`, `model`, and `voice` change.

## 4. Voices

54–88 voices depending on count method, prefix-coded by language+gender: `af_*` American female, `am_*` American male, `bf_*`/`bm_*` British, plus `jf_*`/`jm_*` Japanese, `zf_*`/`zm_*` Mandarin, French `ff_*`, Spanish `ef_*`/`em_*`, Hindi `hf_*`/`hm_*`, Italian `if_*`/`im_*`, Brazilian Portuguese `pf_*`/`pm_*` ([VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)). Each voice carries an A–F quality grade; English voices are A/B-grade, others mostly C. Weighted blending supported in kokoro-fastapi.

## 5. Install paths

- **Docker (recommended for our sidecar):** `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest` (also `-gpu:latest`). Self-contained, downloads model on first boot.
- **pip:** `pip install kokoro-onnx` + manual download of `kokoro-v1.0.onnx` and `voices-v1.0.bin`.
- **Compose:** ready-made files at [`docker/cpu`](https://github.com/remsky/Kokoro-FastAPI/blob/master/docker/cpu/docker-compose.yml) and [`docker/gpu`](https://github.com/remsky/Kokoro-FastAPI/blob/master/docker/gpu/docker-compose.yml).
- **Friendliest one-liner for Phase 5:** the `ghcr.io/remsky/kokoro-fastapi-cpu` image — same shape as our existing `faceplate-sidecar` pull. No host Python required.

## 6. Streaming

Yes — kokoro-fastapi emits **chunked HTTP** for streaming containerized formats (`mp3`, `opus`, `pcm`) via `stream=true`, with sentence-boundary chunking tuned by `TARGET_MIN_TOKENS=175`, `TARGET_MAX_TOKENS=250`, `ABSOLUTE_MAX_TOKENS=450` ([streaming docs](https://deepwiki.com/remsky/Kokoro-FastAPI/7.2-streaming-and-performance-optimization)). MP3 chunks are framed and append cleanly into MSE; **our renderer's existing MSE pipeline should work unchanged**. Opus inside an OGG container is also supported but, as today, MSE prefers MP3.

## 7. License

- **Model weights:** Apache 2.0 — commercial use OK, no attribution beyond standard Apache notice.
- **kokoro-fastapi:** Apache 2.0.
- **kokoro-onnx:** MIT.
- Training data is documented as permissively-licensed/public-domain — no known downstream encumbrance.

## 8. Recommended integration

1. **Runtime:** ship a second sidecar image `ghcr.io/remsky/kokoro-fastapi-cpu:latest` (GPU variant optional later). Keep Piper sidecar unchanged so users can A/B.
2. **Wire-up:** add `speech.tts.engine: 'piper' | 'kokoro'` to settings; the existing TTS client already speaks `/v1/audio/speech`, so the engine switch only swaps `baseUrl` (e.g., `http://localhost:8880/v1` for Kokoro vs current Piper port) and the allowed `voice` enum.
3. **Defaults when `engine === 'kokoro'`:** `model: "kokoro"`, `voice: "af_bella"` (A-grade English), `response_format: "mp3"`, `stream: true`.
4. **Settings UI:** engine dropdown gates the voice list; show Kokoro voice prefixes with language flags.
5. **Phase 5 installer:** add the image to the existing docker-pull bootstrap; ~340 MB extra disk, no extra apt packages, no GPU dependency.

## Sources
- [hexgrad/Kokoro-82M (HF)](https://huggingface.co/hexgrad/Kokoro-82M)
- [hexgrad/kokoro (GitHub)](https://github.com/hexgrad/kokoro)
- [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro-FastAPI streaming docs (DeepWiki)](https://deepwiki.com/remsky/Kokoro-FastAPI/7.2-streaming-and-performance-optimization)
- [Open WebUI integration guide](https://docs.openwebui.com/features/chat-conversations/audio/text-to-speech/Kokoro-FastAPI-integration/)
- [thewh1teagle/kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)
- [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [mattmireles/kokoro-coreml](https://github.com/mattmireles/kokoro-coreml)
- [Kokoro vs Piper (Slashdot)](https://slashdot.org/software/comparison/Kokoro-TTS-vs-Piper-TTS/)
- [Local voice stack on Apple Silicon](https://dev.to/xadenai/building-a-local-voice-ai-stack-whisper-ollama-kokoro-tts-on-apple-silicon-eo0)
