// src/lib/mail-csv.ts — CONTACT CSV: PARSE, MAP, VALIDATE, EXPORT.
//
// Pure. No database. An import is the one moment where a mail system takes in data nobody has
// reviewed, so every decision it makes has to be inspectable BEFORE anything is written: which
// column became which field, which rows are invalid and why, which rows collide with each other.
// That is why parsing, mapping and validating are separate functions and the import screen runs
// them in a dry pass first.
//
// THE PARSER IS RFC4180 AND HAND-WRITTEN ON PURPOSE. `csv-parse` is a dependency here and is used
// by /admin/hei/import, but its sync entry point throws on the first malformed row — which is the
// wrong shape for this screen. An operator pasting a spreadsheet export needs "row 412 has 9 fields
// where the header has 7" printed next to the other 411 rows that imported fine, not one exception
// that loses the whole file. This parser never throws; a ragged row is reported and kept.

/** A contact field a CSV column can map onto. `custom:<key>` is allowed for anything else. */
export const CONTACT_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'organization', label: 'Organisation' },
  { key: 'phone', label: 'Phone' },
  { key: 'role_title', label: 'Role / title' },
  { key: 'status', label: 'Subscription status' },
  { key: 'tags', label: 'Tags (separated by ; or |)' },
  { key: 'consent_source', label: 'Consent source' },
  { key: 'consent_at', label: 'Consent date' },
  { key: 'notes', label: 'Notes' },
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number]['key'];

/** Header aliases seen in real exports. Lower-cased, non-alphanumerics stripped. */
const HEADER_ALIASES: ReadonlyArray<[string, ContactField]> = [
  ['email', 'email'], ['emailaddress', 'email'], ['mail', 'email'], ['workemail', 'email'],
  ['primaryemail', 'email'], ['contactemail', 'email'], ['emailid', 'email'],
  ['firstname', 'first_name'], ['fname', 'first_name'], ['givenname', 'first_name'], ['first', 'first_name'],
  ['lastname', 'last_name'], ['lname', 'last_name'], ['surname', 'last_name'], ['familyname', 'last_name'], ['last', 'last_name'],
  ['organization', 'organization'], ['organisation', 'organization'], ['company', 'organization'],
  ['institution', 'organization'], ['university', 'organization'], ['college', 'organization'], ['employer', 'organization'],
  ['phone', 'phone'], ['phonenumber', 'phone'], ['mobile', 'phone'], ['contactnumber', 'phone'], ['telephone', 'phone'],
  ['role', 'role_title'], ['title', 'role_title'], ['jobtitle', 'role_title'], ['designation', 'role_title'], ['position', 'role_title'],
  ['status', 'status'], ['subscriptionstatus', 'status'], ['subscribed', 'status'],
  ['tags', 'tags'], ['tag', 'tags'], ['labels', 'tags'],
  ['consentsource', 'consent_source'], ['source', 'consent_source'], ['optinsource', 'consent_source'],
  ['consentat', 'consent_at'], ['consentdate', 'consent_at'], ['optindate', 'consent_at'], ['subscribedat', 'consent_at'],
  ['notes', 'notes'], ['note', 'notes'], ['comment', 'notes'], ['comments', 'notes'],
];

/** A full name in one column — split on the LAST space so "Ananya Devi Rao" keeps its given names. */
const FULLNAME_HEADERS: ReadonlySet<string> = new Set(['name', 'fullname', 'contactname', 'displayname', 'candidatename']);

