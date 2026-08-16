// src/lib/mail-personalize.ts — MERGE VARIABLES FOR CAMPAIGN AND TRANSACTIONAL COPY.
//
// Pure. No database, no imports. Everything here is a string transform, which is what makes the
// whole personalisation surface testable without a connection — and personalisation is exactly the
// layer where an untested bug is invisible until it has already been posted to ten thousand people.
//
// THE RULE THIS FILE ENFORCES: A VARIABLE THAT HAS NO VALUE MUST NEVER RENDER AS ITSELF.
// "Hi {{first_name}}," landing in a real inbox is the single most recognisable failure of a mail
// system, and it happens when a renderer leaves an unresolved token in place. Here an unresolved
// token renders as its declared default, or as empty — never as the raw token — and
// missingVariables() lets the composer REFUSE to send copy whose blanks were not thought about.
//
// Grammar (whitespace-tolerant, case-insensitive on the name):
//
//     {{first_name}}
//     {{ first_name }}
//     {{first_name | default:"Applicant"}}
//     {{first_name|default:'Applicant'}}
//     {{custom.university | default:"your university"}}
//
// A `default:` with no quotes is read to the end of the token, trimmed — so `{{stage|default:new}}`
// works too. Anything that is not a recognised token is left exactly as written: a stray `{{` in
// body copy is not an error and must not be swallowed.

/** A variable occurrence found in a template. */
export interface VariableToken {
  /** The literal text matched, including the braces. */
  raw: string;
  /** Lower-cased variable name, e.g. `first_name` or `custom.university`. */
  name: string;
  /** The declared fallback, or null when the author declared none. */
  fallback: string | null;
}

/** The values a template is rendered against. Missing / null / '' all count as "no value". */
export type MergeVars = Record<string, string | number | null | undefined>;

/**
 * The catalog the composer offers. `system` variables are filled by the sender (the unsubscribe
 * link, the browser view) and are NOT expected on a contact record, so variablesWithoutFallback()
 * does not demand the author write a default for them.
 */
export const CAMPAIGN_VARIABLES: ReadonlyArray<{
  name: string;
  label: string;
  example: string;
  system?: boolean;
}> = [
  { name: 'first_name', label: 'First name', example: 'Ananya' },
  { name: 'last_name', label: 'Last name', example: 'Rao' },
  { name: 'full_name', label: 'Full name', example: 'Ananya Rao' },
  { name: 'email', label: 'Email address', example: 'ananya@example.org' },
  { name: 'organization', label: 'Organisation', example: 'IIT Guwahati' },
  { name: 'role', label: 'Role applied for', example: 'Software Engineering Intern' },
  { name: 'stage', label: 'Application stage', example: 'Assessment' },
  { name: 'application_id', label: 'Application number', example: 'ERA-2026-0184' },
  { name: 'deadline', label: 'Deadline', example: '24 August 2026' },
  { name: 'unsubscribe_url', label: 'Unsubscribe link', example: 'https://…/mail/unsubscribe', system: true },
  { name: 'view_in_browser_url', label: 'View in browser', example: 'https://…/mail/view', system: true },
];

const SYSTEM_VARIABLES: ReadonlySet<string> = new Set(
  CAMPAIGN_VARIABLES.filter((v) => v.system).map((v) => v.name),
);

/** Names the composer offers, in catalog order. */
export function variableNames(): string[] {
  return CAMPAIGN_VARIABLES.map((v) => v.name);
}

// The name allows dots so a custom field can be addressed as `custom.university`. It deliberately
// does NOT allow spaces: `{{ hello world }}` is prose in braces, not a variable, and rewriting it
// would corrupt the author's copy.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*default\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^}]*?)\s*)?\}\}/g;

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return s;
}

/** Every variable occurrence in a template, in document order (duplicates included). */
export function extractVariables(template: string): VariableToken[] {
  const out: VariableToken[] = [];
  const src = String(template || '');
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(src))) {
    out.push({
      raw: m[0],
      name: m[1].toLowerCase(),
      fallback: m[2] === undefined ? null : unquote(m[2]),
    });
  }
  return out;
}

/** Distinct variable names used by a template, lower-cased, in first-seen order. */
export function usedVariableNames(template: string): string[] {
  const seen: string[] = [];
  for (const t of extractVariables(template)) if (!seen.includes(t.name)) seen.push(t.name);
  return seen;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return String(v).trim() !== '';
}

