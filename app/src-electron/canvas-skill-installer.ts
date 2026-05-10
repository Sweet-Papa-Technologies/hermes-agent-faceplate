// Auto-installs the Faceplate's "canvas" skill into hermes-agent's skill
// directory so the model knows about the inline <artifact> output protocol
// without users having to hand-edit their Hermes prompt.
//
// Layout:
//   ~/.hermes/skills/faceplate-canvas/SKILL.md
//
// Behavior:
//   - On boot, if the skill is missing → write it.
//   - If present but our SKILL_VERSION is newer than the on-disk file → overwrite.
//   - If present and version matches (or user-edited a newer one) → leave alone.
//   - Setting `hermes.install_canvas_skill` (default true) gates the whole flow.
//   - If ~/.hermes does not exist yet → no-op (the user hasn't set up Hermes).

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getSettings } from './settings-store';

const SKILL_NAME = 'faceplate-canvas';
const SKILL_FILENAME = 'SKILL.md';
// Bump this when the skill body materially changes — old installs will be
// upgraded on next boot. User-edited copies that bump their own version
// past ours stay untouched.
const SKILL_VERSION = '1.3.0';

function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const fromSettings = getSettings().hermes.config_path;
  if (fromSettings && fromSettings.endsWith('config.yaml')) {
    return path.dirname(expand(fromSettings));
  }
  return path.join(os.homedir(), '.hermes');
}

