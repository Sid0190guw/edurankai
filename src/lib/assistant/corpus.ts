// src/lib/assistant/corpus.ts — WHO IS ASKING, AND WHAT MAY THEREFORE BE RETRIEVED.
//
// =================================================================================================
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// =================================================================================================
//
// AUTHORIZATION SCOPES RETRIEVAL, NOT OUTPUT. The corpus is narrowed by who is asking BEFORE a single
// row is fetched. There is no fetch-then-hide here and no generate-then-redact anywhere downstream:
// a document this person may not read never enters the pipeline, so it cannot be leaked by a
// rendering mistake, a snippet, a JSON response, or a model asked to summarise "everything
// retrieved". The same question from a visitor, an employee, a manager and HR is FOUR DIFFERENT
// RETRIEVALS, resolved server-side, per request, from the caller's own session.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   THE HANDBOOK SEARCH   src/lib/knowledge-base.ts searchArticles(). It already pastes
//                         visibilityClause() into its WHERE. This module CALLS it, and splits the
//                         articles it returned into passages with bestPassages(), which lives in that
//                         same module beside excerpt(). There is no second index over kb_articles and
//                         no second audience model to keep in step with the first.
//   THE RANKER            search-index.ts rankResults(). One pure token-overlap function, already
//                         unit-tested, used for every source here. Nothing invents a second notion of
//                         relevance, and tokenize() stays the single definition of what a word is.
//   THE LEARNER SEARCH    search-index.ts search(), called as-is for the catalogue with
//                         canEnrolled:false — so exam-secure material is unreachable from here by the
//                         same code path that already refuses it everywhere else.
//   THE PEOPLE SCOPE      src/lib/performance-scope.ts resolvePerfViewer(). It resolves the employee
//                         record, the department, whether the org graph is initialized at all, and who
//                         reports to this person — from src/lib/org-graph.ts and never from
//                         users.role. This module does NOT write a fourth scope resolver.
//   THE PUBLIC PREDICATES Copied verbatim from the pages that already serve those rows:
//                         content_pages is_published, training_courses is_published AND access_type
//                         IN ('public','both'), aquin_programs through listProgramsResult(). If a page
//                         would not show it to a stranger, the assistant does not retrieve it.
//
// =================================================================================================
// WHAT IS NOT IN THE CORPUS, EVER
// =================================================================================================
//
// There is NO import of src/lib/wellness.ts in this file or in answer.ts, and there never may be.
// Individual health and cycle data is out of bounds to everybody including the founder, so the
// assistant must not have a PATH to it — not a filtered one, not an aggregate one, not one that
// happens to return nothing today. forbiddenTopic() refuses the SUBJECT before any retrieval runs, so
// such a question is routed to a person rather than to a query that came back empty.
//
// Absent by construction, because they appear nowhere below: helpdesk ticket bodies and request
// messages (another person's problem in their own words), hr_employees PII columns, payroll rows,
// legal-hold records, and ai_training_example (verbatim past conversations).
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is a bug; rowsOf() normalizes.
//   - The real Postgres reason is on e.cause.
//   - Every const is declared above the function that reads it.
//   - `= ANY($jsArray)` is rejected by this driver. Nothing here binds an array.
//   - src/lib/db connects on FIRST USE behind a Proxy, and every db-touching import below is DYNAMIC
//     and inside a function — so importing this module costs nothing and opens nothing.
//   - No DDL. This module creates no table and needs no ensureOnce key; it reads what already exists.
import { rankResults, tokenize, type IndexDoc } from '@/lib/search-index';
import type { KbViewer } from '@/lib/knowledge-base';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — every one above the function that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[assistant/corpus] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Shortest question worth searching. Two letters matches half the handbook and helps nobody. */
export const MIN_QUESTION_CHARS = 3;

/** Longest question acted on. Everything past this is dropped rather than sent to the database. */
const MAX_QUESTION_CHARS = 300;

/** Most tokens ANDed together. A pasted paragraph is not a query. */
const MAX_TOKENS = 8;