function lookup(vars: MergeVars, name: string): unknown {
  // Exact key first, then a case-insensitive sweep, so a contact record written with `First_Name`
  // still fills `{{first_name}}`. Contact custom fields are addressable both as `custom.x` and `x`.
  if (Object.prototype.hasOwnProperty.call(vars, name)) return (vars as any)[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(vars)) if (k.toLowerCase() === lower) return (vars as any)[k];
  if (lower.startsWith('custom.')) {
    const bare = lower.slice(7);
    for (const k of Object.keys(vars)) if (k.toLowerCase() === bare) return (vars as any)[k];
  }
  return undefined;
}

/** HTML-escape a merged VALUE. Never applied to the template itself — only to what is spliced in. */
export function escapeHtml(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(template: string, vars: MergeVars, escape: (s: string) => string): string {
  const src = String(template || '');
  TOKEN_RE.lastIndex = 0;
  return src.replace(TOKEN_RE, (_raw: string, rawName: string, rawDefault?: string) => {
    const name = String(rawName).toLowerCase();
    const value = lookup(vars, name);
    if (hasValue(value)) return escape(String(value));
    const fallback = rawDefault === undefined ? '' : unquote(rawDefault);
    return escape(fallback);
  });
}

/** Render into a plain-text body. Values are inserted verbatim. */
export function renderText(template: string, vars: MergeVars): string {
  return render(template, vars, (s) => s);
}

/**
 * Render into an HTML body. Merged VALUES are HTML-escaped — a contact whose organisation is
 * `Sharma & Co <sharma>` must not be able to inject markup into a mail sent to thousands of other
 * people, and a `<` in a real name must not silently eat the rest of the paragraph.
 */
export function renderHtml(template: string, vars: MergeVars): string {
  return render(template, vars, escapeHtml);
}

/** Render a subject line. Same rules as text; newlines are stripped because a header cannot hold one. */
export function renderSubject(template: string, vars: MergeVars): string {
  return renderText(template, vars).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Variables this template will render as BLANK for these values — i.e. no value and no declared
 * default. The composer shows this list per-preview-contact.
 */
export function missingVariables(template: string, vars: MergeVars): string[] {
  const out: string[] = [];
  for (const t of extractVariables(template)) {
    if (t.fallback !== null && t.fallback !== '') continue;
    if (hasValue(lookup(vars, t.name))) continue;
    if (!out.includes(t.name)) out.push(t.name);
  }
  return out;
}

/**
 * Variables with NO declared default anywhere in the copy. This is the check the composer runs
 * BEFORE an audience exists — it is about the copy, not about any one recipient, and it is the
 * honest answer to "will anybody get a blank here?" across a list you have not resolved yet.
 */
export function variablesWithoutFallback(template: string): string[] {
  const out: string[] = [];
  for (const t of extractVariables(template)) {
    if (t.fallback === null && !SYSTEM_VARIABLES.has(t.name) && !out.includes(t.name)) out.push(t.name);
  }
  return out;
}

/** Fill a template with the catalog's example values — the composer's "preview" with no contact. */
export function previewFill(template: string, overrides: MergeVars = {}): string {
  const sample: MergeVars = {};
  for (const v of CAMPAIGN_VARIABLES) sample[v.name] = v.example;
  return renderText(template, { ...sample, ...overrides });
}

/**
 * The merge values for one contact. Kept here (not in the DB module) so the mapping from a contact
 * row to the variable names an author types is one pure function that tests can pin down.
 */
export function mergeVarsForContact(
  c: {
    email: string;
    first_name?: string | null;
    last_name?: string | null;
    organization?: string | null;
    phone?: string | null;
    role_title?: string | null;
    custom?: Record<string, unknown> | null;
    application_stage?: string | null;
    application_number?: string | null;
  },
  extra: MergeVars = {},
): MergeVars {
  const first = (c.first_name || '').trim();
  const last = (c.last_name || '').trim();
  const vars: MergeVars = {
    email: c.email || '',
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    organization: (c.organization || '').trim(),
    phone: (c.phone || '').trim(),
    role: (c.role_title || '').trim(),
    stage: (c.application_stage || '').trim(),
    application_id: (c.application_number || '').trim(),
  };
  for (const [k, v] of Object.entries(c.custom || {})) {
    const key = String(k).toLowerCase();
    if (v === null || v === undefined) continue;
    const flat = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (!(key in vars)) vars[key] = flat;
    vars['custom.' + key] = flat;
  }
  return { ...vars, ...extra };
}
