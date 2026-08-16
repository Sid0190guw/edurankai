// src/lib/mail-search.ts — THE SEARCH ENGINE, AND THE SEAM UNDER IT.
//
// WHAT THIS REPLACES. src/lib/mail.ts grew a search that matched every term with
// `lower(col) LIKE '%term%'` against six columns and an EXISTS over recipients. It was correct and
// it does not scale: a leading-wildcard LIKE cannot use an index, so every search read every row of
// the mailbox. At a few thousand messages nobody notices. At 100,000 the inbox stops loading, and
// the failure arrives as a timeout with no explanation.
//
// THREE THINGS CHANGED HERE.
//
//  1. THE GRAMMAR IS BIGGER AND IT IS ONE GRAMMAR. from/to/cc/bcc/subject/body/filename/domain/
//     label/folder/thread/has/is/after/before/larger/smaller, negation with `-`, quoted phrases.
//     mail.ts's parseMailQuery() now delegates here, so the operators the search box accepts and
//     the operators the listing understands cannot drift apart — they were two functions away from
//     doing exactly that.
//
//  2. FREE TEXT GOES THROUGH POSTGRES FULL-TEXT SEARCH, over a STORED generated tsvector with a
//     GIN index. `to_tsvector(regconfig, text)` is immutable, so the column is generated rather
//     than trigger-maintained: there is no hook to forget to call and no backfill that can drift.
//     Field-scoped operators (`subject:`, `filename:`) stay on ILIKE deliberately — those are
//     substring questions about a short column, and a stemmer would answer a different question
//     ("invoices" matching `subject:invoice` is right; `filename:report` matching a file called
//     "reporting" is not what the person pointed at).
//
//  3. PAGING IS KEYSET, NOT OFFSET, AND IT COLLAPSES THREADS PER PAGE. The old listing ran
//     ROW_NUMBER() OVER (PARTITION BY thread_id) across the WHOLE filtered set to pick one row per
//     conversation — a sort of the entire mailbox to render fifty rows. This walks the existing
//     mail_box(user_id, folder, created_at DESC) index backwards from a cursor, collapses the
//     conversations inside the page, and asks one further indexed question for the per-thread
//     counts. Cost is proportional to the page, not to the mailbox.
//
// THE SEAM. Nothing above the provider interface knows which engine answered. parseSearchQuery()
// produces an engine-neutral SearchQuery; PostgresSearchProvider compiles it to SQL and
// toSearchDsl() compiles the SAME object to an OpenSearch/Elasticsearch bool query. The second one
// is a pure function with tests, so "we can move to OpenSearch later" is a demonstrated claim
// rather than an intention — the day the index exists, only getSearchProvider() changes.
//
// WHAT THIS FILE MUST NOT DO. It does not open a transport, it does not write, and it never widens
// scope: every statement is narrowed to `b.user_id = <caller>` before any operator is applied. A
// search is a read of one person's mailbox and there is no parameter here that can make it anything
// else.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Declared before anything that uses them — `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'] as const;
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/** How many messages a page may walk before collapsing to conversations. */
const PAGE_SCAN_FACTOR = 4;
/** The ceiling on `estimatedTotal`. An exact count over a large mailbox is a table scan. */
export const COUNT_CAP = 10000;

// =================================================================================================
// THE QUERY — engine-neutral
// =================================================================================================

export type SearchField =
  | 'text' | 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'filename' | 'domain'
  | 'label' | 'folder' | 'thread' | 'has' | 'is' | 'after' | 'before' | 'larger' | 'smaller';

/** One matcher. `negate` is set by a leading `-`, so `-from:noreply` is expressible. */
export interface Matcher {
  value: string;
  negate: boolean;
  /** True when the operand arrived inside double quotes and must be matched whole. */
  phrase?: boolean;
}

export interface SearchQuery {
  text: Matcher[];
  from: Matcher[];
  to: Matcher[];
  cc: Matcher[];
  bcc: Matcher[];
  subject: Matcher[];
  body: Matcher[];
  filename: Matcher[];
  domain: Matcher[];
  labels: Matcher[];
  /** A folder named by the query itself (`in:sent`), not the folder being browsed. */
  folder: string | null;
  threadId: string | null;
  hasAttachment: boolean | null;
  isUnread: boolean | null;
  isStarred: boolean | null;
  isImportant: boolean | null;
  isDraft: boolean | null;
  isSnoozed: boolean | null;
  after: Date | null;
  before: Date | null;
  largerThan: number | null;
  smallerThan: number | null;
  /** `in:anywhere` — every folder except Trash and Spam. */
  everywhere: boolean;
  sort: 'date' | 'relevance';
  raw: string;
  /** True when anything at all narrows the result beyond the folder being browsed. */
  active: boolean;
  /** A sentence describing what was actually searched for. Rendered on screen. */
  describe: string;
  /** Operators that parsed to nothing usable. Shown, never swallowed. */
  warnings: string[];
}

export function emptyQuery(raw = ''): SearchQuery {
  return {
    text: [], from: [], to: [], cc: [], bcc: [], subject: [], body: [], filename: [], domain: [],
    labels: [], folder: null, threadId: null,
    hasAttachment: null, isUnread: null, isStarred: null, isImportant: null, isDraft: null, isSnoozed: null,
    after: null, before: null, largerThan: null, smallerThan: null,
    everywhere: false, sort: 'date', raw, active: false, describe: '', warnings: [],
  };
}

/** `2m` becomes 2097152. Bare digits are bytes. Returns null for anything unreadable. */
export function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'b').toLowerCase();
  const mult = unit === 'b' ? 1 : unit[0] === 'k' ? 1024 : unit[0] === 'm' ? 1024 * 1024 : 1024 * 1024 * 1024;
  return Math.round(n * mult);
}

