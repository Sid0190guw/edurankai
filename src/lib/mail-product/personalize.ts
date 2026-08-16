// src/lib/mail-product/personalize.ts — {{variable}} substitution, and the honest boundary around it.
//
// WHY THIS EXISTS NOW AND DID NOT BEFORE. /admin/mail/templates.astro carries a comment saying the
// {{variables}} promise was empty and the copy was corrected rather than the mechanism invented,
// because "one message row is addressed to many recipients, so a per-person merge is not a wording
// change — it is a different send model."
//
// That is exactly right, and the campaign path IS that different send model: mail_campaign_recipients
// holds ONE ROW PER PERSON and the dispatcher sends one message per row. So substitution is real
// here, and it is real ONLY here. Nothing in this module is wired into /api/mail/send, which still
// sends one message to many addresses and where a placeholder would still go out literally.
//
// PURE AND SYNCHRONOUS ON PURPOSE. No database, no network, no clock beyond an injectable `now`.
// That is what makes the preview on screen and the bytes that leave provably the same substitution
// — see personalize.test.ts.

/** A merge variable the UI offers and this module knows how to fill. */
export interface MergeVariable {
  /** The token as typed, without braces. */
  key: string;
  label: string;
  /** Shown in the picker and used by preview when the contact has no value. */
  sample: string;
  group: 'contact' | 'application' | 'campaign' | 'system';
}

/**
 * The catalogue. The picker in the composer, the builder's variable menu and the template screen all
 * render THIS ARRAY, so a variable that exists in the menu is a variable this module can fill.
 *
 * The seven named in the brief come first and are load-bearing; the rest are the ones this product
 * can actually answer from a contact row without inventing data.
 */
export const MERGE_VARIABLES: MergeVariable[] = [
  { key: 'first_name', label: 'First name', sample: 'Anita', group: 'contact' },
  { key: 'last_name', label: 'Last name', sample: 'Rao', group: 'contact' },
  { key: 'email', label: 'Email address', sample: 'anita.rao@example.com', group: 'contact' },
  { key: 'role', label: 'Role applied for', sample: 'Data Engineer', group: 'application' },
  { key: 'stage', label: 'Application stage', sample: '3', group: 'application' },
  { key: 'deadline', label: 'Deadline', sample: '24 August 2026', group: 'application' },
  { key: 'application_id', label: 'Application ID', sample: 'APP-40118', group: 'application' },
  { key: 'full_name', label: 'Full name', sample: 'Anita Rao', group: 'contact' },
  { key: 'company', label: 'Organisation', sample: 'EduRankAI', group: 'system' },
  { key: 'campaign_name', label: 'Campaign name', sample: 'August programme update', group: 'campaign' },
  { key: 'unsubscribe_url', label: 'Unsubscribe link', sample: 'https://edurankai.in/mail/u/…', group: 'system' },
  { key: 'today', label: "Today's date", sample: '16 August 2026', group: 'system' },
];

export const VARIABLE_KEYS = MERGE_VARIABLES.map((v) => v.key);

/** What a contact contributes to the substitution context. */
export interface PersonalizeContact {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  fields?: Record<string, unknown> | null;
}

export interface PersonalizeOptions {
  contact?: PersonalizeContact | null;
  campaignName?: string | null;
  unsubscribeUrl?: string | null;
  company?: string | null;
  /** Injectable so tests are not time-dependent. */
  now?: Date;
  /**
   * What to do with a token nothing can fill.
   *  'blank'    — replace with '' (correct for a real send: never mail somebody "Hi {{first_name}}")
   *  'sample'   — replace with the catalogue's sample (correct for preview)
   *  'keep'     — leave the token visible (correct for the builder canvas, so the author sees it)
   */
  missing?: 'blank' | 'sample' | 'keep';
}

/** Everything a token could resolve to, already flattened to strings. */
export function buildContext(opts: PersonalizeOptions = {}): Record<string, string> {
  const c = opts.contact || null;
  const now = opts.now || new Date();
  const first = String(c?.first_name || '').trim();
  const last = String(c?.last_name || '').trim();

  const ctx: Record<string, string> = {
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    email: String(c?.email || '').trim(),
    company: String(opts.company || 'EduRankAI'),
    campaign_name: String(opts.campaignName || ''),
    unsubscribe_url: String(opts.unsubscribeUrl || ''),
    today: now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }),
  };

  // Custom fields fill anything not already set, so a declared field named `role` answers {{role}}
  // without this module needing to know the field exists.
  const fields = (c?.fields && typeof c.fields === 'object') ? c.fields as Record<string, unknown> : {};
  for (const [k, v] of Object.entries(fields)) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key) continue;
    if (ctx[key] === undefined || ctx[key] === '') ctx[key] = v == null ? '' : String(v);
  }
  return ctx;
}

// Deliberately narrow: {{ key }} with optional inner spaces, keys limited to word characters.
// A loose pattern would swallow CSS in a style block ({ } is everywhere in an email template) and
// silently mangle the HTML — which is a rendering bug that only shows up in the recipient's inbox.
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every distinct variable used in a string, in order of first appearance. */
export function extractVariables(input: string): string[] {
  const out: string[] = [];
  for (const m of String(input || '').matchAll(TOKEN_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Variables used in the text that this product cannot fill — the warning the preview screen shows. */
export function unknownVariables(input: string, ctx?: Record<string, string>): string[] {
  const known = ctx ? new Set(Object.keys(ctx)) : new Set(VARIABLE_KEYS);
  return extractVariables(input).filter((k) => !known.has(k));
}

/**
 * Substitute. Returns the filled string AND what it could not fill, because a caller that wants to
 * refuse a send with unfillable tokens needs to know without re-scanning.
 */
export function personalize(input: string, opts: PersonalizeOptions = {}): { text: string; missing: string[] } {
  const ctx = buildContext(opts);
  const mode = opts.missing || 'blank';
  const samples = new Map(MERGE_VARIABLES.map((v) => [v.key, v.sample]));
  const missing: string[] = [];

  const text = String(input || '').replace(TOKEN_RE, (whole, key: string) => {
    const value = ctx[key];
    if (value !== undefined && value !== '') return value;
    if (!missing.includes(key)) missing.push(key);
    if (mode === 'keep') return whole;
    if (mode === 'sample') return samples.get(key) ?? whole;
    return '';
  });

  return { text, missing };
}

/** Subject + both bodies in one pass, so they can never be personalised with different contexts. */
export function personalizeMessage(
  msg: { subject: string; html: string; text?: string },
  opts: PersonalizeOptions = {},
): { subject: string; html: string; text: string; missing: string[] } {
  const s = personalize(msg.subject, opts);
  const h = personalize(msg.html, opts);
  const t = personalize(msg.text || '', opts);
  const missing = [...new Set([...s.missing, ...h.missing, ...t.missing])];
  return { subject: s.text, html: h.text, text: t.text, missing };
}
