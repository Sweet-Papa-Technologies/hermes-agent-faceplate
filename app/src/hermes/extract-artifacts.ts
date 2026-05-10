// Inline artifact tag parser.
//
// Hermes is prompted to wrap rich content in self-describing tags:
//
//   <artifact type="chart" title="Sales Q3">
//     {"type": "bar", "data": {"labels": ["Jul","Aug","Sep"], "datasets":[…]}}
//   </artifact>
//
//   <artifact type="diagram" title="System diagram">
//     graph TD; A-->B; A-->C
//   </artifact>
//
//   <artifact type="image" title="Logo">https://example.com/logo.png</artifact>
//
//   <artifact type="code" lang="python" title="Fizzbuzz">
//   for i in range(1, 16):
//       …
//   </artifact>
//
// Body interpretation depends on `type`:
//   image / video / audio / visual:
//     - If body looks like a URL or a data: URI → body_storage='url', body=URL
//     - If body looks like base64 (mime hint via attribute) → body_storage='file'
//     - Otherwise treated as text (fallback).
//   text / code / chart / diagram:
//     - body_storage='inline', body is the textual content as-given.
//
// The parser also returns `cleanedText` — the original assistant text with
// the artifact blocks stripped out, so the captions + persisted turn show
// the prose without raw artifact bodies leaking into them.

import type { ArtifactKind, CreateArtifactInput } from '../stores/artifact-types';

const ARTIFACT_RE = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

const KNOWN_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'image', 'video', 'audio', 'text', 'code', 'chart', 'diagram', 'visual',
]);

const URL_OR_DATA_RE = /^(?:https?:\/\/|data:[\w/+.-]+;base64,)/i;
const BASE64_ONLY_RE = /^[A-Za-z0-9+/=\s]+$/;

export interface ExtractedArtifact {
  /** Pre-create payload — feed straight into faceplate.artifacts.create() */
  input: Omit<CreateArtifactInput, 'conversation_id' | 'turn_id'>;
}

export interface ExtractResult {
  cleanedText: string;
  artifacts: ExtractedArtifact[];
}

export function extractArtifacts(text: string): ExtractResult {
  if (!text || !text.includes('<artifact')) {
    return { cleanedText: text, artifacts: [] };
  }
  const artifacts: ExtractedArtifact[] = [];
  const cleanedText = text.replace(ARTIFACT_RE, (_match, attrsRaw: string, bodyRaw: string) => {
    const attrs = parseAttrs(attrsRaw);
    const kindRaw = (attrs.type || attrs.kind || '').toLowerCase();
    if (!KNOWN_KINDS.has(kindRaw as ArtifactKind)) {
      // Unknown kind — leave the tag in place so the user can still see
      // what the model intended.
      return _match;
    }
    const kind = kindRaw as ArtifactKind;
    const body = bodyRaw.trim();
    const input = buildInput(kind, body, attrs);
    if (input) artifacts.push({ input });
    // Replace the tag with a brief placeholder rather than emptying it.
    // Three reasons:
    //   1. If the model's response is MOSTLY artifact tags with little
    //      surrounding prose, stripping to "" leaves the conversation
    //      transcript with no visible text — the user sees only chips
    //      and assumes nothing was said.
    //   2. Captions stream the raw text mid-turn; if we collapse to ""
    //      after stream-end the bubble vanishes mid-read.
    //   3. TTS still reads the placeholder, but as natural prose
    //      ("chart Sales Q3") rather than "left-bracket chart…".
    return placeholderFor(kind, attrs);
  });

  return {
    cleanedText: tidyWhitespace(cleanedText),
    artifacts,
  };
}

const KIND_LABELS: Record<ArtifactKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'document',
  code: 'code',
  chart: 'chart',
  diagram: 'diagram',
  visual: 'visual',
};

function placeholderFor(kind: ArtifactKind, attrs: Record<string, string>): string {
  const label = KIND_LABELS[kind];
  const title = (attrs.title ?? '').trim();
  // Plain parens read naturally in TTS ("chart Sales Q3") and the
  // conversation panel renders them inline. Padded with spaces so the
  // tag site doesn't fuse with adjacent words after collapse.
  if (title) return ` (${label}: ${title}) `;
  return ` (${label}) `;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const k = m[1]?.toLowerCase();
    const v = m[2];
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

function buildInput(
  kind: ArtifactKind,
  body: string,
  attrs: Record<string, string>,
): Omit<CreateArtifactInput, 'conversation_id' | 'turn_id'> | null {
  const title = attrs.title;
  const language = attrs.lang || attrs.language;
  const mime = attrs.mime;
  const baseFields = {
    kind,
    ...(title ? { title } : {}),
    ...(language ? { language } : {}),
    ...(mime ? { mime } : {}),
    source: 'inline' as const,
  };

  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'visual') {
    if (URL_OR_DATA_RE.test(body)) {
      return { ...baseFields, body, body_storage: 'url' };
    }
    // Treat as base64-encoded bytes when we have a mime hint and the body
    // looks like base64. Otherwise fall back to inline text — the renderer
    // will surface a "couldn't parse" message rather than crash.
    if (mime && BASE64_ONLY_RE.test(body.replace(/\s+/g, ''))) {
      return {
        ...baseFields,
        body: body.replace(/\s+/g, ''),
        body_storage: 'file',
      };
    }
    return { ...baseFields, body, body_storage: 'inline' };
  }

  // text / code / chart / diagram → always inline
  return { ...baseFields, body, body_storage: 'inline' };
}

function tidyWhitespace(s: string): string {
  // 1. Collapse run-on spaces from the ` (chart) ` padding (two adjacent
  //    placeholders produce `  (chart)   (image)  `).
  // 2. Strip double spaces but preserve newlines.
  // 3. Collapse 3+ consecutive newlines to a paragraph break.
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