export function normalizeHeader(h: string): string {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which contact field each header column becomes.
 *
 * Returns entries, not an object, so the import screen can render them in COLUMN ORDER and so a
 * duplicated header does not silently overwrite its twin. An unrecognised header becomes
 * `custom:<slug>` — never dropped: a column an operator bothered to export is a column they may
 * want to segment on later, and discarding it quietly is how a "why can't I filter on university"
 * ticket is born.
 */
export function autoMap(headers: string[]): { header: string; field: string | null; kind: 'known' | 'fullname' | 'custom' | 'ignored' }[] {
  const used = new Set<string>();
  return (headers || []).map((h) => {
    const n = normalizeHeader(h);
    if (!n) return { header: h, field: null, kind: 'ignored' as const };
    if (FULLNAME_HEADERS.has(n) && !used.has('first_name')) {
      used.add('first_name');
      return { header: h, field: '__fullname', kind: 'fullname' as const };
    }
    const hit = HEADER_ALIASES.find((a) => a[0] === n);
    if (hit && !used.has(hit[1])) {
      used.add(hit[1]);
      return { header: h, field: hit[1], kind: 'known' as const };
    }
    return { header: h, field: 'custom:' + customKey(h), kind: 'custom' as const };
  });
}

/** A custom-field key: lower snake_case, capped. Must match the segment engine's key rule. */
export function customKey(h: string): string {
  return String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field';
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────

export interface ParsedCsv {
  headers: string[];
  /** One entry per data row: the cells, plus the 1-based line number for error messages. */
  rows: { cells: string[]; line: number }[];
  delimiter: string;
  /** Rows whose cell count differs from the header. Kept, not dropped — see the note at the top. */
  ragged: { line: number; got: number; expected: number }[];
}

/** Comma, semicolon or tab — whichever appears most often outside quotes on the header line. */
export function detectDelimiter(text: string): string {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === d) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return bestCount > 0 ? best : ',';
}

/**
 * RFC4180 parse. Handles quoted fields, doubled quotes inside them, embedded newlines, CRLF, and a
 * UTF-8 BOM (which Excel writes and which otherwise turns the first header into `﻿email`, so the
 * email column silently fails to map and every row reports "email is required").
 */
export function parseCsv(text: string, delimiter?: string): ParsedCsv {
  let src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const d = delimiter || detectDelimiter(src);

  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const pushField = () => { cells.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    records.push({ cells, line: recordLine });
    cells = [];
    started = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!started) { recordLine = line; started = true; }
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { pushField(); continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; line++; pushRecord(); continue; }
    if (ch === '\n') { line++; pushRecord(); continue; }
    field += ch;
  }
  if (started || field !== '' || cells.length) pushRecord();

  // Drop trailing wholly-empty records (a file ending in a newline produces one).
  while (records.length && records[records.length - 1].cells.every((c) => c.trim() === '')) records.pop();

  const headerRec = records.shift();
  const headers = (headerRec?.cells || []).map((h) => h.trim());
  const ragged: ParsedCsv['ragged'] = [];
  const rows = records
    .filter((r) => !r.cells.every((c) => c.trim() === ''))
    .map((r) => {
      if (r.cells.length !== headers.length) ragged.push({ line: r.line, got: r.cells.length, expected: headers.length });
      return r;
    });

  return { headers, rows, delimiter: d, ragged };
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────

/**
 * DELIBERATELY NOT RFC5322. That grammar admits addresses no mail server here will ever route and
 * rejecting a real address is far more damaging than accepting an odd one — the address is checked
 * again at send time and a hard bounce suppresses it. This is the shape check: one @, a local part,
 * a dotted domain, no spaces, no consecutive dots.
 */
export function isValidEmail(e: string): boolean {
  const s = String(e || '').trim();
  if (!s || s.length > 254) return false;
  if (/\s/.test(s)) return false;
  if (s.indexOf('@') !== s.lastIndexOf('@')) return false;
  const [local, domain] = s.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-]+$/.test(local)) return false;
  if (domain.startsWith('-') || domain.endsWith('-') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (labels[labels.length - 1].length < 2) return false;
  if (!/^[A-Za-z]{2,}$/.test(labels[labels.length - 1])) return false;
  return true;
}

export function normalizeEmailValue(e: string): string {
  return String(e || '').trim().toLowerCase();
}

export const SUBSCRIPTION_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'pending'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Map whatever the spreadsheet says into one of our five statuses. Unknown -> subscribed. */
export function coerceStatus(v: string | null | undefined): SubscriptionStatus {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'subscribed';
  if (['unsubscribed', 'unsub', 'opted out', 'optout', 'opt-out', 'no', 'false', '0'].includes(s)) return 'unsubscribed';
  if (['bounced', 'bounce', 'hard bounce', 'invalid'].includes(s)) return 'bounced';
  if (['complained', 'complaint', 'spam'].includes(s)) return 'complained';
  if (['pending', 'unconfirmed', 'double opt-in pending'].includes(s)) return 'pending';
  return 'subscribed';
}

export function splitTags(v: string | null | undefined): string[] {
  return String(v || '')
    .split(/[;|,]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 80)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 40);
}

