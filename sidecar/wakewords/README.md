# Wake-word models

Drop `.onnx` files here; they're picked up by the sidecar at startup if
listed under `wake.models` in `config.yaml`.

The Faceplate's default config references `/wakewords/hey_hermes.onnx`, but
no model is shipped — wake-word is **off by default** and we don't want to
bake a single trained word into the binary.

## Bringing your own

1. Train a model with [openWakeWord's Piper-synthetic pipeline](https://github.com/dscripka/openWakeWord#training-new-models-with-synthetic-data) (~30 minutes on a CPU).
2. Drop the resulting `.onnx` into the `faceplate-wakewords` Docker volume:
   ```
   docker run --rm -v faceplate-wakewords:/wakewords -v $PWD:/host alpine \
       cp /host/hey_hermes.onnx /wakewords/
   ```
3. Add it to your `config.yaml`:
   ```yaml
   wake:
     enabled: true
     models:
       - "/wakewords/hey_hermes.onnx"
     threshold: 0.5
   ```
4. Restart the sidecar (`docker compose restart`).

## Pre-trained alternatives

openWakeWord ships several Apache-2.0 models out of the box (e.g. "hey
jarvis", "alexa"). You can reference them by name in `config.yaml` instead
of mounting an .onnx; the loader will fall back to the bundled ones when
the path doesn't exist on disk.

## Picovoice Porcupine

Porcupine has cleaner DX (web console, no training required) but its free
tier limits "active users" to 3. If your deployment needs more, switch to
openWakeWord; for personal use either works.