/** Candidate rows per source. Small enough that five sources stay quick on a pooled connection. */
const PER_SOURCE_LIMIT = 8;

/** Passages carried out of retrieval, best first. More than this is a reading list, not an answer. */
const MAX_PASSAGES_OUT = 8;

/**
 * THE RELEVANCE FLOOR.
 *
 * Retrieval ALWAYS returns something. A top hit at a poor score is precisely how a system answers a
 * question it did not understand — and it does so in the same confident voice it uses when it is
 * right. So a score here is not a ranking aid, it is a GATE.
 *
 * Scores are normalized against the best a query could possibly do. rankResults() awards 3 per query
 * token found in the title and 1 per token found in the body, so the ceiling is 3 x tokens, and
 * normalizedScore() divides by it. That makes the number mean the same thing for a one-word question
 * and a nine-word one, which a raw score does not.
 *
 * At 0.30:
 *   - every query token found in the body and none in the title scores 0.333 and PASSES. That is a
 *     document whose text discusses the whole question.
 *   - one token of three found in the title scores 0.333 and PASSES. The word "leave" in the title of
 *     a leave policy is a real answer to "how much leave do I get".
 *   - two tokens of three found only in the body scores 0.222 and FAILS. Two words in common with a
 *     document is a coincidence, and this is the case the floor exists for.
 *
 * Moving this number is a product decision, not a tuning knob: lowering it does not produce more
 * answers, it produces more confident wrong ones.
 */
export const RELEVANCE_FLOOR = 0.3;

/**
 * SUBJECTS THIS ASSISTANT REFUSES BEFORE IT RETRIEVES ANYTHING.
 *
 * Not a content filter and not a politeness layer. These are the subjects where the correct behaviour
 * is to have no query at all — so that "we found nothing" can never be mistaken for "there was
 * nothing to find", and so no future filtered read can be justified with "the pipeline already
 * handles it". The wellness system is women-only, gated server-side, aggregate-only on every
 * oversight screen, and deliberately ships no "read any user's log" helper. This is that same rule,
 * expressed one layer earlier.
 */
const FORBIDDEN_TOPICS: readonly { pattern: RegExp; subject: string }[] = [
  {
    pattern: /\b(menstrual|menstruation|period tracker|cycle log|wellness log|wellness record|pms|pregnan\w*|contracepti\w*|gynae\w*|gynaecolog\w*|gynecolog\w*)\b/i,
    subject: 'individual health and wellness records',
  },
  {
    pattern: /\b(legal hold|litigation hold|preservation notice)\b/i,
    subject: 'legal-hold records',
  },
];

/**
 * The named subject a question asks about that has no permitted retrieval, or null.
 *
 * Returns the SUBJECT rather than the matched words, so a refusal can say what it will not look into
 * without repeating the question back at the person.
 */
export function forbiddenTopic(question: string): string | null {
  const q = String(question || '');
  for (const t of FORBIDDEN_TOPICS) if (t.pattern.test(q)) return t.subject;
  return null;
}

// -------------------------------------------------------------------------------------------------
// THE ASKER
// -------------------------------------------------------------------------------------------------

/**
 * Five askers, resolved MOST-PRIVILEGED FIRST, so an HR account that also has direct reports is
 * resolved as HR rather than as a manager.
 *
 * 'visitor' is not only "signed out". A signed-in learner with no employee record is a visitor to the
 * STAFF corpus, and resolving them any other way would mean the handbook gets queried for somebody
 * with no workspace — which knowledge-base.ts would refuse anyway, one layer too late to be the
 * reason it did not happen.
 */
export const ASKER_KINDS = ['visitor', 'employee', 'manager', 'hr', 'admin'] as const;
export type AskerKind = (typeof ASKER_KINDS)[number];

/** Plain words, from a function rather than an exported typed map — every surface here is .astro. */
export function askerKindLabel(kind: string): string {
  if (kind === 'admin') return 'an administrator';
  if (kind === 'hr') return 'the people team';
  if (kind === 'manager') return 'a manager';
  if (kind === 'employee') return 'an employee';
  return 'a visitor';
}