export interface ImportContact {
  email: string;
  first_name: string;
  last_name: string;
  organization: string;
  phone: string;
  role_title: string;
  status: SubscriptionStatus;
  tags: string[];
  consent_source: string;
  consent_at: string | null;
  notes: string;
  custom: Record<string, string>;
}

export interface RowResult {
  line: number;
  ok: boolean;
  contact: ImportContact | null;
  errors: string[];
  warnings: string[];
}

function splitFullName(v: string): { first: string; last: string } {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (!s) return { first: '', last: '' };
  const i = s.lastIndexOf(' ');
  if (i < 0) return { first: s, last: '' };
  return { first: s.slice(0, i), last: s.slice(i + 1) };
}

function parseDate(v: string): string | null {
  const s = String(v || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  // dd/mm/yyyy and dd-mm-yyyy, which Date.parse reads as US month-first or not at all.
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Validate one parsed row against a column mapping. Never throws. */
export function validateRow(
  cells: string[],
  mapping: { header: string; field: string | null }[],
  line: number,
): RowResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const c: ImportContact = {
    email: '', first_name: '', last_name: '', organization: '', phone: '', role_title: '',
    status: 'subscribed', tags: [], consent_source: '', consent_at: null, notes: '', custom: {},
  };

  mapping.forEach((m, i) => {
    if (!m.field) return;
    const raw = (cells[i] ?? '').trim();
    if (m.field === '__fullname') {
      const { first, last } = splitFullName(raw);
      if (!c.first_name) c.first_name = first;
      if (!c.last_name) c.last_name = last;
      return;
    }
    if (m.field.startsWith('custom:')) {
      const key = m.field.slice(7);
      if (raw) c.custom[key] = raw.slice(0, 500);
      return;
    }
    switch (m.field) {
      case 'email': c.email = normalizeEmailValue(raw); break;
      case 'first_name': c.first_name = raw.slice(0, 120); break;
      case 'last_name': c.last_name = raw.slice(0, 120); break;
      case 'organization': c.organization = raw.slice(0, 200); break;
      case 'phone': c.phone = raw.slice(0, 50); break;
      case 'role_title': c.role_title = raw.slice(0, 160); break;
      case 'status': c.status = coerceStatus(raw); break;
      case 'tags': c.tags = splitTags(raw); break;
      case 'consent_source': c.consent_source = raw.slice(0, 160); break;
      case 'consent_at': {
        if (raw) {
          const d = parseDate(raw);
          if (d) c.consent_at = d;
          else warnings.push('Consent date "' + raw + '" was not a date we could read, so it was left blank.');
        }
        break;
      }
      case 'notes': c.notes = raw.slice(0, 2000); break;
    }
  });

  if (!c.email) errors.push('No email address.');
  else if (!isValidEmail(c.email)) errors.push('"' + c.email + '" is not a usable email address.');

  if (c.status === 'unsubscribed') {
    warnings.push('Imported as unsubscribed — this contact will be excluded from every campaign.');
  }
  if (!c.consent_source && c.status === 'subscribed') {
    warnings.push('No consent source recorded for a subscribed contact.');
  }

  return { line, ok: errors.length === 0, contact: errors.length === 0 ? c : null, errors, warnings };
}

export interface ImportPlan {
  headers: string[];
  mapping: { header: string; field: string | null; kind: string }[];
  valid: ImportContact[];
  invalid: RowResult[];
  /** Rows dropped because an EARLIER row in the same file had the same address. */
  duplicatesInFile: { line: number; email: string; firstSeenLine: number }[];
  warnings: { line: number; message: string }[];
  ragged: ParsedCsv['ragged'];
  totalRows: number;
}

/**
 * The dry run. Everything the operator needs to decide whether to commit, computed without touching
 * the database: what maps to what, what is valid, what collides inside the file itself.
 */
export function planImport(text: string, overrideMapping?: { header: string; field: string | null }[]): ImportPlan {
  const parsed = parseCsv(text);
  const mapping = overrideMapping
    ? overrideMapping.map((m) => ({ ...m, kind: m.field && m.field.startsWith('custom:') ? 'custom' : m.field ? 'known' : 'ignored' }))
    : autoMap(parsed.headers);

  const valid: ImportContact[] = [];
  const invalid: RowResult[] = [];
  const warnings: { line: number; message: string }[] = [];
  const duplicatesInFile: ImportPlan['duplicatesInFile'] = [];
  const firstSeen = new Map<string, number>();

  for (const r of parsed.rows) {
    const res = validateRow(r.cells, mapping, r.line);
    for (const w of res.warnings) warnings.push({ line: r.line, message: w });
    if (!res.ok || !res.contact) { invalid.push(res); continue; }
    const prior = firstSeen.get(res.contact.email);
    if (prior !== undefined) {
      duplicatesInFile.push({ line: r.line, email: res.contact.email, firstSeenLine: prior });
      // Later rows MERGE into the first: a spreadsheet where one person appears twice with
      // complementary columns filled in should not lose half its data to "first wins".
      const target = valid.find((v) => v.email === res.contact!.email);
      if (target) mergeImportContacts(target, res.contact);
      continue;
    }
    firstSeen.set(res.contact.email, r.line);
    valid.push(res.contact);
  }

  return {
    headers: parsed.headers,
    mapping,
    valid,
    invalid,
    duplicatesInFile,
    warnings,
    ragged: parsed.ragged,
    totalRows: parsed.rows.length,
  };
}

/** Fill blanks on `target` from `extra`; union the tags. Mutates target. */
export function mergeImportContacts(target: ImportContact, extra: ImportContact): void {
  for (const k of ['first_name', 'last_name', 'organization', 'phone', 'role_title', 'consent_source', 'notes'] as const) {
    if (!target[k] && extra[k]) target[k] = extra[k];
  }
  if (!target.consent_at && extra.consent_at) target.consent_at = extra.consent_at;
  // The most restrictive status wins: a duplicate row saying "unsubscribed" must not be overwritten
  // by one saying "subscribed" just because it came second.
  const rank: Record<string, number> = { complained: 4, unsubscribed: 3, bounced: 2, pending: 1, subscribed: 0 };
  if ((rank[extra.status] || 0) > (rank[target.status] || 0)) target.status = extra.status;
  for (const t of extra.tags) if (!target.tags.includes(t)) target.tags.push(t);
  for (const [k, v] of Object.entries(extra.custom)) if (!(k in target.custom)) target.custom[k] = v;
}

// ── export ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One CSV cell.
 *
 * The leading apostrophe on `= + - @` is CSV-INJECTION defence, not decoration: a contact whose
 * "organisation" is `=HYPERLINK("http://evil","click")` becomes a live formula the moment an
 * operator opens the export in a spreadsheet. Anyone can put that string into a contact form. The
 * apostrophe is visible in the cell, which is the honest trade — the alternative is silently
 * altering the operator's data or shipping the formula.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/["\n\r,;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  // CRLF and a BOM so Excel opens UTF-8 names correctly rather than mojibake.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

// ── duplicate detection (beyond exact email) ───────────────────────────────────────────────────

function nameKey(first: string, last: string): string {
  return (String(first || '') + ' ' + String(last || '')).toLowerCase().replace(/[^a-z]/g, '');
}
function phoneKey(p: string): string {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-10) : '';
}

