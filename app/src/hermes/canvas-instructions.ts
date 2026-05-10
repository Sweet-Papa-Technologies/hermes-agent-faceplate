// Inline artifact-protocol "instructions" string sent with every Hermes
// request via the /v1/runs `instructions` field (mapped to
// ephemeral_system_prompt server-side). This guarantees the protocol is
// present in the system prompt for every turn, regardless of whether the
// model decides to skill_view() the standalone faceplate-canvas skill.
//
// Kept short on purpose — every request pays the token cost. The full,
// example-rich version lives in canvas-skill-installer.ts and is loaded
// on demand via skill_view when the model wants more detail.
//
// Stable string per eagerness setting: same content on every request →
// eligible for prompt caching on the server side.

import type { ArtifactsSettings } from '../stores/settings-schema';

const EAGERNESS_PREAMBLE: Record<ArtifactsSettings['eagerness'], string> = {
  subtle:
    'EAGERNESS: subtle. Only emit artifacts when the user explicitly asks for a visual (chart, diagram, code, image). Otherwise stay text-only.',
  balanced:
    'EAGERNESS: balanced. Emit artifacts whenever they materially help — comparable data → chart, multi-step process → diagram, runnable snippet → code, referenced URL of an image → image. Skip for short factual answers.',
  liberal:
    'EAGERNESS: liberal. Look for opportunities to render visually. Lists of comparable numbers → chart. System / process explanations → diagram. Any non-trivial code block → <artifact type="code">. Any external URL pointing at an image / video → <artifact>. Mention of a UI snippet → HTML code artifact (the canvas previews it). Default to "yes, render it" unless artifact clearly adds nothing.',
  aggressive:
    'EAGERNESS: aggressive. Every reply that CAN have a visualization gets one, even when prose alone would suffice. Pair charts with related diagrams. Multi-section answers get separate text artifacts per section. Always look for a way to add visual richness via <artifact> tags.',
};

const BASE = `OUTPUT PROTOCOL — CRITICAL.
This response renders in the HermesAgent Faceplate desktop app, which has a built-in canvas window with native renderers for Chart.js, Mermaid, syntax-highlighted code, images, video, audio, and HTML/SVG previews.

When you want to show the user a chart, diagram, code, image, or rich text, wrap a DECLARATIVE SPEC inside an <artifact> tag. The Faceplate renders it natively.

DO NOT:
- import matplotlib / plotly / pandas (not installed, not needed)
- call terminal/shell tools to render an image
- emit ASCII bar charts, box-drawing tables claiming to be "the chart", or markdown bullets describing the chart
- apologize for missing libraries — you have all you need: the artifact tag

INSTEAD, emit the spec directly. The Faceplate parses the tag, persists the artifact, and auto-opens the canvas focused on it. Tag bodies are stripped from TTS so narration goes OUTSIDE the tag.

Tag format:
<artifact type="..." title="..." [lang="..."]>BODY</artifact>

Examples:
<artifact type="chart" title="Cats vs Dogs">{"type":"bar","data":{"labels":["Cats","Dogs"],"datasets":[{"label":"Cuteness","data":[10,10]}]}}</artifact>
<artifact type="diagram" title="Login flow">sequenceDiagram
  User->>App: open
  App->>Auth: redirect</artifact>
<artifact type="code" lang="python" title="Fib">def fib(n):
    a,b=0,1
    for _ in range(n): a,b=b,a+b
    return a</artifact>
<artifact type="image" title="Logo">https://example.com/logo.png</artifact>

Types: chart (Chart.js JSON), diagram (Mermaid), code (any lang), text (markdown), image / video / audio / visual (URL or data:URI).

The faceplate-canvas skill has the full protocol if you need details, but you do NOT need to skill_view it for normal use.`;

/** Build the system-prompt instructions for the configured eagerness mode. */
export function buildCanvasInstructions(
  eagerness: ArtifactsSettings['eagerness'] = 'balanced',
): string {
  return `${EAGERNESS_PREAMBLE[eagerness]}\n\n${BASE}`;
}

// Backward-compat default export for callers that don't pass a setting.
export const CANVAS_PROTOCOL_INSTRUCTIONS = buildCanvasInstructions('balanced');