export function formatSize(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/**
 * Dates people actually type. `today`, `yesterday`, `7d`, `3w`, `2026-07-01`, `01/07/2026`.
 * Returns null rather than a guess — a misread date silently searching the wrong month is worse
 * than an operator that says it did not understand.
 */
export function parseWhen(v: string, now = new Date()): Date | null {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const rel = /^(\d{1,4})\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  // Day-first, because this product's dates are written in India and 01/07 is the first of July.
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

const FIELD_ALIASES: Record<string, SearchField> = {
  from: 'from', sender: 'from',
  to: 'to', recipient: 'to',
  cc: 'cc', bcc: 'bcc',
  subject: 'subject', title: 'subject',
  body: 'body', content: 'body',
  filename: 'filename', file: 'filename', attachment: 'filename',
  domain: 'domain',
  label: 'label', tag: 'label',
  folder: 'folder', in: 'folder',
  thread: 'thread', conversation: 'thread',
  has: 'has', is: 'is',
  after: 'after', since: 'after', newer: 'after',
  before: 'before', until: 'before', older: 'before',
  larger: 'larger', bigger: 'larger',
  smaller: 'smaller',
};

/**
 * THE PARSER.
 *
 * Every operator is optional and anything unrecognised falls through to free text rather than being
 * dropped — a query that silently discards half of what was typed is how a person concludes the
 * mailbox has lost their mail.
 *
 * The result is ECHOED ON SCREEN through `describe`. If a search finds nothing, the person can read
 * what was actually asked instead of guessing whether the operator was understood.
 */
export function parseSearchQuery(raw: string, now = new Date()): SearchQuery {
  const q = emptyQuery(String(raw || ''));
  const src = q.raw.trim();
  if (!src) return q;

  // Split on whitespace but keep "quoted phrases" and field:"quoted values" whole.
  const tokens = src.match(/-?[a-zA-Z]+:"[^"]*"|"[^"]*"|\S+/g) || [];
  const unquote = (s: string) => s.replace(/^"([\s\S]*)"$/, '$1').trim();

  for (const tokRaw of tokens) {
    let tok = tokRaw.trim();
    if (!tok) continue;
    let negate = false;
    if (tok.length > 1 && tok.charAt(0) === '-') { negate = true; tok = tok.slice(1); }

    const m = /^([a-zA-Z]+):([\s\S]*)$/.exec(tok);
    if (!m) {
      const wasQuoted = /^"[\s\S]*"$/.test(tok);
      const plain = unquote(tok);
      if (plain) q.text.push({ value: plain.toLowerCase(), negate, phrase: wasQuoted });
      continue;
    }

    const fieldName = m[1].toLowerCase();
    const field = FIELD_ALIASES[fieldName];
    const wasQuoted = /^"[\s\S]*"$/.test(m[2]);
    const value = unquote(m[2]);

    if (!field) {
      // An unknown operator is free text, whole. Dropping it would be a silent lie.
      q.text.push({ value: tok.toLowerCase(), negate, phrase: false });
      q.warnings.push(fieldName + ': is not an operator, so it was searched as ordinary text.');
      continue;
    }
    if (!value && field !== 'has' && field !== 'is') {
      q.warnings.push(fieldName + ': had no value and was ignored.');
      continue;
    }

    const push = (arr: Matcher[]) => arr.push({ value: value.toLowerCase(), negate, phrase: wasQuoted });
    switch (field) {
      case 'from': push(q.from); break;
      case 'to': push(q.to); break;
      case 'cc': push(q.cc); break;
      case 'bcc': push(q.bcc); break;
      case 'subject': push(q.subject); break;
      case 'body': push(q.body); break;
      case 'filename': push(q.filename); break;
      case 'domain': q.domain.push({ value: value.toLowerCase().replace(/^@/, ''), negate }); break;
      case 'label': push(q.labels); break;
      case 'thread':
        if (UUID_RE.test(value)) q.threadId = value;
        else q.warnings.push('thread: needs a conversation id and was ignored.');
        break;
      case 'folder': {
        const v = value.toLowerCase();
        if (v === 'anywhere' || v === 'all' || v === 'everywhere') q.everywhere = true;
        else if ((SYSTEM_FOLDERS as readonly string[]).includes(v)) q.folder = v;
        else q.labels.push({ value: v, negate });
        break;
      }
      case 'has': {
        const v = value.toLowerCase();
        if (/attach|file|doc|link/.test(v)) q.hasAttachment = !negate;
        else q.warnings.push('has:' + value + ' is not something that can be searched for.');
        break;
      }
      case 'is': {
        const v = value.toLowerCase();
        const on = !negate;
        if (v === 'unread') q.isUnread = on;
        else if (v === 'read') q.isUnread = !on;
        else if (v === 'starred' || v === 'star') q.isStarred = on;
        else if (v === 'unstarred') q.isStarred = !on;
        else if (v === 'important') q.isImportant = on;
        else if (v === 'draft') q.isDraft = on;
        else if (v === 'snoozed') q.isSnoozed = on;
        else q.warnings.push('is:' + value + ' is not a state that can be searched for.');
        break;
      }
      case 'after': {
        const d = parseWhen(value, now);
        if (d) q.after = d; else q.warnings.push('after:' + value + ' is not a date that could be read.');
        break;
      }
      case 'before': {
        const d = parseWhen(value, now);
        // `before:` is inclusive of the named day — nobody means "up to midnight that morning".
        if (d) { d.setDate(d.getDate() + 1); q.before = d; }
        else q.warnings.push('before:' + value + ' is not a date that could be read.');
        break;
      }
      case 'larger': {
        const n = parseSize(value);
        if (n != null) q.largerThan = n; else q.warnings.push('larger:' + value + ' is not a size (try 2m).');
        break;
      }
      case 'smaller': {
        const n = parseSize(value);
        if (n != null) q.smallerThan = n; else q.warnings.push('smaller:' + value + ' is not a size (try 500k).');
        break;
      }
      default: break;
    }
  }

  return describeQuery(q);
}

/** Fills `describe` and `active`. Split out so a hand-built query gets the same sentence. */
export function describeQuery(q: SearchQuery): SearchQuery {
  const bits: string[] = [];
  const list = (ms: Matcher[], word: string) => {
    const yes = ms.filter((x) => !x.negate).map((x) => x.value);
    const no = ms.filter((x) => x.negate).map((x) => x.value);
    if (yes.length) bits.push(word + ' ' + yes.join(', '));
    if (no.length) bits.push('not ' + word + ' ' + no.join(', '));
  };
  const plainYes = q.text.filter((t) => !t.negate).map((t) => t.value);
  const plainNo = q.text.filter((t) => t.negate).map((t) => t.value);
  if (plainYes.length) bits.push('"' + plainYes.join(' ') + '"');
  if (plainNo.length) bits.push('without ' + plainNo.join(', '));
  list(q.from, 'from');
  list(q.to, 'to');
  list(q.cc, 'cc');
  list(q.bcc, 'bcc');
  list(q.subject, 'subject containing');
  list(q.body, 'body containing');
  list(q.filename, 'attached file named');
  list(q.domain, 'at domain');
  list(q.labels, 'labelled');
  if (q.folder) bits.push('in ' + q.folder);
  if (q.everywhere) bits.push('everywhere except trash and spam');
  if (q.threadId) bits.push('in one conversation');
  if (q.hasAttachment === true) bits.push('with an attachment');
  if (q.hasAttachment === false) bits.push('with no attachment');
  if (q.isUnread === true) bits.push('unread only');
  if (q.isUnread === false) bits.push('read only');
  if (q.isStarred === true) bits.push('starred only');
  if (q.isStarred === false) bits.push('not starred');
  if (q.isImportant === true) bits.push('important only');
  if (q.isDraft === true) bits.push('drafts only');
  if (q.isSnoozed === true) bits.push('snoozed only');
  if (q.after) bits.push('on or after ' + fmtDay(q.after));
  if (q.before) { const b = new Date(q.before); b.setDate(b.getDate() - 1); bits.push('on or before ' + fmtDay(b)); }
  if (q.largerThan != null) bits.push('larger than ' + formatSize(q.largerThan));
  if (q.smallerThan != null) bits.push('smaller than ' + formatSize(q.smallerThan));
  q.describe = bits.join(' · ');
  q.active = bits.length > 0;
  return q;
}

/** True when the query asks a question no index can narrow. Used to warn, never to refuse. */
export function isBroadQuery(q: SearchQuery): boolean {
  return !q.text.length && !q.from.length && !q.to.length && !q.cc.length && !q.bcc.length
    && !q.subject.length && !q.body.length && !q.filename.length && !q.domain.length
    && !q.labels.length && !q.threadId;
}

// =================================================================================================
// THE PROVIDER INTERFACE
// =================================================================================================

export interface SearchScope {
  /** The system folder being browsed. Overridden by `in:` / `in:anywhere` in the query. */
  folder?: string | null;
  /** The Starred pseudo-folder in the rail. */
  starred?: boolean;
  /** A label pseudo-folder in the rail; searches every folder except Trash and Spam. */
  label?: string | null;
}

export interface SearchContext {
  userId: string;
  scope?: SearchScope;
  limit?: number;
  /** Opaque. Callers must not parse it — see encodeCursor(). */
  cursor?: string | null;
  /** Ask for a bounded total. Off by default: it costs a second statement. */
  withTotal?: boolean;
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  subject: string;
  snippet: string;
  fromName: string;
  fromEmail: string;
  fromUserId: string | null;
  createdAt: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  folder: string;
  labels: string[];
  threadCount: number;
  participants: string;
  isDraft: boolean;
  direction: string;
  snoozedUntil: string | null;
  sizeBytes: number | null;
  /** Relevance, when the engine produced one. Null on a pure date-ordered browse. */
  rank: number | null;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Bounded count of MATCHING CONVERSATIONS, capped at COUNT_CAP. `cappedAt` says whether the
   * number is exact or a floor, so a screen can print "10,000+" rather than claiming a total it
   * did not compute.
   */
  total?: number;
  totalIsCapped?: boolean;
  query: SearchQuery;
  scopeLabel: string;
  engine: string;
  tookMs: number;
  /** Set when a preferred engine was unavailable and a fallback answered. Shown, never hidden. */
  degraded: string | null;
}

export interface MailSearchProvider {
  readonly name: string;
  search(q: SearchQuery, ctx: SearchContext): Promise<SearchPage>;
  /** Whether this engine can answer a field at all. A provider that cannot must say so. */
  supports(field: SearchField): boolean;
}

/** Keyset cursor. Base64 so nobody is tempted to read it; not a security boundary, a discipline. */
export function encodeCursor(createdAt: string, messageId: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id: messageId }), 'utf8').toString('base64url');
}

