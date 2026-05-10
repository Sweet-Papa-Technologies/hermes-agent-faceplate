// Conversation persistence types.
//
// Imported by both the main process (disk I/O in conversation-store.ts) and
// the renderer (Pinia stores). Same pattern as settings-schema.ts.

export type TurnRole = 'user' | 'assistant' | 'system';

export interface PersistedToolCall {
  tool: string;
  args_preview: string;
  status: 'started' | 'completed' | 'failed';
  ts: number;
}

export interface PersistedTurn {
  id: string;
  role: TurnRole;
  text: string;
  ts: number;
  tool_calls?: PersistedToolCall[];
  /** IDs of artifacts attached to this turn. The artifact bodies live in the
   * artifact store (artifact-store.ts in main, artifact-types.ts schema). */
  artifact_ids?: string[];
  model?: string;
  error?: string;
}

export interface ConversationManifestEntry {
  id: string;
  title: string;
  created_at: number;
  last_used_at: number;
  preview: string;
  turn_count: number;
  hermes_session_id: string | null;
  archived?: boolean;
}

export interface ConversationManifest {
  schema_version: 1;
  active_id: string | null;
  conversations: ConversationManifestEntry[];
}

export interface ConversationFile {
  schema_version: 1;
  id: string;
  title: string;
  created_at: number;
  last_used_at: number;
  /** Audit / approval handle. Hermes uses this to group turns into one
   * dashboard entry; not used for memory. */
  hermes_session_id: string | null;
  /** OpenAI-Responses-style chain head. We send this as
   * `previous_response_id` on the next turn so Hermes reconstructs
   * conversation memory from its server-side response store — the
   * proper alternative to replaying `conversation_history` ourselves. */
  hermes_last_response_id?: string | null;
  turns: PersistedTurn[];
}
