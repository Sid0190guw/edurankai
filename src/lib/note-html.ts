// src/lib/note-html.ts — render a portal note's stored HTML safely on a surface someone else opens.
//
// WHY. /portal/notes stores the raw innerHTML of a contenteditable. That is fine while the only
// reader is the author, and it stops being fine the moment a second person can open it — a shared
// link, or a collaborator's copy. Anything the author (or a collaborator, who is a DIFFERENT user)
// typed would run in the reader's session. This project has no HTML sanitiser and no dependency
// that provides one, so the safe rendering rule is written here once instead of being re-invented
// per page.
//
// THE RULE IS AN ALLOW-LIST, AND IT KEEPS NO ATTRIBUTES. Every tag is escaped first; only the
// structural tags below are put back, and only in their bare form. No href, no src, no style, no
// class, no event handler survives — not because each one is individually dangerous, but because an
// allow-list that has to reason about attribute VALUES is the kind that gets bypassed. Links
// therefore render as their text. That is a real limitation and callers should say so on the page
// rather than let a reader wonder why a link is not clickable.

/** Tags kept, in bare form, when a note is rendered for someone other than its author. */
const ALLOWED_TAGS = [
  'p', 'div', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'blockquote', 'code', 'pre',
] as const;

const TAG_RE = new RegExp('&lt;(\\/?)(' + ALLOWED_TAGS.join('|') + ')\\s*\\/?&gt;', 'gi');

/**
 * Escape everything, then restore only the allow-listed structural tags.
 * Returns a string that is safe to pass to `set:html`.
 */
export function safeNoteHtml(raw: unknown): string {
  const input = typeof raw === 'string' ? raw : '';
  if (!input) return '';

  // Drop script/style/iframe/object bodies outright so their CONTENT does not survive as text.
  const stripped = input.replace(
    /<\s*(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
    '',
  );

  const escaped = stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(TAG_RE, (_m, slash: string, tag: string) => '<' + slash + tag.toLowerCase() + '>');
}

/** Plain text of a note, for previews and meta descriptions. */
export function noteExcerpt(raw: unknown, max = 180): string {
  const text = String(typeof raw === 'string' ? raw : '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