export function decodeCursor(c: string | null | undefined): { t: string; id: string } | null {
  if (!c) return null;
  try {
    const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
    if (!o || typeof o.t !== 'string' || !UUID_RE.test(String(o.id || ''))) return null;
    return { t: o.t, id: String(o.id) };
  } catch {
    // A malformed cursor starts from the top. It never throws the listing away.
    return null;
  }
}

// =================================================================================================
// SCHEMA — additive, idempotent, and generated rather than triggered
// =================================================================================================
//
// `search_tsv` and `body_bytes` are GENERATED ... STORED. Both expressions are immutable
// (to_tsvector with an explicit regconfig, regexp_replace, octet_length, coalesce), which is what
// Postgres requires and what makes the columns impossible to leave stale. A trigger would have been
// one more thing for an inbound path to forget.
//
// Attachment bytes are deliberately NOT in body_bytes: attachments arrive as their own rows after
// the message is inserted, so a generated column cannot see them. `larger:`/`smaller:` therefore
// add the attachment sum with a LATERAL only when one of those operators is present — see
// buildFrom(). Attachments stored as links have no recorded size and count as zero; the search
// help text says so rather than pretending the number is complete.
let searchSchemaReady: Promise<{ fts: boolean; bytes: boolean }> | null = null;

export function ensureSearchSchema(): Promise<{ fts: boolean; bytes: boolean }> {
  if (!searchSchemaReady) searchSchemaReady = bootstrapSearchSchema();
  return searchSchemaReady;
}

