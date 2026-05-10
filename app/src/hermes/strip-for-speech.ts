// Strip markdown / code / URLs from a model response so Piper doesn't read
// asterisks and backticks aloud. Used right before TTS; captions still show
// the original formatted text.
//
// Conservative on purpose — we don't try to be a full markdown renderer,
// just remove the noise characters that Piper otherwise vocalizes.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const HEADER_RE = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>[ \t]?/gm;
const LIST_BULLET_RE = /^[ \t]*([-*+]|\d+\.)[ \t]+/gm;
const HORIZONTAL_RULE_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
// **bold** / *italic* / __bold__ / _italic_ / ~~strike~~. Done last so the
// inner text survives.
const BOLD_RE = /(\*\*|__)(\S(?:.*?\S)?)\1/g;
const ITALIC_RE = /(?<!\w)([*_])(?!\s)(\S(?:.*?\S)?)\1(?!\w)/g;
const STRIKE_RE = /~~(\S(?:.*?\S)?)~~/g;

/**
 * Best-effort markdown→spoken-text conversion. Safe to call on plain text
 * (no markdown means no changes).
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

  // Headers, blockquotes, list bullets, hr — drop the punctuation only.
  out = out.replace(HEADER_RE, '');
  out = out.replace(BLOCKQUOTE_RE, '');
  out = out.replace(LIST_BULLET_RE, '');
  out = out.replace(HORIZONTAL_RULE_RE, '');

  // Inline emphasis. Order matters: bold before italic so `**foo**` doesn't
  // get half-eaten.
  out = out.replace(BOLD_RE, '$2');
  out = out.replace(STRIKE_RE, '$1');
  out = out.replace(ITALIC_RE, '$2');

  // Drop stray HTML tags the model sometimes emits.
  out = out.replace(HTML_TAG_RE, '');

  // Collapse run-on whitespace introduced by the substitutions; preserve
  // single newlines so Piper still gets sentence boundaries.
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
