// src/lib/mail-product/common.ts — the handful of things every service and every endpoint in the
// mail product needs, written once so they cannot drift apart.
//
// Three of the four are house rules this project has paid for in outages, and they are here rather
// than copy-pasted into twenty files:
//   rowsOf()  — postgres-js returns a PLAIN ARRAY, not { rows }. `r.rows[0]` is undefined.
//   reasonOf()— the real Postgres reason is on e.cause; e.message is only the SQL that failed.
//   isUuid()  — an id bound blind into a uuid column raises 22P02, which reaches the operator as a
//               database complaint about their own click.
// All of them are declared at module top level, never inside a handler: `const` is not hoisted and
// a handler reaching a later declaration has taken pages down here before.

export function rowsOf<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : (r?.rows || [])) as T[];
}

export function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * A failure the caller can act on.
 *
 * The message is written FOR THE OPERATOR: it says what did not happen and what is unchanged, not
 * which table refused. An endpoint that answers "That did not go through" without saying what
 * survived is the reason people re-press buttons and send things twice.
 */
export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

export function normaliseEmail(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export function isEmail(v: unknown): boolean {
  const s = normaliseEmail(v);
  return s.length <= 254 && EMAIL_RE.test(s);
}

export function slugify(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ---- Keyset pagination ---------------------------------------------------------------------
//
// OFFSET IS NOT AN OPTION HERE. "Prepare for millions of contacts" and `OFFSET 900000` are mutually
// exclusive: Postgres walks and discards every skipped row, so page 9000 costs 9000 pages of work
// and the list gets slower the further anyone scrolls. Worse, an insert between two requests shifts
// every subsequent page by one and the reader silently never sees a row.
//
// A cursor is the last row's (sort key, id) encoded as one opaque string. The next page asks for
// rows strictly after it, which is an index range scan of constant cost and is stable under insert.

export interface Cursor { ts: string; id: string; }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced — never throws on junk. */
export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const [ts, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!ts || !isUuid(id)) return null;
    if (Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/** Initials for an avatar. Never more than two characters, never empty. */
export function initials(name?: string | null, email?: string | null): string {
  const src = String(name || '').trim() || String(email || '').trim();
  if (!src) return '?';
  const parts = src.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * A deterministic avatar colour from the chart ramp — same person, same colour, every screen.
 * Not random: a colour that changes between the contact list and the contact profile reads as two
 * different people.
 */
export function avatarColour(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ['var(--em-c2)', 'var(--em-c3)', 'var(--em-c4)', 'var(--em-c5)', 'var(--em-c6)'][h % 5];
}

/** HTML-escape. Everything user-authored that reaches a template literal goes through this. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip HTML to a plain-text fallback. Block-level tags become newlines so the text is readable. */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h1|h2|h3|h4|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Relative time, in words, for a UI that is read at a glance.
 * Absolute dates are rendered separately (and always carry a title with the full timestamp) —
 * "3d ago" alone is not a date anybody can act on.
 */
export function timeAgo(input: string | Date | null | undefined, now = Date.now()): string {
  if (!input) return '';
  const t = input instanceof Date ? input.getTime() : Date.parse(String(input));
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  if (d < 365) return Math.floor(d / 7) + 'w ago';
  return Math.floor(d / 365) + 'y ago';
}

/** IST, because that is where this company reads its mail. Always paired with a relative label. */
export function fullTime(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(String(input));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** 1234567 -> "1,234,567". Counts on a dashboard are unreadable without it. */
export function num(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-IN') : '0';
}

/** A rate as a percentage of a base, with the "0 of 0 is not 0%" case handled honestly. */
export function pct(part: unknown, whole: unknown, digits = 1): string {
  const p = Number(part) || 0;
  const w = Number(whole) || 0;
  if (w <= 0) return '—';
  return ((p / w) * 100).toFixed(digits) + '%';
}