export interface DuplicateGroup {
  reason: 'name+organization' | 'phone';
  key: string;
  members: { id: string; email: string }[];
}

/**
 * Contacts that are probably the same person under two addresses. Exact-email duplicates cannot
 * occur (the table has a unique index), so this looks at the two signals that actually recur in
 * practice: the same name at the same organisation, and the same phone number.
 *
 * It SUGGESTS. It never merges — merging destroys history, so a human decides.
 */
export function findDuplicateGroups(
  contacts: { id: string; email: string; first_name?: string | null; last_name?: string | null; organization?: string | null; phone?: string | null }[],
): DuplicateGroup[] {
  const byName = new Map<string, { id: string; email: string }[]>();
  const byPhone = new Map<string, { id: string; email: string }[]>();
  for (const c of contacts) {
    const nk = nameKey(c.first_name || '', c.last_name || '');
    const org = String(c.organization || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nk.length >= 4) {
      const key = nk + '@' + org;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push({ id: c.id, email: c.email });
    }
    const pk = phoneKey(c.phone || '');
    if (pk) {
      if (!byPhone.has(pk)) byPhone.set(pk, []);
      byPhone.get(pk)!.push({ id: c.id, email: c.email });
    }
  }
  const out: DuplicateGroup[] = [];
  for (const [key, members] of byName) if (members.length > 1) out.push({ reason: 'name+organization', key, members });
  for (const [key, members] of byPhone) if (members.length > 1) out.push({ reason: 'phone', key, members });
  return out;
}
