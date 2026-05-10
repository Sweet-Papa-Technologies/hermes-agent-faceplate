// Extract the first balanced JSON object/array from a string that may
// contain surrounding noise — markdown code fences, trailing prose, a
// stray comment, a comma after the closing brace, etc.
//
// Why: LLMs sometimes wrap chart JSON in ```json ... ``` fences, append a
// "// note: ..." trailing line, or add prose after the closing brace.
// Strict JSON.parse fails with "Unexpected non-whitespace character after
// JSON at position N" — useless for the user. This walks the input as a
// state machine, finds the first complete object/array, and returns just
// that slice for parsing.

export interface ExtractResult {
  /** The extracted JSON-like substring, or null if no balanced object/array found. */
  slice: string | null;
  /** True if we had to strip ``` fences or other noise to find it. */
  trimmed: boolean;
}

/**
 * Find the first balanced `{...}` or `[...]` in `raw`. String literals
 * are tracked so braces inside strings don't count toward depth.
 */
export function extractBalancedJson(raw: string): ExtractResult {
  if (!raw) return { slice: null, trimmed: false };

  // Strip a leading ```json (or just ```) fence and the matching closing
  // fence. We do this before the brace walk because the fence backticks
  // can appear after the closing brace and trip the trailing-junk check.
  let s = raw.trim();
  let trimmed = false;
  const fenceMatch = s.match(/^```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch && fenceMatch[1]) {
    s = fenceMatch[1].trim();
    trimmed = true;
  }

  // Find the first opening bracket. Anything before is prose / whitespace.
  const start = findFirstBracket(s);
  if (start < 0) return { slice: null, trimmed };
  if (start > 0) trimmed = true;

  const open = s.charAt(start);
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        if (i + 1 < s.length && s.slice(i + 1).trim().length > 0) trimmed = true;
        return { slice, trimmed };
      }
    }
  }
  // Unbalanced — return what we have so the parser surfaces a useful error.
  return { slice: s.slice(start), trimmed: true };
}

function findFirstBracket(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

/**
 * Convenience: extract + JSON.parse in one call. Returns the parsed value
 * on success, throws an Error with a friendlier message on failure.
 */
export function parseLooseJson<T = unknown>(raw: string): T {
  const result = extractBalancedJson(raw);
  if (!result.slice) {
    throw new Error('No JSON object or array found in body');
  }
  try {
    return JSON.parse(result.slice) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = result.trimmed
      ? ' (the body had extra text around the JSON; the slice we tried was: '
        + truncate(result.slice, 200) + ')'
      : '';
    throw new Error(`${msg}${hint}`);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
