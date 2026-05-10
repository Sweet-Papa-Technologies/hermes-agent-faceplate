// Artifact persistence types.
//
// Artifacts are pieces of rich content (images, charts, code, diagrams,
// etc.) that the assistant attaches to a turn. They render in the canvas
// window and inline in the conversation panel transcript.
//
// Storage layout:
//   <userData>/artifacts/manifest.json         — fast index for list views
//   <userData>/artifacts/<id>/manifest.json    — full per-artifact metadata
//   <userData>/artifacts/<id>/body.<ext>       — when body_storage='file'

export type ArtifactKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'code'
  | 'chart'
  | 'diagram'
  | 'visual';

/**
 * How the artifact's body is stored:
 *   - 'inline': body is the actual content (text, JSON, mermaid source, etc.)
 *   - 'file':   body is a relative filename inside the artifact's directory
 *               (binary content like decoded image/video/audio bytes)
 *   - 'url':    body is an absolute URL (http(s) or data:); rendered as-is
 */
export type ArtifactBodyStorage = 'inline' | 'file' | 'url';

export interface Artifact {
  id: string;
  conversation_id: string;
  /** The assistant turn this artifact belongs to. Null = unattached. */
  turn_id: string | null;
  kind: ArtifactKind;
  title?: string;
  created_at: number;
  body_storage: ArtifactBodyStorage;
  body: string;
  mime?: string;
  /** For 'code': the language identifier (e.g. 'typescript', 'python'). */
  language?: string;
  /** Where this artifact came from. */
  source: 'inline' | 'tool' | 'manual';
}

export interface ArtifactIndexEntry {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  kind: ArtifactKind;
  title?: string;
  created_at: number;
  /** Short text preview (~80 chars) for gallery cards. */
  preview?: string;
}

export interface ArtifactsManifest {
  schema_version: 1;
  artifacts: ArtifactIndexEntry[];
}

/**
 * What a renderer asks the main process to create. Body is either inline
 * text or a base64-encoded blob. Main decides how to persist.
 */
export interface CreateArtifactInput {
  conversation_id: string;
  turn_id?: string | null;
  kind: ArtifactKind;
  title?: string;
  body: string;
  body_storage: ArtifactBodyStorage;
  /** Required when body_storage === 'file' (so main knows the extension). */
  mime?: string;
  /** For 'code'. */
  language?: string;
  /** Default 'inline'. */
  source?: Artifact['source'];
}
