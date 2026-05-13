// Strip markdown / code / URLs from a model response so the TTS engine
// doesn't read asterisks and backticks aloud, while PRESERVING the
// formatting cues that drive natural pacing — sentence breaks, paragraph
// breaks, list-item pauses, em-dashes, ellipses.
//
// Captions still show the original formatted text; this function only
// shapes what gets spoken.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const HEADER_RE = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>[ \t]?/gm;
const LIST_BULLET_RE = /^[ \t]*([-*+]|\d+\.)[ \t]+(.*)$/gm;
const HORIZONTAL_RULE_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
// **bold** / *italic* / __bold__ / _italic_ / ~~strike~~. Done last so the
// inner text survives.
const BOLD_RE = /(\*\*|__)(\S(?:.*?\S)?)\1/g;
const ITALIC_RE = /(?<!\w)([*_])(?!\s)(\S(?:.*?\S)?)\1(?!\w)/g;
const STRIKE_RE = /~~(\S(?:.*?\S)?)~~/g;

// Already-terminal punctuation. If a list item or heading already ends in
// one of these, we don't append our own period — TTS engines treat any of
// these as a sentence boundary.
const TERMINAL_PUNCT_RE = /[.!?…:;]["')\]]?$/;

function ensureSentenceEnd(line: string): string {
  const trimmed = line.replace(/[ \t]+$/, '');
  if (!trimmed) return trimmed;
  return TERMINAL_PUNCT_RE.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Best-effort markdown→spoken-text conversion that PRESERVES pacing cues
 * (sentence + paragraph breaks, em-dashes, ellipses). Safe to call on
 * plain text (no markdown means no changes).
 */
export function stripForSpeech(text: string): string {
  if (!text) return text;
  let out = text;

  // Drop fenced code blocks entirely — they're noise when spoken.
  out = out.replace(FENCE_RE, ' (code block omitted) ');
  // Inline `code` → bare word.
  out = out.replace(INLINE_CODE_RE, '$1');

  // Images: keep alt text only.
  out = out.replace(IMAGE_RE, '$1');
  // [text](url) → text.
  out = out.replace(LINK_RE, '$1');
  // Bare URLs → "(link)" so the model doesn't spell out the whole URL.
  out = out.replace(URL_RE, '(link)');

  // Headers — strip the # markers AND the optional trailing # (ATX-style),
  // then ensure a period so the heading reads as its own sentence ("Q3
  // results were strong. Revenue …").
  out = out.replace(HEADER_RE, (_m, content: string) => ensureSentenceEnd(content));
  out = out.replace(BLOCKQUOTE_RE, '');
  // List bullets — drop the marker AND ensure each item ends with a period
  // so adjacent items don't run together when spoken. Without this,
  // "- foo\n- bar\n- baz" becomes "foo bar baz" with no pauses.
  out = out.replace(LIST_BULLET_RE, (_m, _marker: string, content: string) => ensureSentenceEnd(content));
  out = out.replace(HORIZONTAL_RULE_RE, '');

  // Inline emphasis. Order matters: bold before italic so `**foo**` doesn't
  // get half-eaten.
  out = out.replace(BOLD_RE, '$2');
  out = out.replace(STRIKE_RE, '$1');
  out = out.replace(ITALIC_RE, '$2');

  // Drop stray HTML tags the model sometimes emits.
  out = out.replace(HTML_TAG_RE, '');

  // Normalize spacing.
  //   - Tabs/multi-spaces collapse to single.
  //   - Three+ newlines clamp to two (paragraph break).
  //   - Triple-dot ASCII to ellipsis char so the engine treats it as a
  //     pause rather than three sequential periods (which can sound choppy
  //     on Piper). Kokoro handles either fine.
  //   - " ." / " ," / " ?" / " !" → strip the leading space (artifact of
  //     bullet-removal that left a space before the appended period).
  out = out.replace(/\.{3,}/g, '…');
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/ +([.!?,;:])/g, '$1');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