export interface Asker {
  kind: AskerKind;
  userId: string | null;
  /**
   * hr_employees.id, resolved through performance-scope. Null for a visitor, and legitimately null
   * for an admin or founder account with no employee row of its own.
   */
  employeeId: string | null;
  departmentId: string | null;
  /** The composition's own capability test, wrapped so a throw is `false` and never a grant. */
  holds: (key: string) => boolean;
  /** The knowledge-base viewer, or null when the staff handbook is not to be queried at all. */
  kb: KbViewer | null;
  /** Is there anything in the organization graph? Distinct from "this person has nobody". */
  graphInitialized: boolean;
  /** hr_employees.id of this person's direct reports, from the graph. Never from users.role. */
  reportIds: readonly string[];
  /** Holds performance.manage — the whole organization, without a relationship. */
  managesOrg: boolean;
  /** Something that decides scope did not answer. Nothing was widened because of it. */
  degraded: boolean;
  /** Named sources that did not answer, in words. */
  gaps: readonly string[];
  /** One sentence a person can read about what they were resolved as, and what that searches. */
  explanation: string;
}

/** A viewer with no workspace and no user. Every staff source is SKIPPED, not filtered to nothing. */
export function visitorAsker(): Asker {
  return {
    kind: 'visitor',
    userId: null,
    employeeId: null,
    departmentId: null,
    holds: () => false,
    kb: null,
    graphInitialized: false,
    reportIds: [],
    managesOrg: false,
    degraded: false,
    gaps: [],
    explanation: 'You are asking as a visitor, so only published public pages and catalogues are searched.',
  };
}

/**
 * RESOLVE WHO IS ASKING, SERVER-SIDE, FROM THE SESSION.
 *
 * `holds` and `permissions` come from the CALLER'S composition — the same closure
 * /portal/search.astro builds from composeWorkspace(). This function does not compose one itself,
 * because composeWorkspace() caches on Astro.locals for a reason: a workspace resolved anywhere but
 * the request is a workspace that can be handed to the wrong person.
 *
 * A holds() that THROWS answers false. A broken composition is not a grant.
 */
export async function resolveAsker(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: {
    holds?: ((key: string) => boolean) | null;
    permissions?: Iterable<string> | null;
    employeeId?: string | null;
    departmentId?: string | null;
    hasWorkspace?: boolean;
  } = {},
): Promise<Asker> {
  const userId = String(user?.id || '').trim();
  if (!isUuid(userId)) return visitorAsker();

  const holds = (key: string): boolean => {
    try {
      return opts.holds ? opts.holds(key) === true : false;
    } catch {
      return false;
    }
  };

  const gaps: string[] = [];
  let degraded = false;

  // THE PEOPLE SCOPE, from the resolver that already exists. It reads the employee record, the
  // department and the graph, and it fails closed on every one of them.
  let perf: any = null;
  try {
    const { resolvePerfViewer } = await import('@/lib/performance-scope');
    perf = await resolvePerfViewer(userId, holds);
  } catch (e: any) {
    logFail('resolvePerfViewer', e);
    degraded = true;
    gaps.push('the organization graph');
  }

  const employeeId = isUuid(perf?.employeeId)
    ? String(perf.employeeId)
    : (isUuid(opts.employeeId) ? String(opts.employeeId) : null);
  const departmentId = perf?.departmentId
    ? String(perf.departmentId)
    : (opts.departmentId ? String(opts.departmentId) : null);
  const reportIds: string[] = Array.isArray(perf?.reportIds) ? perf.reportIds.filter(isUuid) : [];
  const managesOrg = perf?.managesOrg === true;
  const graphInitialized = perf?.initialized === true;

  const { makeViewer } = await import('@/lib/knowledge-base');
  const kb = makeViewer(user as any, {
    permissions: opts.permissions || null,
    employeeId,
    hasWorkspace: opts.hasWorkspace === true,
  });

  // MOST-PRIVILEGED FIRST. Every arm is a capability or a graph relationship. Not one reads users.role.
  const kind: AskerKind = kb.wildcard || holds('*') || holds('admin.access')
    ? 'admin'
    : holds('employee.manage')
      ? 'hr'
      : (managesOrg || reportIds.length > 0)
        ? 'manager'
        : kb.hasWorkspace
          ? 'employee'
          : 'visitor';

  // A person with no workspace is a visitor to the staff corpus, and the viewer is DROPPED rather
  // than passed along disabled — so the handbook is not searched, rather than searched and filtered
  // to nothing.
  const kbForKind = kind === 'visitor' ? null : kb;

  const explanation = kind === 'visitor'
    ? 'You are signed in but have no workspace here, so only published public pages and catalogues are searched.'
    : 'You are asking as ' + askerKindLabel(kind)
      + ', so the staff handbook is searched too — limited to the articles your capabilities allow.';

  return {
    kind,
    userId,
    employeeId,
    departmentId,
    holds,
    kb: kbForKind,
    graphInitialized,
    reportIds,
    managesOrg,
    degraded,
    gaps,
    explanation,
  };
}

