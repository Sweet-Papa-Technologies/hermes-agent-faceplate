// Renderer-side paraphrase entry. Real work happens in main
// (paraphrase-bridge.ts) so the LLM API key never crosses into renderer.

export interface ParaphraseRequest {
  text: string;
}

export interface ParaphraseOutcome {
  text: string;
  used: 'reuse_hermes_llm' | 'sidecar_fallback' | 'disabled' | 'skipped';
  latency_ms: number;
}

export async function paraphrase(text: string): Promise<ParaphraseOutcome> {
  const fp = window.faceplate;
  if (!fp) return { text, used: 'disabled', latency_ms: 0 };
  return fp.hermes.paraphrase(text);
}