function expand(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function skillDir(): string { return path.join(hermesHome(), 'skills', SKILL_NAME); }
function skillFile(): string { return path.join(skillDir(), SKILL_FILENAME); }

function atomicWrite(file: string, content: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.faceplate.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function readVersion(content: string): string | null {
  const m = content.match(/^version:\s*"?([\d.]+)"?\s*$/m);
  return m ? m[1]! : null;
}

function semverGreater(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function buildSkill(): string {
  return `---
name: ${SKILL_NAME}
description: ALWAYS LOAD. Output formatting protocol for the HermesAgent Faceplate desktop UI. The user's Electron app NATIVELY RENDERS any <artifact type="..."> tag in your reply — you do NOT need matplotlib, plotly, browser tools, or any execution to draw charts/diagrams/images. Just emit a declarative JSON spec (or Mermaid source, or HTML, or a URL) inside the tag and the Faceplate renders it for the user. Wrap any chart, diagram, code block, image, video, audio, or rich text in <artifact> tags instead of describing it in prose, drawing it as ASCII, or trying to execute code to render it.
version: ${SKILL_VERSION}
metadata:
  hermes:
    tags: [output, formatting, canvas, visualization, faceplate, artifacts, always-load, charting, diagramming]
    related_skills: [diagramming, creative]
    always_load: true
---

# Faceplate Canvas — Artifact Output Protocol

## Critical: the Faceplate does the rendering, not you

The user is running the **HermesAgent Faceplate** desktop overlay. It has a dedicated transparent **canvas window** with built-in renderers for **Chart.js**, **Mermaid**, syntax-highlighted code, images, video, audio, markdown, and HTML/SVG previews.

When you want to show the user a chart, diagram, or any rich content, **DO NOT**:
- Try to import matplotlib, plotly, seaborn, pandas — they are not available, and you don't need them.
- Call \`terminal\` or \`shell\` tools to run python/node to render an image — the user's app handles the rendering itself.
- Open a browser, write an HTML file, or save anything to disk to "produce" the chart.
- Apologize for not having charting libraries. You have all you need: the artifact tag.
- Describe the chart in prose, ASCII art, or markdown bullets when the user asked for the chart itself.

**INSTEAD**, just emit the *spec* inside an \`<artifact>\` tag. The Faceplate's canvas window will render it natively as soon as you're done writing the tag. Example: for a bar chart, emit Chart.js JSON; the canvas takes that JSON and renders an interactive chart. You contribute the *data + intent*, the Faceplate contributes the *pixels*.

## Tag format

\`\`\`
<artifact type="..." title="..." [lang="..."] [mime="..."]>
BODY
</artifact>
\`\`\`

- \`type\` (required): one of \`chart\`, \`diagram\`, \`code\`, \`text\`, \`image\`, \`video\`, \`audio\`, \`visual\`.
- \`title\` (recommended): short label shown above the artifact in the canvas.
- \`lang\` / \`language\` (for \`code\`): syntax highlighter id (\`typescript\`, \`python\`, \`bash\`, \`html\`, \`svg\`, …).
- \`mime\` (for binary \`image\`/\`video\`/\`audio\` bodies): set when the body is base64 bytes rather than a URL.

You may include multiple artifacts in one response.

## Examples

### Chart — Chart.js v4 JSON config (body is JSON)

\`\`\`
<artifact type="chart" title="Quarterly revenue">
{
  "type": "bar",
  "data": {
    "labels": ["Q1", "Q2", "Q3", "Q4"],
    "datasets": [{ "label": "Revenue ($M)", "data": [12, 19, 8, 15] }]
  }
}
</artifact>
\`\`\`

### Diagram — Mermaid source (body is mermaid syntax)

\`\`\`
<artifact type="diagram" title="Login flow">
sequenceDiagram
    User->>App: open
    App->>Auth: redirect
    Auth-->>User: login form
    User->>Auth: credentials
    Auth-->>App: token
</artifact>
\`\`\`

### Code — any language; HTML/SVG additionally renders a live Preview tab

\`\`\`
<artifact type="code" lang="python" title="Fibonacci">
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
</artifact>
\`\`\`

\`\`\`
<artifact type="code" lang="html" title="Greeting card">
<div style="font: 24px serif; color: #4af;">Hello, world.</div>
</artifact>
\`\`\`

### Image — URL or data:URI in body

\`\`\`
<artifact type="image" title="Architecture sketch">https://example.com/diagram.png</artifact>
\`\`\`

### Video — direct file URL OR YouTube / Vimeo / Twitch / Dailymotion link

The Faceplate's video renderer detects the URL pattern and uses the platform's
embed endpoint when it's not a directly-streamable file. You don't have to
remember the embed URL shape — just paste the watch-page URL.

\`\`\`
<artifact type="video" title="Funny Cat Compilation">https://www.youtube.com/watch?v=dQw4w9WgXcQ</artifact>
<artifact type="video" title="Talk">https://vimeo.com/76979871</artifact>
\`\`\`

### Audio — direct file URL OR Spotify / SoundCloud / Apple Music

\`\`\`
<artifact type="audio" title="Lo-Fi Beats">https://open.spotify.com/playlist/37i9dQZF1DXc8kgYqQLMfH</artifact>
<artifact type="audio" title="Mix">https://soundcloud.com/artist/track</artifact>
\`\`\`

### Multi-media gallery — when the user wants several at once

Wrap an HTML page with multiple iframe embeds in a code artifact with \`lang="html"\` —
the canvas renders the Preview tab in a sandboxed iframe that allows YouTube, Spotify,
etc. embeds.

\`\`\`
<artifact type="code" lang="html" title="Cat Video Gallery">
<style>body{margin:0;font-family:system-ui;background:#111;color:#eee}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px}
  iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:8px}</style>
<div class="grid">
  <iframe src="https://www.youtube.com/embed/VIDEO_ID_1" allowfullscreen></iframe>
  <iframe src="https://www.youtube.com/embed/VIDEO_ID_2" allowfullscreen></iframe>
  <iframe src="https://www.youtube.com/embed/VIDEO_ID_3" allowfullscreen></iframe>
  <iframe src="https://www.youtube.com/embed/VIDEO_ID_4" allowfullscreen></iframe>
</div>
</artifact>
\`\`\`

### Text — markdown that should render in its own viewer (not be spoken)

\`\`\`
<artifact type="text" title="Key takeaways">
- Auth flow now uses JWTs
- Refresh tokens rotate every 24h
- All endpoints require \`Bearer\` header
</artifact>
\`\`\`

## Rules

- Put a 1-2 sentence narration in your reply text outside the tag, then drop the artifact tag right after. Don't bury the artifact under five paragraphs of explanation.
- Do NOT wrap your entire response in an artifact.
- Inside \`<artifact type="chart">\` the body is RAW JSON Chart.js v4 config — not a stringified blob, not escaped, not in a fence. The Faceplate parses it directly.
- Inside \`<artifact type="diagram">\` the body is RAW Mermaid source — no fence.
- For images / videos / audio, prefer a URL or data:URI in the body. Do not inline raw binary unless using \`mime\` + base64.
- Always include a \`title\` for chart, diagram, and code artifacts — it labels the canvas window.
- Tags are stripped from spoken/captioned text. Don't worry about the body confusing TTS.

## Media queries — finding real URLs

When the user asks for a video, song, image, or any other media you'd need to find:

1. **NEVER hallucinate URLs.** A real URL or no URL.
2. **Use Hermes' web tools** to find them:
   - \`web_search(query)\` — fast text search; returns titles + URLs
   - \`browser_navigate\` + \`browser_get_images\` — when you need images from a specific page
   - \`browser_vision\` — when text search isn't enough and you need to "see" the page
3. **Emit each result as its own artifact tag.** The canvas window already has prev/next nav so the user can step through multiple results.
4. **Multi-item galleries** (e.g. "show me 4 cat videos at once"): use the HTML gallery pattern from the Multi-media gallery section above.
5. **YouTube short-form / playlist URLs are fine** — the renderer handles \`youtube.com/watch?v=\`, \`youtu.be/\`, \`youtube.com/shorts/\`, and \`youtube.com/playlist?list=\`.

Examples of media query handling:

| User asks | Workflow |
|---|---|
| "show me a funny cat video" | \`web_search("funny cat video site:youtube.com")\` → pick best result → \`<artifact type="video" title="...">URL</artifact>\` |
| "play some lo-fi" | \`web_search("lo-fi beats spotify playlist")\` → \`<artifact type="audio" title="Lo-Fi">spotify URL</artifact>\` |
| "show me pictures of red pandas" | \`web_search("red panda images")\` → multiple \`<artifact type="image">URL</artifact>\` tags (one per image, nav-able) |
| "find a tutorial video about CSS grid" | \`web_search("CSS grid tutorial youtube")\` → \`<artifact type="video">URL</artifact>\` |

## What NOT to do

These are common LLM failure modes — actively avoid them:

| Wrong (don't do this) | Right (do this instead) |
|---|---|
| "Sorry, no charting libraries are installed" + ASCII bars | \`<artifact type="chart">{...JSON config...}</artifact>\` |
| Calling \`terminal\` to run \`python -c "import matplotlib..."\` | Emit the Chart.js JSON spec — Faceplate renders it |
| Long markdown table claiming to be "the chart" | The actual \`<artifact type="chart">\` tag |
| Drawing an SVG by hand and pasting it as text | \`<artifact type="diagram">\` with Mermaid OR \`<artifact type="code" lang="svg">\` |
| Writing an HTML file with \`terminal\` and saying "open this" | \`<artifact type="code" lang="html">...</artifact>\` (gets a Preview tab) |
| Saying "I made a chart" without actually emitting an artifact tag | If you say it, emit it |

## What the user sees

1. The canvas window auto-opens and focuses the latest artifact. Prev/next arrows step backward through the session.
2. The conversation panel shows a colored chip for every artifact next to the assistant's message. Clicking the chip re-opens the canvas focused on that artifact.
3. The "Artifacts" tab in the conversation panel shows all artifacts in this conversation; toggle "All conversations" to see every artifact ever generated.
4. Every artifact is downloadable from the canvas (⤓ button) and is persisted on disk across app restarts.
`;
}

export function ensureCanvasSkillInstalled(): { ok: boolean; path: string; reason?: string } {
  if (!getSettings().hermes.install_canvas_skill) {
    return { ok: false, path: skillFile(), reason: 'disabled by setting' };
  }
  const home = hermesHome();
  if (!existsSync(home)) {
    // Hermes isn't set up yet on this machine — nothing to do. We'll try
    // again on next boot once the user has installed Hermes.
    return { ok: false, path: skillFile(), reason: 'hermes home not found' };
  }
  const target = skillFile();
  const desired = buildSkill();
  if (!existsSync(target)) {
    try {
      atomicWrite(target, desired);
      console.log(`[canvas-skill] installed at ${target}`);
      return { ok: true, path: target };
    } catch (err) {
      console.error('[canvas-skill] install failed:', err);
      return { ok: false, path: target, reason: String(err) };
    }
  }
  // File exists. Compare versions; only overwrite if ours is newer than
  // what's on disk. That way users (or other tools) can fork the skill
  // and bump its version to keep our updates from clobbering their edits.
  let onDiskVersion: string | null = null;
  try {
    const existing = readFileSync(target, 'utf8');
    onDiskVersion = readVersion(existing);
  } catch (err) {
    console.warn('[canvas-skill] read existing failed, will overwrite:', err);
  }
  if (!onDiskVersion || semverGreater(SKILL_VERSION, onDiskVersion)) {
    try {
      atomicWrite(target, desired);
      console.log(`[canvas-skill] upgraded ${onDiskVersion ?? '(unknown)'} → ${SKILL_VERSION}`);
      return { ok: true, path: target };
    } catch (err) {
      console.error('[canvas-skill] upgrade failed:', err);
      return { ok: false, path: target, reason: String(err) };
    }
  }
  return { ok: true, path: target };
}
