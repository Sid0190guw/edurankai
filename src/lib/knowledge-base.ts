// src/lib/knowledge-base.ts — THE WORKPLACE KNOWLEDGE BASE. Articles, policies, versions, search,
// ticket deflection, and a record of who has read which policy version.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   THE HELPDESK   src/lib/helpdesk.ts. This module EXTENDS it rather than sitting beside it: the
//                  article categories ARE the ticket categories (imported, not restated), so
//                  suggestArticles() can answer "what does the IT desk already have written down?"
//                  for the exact category the person picked on the raise form. There is no second
//                  category vocabulary and no mapping table between two of them.
//   THE KERNEL     src/lib/kernel-content.ts / knowledge-graph.ts hold KnowledgeObject — TEACHING
//                  content for learners, versioned in kernel_objects, published with the `execute`
//                  capability. That is course material for students. This is the STAFF handbook: how
//                  to ask for a laptop, what the leave policy says, which form to fill in. Different
//                  audience, different lifecycle, different authorization. Neither reads the other's
//                  tables, and nothing here is a second wiki over kernel_objects.
//   MARKDOWN       src/lib/content-render.ts mdLite(). This project renders markdown SERVER-SIDE and
//                  ships no client renderer; every surface here calls renderArticleHtml(), which is
//                  mdLite with nothing added. No second parser, no client-side library, no bytes.
//   DOCUMENTS      src/lib/documents.ts is the LINK LIBRARY — Google Drive links to files that live
//                  somewhere else, by standing rule. An article is text written HERE, in this
//                  database, that can be searched and versioned. A link to a PDF cannot be either.
//   AUTHORIZATION  src/lib/auth/permissions.ts. One new capability, `knowledge.manage`, for writing.
//                  READING is scoped by the capability an ARTICLE names, resolved through the
//                  registry and applied IN THE WHERE CLAUSE.
//   AUDIT          logAudit() (src/lib/audit.ts). No second log.
//
// =================================================================================================
// VISIBILITY IS A WHERE CLAUSE, NEVER A HIDDEN ROW
// =================================================================================================
//
// Every article carries an `audience`:
//
//   workspace    anybody who has a workspace here — an employee record, or an admin account. The
//                leave policy, the expenses guide, how to reach the IT desk.
//   restricted   only the holders of the capability named in `required_capability`. Interview
//                scoring guidance is for the people who interview; a payroll runbook is for the
//                people who run payroll.
//
// The filter is built into the SQL by visibilityClause(), which the readers below CANNOT be called
// without: every reader takes a KbViewer and every query pastes that clause in. A row this person
// may not read is never fetched, so it cannot be leaked by a rendering mistake, a JSON dump, a
// search-result snippet or a "view source". Filtering after the fetch would put the whole article
// body in the response and hide it with CSS, which is not privacy, it is a light switch.
//
// A capability key that is not in the registry's built-in list is treated as "nobody holds it": an
// article restricted to a typo is invisible rather than public. That is the fail-closed direction.
//
// =================================================================================================
// POLICIES, AND WHAT AN ACKNOWLEDGEMENT IS
// =================================================================================================
//
// A policy is an article with kind='policy'. It can require acknowledgement, and the acknowledgement
// is recorded AGAINST A VERSION — because "Priya read the travel policy" is worthless if the travel
// policy has been rewritten twice since. Publishing a new version re-opens the acknowledgement for
// everybody; that is the point of tracking it at all.
//
// WHAT THE ADMIN SURFACE MAY SHOW, and this is a deliberate line: the people who HAVE acknowledged
// are named, because an acknowledgement is an act that person deliberately performed on a document
// and being able to prove they did it is the entire purpose of the record. The people who have NOT
// are a COUNT — never a list of names. A screen that prints "these eleven people have not read the
// code of conduct" is a shame list, and this product does not build one. The count tells whoever
// owns the policy that a reminder is due, which is the action the number is for.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { holdsCapability } from '@/lib/auth/capability';
import { mdLite } from '@/lib/content-render';
import { BUILTIN_PERMISSION_KEYS } from '@/lib/auth/registry';
import { TICKET_CATEGORIES, categoryLabel } from '@/lib/helpdesk';
import { textArray } from '@/lib/pg-array';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that read it. `const` is not hoisted,
// and a const declared under its first use throws on the first line of whatever reads it.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never an object with `rows`. `r.rows[0]` is always a bug. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[knowledge-base] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Shown when a write fails. Deliberately NOT the database's own words — those go to the log. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found / not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That article is not available.';

const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const BODY_MAX = 60000;
const TAG_MAX = 40;
const MAX_TAGS = 12;
const SEARCH_MAX = 120;

/** A capability key may only ever contain these characters. Anything else is not a key. */
const CAPABILITY_RE = /^[a-z0-9_.*-]+$/;

/** The keys the registry actually defines. An article naming anything else is read by nobody. */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(BUILTIN_PERMISSION_KEYS);

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * CATEGORIES ARE THE HELPDESK'S CATEGORIES, plus one.
 *
 * Imported from src/lib/helpdesk.ts rather than retyped, so an article filed under `it` is filed
 * under the same word the IT desk's tickets are, and deflection is a WHERE clause rather than a
 * lookup table between two vocabularies that will drift. 'general' is the article-only addition —
 * the joining guide belongs to no desk.
 */
export const KB_CATEGORIES = [...TICKET_CATEGORIES, 'general'] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(KB_CATEGORIES);
export function isKbCategory(v: unknown): v is KbCategory {
  return typeof v === 'string' && CATEGORY_SET.has(v);
}

/**
 * Plain words, from a FUNCTION rather than an exported `Record<string, string>`. A typed map read
 * inside .astro JSX is one of this project's known parse hazards, and every surface here is .astro.
 * The shared categories defer to the helpdesk's own labels so the two screens never disagree.
 */
export function kbCategoryLabel(category: string): string {
  const k = String(category || '');
  if (k === 'general') return 'General';
  return categoryLabel(k);
}

export const KB_KINDS = ['article', 'policy'] as const;
export type KbKind = (typeof KB_KINDS)[number];

