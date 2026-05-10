// Renderer-side paraphrase entry. Real work happens in main
// (paraphrase-bridge.ts) so the LLM API key never crosses into renderer.

export interface ParaphraseRequest {
  text: string;
}

export interface ParaphraseOutcome {
  text: string;
  used: 'reuse_hermes_llm' | 'local_litert' | 'disabled' | 'skipped';
  latency_ms: number;
  fallback_reason?: 'unsafe_to_bypass' | 'unreachable' | 'no_endpoint';
}

export async function paraphrase(text: string): Promise<ParaphraseOutcome> {
  const fp = window.faceplate;
  if (!fp) return { text, used: 'disabled', latency_ms: 0 };
  return fp.hermes.paraphrase(text);
}
