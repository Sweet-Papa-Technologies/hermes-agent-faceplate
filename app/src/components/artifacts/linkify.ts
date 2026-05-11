// Render-time URL auto-linker for artifacts that show plain text inside the
// Canvas (CSV cells, future log views, etc.). The output is HTML — escape
// the input first, then run the URL regex over the already-escaped string
// so we never re-introduce unsafe characters. The original artifact body is
// never modified; this only shapes what appears in the DOM. Saves to disk
// continue to write the unmodified source.
//
// Click handling is centralized in CanvasPage.vue's delegated <a href>
// handler — any link this helper emits gets routed to the system browser.

const URL_RE =
  /\b(?:https?:\/\/|mailto:|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function linkify(raw: string): string {
  if (!raw) return '';
  const escaped = escapeHtml(raw);
  return escaped.replace(URL_RE, (m) => {
    const href = m.startsWith('www.') ? `https://${m}` : m;
    return `<a href="${href}" rel="noopener noreferrer">${m}</a>`;
  });
}
