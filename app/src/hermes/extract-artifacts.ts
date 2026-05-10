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
    return ''; // strip from cleaned text
  });

  return {
    cleanedText: tidyWhitespace(cleanedText),
    artifacts,
  };
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
  // Collapse the blank lines artifact tags leave behind, but preserve
  // intentional paragraph breaks elsewhere.
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