export function kindLabel(kind: string): string {
  return String(kind || '') === 'policy' ? 'Policy' : 'Article';
}

export const KB_AUDIENCES = ['workspace', 'restricted'] as const;
export type KbAudience = (typeof KB_AUDIENCES)[number];

export function audienceLabel(audience: string, requiredCapability: string | null): string {
  if (String(audience || '') === 'restricted') {
    return 'Restricted' + (requiredCapability ? ' (' + requiredCapability + ')' : '');
  }
  return 'Everyone with a workspace';
}

export const KB_STATUSES = ['draft', 'published', 'archived'] as const;
export type KbStatus = (typeof KB_STATUSES)[number];

export function statusLabel(status: string): string {
  const k = String(status || '');
  if (k === 'published') return 'Published';
  if (k === 'archived') return 'Archived';
  return 'Draft';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, asserted column by column.
// -------------------------------------------------------------------------------------------------

/**
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS — which
 * is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
 * table, locking every administrator out of /admin for a day. Every column past the primary key is
 * therefore asserted again with ADD COLUMN IF NOT EXISTS.
 *
 * THERE IS EXACTLY ONE DEFINITION OF EACH OF THESE THREE TABLES, IN THIS FILE. Two CREATE TABLE IF
 * NOT EXISTS statements for one table with different shapes silently breaks every write for whichever
 * module lost the race. Before adding a table anywhere, grep for its name.
 *
 * ensureOnce() memoises the in-flight promise per process and DELETES the cache entry if the callback
 * rejects, so a transient failure retries on the next call instead of poisoning the process — which
 * is why the catch below RE-THROWS after logging.
 */
export function ensureKnowledgeSchema(): Promise<void> {
  return ensureOnce('knowledge_base_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kb_articles (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                 TEXT NOT NULL,
        kind                 TEXT NOT NULL DEFAULT 'article',
        title                TEXT NOT NULL,
        summary              TEXT NOT NULL DEFAULT '',
        category             TEXT NOT NULL DEFAULT 'general',
        tags                 TEXT[] NOT NULL DEFAULT '{}',
        body                 TEXT NOT NULL DEFAULT '',
        audience             TEXT NOT NULL DEFAULT 'workspace',
        required_capability  TEXT,
        status               TEXT NOT NULL DEFAULT 'draft',
        version              INT NOT NULL DEFAULT 1,
        ack_required         BOOLEAN NOT NULL DEFAULT false,
        effective_from       DATE,
        author_user_id       UUID,
        author_employee_id   UUID,
        author_name          TEXT NOT NULL DEFAULT '',
        published_at         TIMESTAMPTZ,
        view_count           BIGINT NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      for (const q of [
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'article'`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'workspace'`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS required_capability TEXT`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS ack_required BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS effective_from DATE`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS author_user_id UUID`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS author_employee_id UUID`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS author_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        sql`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      // NO CHECK CONSTRAINT on kind, audience, status or category, and no foreign keys — the same
      // reasons helpdesk.ts and workflow-schema.ts give: this project has no migration runner, so a
      // CHECK could never be widened to admit a new category; the vocabulary is enforced in
      // TypeScript above; and a foreign key would take an article's history with a deleted row.

      // The slug is the readable URL. UNIQUE so two articles cannot answer to one address; the
      // writers below resolve a collision by appending a counter rather than failing the save.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS kb_articles_slug_idx ON kb_articles (slug)`);
      // The reading surface: published, in a category, newest first.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS kb_articles_read_idx
        ON kb_articles (status, category, updated_at DESC)`);
      // The policy surface: which policies are live and require an acknowledgement.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS kb_articles_policy_idx
        ON kb_articles (kind, status, ack_required)`);

      // ---------------------------------------------------------------------------------------
      // VERSION HISTORY. One row per published version, written BEFORE the article row moves on,
      // so the history is the record of what people actually read — not a diff reconstructed later.
      // ---------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kb_article_versions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id      UUID NOT NULL,
        version         INT NOT NULL,
        title           TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL DEFAULT '',
        body            TEXT NOT NULL DEFAULT '',
        tags            TEXT[] NOT NULL DEFAULT '{}',
        change_note     TEXT NOT NULL DEFAULT '',
        author_user_id  UUID,
        author_name     TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS change_note TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS author_user_id UUID`,
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS author_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS kb_article_versions_key
        ON kb_article_versions (article_id, version)`);

      // ---------------------------------------------------------------------------------------
      // ACKNOWLEDGEMENTS. Keyed by (article, version, user): a new version re-opens the question,
      // which is the whole reason to record it. UNIQUE so a double click cannot write two rows.
      // ---------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS kb_article_acks (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id      UUID NOT NULL,
        version         INT NOT NULL,
        user_id         UUID NOT NULL,
        employee_id     UUID,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE kb_article_acks ADD COLUMN IF NOT EXISTS employee_id UUID`,
        sql`ALTER TABLE kb_article_acks ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS kb_article_acks_key
        ON kb_article_acks (article_id, version, user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS kb_article_acks_user_idx
        ON kb_article_acks (user_id, article_id)`);
    } catch (e: any) {
      logFail('ensureKnowledgeSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE VIEWER. Everything a read is allowed to know about who is asking.
// -------------------------------------------------------------------------------------------------

/**
 * WHO IS READING, reduced to the three facts a query may use.
 *
 * No user object, no email, no role — a reader that cannot reach a role cannot test one. `capabilities`
 * comes from resolvePermissions() (the registry, so a custom role works with no deploy) or from the
 * built-in matrix; `wildcard` is the super_admin '*' the registry hands out, and it is carried
 * separately because a set membership test against '*' would answer false and hide every restricted
 * article from the founder — which is exactly how a console became unreachable on this project once.
 */
export interface KbViewer {
  userId: string | null;
  employeeId: string | null;
  /** Does this person have a workspace here at all? Nothing is readable without one. */
  hasWorkspace: boolean;
  /** Capability keys held, as strings. Filtered to known keys before they reach any SQL. */
  capabilities: readonly string[];
  /** The registry wildcard. True means every restricted article is readable. */
  wildcard: boolean;
  /** May this person write? Asked once, here, so no surface has to remember to. */
  canManage: boolean;
}

/**
 * Build a viewer from a signed-in account plus its resolved permission set.
 *
 * `permissions` is whatever resolvePermissions(user.id).permissions holds — a Set of strings including
 * possibly '*'. Passing the built-in matrix instead is fine; the difference is only that a custom role
 * grant is invisible to the second, which is the same honest limit rolesHolding() documents.
 */
export function makeViewer(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: { permissions?: Iterable<string> | null; employeeId?: string | null; hasWorkspace?: boolean } = {},
): KbViewer {
  const userId = String(user?.id || '').trim() || null;
  const held = new Set<string>(opts.permissions || []);
  const wildcard = held.has('*');
  const capabilities = [...held].filter(
    (k) => typeof k === 'string' && CAPABILITY_RE.test(k) && KNOWN_CAPABILITIES.has(k),
  );
  const employeeId = isUuid(opts.employeeId) ? String(opts.employeeId) : null;
  return {
    userId,
    employeeId,
    // An employee record, OR an admin-capable account. The second arm is not a convenience: an HR
    // account or the founder frequently has no hr_employees row of their own, and gating the handbook
    // on the record alone would hide the company's own policies from the people who write them.
    hasWorkspace:
      opts.hasWorkspace === true || !!employeeId || wildcard || held.has('admin.access'),
    capabilities,
    wildcard,
    canManage: wildcard || holdsCapability(user as any, 'knowledge.manage') || held.has('knowledge.manage'),
  };
}

/**
 * THE VISIBILITY CLAUSE. The only place an article's audience is enforced, and it is enforced in SQL.
 *
 * Returns a fragment that is pasted into every read below. Read the three branches:
 *   - no workspace          -> AND FALSE. Nothing at all, and the surface says so honestly.
 *   - wildcard              -> no restriction. The founder reads the handbook they own.
 *   - anybody else          -> workspace articles, plus restricted ones whose named capability they
 *                             actually hold.
 *
 * THE CAPABILITY LIST IS INLINED AS QUOTED LITERALS, not bound as an array parameter, and every key
 * has already been checked against CAPABILITY_RE and the registry's own key list — so a value that is
 * not a known capability never reaches the SQL at all, and the fragment cannot be anything but a list
 * of lowercase dotted words. An article restricted to a misspelled key is read by nobody, which is
 * the fail-closed direction.
 */
function visibilityClause(viewer: KbViewer) {
  if (!viewer.hasWorkspace) return sql`AND FALSE`;
  if (viewer.wildcard) return sql``;
  const keys = viewer.capabilities.filter((k) => CAPABILITY_RE.test(k) && KNOWN_CAPABILITIES.has(k));
  if (keys.length === 0) return sql`AND a.audience = 'workspace'`;
  const list = sql.raw(keys.map((k) => "'" + k + "'").join(', '));
  return sql`AND (a.audience = 'workspace'
    OR (a.audience = 'restricted' AND a.required_capability IN (${list})))`;
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface KbArticle {
  id: string;
  slug: string;
  kind: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  body: string;
  audience: string;
  requiredCapability: string | null;
  status: string;
  version: number;
  ackRequired: boolean;
  effectiveFrom: string | null;
  authorUserId: string | null;
  authorName: string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface KbVersion {
  version: number;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  changeNote: string;
  authorName: string;
  createdAt: string | null;
}

export interface KbResult {
  ok: boolean;
  id?: string;
  slug?: string;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
  error?: string;
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function dateOnly(v: any): string | null {
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
}

function toTags(v: any): string[] {
  if (Array.isArray(v)) return v.map((t) => String(t)).filter(Boolean).slice(0, MAX_TAGS);
  return [];
}

function mapArticle(r: any): KbArticle {
  return {
    id: String(r?.id ?? ''),
    slug: String(r?.slug ?? ''),
    kind: String(r?.kind ?? 'article'),
    title: String(r?.title ?? ''),
    summary: String(r?.summary ?? ''),
    category: String(r?.category ?? 'general'),
    tags: toTags(r?.tags),
    body: String(r?.body ?? ''),
    audience: String(r?.audience ?? 'workspace'),
    requiredCapability: r?.required_capability ? String(r.required_capability) : null,
    status: String(r?.status ?? 'draft'),
    version: Number(r?.version) || 1,
    ackRequired: r?.ack_required === true,
    effectiveFrom: dateOnly(r?.effective_from),
    authorUserId: r?.author_user_id ? String(r.author_user_id) : null,
    authorName: String(r?.author_name ?? ''),
    publishedAt: iso(r?.published_at),
    createdAt: iso(r?.created_at),
    updatedAt: iso(r?.updated_at),
  };
}

/** The article body as HTML. mdLite, server-side, escape-first. ZERO client JavaScript is shipped. */
export function renderArticleHtml(body: string): string {
  return mdLite(String(body || ''));
}

/** A plain-text opening, for a search result or a suggestion card. Never the whole body. */
export function excerpt(article: KbArticle, max = 180): string {
  const source = article.summary || article.body;
  const flat = String(source || '')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

// -------------------------------------------------------------------------------------------------
// READS. Every one of them takes a viewer, and every one of them pastes the visibility clause.
// -------------------------------------------------------------------------------------------------

const ARTICLE_COLS = sql`a.id, a.slug, a.kind, a.title, a.summary, a.category, a.tags, a.body,
  a.audience, a.required_capability, a.status, a.version, a.ack_required, a.effective_from,
  a.author_user_id, a.author_name, a.published_at, a.created_at, a.updated_at`;

export interface ListArticleOptions {
  category?: string | null;
  kind?: string | null;
  /** Drafts and archived articles. Only ever true for a `knowledge.manage` holder — enforced here. */
  includeUnpublished?: boolean;
  limit?: number;
}

/**
 * The library, newest first.
 *
 * `includeUnpublished` IS RE-CHECKED AGAINST THE VIEWER rather than trusted: a caller that passes it
 * without the capability gets published articles, not an error and not a draft. A draft is somebody
 * mid-sentence about a policy that has not been agreed, and it is not for readers.
 */
export async function listArticles(viewer: KbViewer, opts: ListArticleOptions = {}): Promise<KbArticle[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureKnowledgeSchema();
    const unpublished = opts.includeUnpublished === true && viewer.canManage;
    const byStatus = unpublished ? sql`` : sql`AND a.status = 'published'`;
    const byCategory = isKbCategory(opts.category) ? sql`AND a.category = ${String(opts.category)}` : sql``;
    const byKind = (KB_KINDS as readonly string[]).indexOf(String(opts.kind)) >= 0
      ? sql`AND a.kind = ${String(opts.kind)}` : sql``;
    const r = await db.execute(sql`
      SELECT ${ARTICLE_COLS}
        FROM kb_articles a
       WHERE TRUE ${byStatus} ${byCategory} ${byKind} ${visibilityClause(viewer)}
       ORDER BY (a.status = 'published') DESC, a.updated_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapArticle);
  } catch (e: any) {
    logFail('listArticles', e);
    return [];
  }
}