/**
 * MAY THIS PERSON ASK ABOUT THAT PERSON'S RECORD? Resolved PER ROW, from the graph, defaulting to no.
 *
 * Self is always yes. A manager is yes only for the people the GRAPH records as reporting to them.
 * `performance.manage` is the org-wide arm, and it is a capability rather than a job title.
 *
 * AN EMPTY GRAPH IS A REFUSAL, NOT A PASS. org-graph distinguishes "no relationship" from "no graph",
 * and this is where that distinction has to be honoured: answering "they are not your report" out of
 * an uninitialized graph would be a statement about a person made from missing data.
 */
export function mayReadFactsFor(
  asker: Asker,
  subjectEmployeeId: string | null | undefined,
): { ok: boolean; reason: string } {
  const subject = isUuid(subjectEmployeeId) ? String(subjectEmployeeId) : null;
  if (!subject) return { ok: false, reason: 'There is no employee record to read this from.' };
  if (!asker.employeeId) {
    return {
      ok: false,
      reason: 'This account has no employee record attached to it, so there are no personal figures to read.',
    };
  }
  if (subject === asker.employeeId) return { ok: true, reason: 'These are your own records.' };
  if (asker.managesOrg) {
    return { ok: true, reason: 'You hold the capability to manage performance records across the organization.' };
  }
  if (!asker.graphInitialized) {
    return {
      ok: false,
      reason: 'The organization graph has no relationships recorded yet, so no reporting line can be '
        + 'confirmed. This is not a statement that you are not their manager.',
    };
  }
  if (asker.reportIds.indexOf(subject) >= 0) {
    return { ok: true, reason: 'The organization graph records this person as reporting to you.' };
  }
  return {
    ok: false,
    reason: 'That is somebody else’s record, and the organization graph does not record them as reporting to you.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE SOURCES
// -------------------------------------------------------------------------------------------------

export const CORPUS_SOURCES = [
  { key: 'handbook', label: 'the staff handbook and policies', audience: 'staff' },
  { key: 'pages', label: 'published pages on this site', audience: 'everyone' },
  { key: 'courses', label: 'the published course catalogue', audience: 'everyone' },
  { key: 'programmes', label: 'the published programme catalogue', audience: 'everyone' },
  { key: 'catalogue', label: 'the learning catalogue index', audience: 'everyone' },
] as const;

export type CorpusSourceKey = (typeof CORPUS_SOURCES)[number]['key'];

function sourceLabel(key: CorpusSourceKey): string {
  const d = CORPUS_SOURCES.find((s) => s.key === key);
  return d ? d.label : String(key);
}

/**
 * A retrieved piece of TEXT, with everywhere it came from attached.
 *
 * `text` is never empty, and it is always words that exist in the source document. Nothing downstream
 * may put a sentence in an answer that is not derived from one of these.
 */
export interface Passage {
  id: string;
  sourceKey: CorpusSourceKey;
  sourceLabel: string;
  /** What the document is called, including the section within it when there is one. */
  label: string;
  /** The route a reader opens to check it. Every one of these is a route that exists. */
  href: string;
  text: string;
  /** 0..1, normalized so a one-word and a nine-word question mean the same thing. */
  score: number;
  aboveFloor: boolean;
  /** Why this came back, in words. A result nobody can explain is a result nobody trusts. */
  why: string;
}

export interface SearchedSource {
  key: CorpusSourceKey;
  label: string;
  /** False when this source was not searched at all — and `note` says why. */
  searched: boolean;
  hits: number;
  /** A sentence, rendered verbatim. "No results" without saying where it looked is not an answer. */
  note: string | null;
}

export interface Retrieval {
  question: string;
  tokens: readonly string[];
  /** True when the question was too short to run. Not an error. */
  tooShort: boolean;
  /** Best first. Below-floor passages are INCLUDED and flagged, so the caller decides, not the ranker. */
  passages: readonly Passage[];
  /** The top normalized score; 0 when nothing came back at all. */
  best: number;
  searched: readonly SearchedSource[];
  /** True when a source that exists could not be read. Never true for a source deliberately skipped. */
  degraded: boolean;
}

/** The tokens a question actually searches for. tokenize() is search-index's, so there is one vocabulary. */
export function questionTokens(question: string): string[] {
  return [...new Set(tokenize(String(question || '').slice(0, MAX_QUESTION_CHARS)))].slice(0, MAX_TOKENS);
}

/**
 * A raw rankResults() score as a fraction of the best that query could have scored.
 *
 * rankResults awards 3 for a title token and 1 for a body token, so the ceiling is 3 x tokens.
 * Without this, a floor would be a different standard for every question length.
 */
export function normalizedScore(rawScore: number, tokenCount: number): number {
  const ceiling = 3 * Math.max(1, Number(tokenCount) || 1);
  const n = (Number(rawScore) || 0) / ceiling;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** postgres-js safe, dynamic, first-use only. Importing this module opens no connection. */
async function dbctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/**
 * `col ILIKE '%a%' AND col ILIKE '%b%'` over one or more columns, as BOUND PARAMETERS.
 *
 * Every token is a parameter and never interpolated text, so a question containing a quote or a
 * percent sign is matched literally instead of changing the statement. `columns` is a compile-time
 * literal at every call site below and never comes from a request. AND across tokens, OR across
 * columns, which is what somebody typing three words means.
 */
function matchAll(sql: any, columns: readonly string[], tokens: readonly string[]) {
  const perToken = tokens.map((t) => {
    const pattern = '%' + t.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    const perColumn = columns.map((c) => sql`COALESCE(${sql.raw(c)}, '') ILIKE ${pattern}`);
    return sql`(${sql.join(perColumn, sql` OR `)})`;
  });
  return sql.join(perToken, sql` AND `);
}

/** Rank already-fetched rows with the house ranker and wrap each as a cited passage. */
function passagesFromDocs(
  sourceKey: CorpusSourceKey,
  question: string,
  tokens: readonly string[],
  docs: IndexDoc[],
  hrefOf: (doc: IndexDoc) => string,
  why: string,
): Passage[] {
  const ranked = rankResults(question, docs);
  return ranked.map((d) => {
    const score = normalizedScore(d.score, tokens.length);
    return {
      id: sourceKey + ':' + d.id,
      sourceKey,
      sourceLabel: sourceLabel(sourceKey),
      label: d.title,
      href: hrefOf(d),
      text: String(d.body || d.title),
      score,
      aboveFloor: score >= RELEVANCE_FLOOR,
      why,
    };
  });
}

// -------------------------------------------------------------------------------------------------
// SOURCE: THE STAFF HANDBOOK. Staff only, and the audience filter is knowledge-base's own WHERE clause.
// -------------------------------------------------------------------------------------------------

async function handbookSource(
  asker: Asker,
  question: string,
  tokens: readonly string[],
): Promise<{ passages: Passage[]; searched: SearchedSource }> {
  const label = sourceLabel('handbook');
  if (!asker.kb) {
    return {
      passages: [],
      searched: {
        key: 'handbook',
        label,
        searched: false,
        hits: 0,
        note: 'The staff handbook is not searched for a visitor. Sign in with your work account to include it.',
      },
    };
  }
  try {
    const { searchArticles, bestPassages, passageLabel, articleHref } = await import('@/lib/knowledge-base');
    const hits = await searchArticles(asker.kb, question, PER_SOURCE_LIMIT);
    const out: Passage[] = [];
    for (const hit of hits) {
      for (const p of bestPassages(hit.article, question, 2)) {
        const raw = rankResults(question, [
          { id: 'p', type: 'kb-passage', title: p.heading || hit.article.title, body: p.text },
        ]);
        const score = normalizedScore(raw.length ? raw[0].score : 0, tokens.length);
        out.push({
          id: 'handbook:' + p.articleId + ':' + p.ordinal,
          sourceKey: 'handbook',
          sourceLabel: label,
          label: passageLabel(p),
          href: articleHref(p.slug),
          text: p.text,
          score,
          aboveFloor: score >= RELEVANCE_FLOOR,
          why: 'This article ' + hit.why + '.',
        });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return {
      passages: out,
      searched: {
        key: 'handbook',
        label,
        searched: true,
        hits: out.length,
        note: out.length ? null : 'Nothing in the handbook you can read mentions this.',
      },
    };
  } catch (e: any) {
    logFail('handbookSource', e);
    return {
      passages: [],
      searched: {
        key: 'handbook',
        label,
        searched: false,
        hits: 0,
        note: 'The handbook could not be searched just now, so this answer may be incomplete.',
      },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// SOURCE: PUBLISHED PAGES. is_published, exactly as /p/[slug] serves them.
//
// DRAFTS ARE NEVER SEARCHED, for anybody, including a `content.view` holder. search-global.ts includes
// drafts for that capability because its job is to help somebody FIND a page they are editing. This
// assistant's job is to state what the organization has agreed, and a draft is somebody mid-sentence
// about a policy that has not been agreed to.
// -------------------------------------------------------------------------------------------------

async function pageSource(
  question: string,
  tokens: readonly string[],
): Promise<{ passages: Passage[]; searched: SearchedSource }> {
  const label = sourceLabel('pages');
  try {
    const { db, sql } = await dbctx();
    const r = await db.execute(sql`
      SELECT slug, title, COALESCE(meta_description, '') AS meta_description, COALESCE(body, '') AS body
        FROM content_pages
       WHERE is_published = TRUE
         AND ${matchAll(sql, ['title', 'slug', 'meta_description', 'body'], tokens)}
       ORDER BY updated_at DESC
       LIMIT ${PER_SOURCE_LIMIT}`);
    const docs: IndexDoc[] = rowsOf(r).map((row: any) => ({
      id: String(row?.slug || ''),
      type: 'page',
      title: String(row?.title || row?.slug || 'Page'),
      body: (String(row?.meta_description || '') + ' ' + String(row?.body || '').slice(0, 4000)).trim(),
    }));
    const passages = passagesFromDocs(
      'pages',
      question,
      tokens,
      docs,
      (d) => '/p/' + encodeURIComponent(String(d.id)),
      'This is a published page on this site.',
    );
    return {
      passages,
      searched: {
        key: 'pages',
        label,
        searched: true,
        hits: passages.length,
        note: passages.length ? null : 'No published page mentions this.',
      },
    };
  } catch (e: any) {
    logFail('pageSource', e);
    return {
      passages: [],
      searched: { key: 'pages', label, searched: false, hits: 0, note: 'Published pages could not be searched just now.' },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// SOURCE: THE COURSE CATALOGUE. The predicate is copied verbatim from /aquintutor/courses — if that
// page would not show it to a stranger, this does not retrieve it.
//
// NO PRICE COLUMN IS SELECTED AND NO FEE IS RETURNED. A fee comes from src/lib/fee-engine.ts or it is
// not stated, and a catalogue row's stored price is not a fee schedule. Leaving the column out of the
// SELECT is the version of that rule that cannot be forgotten later.
// -------------------------------------------------------------------------------------------------

async function courseSource(
  question: string,
  tokens: readonly string[],
): Promise<{ passages: Passage[]; searched: SearchedSource }> {
  const label = sourceLabel('courses');
  try {
    const { db, sql } = await dbctx();
    const r = await db.execute(sql`
      SELECT c.slug, c.title, COALESCE(c.subtitle, '') AS subtitle, COALESCE(c.short_desc, '') AS short_desc,
             COALESCE(c.level, '') AS level, COALESCE(c.category, '') AS category
        FROM training_courses c
       WHERE c.is_published = TRUE AND c.access_type IN ('public', 'both')
         AND ${matchAll(sql, ['c.title', 'c.subtitle', 'c.short_desc', 'c.category'], tokens)}
       ORDER BY c.created_at DESC
       LIMIT ${PER_SOURCE_LIMIT}`);
    const docs: IndexDoc[] = rowsOf(r).map((row: any) => ({
      id: String(row?.slug || ''),
      type: 'course',
      title: String(row?.title || 'Course'),
      body: [row?.subtitle, row?.short_desc, row?.level, row?.category].filter(Boolean).join('. '),
    }));
    const passages = passagesFromDocs(
      'courses',
      question,
      tokens,
      docs,
      (d) => '/aquintutor/courses/' + encodeURIComponent(String(d.id)),
      'This course is published and open to anyone.',
    );
    return {
      passages,
      searched: {
        key: 'courses',
        label,
        searched: true,
        hits: passages.length,
        note: passages.length ? null : 'No published course matches this.',
      },
    };
  } catch (e: any) {
    logFail('courseSource', e);
    return {
      passages: [],
      searched: { key: 'courses', label, searched: false, hits: 0, note: 'The course catalogue could not be searched just now.' },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// SOURCE: THE PROGRAMME CATALOGUE. listProgramsResult() keeps "could not read" apart from "none", so
// a failed read is never rendered as "we publish no programmes".
// -------------------------------------------------------------------------------------------------

async function programmeSource(
  question: string,
  tokens: readonly string[],
): Promise<{ passages: Passage[]; searched: SearchedSource }> {
  const label = sourceLabel('programmes');
  try {
    const { listProgramsResult } = await import('@/lib/aquin-programs');
    const res = await listProgramsResult();
    if (!res.ok) {
      return {
        passages: [],
        searched: {
          key: 'programmes',
          label,
          searched: false,
          hits: 0,
          note: 'The programme catalogue could not be read just now, so nothing here is a statement that a programme does not exist.',
        },
      };
    }
    const docs: IndexDoc[] = res.programs.map((p) => ({
      id: p.slug,
      type: 'programme',
      title: p.name,
      body: [p.level, p.discipline, p.regulatoryNote].filter(Boolean).join('. '),
    }));
    const passages = passagesFromDocs(
      'programmes',
      question,
      tokens,
      docs,
      (d) => '/aquintutor/programs/' + encodeURIComponent(String(d.id)),
      'This programme is published in the catalogue.',
    );
    return {
      passages,
      searched: {
        key: 'programmes',
        label,
        searched: true,
        hits: passages.length,
        note: passages.length ? null : 'No published programme matches this.',
      },
    };
  } catch (e: any) {
    logFail('programmeSource', e);
    return {
      passages: [],
      searched: { key: 'programmes', label, searched: false, hits: 0, note: 'The programme catalogue could not be searched just now.' },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// SOURCE: THE LEARNING CATALOGUE INDEX. search-index.ts, called as-is.
//
// canEnrolled is FALSE for every asker here. Enrolment is not resolved by this module, and the
// fail-closed direction is to search only what is discoverable to anyone. exam-secure material is
// unreachable through this call by construction, in isDiscoverable() and again in the SQL.
// -------------------------------------------------------------------------------------------------

async function catalogueSource(
  question: string,
  tokens: readonly string[],
): Promise<{ passages: Passage[]; searched: SearchedSource }> {
  const label = sourceLabel('catalogue');
  try {
    const { search } = await import('@/lib/search-index');
    const found = await search(question, {}, { canEnrolled: false }, PER_SOURCE_LIMIT);
    const passages: Passage[] = found.map((d) => {
      const score = normalizedScore(d.score, tokens.length);
      return {
        id: 'catalogue:' + d.id,
        sourceKey: 'catalogue' as CorpusSourceKey,
        sourceLabel: label,
        label: d.title,
        href: '/aquintutor/lesson/' + encodeURIComponent(String(d.id)),
        text: String(d.body || d.title),
        score,
        aboveFloor: score >= RELEVANCE_FLOOR,
        why: 'This is published learning material in the catalogue index.',
      };
    });
    return {
      passages,
      searched: {
        key: 'catalogue',
        label,
        searched: true,
        hits: passages.length,
        note: passages.length ? null : 'Nothing in the learning catalogue matches this.',
      },
    };
  } catch (e: any) {
    logFail('catalogueSource', e);
    return {
      passages: [],
      searched: { key: 'catalogue', label, searched: false, hits: 0, note: 'The learning catalogue could not be searched just now.' },
    };
  }
}

// -------------------------------------------------------------------------------------------------
// RETRIEVE
// -------------------------------------------------------------------------------------------------

/**
 * BUILD THE CORPUS FOR THIS ASKER AND SEARCH IT.
 *
 * Sources run in SEQUENCE rather than in parallel, on purpose: this deployment runs on a transaction
 * pooler, and five simultaneous statements from one request is how a connection pool starts refusing
 * other people's page loads.
 *
 * A FORBIDDEN SUBJECT TOUCHES NO SOURCE AT ALL, and every source says so by name. That is the
 * difference between "we will not look" and "we looked and found nothing", and the two must never
 * read the same to the person who asked.
 */
export async function retrieve(asker: Asker, question: string): Promise<Retrieval> {
  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  const tokens = questionTokens(q);

  const banned = forbiddenTopic(q);
  if (banned) {
    return {
      question: q,
      tokens: [],
      tooShort: false,
      passages: [],
      best: 0,
      searched: CORPUS_SOURCES.map((s) => ({
        key: s.key,
        label: s.label,
        searched: false,
        hits: 0,
        note: 'Nothing was searched. This assistant has no route to ' + banned + ', for anyone.',
      })),
      degraded: false,
    };
  }

  if (q.length < MIN_QUESTION_CHARS || tokens.length === 0) {
    return { question: q, tokens: [], tooShort: true, passages: [], best: 0, searched: [], degraded: false };
  }

  const results = [
    await handbookSource(asker, q, tokens),
    await pageSource(q, tokens),
    await courseSource(q, tokens),
    await programmeSource(q, tokens),
    await catalogueSource(q, tokens),
  ];

  const passages = results
    .flatMap((r) => r.passages)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PASSAGES_OUT);

  const searched = results.map((r) => r.searched);

  // A source deliberately SKIPPED — the handbook, for a visitor — is not a degraded read. Only a
  // source that exists and could not be read counts, so an answer does not permanently warn about a
  // decision the pipeline made on purpose.
  const skippedByDesign = (s: SearchedSource): boolean => s.key === 'handbook' && asker.kind === 'visitor';
  const degraded = asker.degraded || searched.some((s) => !s.searched && !skippedByDesign(s));

  return {
    question: q,
    tokens,
    tooShort: false,
    passages,
    best: passages.length ? passages[0].score : 0,
    searched,
    degraded,
  };
}