async function bootstrapSearchSchema(): Promise<{ fts: boolean; bytes: boolean }> {
  let fts = false;
  let bytes = false;
  try {
    await db.execute(sql`
      ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || coalesce(from_email, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(nullif(body_text, ''), regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g'))), 'C')
      ) STORED`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_msg_tsv_idx ON mail_messages USING GIN (search_tsv)`);
    fts = true;
  } catch (e: any) {
    // NOT FATAL AND NOT SILENT. Without the column, free text falls back to ILIKE — correct, slower,
    // and reported on every page through `degraded` so nobody concludes the index is working.
    console.error('[mail-search] full-text column unavailable, falling back to ILIKE:', reasonOf(e));
  }
  try {
    await db.execute(sql`
      ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS body_bytes BIGINT
      GENERATED ALWAYS AS (
        octet_length(coalesce(subject, '')) + octet_length(coalesce(body_text, '')) + octet_length(coalesce(body_html, ''))
      ) STORED`);
    bytes = true;
  } catch (e: any) {
    console.error('[mail-search] size column unavailable, larger:/smaller: will be ignored:', reasonOf(e));
  }
  // Paging walks (user_id, folder, created_at DESC) — already indexed by mail.ts. These two cover
  // the label rail and the starred rail, which had no index of their own and were sequential scans.
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_box_labels_idx ON mail_box USING GIN (labels)`);
  } catch (e: any) { console.error('[mail-search] label index:', reasonOf(e)); }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_box_starred_idx ON mail_box(user_id, created_at DESC) WHERE is_starred = true`);
  } catch (e: any) { console.error('[mail-search] starred index:', reasonOf(e)); }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_box_snooze_idx ON mail_box(snoozed_until) WHERE snoozed_until IS NOT NULL`);
  } catch (e: any) { console.error('[mail-search] snooze index:', reasonOf(e)); }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_attach_name_idx ON mail_attachments(lower(filename))`);
  } catch (e: any) { console.error('[mail-search] filename index:', reasonOf(e)); }
  return { fts, bytes };
}

// =================================================================================================
// POSTGRES PROVIDER
// =================================================================================================

/** A term is turned into a websearch tsquery. Postgres parses the quoting; we do not hand-build it. */
function ftsExpression(terms: Matcher[]): string {
  return terms.filter((t) => !t.negate).map((t) => (t.phrase ? '"' + t.value.replace(/"/g, ' ') + '"' : t.value)).join(' ');
}

function like(v: string): string {
  // Escape the LIKE metacharacters so a literal % in an address is not a wildcard.
  return '%' + String(v).replace(/([\\%_])/g, '\\$1') + '%';
}

class PostgresSearchProvider implements MailSearchProvider {
  readonly name = 'postgres';

  supports(field: SearchField): boolean {
    // Everything in the grammar is answerable here. `larger`/`smaller` need the generated column;
    // if the ALTER failed, buildWhere() drops them and search() reports it through `degraded`.
    return true;
  }

  async search(q: SearchQuery, ctx: SearchContext): Promise<SearchPage> {
    const started = Date.now();
    const caps = await ensureSearchSchema();
    const limit = Math.min(Math.max(Number(ctx.limit) || 50, 1), 200);
    const scope = ctx.scope || {};
    const degraded: string[] = [];

    const { where, scopeLabel, wide } = buildWhere(q, ctx.userId, scope, caps, degraded);
    const sizeJoin = (q.largerThan != null || q.smallerThan != null) && caps.bytes
      ? sql`LEFT JOIN LATERAL (SELECT COALESCE(SUM(a.size_bytes), 0)::bigint AS att_bytes FROM mail_attachments a WHERE a.message_id = m.id) sz ON true`
      : sql``;

    const cur = decodeCursor(ctx.cursor);
    const keyset = cur
      ? sql` AND (b.created_at, b.message_id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`
      : sql``;

    // Relevance ordering cannot be keyset-paged (rank is not monotonic in time), so it is answered
    // as a single ranked page and says so by returning no cursor. Date order is the pageable one
    // and is the default, which is what a mailbox is for.
    const wantRank = q.sort === 'relevance' && caps.fts && q.text.some((t) => !t.negate);
    const rankExpr = wantRank
      ? sql`ts_rank_cd(m.search_tsv, websearch_to_tsquery('english', ${ftsExpression(q.text)}))`
      : sql`NULL::real`;

    // Walk MESSAGES newest-first and collapse to conversations inside the page. Scanning a multiple
    // of the page size means a page of heavily-threaded mail still fills up; it is bounded work
    // either way, unlike a window function over the whole mailbox.
    const scan = limit * PAGE_SCAN_FACTOR;
    let msgRows: any[] = [];
    try {
      const r = await db.execute(sql`
        SELECT b.thread_id, b.message_id, b.folder, b.is_read, b.is_starred, b.labels, b.snoozed_until,
               b.created_at AS box_created,
               m.subject, m.snippet, m.from_name, m.from_email, m.from_user_id,
               m.has_attachments, m.direction, m.is_draft, m.created_at AS msg_created,
               ${caps.bytes ? sql`m.body_bytes` : sql`NULL::bigint AS body_bytes`},
               ${rankExpr} AS rank
        FROM mail_box b
        JOIN mail_messages m ON m.id = b.message_id
        ${sizeJoin}
        WHERE ${where}${keyset}
        ORDER BY ${wantRank ? sql`rank DESC NULLS LAST, ` : sql``}b.created_at DESC, b.message_id DESC
        LIMIT ${scan}
      `);
      msgRows = rowsOf(r);
    } catch (e: any) {
      // The listing is not swallowed into an empty inbox. The caller renders the reason.
      console.error('[mail-search] listing failed:', reasonOf(e));
      throw e;
    }

    // Collapse: newest message per conversation wins the row, and the cursor is the last MESSAGE
    // consumed — not the last thread — so the next page resumes exactly where this scan stopped and
    // no message is skipped or repeated.
    const seen = new Map<string, any>();
    let lastConsumed: any = null;
    let consumed = 0;
    for (const row of msgRows) {
      if (seen.size >= limit && !seen.has(String(row.thread_id))) break;
      consumed++;
      lastConsumed = row;
      const key = String(row.thread_id);
      if (!seen.has(key)) seen.set(key, row);
    }
    const picked = Array.from(seen.values());
    const scanExhausted = consumed >= msgRows.length;
    const hasMore = !(scanExhausted && msgRows.length < scan);
    const nextCursor = !wantRank && hasMore && lastConsumed
      ? encodeCursor(new Date(lastConsumed.box_created).toISOString(), String(lastConsumed.message_id))
      : null;

    const hits: SearchHit[] = picked.map((row) => ({
      threadId: String(row.thread_id),
      messageId: String(row.message_id),
      subject: row.subject || '',
      snippet: row.snippet || '',
      fromName: row.from_name || '',
      fromEmail: row.from_email || '',
      fromUserId: row.from_user_id ? String(row.from_user_id) : null,
      createdAt: new Date(row.msg_created || row.box_created).toISOString(),
      isRead: !!row.is_read,
      isStarred: !!row.is_starred,
      hasAttachments: !!row.has_attachments,
      folder: String(row.folder || 'inbox'),
      labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
      threadCount: 1,
      participants: row.from_name || row.from_email || '',
      isDraft: !!row.is_draft,
      direction: String(row.direction || 'internal'),
      snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString() : null,
      sizeBytes: row.body_bytes == null ? null : Number(row.body_bytes),
      rank: row.rank == null ? null : Number(row.rank),
    }));

    await decorateThreads(ctx.userId, hits);

    let total: number | undefined;
    let totalIsCapped: boolean | undefined;
    if (ctx.withTotal) {
      const counted = await countMatching(ctx.userId, where, sizeJoin);
      if (counted != null) { total = counted.total; totalIsCapped = counted.capped; }
    }

    return {
      hits,
      nextCursor,
      hasMore: !!nextCursor || (wantRank && hasMore),
      total,
      totalIsCapped,
      query: q,
      scopeLabel,
      engine: this.name + (caps.fts ? '+fts' : '+like'),
      tookMs: Date.now() - started,
      degraded: degraded.length ? degraded.join(' ') : null,
    };
  }
}

/**
 * Per-conversation counts, participants and roll-up flags for ONE PAGE of results.
 *
 * This is the query the old listing did with a window function over the entire filtered mailbox.
 * Keyed by thread id and indexed by mail_box(user_id, thread_id), it reads only the conversations
 * on screen. A failure here degrades the row (count 1, sender as participant) rather than throwing
 * the page away — a thread list with imperfect counts is worth more than an error page.
 */
async function decorateThreads(userId: string, hits: SearchHit[]): Promise<void> {
  if (!hits.length) return;
  const ids = hits.map((h) => h.threadId).filter((t) => UUID_RE.test(t));
  if (!ids.length) return;
  try {
    const r = await db.execute(sql`
      SELECT b.thread_id,
             COUNT(*)::int AS thread_count,
             bool_and(b.is_read) AS all_read,
             bool_or(b.is_starred) AS any_star,
             bool_or(m.has_attachments) AS any_attach,
             string_agg(DISTINCT coalesce(nullif(m.from_name, ''), m.from_email), ', ') AS names
      FROM mail_box b
      JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${userId}
        AND b.thread_id = ANY((SELECT array_agg(t.x::uuid) FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)))
      GROUP BY b.thread_id
    `);
    const by: Record<string, any> = {};
    for (const row of rowsOf(r)) by[String(row.thread_id)] = row;
    for (const h of hits) {
      const d = by[h.threadId];
      if (!d) continue;
      h.threadCount = Number(d.thread_count) || 1;
      h.isRead = !!d.all_read;
      h.isStarred = !!d.any_star;
      h.hasAttachments = h.hasAttachments || !!d.any_attach;
      h.participants = d.names || h.participants;
    }
  } catch (e: any) {
    console.error('[mail-search] conversation roll-up failed:', reasonOf(e));
  }
}

/**
 * How many conversations match, bounded.
 *
 * An exact count over a large mailbox is a table scan, so this counts DISTINCT thread ids inside a
 * subquery capped at COUNT_CAP messages and reports whether it hit the cap. Bulk operations need
 * this number to tell somebody what "select all results" is about to touch; a screen that says
 * "10,000+" is honest and a screen that says "10,000" when it means "at least" is not.
 */
async function countMatching(userId: string, where: any, sizeJoin: any): Promise<{ total: number; capped: boolean } | null> {
  try {
    const r = await db.execute(sql`
      SELECT COUNT(DISTINCT t.thread_id)::int AS n, COUNT(*)::int AS seen FROM (
        SELECT b.thread_id
        FROM mail_box b
        JOIN mail_messages m ON m.id = b.message_id
        ${sizeJoin}
        WHERE ${where}
        LIMIT ${COUNT_CAP}
      ) t
    `);
    const row = rowsOf(r)[0];
    if (!row) return null;
    return { total: Number(row.n) || 0, capped: Number(row.seen) >= COUNT_CAP };
  } catch (e: any) {
    console.error('[mail-search] count failed:', reasonOf(e));
    return null;
  }
}

/**
 * The WHERE clause, and the ONE place mailbox ownership is applied.
 *
 * `b.user_id = <caller>` is the first predicate and nothing below can remove it. Every operator
 * narrows; none widens beyond the mailbox.
 */
export function buildWhere(
  q: SearchQuery,
  userId: string,
  scope: SearchScope,
  caps: { fts: boolean; bytes: boolean },
  degraded: string[],
): { where: any; scopeLabel: string; wide: boolean } {
  let where = sql`b.user_id = ${userId}`;
  let scopeLabel: string;
  const wide = q.everywhere || !!scope.label || !!q.threadId;

  if (q.threadId) {
    where = sql`${where} AND b.thread_id = ${q.threadId}::uuid`;
    scopeLabel = 'One conversation';
  } else if (scope.label) {
    where = sql`${where} AND b.labels @> ARRAY[${scope.label}]::text[] AND b.folder NOT IN ('trash','spam')`;
    scopeLabel = 'Label: ' + scope.label;
  } else if (scope.starred) {
    where = sql`${where} AND b.is_starred = true AND b.folder <> 'trash'`;
    scopeLabel = 'Starred';
  } else if (q.everywhere) {
    where = sql`${where} AND b.folder NOT IN ('trash','spam')`;
    scopeLabel = 'All mail';
  } else {
    const folder = q.folder || scope.folder || 'inbox';
    where = sql`${where} AND b.folder = ${folder}`;
    scopeLabel = folder.charAt(0).toUpperCase() + folder.slice(1);
  }

  // A snoozed conversation is OUT OF THE INBOX UNTIL IT WAKES. This is the predicate that makes
  // snooze mean anything: without it the row stays visible and the feature is decoration.
  if (q.isSnoozed === true) {
    where = sql`${where} AND b.snoozed_until IS NOT NULL AND b.snoozed_until > NOW()`;
  } else if (!q.threadId && (q.folder || scope.folder || 'inbox') === 'inbox' && !scope.label && !scope.starred) {
    where = sql`${where} AND (b.snoozed_until IS NULL OR b.snoozed_until <= NOW())`;
  }

  for (const l of q.labels) {
    where = l.negate
      ? sql`${where} AND NOT (b.labels @> ARRAY[${l.value}]::text[])`
      : sql`${where} AND b.labels @> ARRAY[${l.value}]::text[]`;
  }
  if (q.isUnread === true) where = sql`${where} AND b.is_read = false`;
  if (q.isUnread === false) where = sql`${where} AND b.is_read = true`;
  if (q.isStarred === true) where = sql`${where} AND b.is_starred = true`;
  if (q.isStarred === false) where = sql`${where} AND b.is_starred = false`;
  if (q.isImportant === true) where = sql`${where} AND b.is_important = true`;
  if (q.isDraft === true) where = sql`${where} AND m.is_draft = true`;
  if (q.isDraft === false) where = sql`${where} AND m.is_draft = false`;
  if (q.hasAttachment === true) where = sql`${where} AND m.has_attachments = true`;
  if (q.hasAttachment === false) where = sql`${where} AND m.has_attachments = false`;
  if (q.after) where = sql`${where} AND m.created_at >= ${q.after.toISOString()}::timestamptz`;
  if (q.before) where = sql`${where} AND m.created_at < ${q.before.toISOString()}::timestamptz`;

  if (q.largerThan != null || q.smallerThan != null) {
    if (!caps.bytes) {
      degraded.push('Message size is not recorded on this database yet, so larger:/smaller: were ignored.');
    } else {
      if (q.largerThan != null) where = sql`${where} AND (COALESCE(m.body_bytes,0) + sz.att_bytes) > ${q.largerThan}`;
      if (q.smallerThan != null) where = sql`${where} AND (COALESCE(m.body_bytes,0) + sz.att_bytes) < ${q.smallerThan}`;
    }
  }

  for (const t of q.from) {
    const inner = sql`(lower(coalesce(m.from_email,'')) LIKE ${like(t.value)} ESCAPE '\\' OR lower(coalesce(m.from_name,'')) LIKE ${like(t.value)} ESCAPE '\\')`;
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  const recipientMatch = (kinds: string[] | null, v: string) => {
    const kindFilter = kinds ? sql` AND r.kind = ANY(ARRAY[${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}]::text[])` : sql``;
    return sql`EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id${kindFilter}
      AND (lower(coalesce(r.email,'')) LIKE ${like(v)} ESCAPE '\\' OR lower(coalesce(r.name,'')) LIKE ${like(v)} ESCAPE '\\'))`;
  };
  // `to:` is the ordinary reading — anybody the message was addressed to, cc included. `cc:` and
  // `bcc:` are the precise ones.
  for (const t of q.to) {
    const inner = recipientMatch(['to', 'cc'], t.value);
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  for (const t of q.cc) {
    const inner = recipientMatch(['cc'], t.value);
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  for (const t of q.bcc) {
    const inner = recipientMatch(['bcc'], t.value);
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  for (const t of q.subject) {
    const inner = sql`lower(coalesce(m.subject,'')) LIKE ${like(t.value)} ESCAPE '\\'`;
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  for (const t of q.body) {
    const inner = sql`(lower(coalesce(m.body_text,'')) LIKE ${like(t.value)} ESCAPE '\\' OR lower(coalesce(m.body_html,'')) LIKE ${like(t.value)} ESCAPE '\\')`;
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  for (const t of q.filename) {
    const inner = sql`EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_id = m.id AND lower(coalesce(a.filename,'')) LIKE ${like(t.value)} ESCAPE '\\')`;
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }
  // `domain:` is an address question, not a text question: it matches the part after the @ on the
  // sender or on any recipient, so `domain:university.edu` cannot be satisfied by the word appearing
  // in a signature.
  for (const t of q.domain) {
    const suffix = '%@' + String(t.value).replace(/([\\%_])/g, '\\$1');
    const inner = sql`(lower(coalesce(m.from_email,'')) LIKE ${suffix} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND lower(coalesce(r.email,'')) LIKE ${suffix} ESCAPE '\\'))`;
    where = t.negate ? sql`${where} AND NOT ${inner}` : sql`${where} AND ${inner}`;
  }

  // FREE TEXT. One tsquery for all positive terms (the index is consulted once), and negative terms
  // as ILIKE exclusions — a GIN index cannot answer "does not contain" usefully anyway.
  const positive = q.text.filter((t) => !t.negate);
  const negative = q.text.filter((t) => t.negate);
  if (positive.length) {
    if (caps.fts) {
      where = sql`${where} AND m.search_tsv @@ websearch_to_tsquery('english', ${ftsExpression(positive)})`;
    } else {
      degraded.push('Full-text search is not available on this database, so this was matched as plain substrings.');
      for (const t of positive) {
        where = sql`${where} AND (
          lower(coalesce(m.subject,'')) LIKE ${like(t.value)} ESCAPE '\\'
          OR lower(coalesce(m.snippet,'')) LIKE ${like(t.value)} ESCAPE '\\'
          OR lower(coalesce(m.body_text,'')) LIKE ${like(t.value)} ESCAPE '\\'
          OR lower(coalesce(m.body_html,'')) LIKE ${like(t.value)} ESCAPE '\\'
          OR lower(coalesce(m.from_name,'')) LIKE ${like(t.value)} ESCAPE '\\'
          OR lower(coalesce(m.from_email,'')) LIKE ${like(t.value)} ESCAPE '\\'
        )`;
      }
    }
  }
  for (const t of negative) {
    where = sql`${where} AND NOT (
      lower(coalesce(m.subject,'')) LIKE ${like(t.value)} ESCAPE '\\'
      OR lower(coalesce(m.body_text,'')) LIKE ${like(t.value)} ESCAPE '\\'
      OR lower(coalesce(m.from_email,'')) LIKE ${like(t.value)} ESCAPE '\\'
    )`;
  }

  return { where, scopeLabel, wide };
}

// =================================================================================================
// THE OTHER ENGINE — compiled from the same object, so the swap is a demonstrated claim
// =================================================================================================

/**
 * The SAME SearchQuery as an OpenSearch/Elasticsearch bool query.
 *
 * PURE, and tested. This is what makes "the search layer is swappable" checkable rather than
 * asserted: the day an index exists, getSearchProvider() returns a provider that posts this body to
 * it and nothing above the interface changes. Field names are the document shape an indexer would
 * write — flat, analysed text for the bodies, keyword for the addresses and labels.
 *
 * `user_id` is a FILTER, not a should-clause. Mailbox ownership is not a relevance signal.
 */
export function toSearchDsl(q: SearchQuery, ctx: { userId: string; scope?: SearchScope; limit?: number }): Record<string, any> {
  const must: any[] = [];
  const must_not: any[] = [];
  const filter: any[] = [{ term: { user_id: ctx.userId } }];
  const scope = ctx.scope || {};

  if (q.threadId) filter.push({ term: { thread_id: q.threadId } });
  else if (scope.label) { filter.push({ term: { labels: scope.label } }); must_not.push({ terms: { folder: ['trash', 'spam'] } }); }
  else if (scope.starred) { filter.push({ term: { is_starred: true } }); must_not.push({ term: { folder: 'trash' } }); }
  else if (q.everywhere) must_not.push({ terms: { folder: ['trash', 'spam'] } });
  else filter.push({ term: { folder: q.folder || scope.folder || 'inbox' } });

  const textFields = ['subject^3', 'from_name^2', 'from_email^2', 'body', 'recipients'];
  for (const t of q.text) {
    const clause = t.phrase
      ? { multi_match: { query: t.value, fields: textFields, type: 'phrase' } }
      : { multi_match: { query: t.value, fields: textFields, operator: 'and' } };
    (t.negate ? must_not : must).push(clause);
  }
  const field = (ms: Matcher[], name: string, type: 'match' | 'wildcard' = 'match') => {
    for (const t of ms) {
      const clause = type === 'wildcard'
        ? { wildcard: { [name]: { value: '*' + t.value + '*', case_insensitive: true } } }
        : { match: { [name]: t.value } };
      (t.negate ? must_not : must).push(clause);
    }
  };
  field(q.from, 'from', 'wildcard');
  field(q.to, 'recipients_to', 'wildcard');
  field(q.cc, 'recipients_cc', 'wildcard');
  field(q.bcc, 'recipients_bcc', 'wildcard');
  field(q.subject, 'subject', 'wildcard');
  field(q.body, 'body');
  field(q.filename, 'attachment_names', 'wildcard');
  for (const t of q.domain) (t.negate ? must_not : must).push({ term: { address_domains: t.value } });
  for (const t of q.labels) (t.negate ? must_not : filter).push({ term: { labels: t.value } });

  if (q.hasAttachment != null) (q.hasAttachment ? filter : must_not).push({ term: { has_attachments: true } });
  if (q.isUnread != null) filter.push({ term: { is_read: !q.isUnread } });
  if (q.isStarred != null) filter.push({ term: { is_starred: q.isStarred } });
  if (q.isImportant != null) filter.push({ term: { is_important: q.isImportant } });
  if (q.isDraft != null) filter.push({ term: { is_draft: q.isDraft } });

  const range: Record<string, any> = {};
  if (q.after) range.gte = q.after.toISOString();
  if (q.before) range.lt = q.before.toISOString();
  if (Object.keys(range).length) filter.push({ range: { created_at: range } });

  const size: Record<string, any> = {};
  if (q.largerThan != null) size.gt = q.largerThan;
  if (q.smallerThan != null) size.lt = q.smallerThan;
  if (Object.keys(size).length) filter.push({ range: { size_bytes: size } });

  return {
    size: Math.min(Math.max(Number(ctx.limit) || 50, 1), 200),
    track_total_hits: COUNT_CAP,
    sort: q.sort === 'relevance' ? ['_score', { created_at: 'desc' }] : [{ created_at: 'desc' }, { message_id: 'desc' }],
    collapse: { field: 'thread_id', inner_hits: { name: 'latest', size: 1, sort: [{ created_at: 'desc' }] } },
    query: { bool: { must, must_not, filter } },
  };
}

// =================================================================================================
// ENGINE SELECTION
// =================================================================================================

const postgresProvider = new PostgresSearchProvider();

/**
 * WHICH ENGINE ANSWERS.
 *
 * Postgres today, and it is the only one wired: there is no OpenSearch cluster on this deployment
 * and a provider that posts to a URL nobody has configured would be a feature that cannot run, only
 * maintained. toSearchDsl() above is the compiled half of the second engine and it is tested; the
 * missing half is a client and an indexer, recorded as a follow-up rather than stubbed here.
 */
export function getSearchProvider(): MailSearchProvider {
  return postgresProvider;
}

/** The one call the rest of the product makes. */
export async function searchMailbox(userId: string, opts: {
  query?: string;
  scope?: SearchScope;
  limit?: number;
  cursor?: string | null;
  withTotal?: boolean;
  sort?: 'date' | 'relevance';
}): Promise<SearchPage> {
  const q = parseSearchQuery(opts.query || '');
  if (opts.sort) q.sort = opts.sort;
  return getSearchProvider().search(q, {
    userId,
    scope: opts.scope,
    limit: opts.limit,
    cursor: opts.cursor,
    withTotal: opts.withTotal,
  });
}

/**
 * The WHERE clause for a query, exposed so bulk operations can act on EVERY MATCH without the
 * browser ever enumerating the ids. src/lib/mail-bulk.ts is the only caller; it is here because
 * this is the module that owns the meaning of a query, and two compilers of the same grammar is
 * exactly the drift this file was written to end.
 */
export async function compileSelection(userId: string, rawQuery: string, scope: SearchScope): Promise<{ where: any; query: SearchQuery; degraded: string[] }> {
  const caps = await ensureSearchSchema();
  const q = parseSearchQuery(rawQuery || '');
  const degraded: string[] = [];
  const { where } = buildWhere(q, userId, scope || {}, caps, degraded);
  return { where, query: q, degraded };
}

/** Operator help, rendered next to the search box. One list, so the help cannot describe a
 *  grammar the parser does not have. */
export const SEARCH_HELP: { op: string; means: string }[] = [
  { op: 'from:anita', means: 'sender name or address' },
  { op: 'to:accounts', means: 'anyone it was addressed to, cc included' },
  { op: 'cc: / bcc:', means: 'those two lines exactly' },
  { op: 'subject:invoice', means: 'words in the subject line' },
  { op: 'body:"site visit"', means: 'words inside the message' },
  { op: 'filename:report.pdf', means: 'the name of an attached file' },
  { op: 'domain:university.edu', means: 'the part after the @, sender or recipient' },
  { op: 'has:attachment', means: 'carries an attachment' },
  { op: 'is:unread / is:starred', means: 'state, also is:read, is:important, is:draft, is:snoozed' },
  { op: 'label:payroll', means: 'carries that label' },
  { op: 'in:sent / in:anywhere', means: 'a folder, or everywhere but trash and spam' },
  { op: 'after:2026-07-01', means: 'also after:7d, after:today, before:...' },
  { op: 'larger:2m / smaller:500k', means: 'message size; linked files count as zero' },
  { op: '-from:noreply', means: 'a leading minus excludes' },
  { op: '"exact phrase"', means: 'quotes keep words together' },
];