/**
 * One article, by id or by slug.
 *
 * The visibility clause is in the WHERE, so an article this person may not read comes back null and
 * is indistinguishable from one that does not exist. That is deliberate: a 403 on a restricted
 * article tells you the article exists, which is half of what it was hiding.
 */
export async function getArticle(viewer: KbViewer, idOrSlug: string, opts: { includeUnpublished?: boolean } = {}): Promise<KbArticle | null> {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  try {
    await ensureKnowledgeSchema();
    const unpublished = opts.includeUnpublished === true && viewer.canManage;
    const byStatus = unpublished ? sql`` : sql`AND a.status = 'published'`;
    const byKey = isUuid(key) ? sql`a.id = ${key}::uuid` : sql`a.slug = ${key}`;
    const r = rows(await db.execute(sql`
      SELECT ${ARTICLE_COLS}
        FROM kb_articles a
       WHERE ${byKey} ${byStatus} ${visibilityClause(viewer)}
       LIMIT 1`));
    return r.length ? mapArticle(r[0]) : null;
  } catch (e: any) {
    logFail('getArticle', e);
    return null;
  }
}

/** Escape the two LIKE wildcards so a query of "100%" searches for "100%" and not for everything. */
function likeTerm(q: string): string {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

export interface KbHit {
  article: KbArticle;
  /** Why this matched, in words. A result nobody can explain is a result nobody trusts. */
  why: string;
}

/**
 * SEARCH ACROSS ARTICLES.
 *
 * ILIKE across title, summary, tags and body, ranked title > summary > tag > body. Not a tsvector
 * index, and that is a considered choice rather than an oversight: a GIN index on to_tsvector would
 * be faster at ten thousand articles, and a staff handbook is a few hundred. Adding the index later
 * changes this function and nothing else — no caller learns about it.
 *
 * THE VISIBILITY CLAUSE IS IN THIS QUERY TOO. Search is the classic hole: a snippet from a restricted
 * article in a result list leaks exactly the sentence somebody wanted hidden.
 */
export async function searchArticles(viewer: KbViewer, query: string, limit = 20): Promise<KbHit[]> {
  const q = String(query || '').trim().slice(0, SEARCH_MAX);
  if (q.length < 2) return [];
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  try {
    await ensureKnowledgeSchema();
    const term = likeTerm(q);
    const r = rows(await db.execute(sql`
      SELECT ${ARTICLE_COLS},
             (CASE WHEN a.title ILIKE ${term} THEN 4 ELSE 0 END
            + CASE WHEN a.summary ILIKE ${term} THEN 3 ELSE 0 END
            + CASE WHEN EXISTS (SELECT 1 FROM unnest(a.tags) t WHERE t ILIKE ${term}) THEN 3 ELSE 0 END
            + CASE WHEN a.body ILIKE ${term} THEN 1 ELSE 0 END)::int AS score,
             (a.title ILIKE ${term}) AS hit_title,
             (a.summary ILIKE ${term}) AS hit_summary,
             EXISTS (SELECT 1 FROM unnest(a.tags) t WHERE t ILIKE ${term}) AS hit_tag
        FROM kb_articles a
       WHERE a.status = 'published'
         AND (a.title ILIKE ${term} OR a.summary ILIKE ${term} OR a.body ILIKE ${term}
              OR EXISTS (SELECT 1 FROM unnest(a.tags) t WHERE t ILIKE ${term}))
         ${visibilityClause(viewer)}
       ORDER BY score DESC, a.updated_at DESC
       LIMIT ${cap}`));
    return r.map((row) => ({
      article: mapArticle(row),
      why: row?.hit_title ? 'matched the title'
        : row?.hit_summary ? 'matched the summary'
        : row?.hit_tag ? 'matched a tag'
        : 'matched the text of the article',
    }));
  } catch (e: any) {
    logFail('searchArticles', e);
    return [];
  }
}

export interface SuggestOptions {
  /** The desk the person picked on the raise form. Matched first. */
  category?: string | null;
  /** Whatever they have typed as a subject so far. */
  text?: string | null;
  limit?: number;
}

/**
 * DEFLECTION BEFORE ESCALATION — what is already written down about this.
 *
 * Called from the ticket form, with the category they picked and the subject they typed. Ranked so a
 * category match beats a text match, because "here is everything the IT desk has written" is useful
 * even before they have typed a word.
 *
 * IT SUGGESTS. IT NEVER REFUSES A TICKET. Nothing in this module can stop somebody raising one, and
 * no surface built on it may: a helpdesk that answers a question with a link to an article that does
 * not answer it is how people stop asking for help. The article list sits ABOVE the form, and the
 * form still submits.
 */
export async function suggestArticles(viewer: KbViewer, opts: SuggestOptions = {}): Promise<KbArticle[]> {
  const cap = Math.min(Math.max(Number(opts.limit) || 4, 1), 10);
  const category = isKbCategory(opts.category) ? String(opts.category) : null;
  const text = String(opts.text || '').trim().slice(0, SEARCH_MAX);
  if (!category && text.length < 2) return [];
  try {
    await ensureKnowledgeSchema();
    const term = text.length >= 2 ? likeTerm(text) : null;
    const textScore = term
      ? sql`+ CASE WHEN a.title ILIKE ${term} THEN 3 ELSE 0 END
            + CASE WHEN a.summary ILIKE ${term} THEN 2 ELSE 0 END
            + CASE WHEN a.body ILIKE ${term} THEN 1 ELSE 0 END`
      : sql``;
    const categoryScore = category ? sql`CASE WHEN a.category = ${category} THEN 4 ELSE 0 END` : sql`0`;
    const r = rows(await db.execute(sql`
      SELECT ${ARTICLE_COLS}, (${categoryScore} ${textScore})::int AS score
        FROM kb_articles a
       WHERE a.status = 'published' ${visibilityClause(viewer)}
       ORDER BY score DESC, a.updated_at DESC
       LIMIT ${cap}`));
    // A score of zero means nothing about this article resembled the question. Showing it anyway
    // would be padding the panel with whatever was edited most recently.
    return r.filter((row) => (Number(row?.score) || 0) > 0).map(mapArticle);
  } catch (e: any) {
    logFail('suggestArticles', e);
    return [];
  }
}

/** Every recorded version of one article, newest first. Managers only — it is the editing history. */
export async function articleVersions(viewer: KbViewer, articleId: string): Promise<KbVersion[]> {
  if (!isUuid(articleId) || !viewer.canManage) return [];
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT version, title, summary, body, tags, change_note, author_name, created_at
        FROM kb_article_versions
       WHERE article_id = ${articleId}::uuid
       ORDER BY version DESC
       LIMIT 50`));
    return r.map((row) => ({
      version: Number(row?.version) || 0,
      title: String(row?.title ?? ''),
      summary: String(row?.summary ?? ''),
      body: String(row?.body ?? ''),
      tags: toTags(row?.tags),
      changeNote: String(row?.change_note ?? ''),
      authorName: String(row?.author_name ?? ''),
      createdAt: iso(row?.created_at),
    }));
  } catch (e: any) {
    logFail('articleVersions', e);
    return [];
  }
}

/** How many published articles sit in each category. Used to label the browse tabs honestly. */
export async function categoryCounts(viewer: KbViewer): Promise<{ category: string; count: number }[]> {
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT a.category, COUNT(*)::int AS n
        FROM kb_articles a
       WHERE a.status = 'published' ${visibilityClause(viewer)}
       GROUP BY a.category`));
    return r.map((row) => ({ category: String(row?.category || 'general'), count: Number(row?.n) || 0 }));
  } catch (e: any) {
    logFail('categoryCounts', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES. `knowledge.manage`, asked for and never derived.
// -------------------------------------------------------------------------------------------------

function slugify(title: string): string {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return base || 'article';
}

/** A slug nobody else is using. Collisions are resolved, never reported as a failure to save. */
async function freeSlug(base: string, exceptId: string | null): Promise<string> {
  let candidate = base;
  for (let n = 2; n < 60; n++) {
    const clash = rows(await db.execute(sql`
      SELECT id FROM kb_articles
       WHERE slug = ${candidate} ${exceptId ? sql`AND id <> ${exceptId}::uuid` : sql``}
       LIMIT 1`));
    if (!clash.length) return candidate;
    candidate = base.slice(0, 66) + '-' + n;
  }
  return base + '-' + Date.now();
}

function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',');
  const out: string[] = [];
  for (const t of list) {
    const tag = String(t || '').trim().toLowerCase().slice(0, TAG_MAX);
    if (tag && out.indexOf(tag) < 0) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export interface SaveArticleInput {
  id?: string | null;
  kind?: string;
  title: string;
  summary?: string;
  category?: string;
  tags?: unknown;
  body: string;
  audience?: string;
  requiredCapability?: string | null;
  ackRequired?: boolean;
  effectiveFrom?: string | null;
  changeNote?: string;
  authorName?: string;
  authorEmployeeId?: string | null;
}

/**
 * Create or update an article.
 *
 * FOUR THINGS ARE TRUE BEFORE ANYTHING IS WRITTEN:
 *   1. the actor holds `knowledge.manage` — asked through the capability, never spelled as a role;
 *   2. a restricted article names a capability THE REGISTRY ACTUALLY DEFINES. A typo would make the
 *      article invisible to everybody including its author, which looks like data loss;
 *   3. the title and body are present. An empty article is not a draft, it is a broken link;
 *   4. the slug is free.
 *
 * EVERY UPDATE THAT CHANGES THE TEXT WRITES A VERSION ROW FIRST, holding what the article said
 * BEFORE this edit. That is what makes an acknowledgement meaningful later: the row records what the
 * person actually agreed to, and it cannot be rewritten by editing the article afterwards.
 *
 * NO EXCEPTION IS SWALLOWED. A failure returns { ok: false } with a sentence and logs the real
 * Postgres reason, because a save path that reports success on a failed write is how somebody
 * believes the policy is published and nobody can read it.
 */
export async function saveArticle(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null; name?: string | null } | null | undefined,
  viewer: KbViewer,
  input: SaveArticleInput,
): Promise<KbResult> {
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!viewer.canManage) return { ok: false, error: 'Writing the knowledge base is a knowledge-manager action.' };

  const title = String(input?.title || '').trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, error: 'Give it a title. A title is how anybody finds it again.' };

  const body = String(input?.body || '').trim().slice(0, BODY_MAX);
  if (!body) return { ok: false, error: 'Write the article. A title with nothing under it answers nobody.' };

  const kind = (KB_KINDS as readonly string[]).indexOf(String(input?.kind)) >= 0 ? String(input.kind) : 'article';
  const category = isKbCategory(input?.category) ? String(input.category) : 'general';
  const summary = String(input?.summary || '').trim().slice(0, SUMMARY_MAX);
  const tags = cleanTags(input?.tags);
  const audience = String(input?.audience) === 'restricted' ? 'restricted' : 'workspace';
  const ackRequired = kind === 'policy' && input?.ackRequired === true;
  const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.effectiveFrom || ''))
    ? String(input.effectiveFrom) : null;
  const changeNote = String(input?.changeNote || '').trim().slice(0, 500);
  const authorName = String(input?.authorName || user?.name || '').trim().slice(0, 200);
  const authorEmployeeId = isUuid(input?.authorEmployeeId) ? String(input.authorEmployeeId) : null;

  let requiredCapability: string | null = null;
  if (audience === 'restricted') {
    const key = String(input?.requiredCapability || '').trim();
    if (!key) return { ok: false, error: 'A restricted article has to name the capability that unlocks it.' };
    if (!CAPABILITY_RE.test(key) || !KNOWN_CAPABILITIES.has(key)) {
      return {
        ok: false,
        error: 'There is no capability called "' + key.slice(0, 60) + '". An article restricted to a key '
          + 'nobody holds is an article nobody can read, including you, so it is refused rather than saved.',
      };
    }
    requiredCapability = key;
  }

  const id = isUuid(input?.id) ? String(input.id) : null;

  try {
    await ensureKnowledgeSchema();

    // THE KNOWLEDGE BASE COULD NOT BE WRITTEN TO AT ALL, AND SAID SO IN ONE GENERIC SENTENCE.
    //
    // Every statement in this module that touched `tags` bound a JS array and cast it —
    // `${tags}::text[]` — which is the exact defect src/lib/pg-array.ts was written about. drizzle
    // renders an interpolated array as a ROW CONSTRUCTOR, so the four statements below came out as
    // `()::text[]` with no tags (a syntax error), `($1)::text[]` with one (cannot cast text to
    // text[]) and `($1, $2)::text[]` with more (cannot cast record to text[]). There is no input
    // that made them legal: creating an article, editing one, and the version snapshot taken on
    // publish ALL threw, every time, for everybody. Each sat inside this try/catch, so the author
    // got WRITE_FAILED — "That could not be saved" — with the real reason only in the log, and the
    // library the helpdesk deflects tickets into stayed permanently empty.
    //
    // textArray() sends the list as one ordinary JSON text parameter and lets Postgres unpack it.
    // Do NOT re-add a `::text[]` cast at the call site: the fragment is already text[]-typed.
    if (!id) {
      const slug = await freeSlug(slugify(title), null);
      const ins = rows(await db.execute(sql`
        INSERT INTO kb_articles
          (slug, kind, title, summary, category, tags, body, audience, required_capability,
           status, version, ack_required, effective_from, author_user_id, author_employee_id, author_name)
        VALUES
          (${slug}, ${kind}, ${title}, ${summary}, ${category}, ${textArray(tags)}, ${body}, ${audience},
           ${requiredCapability}::text, 'draft', 1, ${ackRequired}, ${effectiveFrom}::date,
           ${actorId}::uuid, ${authorEmployeeId}::uuid, ${authorName})
        RETURNING id, slug`));
      if (!ins.length) return { ok: false, error: WRITE_FAILED };
      const newId = String(ins[0].id);
      await logAudit({
        userId: actorId, action: 'knowledge.create', entity: 'kb_article', entityId: newId,
        diff: { title, kind, category, audience, requiredCapability, ackRequired },
      });
      return { ok: true, id: newId, slug: String(ins[0].slug), changed: true };
    }

    const existing = rows(await db.execute(sql`
      SELECT id, slug, title, summary, body, tags, version, status FROM kb_articles
       WHERE id = ${id}::uuid LIMIT 1`));
    if (!existing.length) return { ok: false, error: NOT_AVAILABLE };
    const before = existing[0];

    // THE TEXT CHANGED, SO THE OLD TEXT BECOMES HISTORY. Written BEFORE the update, and only when
    // something a reader would notice actually moved — a category change is not a new version of the
    // words. ON CONFLICT DO NOTHING because the version row for this version may already exist from
    // an earlier edit in the same version; the first snapshot of a version is the one that counts.
    const textChanged =
      String(before.title || '') !== title ||
      String(before.summary || '') !== summary ||
      String(before.body || '') !== body;

    if (textChanged) {
      await db.execute(sql`
        INSERT INTO kb_article_versions
          (article_id, version, title, summary, body, tags, change_note, author_user_id, author_name)
        VALUES
          (${id}::uuid, ${Number(before.version) || 1}, ${String(before.title || '')},
           ${String(before.summary || '')}, ${String(before.body || '')},
           ${textArray(toTags(before.tags))}, ${changeNote}, ${actorId}::uuid, ${authorName})
        ON CONFLICT (article_id, version) DO NOTHING`);
    }

    const slug = String(before.title || '') !== title
      ? await freeSlug(slugify(title), id)
      : String(before.slug || slugify(title));

    const wrote = rows(await db.execute(sql`
      UPDATE kb_articles
         SET slug = ${slug}, kind = ${kind}, title = ${title}, summary = ${summary},
             category = ${category}, tags = ${textArray(tags)}, body = ${body},
             audience = ${audience}, required_capability = ${requiredCapability}::text,
             ack_required = ${ackRequired}, effective_from = ${effectiveFrom}::date,
             author_name = ${authorName || String(before.author_name || '')},
             updated_at = NOW()
       WHERE id = ${id}::uuid
      RETURNING id, slug`));
    if (!wrote.length) return { ok: false, error: WRITE_FAILED };

    await logAudit({
      userId: actorId, action: 'knowledge.update', entity: 'kb_article', entityId: id,
      diff: { title, kind, category, audience, requiredCapability, ackRequired, textChanged, changeNote },
    });
    return { ok: true, id, slug: String(wrote[0].slug), changed: true };
  } catch (e: any) {
    logFail('saveArticle', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Publish an article — or publish a NEW VERSION of one that is already published.
 *
 * PUBLISHING A CHANGED POLICY BUMPS THE VERSION, and because acknowledgements are keyed by version
 * that RE-OPENS the acknowledgement for everybody. That is the intended behaviour and it is the whole
 * reason acknowledgements are versioned: a policy nobody re-read after it was rewritten has not been
 * acknowledged, whatever the old rows say.
 *
 * The version is bumped only when the text has moved since the last published version — reviewed with
 * the version snapshot rather than a flag, so pressing Publish twice does not ask four hundred people
 * to read the same words again.
 */
export async function publishArticle(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  viewer: KbViewer,
  articleId: string,
  changeNote = '',
): Promise<KbResult> {
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!viewer.canManage) return { ok: false, error: 'Publishing is a knowledge-manager action.' };
  if (!isUuid(articleId)) return { ok: false, error: NOT_AVAILABLE };

  try {
    await ensureKnowledgeSchema();
    const found = rows(await db.execute(sql`
      SELECT id, status, version, title, summary, body, tags FROM kb_articles
       WHERE id = ${articleId}::uuid LIMIT 1`));
    if (!found.length) return { ok: false, error: NOT_AVAILABLE };
    const a = found[0];
    const version = Number(a.version) || 1;

    // Has the text moved since the last snapshot? No snapshot at all means this is the first
    // publication, which is a version 1 that needs no bump.
    const last = rows(await db.execute(sql`
      SELECT title, summary, body FROM kb_article_versions
       WHERE article_id = ${articleId}::uuid ORDER BY version DESC LIMIT 1`));
    const changed = last.length
      ? (String(last[0].title || '') !== String(a.title || '')
        || String(last[0].summary || '') !== String(a.summary || '')
        || String(last[0].body || '') !== String(a.body || ''))
      : String(a.status) !== 'published';

    const nextVersion = String(a.status) === 'published' && changed ? version + 1 : version;

    if (nextVersion !== version || !last.length) {
      await db.execute(sql`
        INSERT INTO kb_article_versions
          (article_id, version, title, summary, body, tags, change_note, author_user_id, author_name)
        VALUES
          (${articleId}::uuid, ${nextVersion}, ${String(a.title || '')}, ${String(a.summary || '')},
           ${String(a.body || '')}, ${textArray(toTags(a.tags))},
           ${String(changeNote || '').slice(0, 500)}, ${actorId}::uuid, '')
        ON CONFLICT (article_id, version) DO NOTHING`);
    }

    const wrote = rows(await db.execute(sql`
      UPDATE kb_articles
         SET status = 'published', version = ${nextVersion},
             published_at = COALESCE(published_at, NOW()), updated_at = NOW()
       WHERE id = ${articleId}::uuid
         AND status = ${String(a.status)}
      RETURNING id, slug, version`));
    if (!wrote.length) {
      return { ok: false, error: 'That article changed while this page was open. Reload it and try again.' };
    }

    await logAudit({
      userId: actorId, action: 'knowledge.publish', entity: 'kb_article', entityId: articleId,
      diff: { fromStatus: String(a.status), version: nextVersion, reopenedAcknowledgements: nextVersion !== version },
    });
    return { ok: true, id: articleId, slug: String(wrote[0].slug), changed: true };
  } catch (e: any) {
    logFail('publishArticle', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Archive an article. NOT a delete.
 *
 * The row stays, the versions stay, and every acknowledgement stays — because "did we tell people
 * about this, and when" is a question that gets asked about policies that are no longer in force,
 * and deleting the article deletes the answer.
 */
export async function archiveArticle(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  viewer: KbViewer,
  articleId: string,
): Promise<KbResult> {
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!viewer.canManage) return { ok: false, error: 'Archiving is a knowledge-manager action.' };
  if (!isUuid(articleId)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureKnowledgeSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE kb_articles SET status = 'archived', updated_at = NOW()
       WHERE id = ${articleId}::uuid AND status <> 'archived'
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'It is already archived, or it does not exist.' };
    await logAudit({ userId: actorId, action: 'knowledge.archive', entity: 'kb_article', entityId: articleId, diff: {} });
    return { ok: true, id: articleId, changed: true };
  } catch (e: any) {
    logFail('archiveArticle', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// POLICY ACKNOWLEDGEMENT
// -------------------------------------------------------------------------------------------------

export interface PolicyAckState {
  articleId: string;
  version: number;
  /** Has THIS viewer acknowledged THIS version? */
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

/**
 * Record that this person has read this version of this policy.
 *
 * IT IS THEIR OWN ACT AND NOBODY ELSE'S. The user id comes from the SESSION, never from a form field,
 * so there is no shape of request that acknowledges a policy on somebody else's behalf. The article
 * is re-read through getArticle() with the viewer's own visibility clause, so a person cannot
 * acknowledge a policy they were never allowed to read.
 */
export async function acknowledgePolicy(viewer: KbViewer, articleId: string): Promise<KbResult> {
  if (!viewer.userId) return { ok: false, error: 'Sign in to do that.' };
  if (!isUuid(articleId)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureKnowledgeSchema();
    const article = await getArticle(viewer, articleId);
    if (!article) return { ok: false, error: NOT_AVAILABLE };
    if (article.kind !== 'policy') return { ok: false, error: 'That is an article, not a policy. There is nothing to acknowledge.' };

    const wrote = rows(await db.execute(sql`
      INSERT INTO kb_article_acks (article_id, version, user_id, employee_id)
      VALUES (${articleId}::uuid, ${article.version}, ${viewer.userId}::uuid, ${viewer.employeeId}::uuid)
      ON CONFLICT (article_id, version, user_id) DO NOTHING
      RETURNING id`));

    await logAudit({
      userId: viewer.userId, action: 'knowledge.acknowledge', entity: 'kb_article', entityId: articleId,
      diff: { version: article.version, alreadyRecorded: wrote.length === 0 },
    });
    // Not a change is not an error: pressing it twice means the same thing as pressing it once.
    return { ok: true, id: articleId, changed: wrote.length > 0 };
  } catch (e: any) {
    logFail('acknowledgePolicy', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Has this viewer acknowledged the current version of this policy? */
export async function myAckState(viewer: KbViewer, article: KbArticle): Promise<PolicyAckState> {
  const base: PolicyAckState = { articleId: article.id, version: article.version, acknowledged: false, acknowledgedAt: null };
  if (!viewer.userId || article.kind !== 'policy') return base;
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT acknowledged_at FROM kb_article_acks
       WHERE article_id = ${article.id}::uuid AND version = ${article.version}
         AND user_id = ${viewer.userId}::uuid LIMIT 1`));
    if (!r.length) return base;
    return { ...base, acknowledged: true, acknowledgedAt: iso(r[0].acknowledged_at) };
  } catch (e: any) {
    logFail('myAckState', e);
    return base;
  }
}

/** Every published policy this person has not acknowledged at its current version. Their own list. */
export async function outstandingPolicies(viewer: KbViewer): Promise<KbArticle[]> {
  if (!viewer.userId) return [];
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT ${ARTICLE_COLS}
        FROM kb_articles a
       WHERE a.status = 'published' AND a.kind = 'policy' AND a.ack_required = true
         AND NOT EXISTS (
           SELECT 1 FROM kb_article_acks k
            WHERE k.article_id = a.id AND k.version = a.version AND k.user_id = ${viewer.userId}::uuid)
         ${visibilityClause(viewer)}
       ORDER BY a.effective_from DESC NULLS LAST, a.updated_at DESC
       LIMIT 30`));
    return r.map(mapArticle);
  } catch (e: any) {
    logFail('outstandingPolicies', e);
    return [];
  }
}

export interface AckLedgerEntry {
  name: string;
  version: number;
  acknowledgedAt: string | null;
  /** True when the acknowledgement was for an older version than the one in force now. */
  stale: boolean;
}

export interface AckLedger {
  currentVersion: number;
  /** People who have acknowledged. NAMED — see the header: it is an act they performed. */
  entries: AckLedgerEntry[];
  /** How many have acknowledged the CURRENT version. */
  currentCount: number;
  /**
   * How many active employees have not acknowledged the current version. A COUNT AND NEVER A LIST.
   * The number tells whoever owns the policy that a reminder is due; a list of names would be a
   * shame list, and this product does not build one.
   */
  outstandingCount: number;
  /** Active employees, the denominator. Stated so the two numbers can be checked against each other. */
  eligibleCount: number;
  available: boolean;
  note: string | null;
}

/**
 * WHO HAS READ WHICH VERSION OF THIS POLICY.
 *
 * Managers only, and only for a policy. The acknowledged side is named because the record exists to
 * be shown; the unacknowledged side is a count, for the reason written at the top of this file.
 */
export async function ackLedger(viewer: KbViewer, article: KbArticle): Promise<AckLedger> {
  const empty: AckLedger = {
    currentVersion: article.version, entries: [], currentCount: 0, outstandingCount: 0,
    eligibleCount: 0, available: false, note: 'Acknowledgements are only tracked for policies.',
  };
  if (article.kind !== 'policy') return empty;
  if (!viewer.canManage) return { ...empty, note: 'Reading the acknowledgement record is a knowledge-manager action.' };

  try {
    await ensureKnowledgeSchema();
    const acks = rows(await db.execute(sql`
      SELECT k.version, k.acknowledged_at,
             COALESCE(e.full_name, u.name, 'A colleague') AS name
        FROM kb_article_acks k
        LEFT JOIN hr_employees e ON e.id = k.employee_id
        LEFT JOIN users u ON u.id = k.user_id
       WHERE k.article_id = ${article.id}::uuid
       ORDER BY k.acknowledged_at DESC
       LIMIT 500`));

    const entries: AckLedgerEntry[] = acks.map((row) => ({
      name: String(row?.name || 'A colleague'),
      version: Number(row?.version) || 0,
      acknowledgedAt: iso(row?.acknowledged_at),
      stale: (Number(row?.version) || 0) < article.version,
    }));
    const currentCount = entries.filter((x) => !x.stale).length;

    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_employees WHERE is_active = TRUE`));
    const eligibleCount = head.length ? Number(head[0].n) || 0 : 0;

    return {
      currentVersion: article.version,
      entries,
      currentCount,
      outstandingCount: Math.max(0, eligibleCount - currentCount),
      eligibleCount,
      available: true,
      note: null,
    };
  } catch (e: any) {
    logFail('ackLedger', e);
    return { ...empty, note: 'The acknowledgement record could not be read just now.' };
  }
}

/**
 * Acknowledgement coverage across every live policy, as counts.
 *
 * AGGREGATE, and it is what the HR dashboard reads: a policy with 4 of 31 acknowledgements is a
 * process fact about a document, not an observation about a person, and no name leaves this query.
 */
export async function policyCoverage(): Promise<{ title: string; version: number; acknowledged: number }[]> {
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT a.title, a.version,
             (SELECT COUNT(*)::int FROM kb_article_acks k
               WHERE k.article_id = a.id AND k.version = a.version) AS acknowledged
        FROM kb_articles a
       WHERE a.status = 'published' AND a.kind = 'policy' AND a.ack_required = true
       ORDER BY a.updated_at DESC
       LIMIT 20`));
    return r.map((row) => ({
      title: String(row?.title || ''),
      version: Number(row?.version) || 1,
      acknowledged: Number(row?.acknowledged) || 0,
    }));
  } catch (e: any) {
    logFail('policyCoverage', e);
    return [];
  }
}

/** Counts for the admin header. One query, so a phone does not pay for four. */
export async function knowledgeCounts(): Promise<{ published: number; drafts: number; policies: number; restricted: number }> {
  const zero = { published: 0, drafts: 0, policies: 0, restricted: 0 };
  try {
    await ensureKnowledgeSchema();
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE status = 'published')::int AS published,
             COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
             COUNT(*) FILTER (WHERE kind = 'policy' AND status = 'published')::int AS policies,
             COUNT(*) FILTER (WHERE audience = 'restricted')::int AS restricted
        FROM kb_articles`));
    if (!r.length) return zero;
    return {
      published: Number(r[0].published) || 0,
      drafts: Number(r[0].drafts) || 0,
      policies: Number(r[0].policies) || 0,
      restricted: Number(r[0].restricted) || 0,
    };
  } catch (e: any) {
    logFail('knowledgeCounts', e);
    return zero;
  }
}
