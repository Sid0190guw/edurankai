// src/lib/ask/log.ts — WHAT WAS ASKED, WHAT WAS SEARCHED, AND WHETHER ANYTHING ANSWERED IT.
//
// =================================================================================================
// THE ROW THIS TABLE EXISTS FOR
// =================================================================================================
//
// It is the one with cleared_floor = false. A question that nothing in the corpus could answer names
// a policy nobody has written down, and until now the only trace of it was somebody giving up. This
// table turns that into a list that the people who write the handbook can work through.
//
// Everything else here is in service of being ALLOWED to keep that list.
//
// =================================================================================================
// WHAT IS STORED ABOUT THE PERSON, AND WHAT IS NOT
// =================================================================================================
//
// A VISITOR QUESTION IS STORED WITH NO IDENTITY. Not a hashed one, not a session id: the column is
// simply left null. There is nothing to correlate and nothing to subpoena.
//
// A SIGNED-IN QUESTION STORES THE ASKER, for exactly one purpose — myRecentAsks(), which narrows on
// the session's own user id so a person can find the answer they got last Tuesday. Their own history
// is theirs.
//
// AND THE ADMIN READS CANNOT SELECT IT. gapReport() and askVolume() do not name asker_user_id in
// their select lists — it is absent, not filtered out afterwards — and there is no join to `users`
// or to `hr_employees` anywhere in this module. That is deliberate and it is the whole reason the
// capability is grantable at all: "which policies has nobody written" is a question this company
// should be able to answer, and "who has been worrying about their notice period" is not a question
// it should be able to answer about one of its own employees. One of those is a list of gaps and the
// other is a list of people, and the difference between them is which columns the query names.
//
// TWO SHAPES OF QUESTION ARE STORED REDACTED, with the text replaced before it reaches the insert:
// anything the classifier read as being about health or wellness, and anything it read as being
// about another named person. The first is out of bounds to everyone including the founder, and
// writing "when is my next scan" into a table an HR account can read would be this module leaking
// the exact category of data the rest of the codebase is built to protect. The second usually
// contains a colleague's name. The scope class and the intent survive, so the gap report still
// learns that these questions are being asked and how often — which is the useful part.
//
// =================================================================================================
// THE SCHEMA IS VERIFIED, NOT ASSUMED
// =================================================================================================
//
// src/lib/ensure-once.ts ends in p.catch(() => {}) — a DDL failure inside it RESOLVES and the caller
// reports success. Ten module tables have been reported created on this project and none of them
// existed. So this module memoises only a VERIFIED state, and verification is a read of
// information_schema: the database saying what is there, not this file saying what it asked for. A
// state that is not ok is never cached, so the next call tries again. Same shape as
// src/lib/ai-boundary.ts, for the same reason.
//
// DDL IS ADDITIVE. CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS. Nothing here drops
// anything, ever.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import type { AskAnswer, AskSurface, ScopeClass } from './types';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the top, above
// everything that uses it: `const` is not hoisted, and a handler reaching a later declaration has
// taken pages down in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');
const logFail = (tag: string, e: any) => console.error('[ask/log] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const TABLE = 'ask_log';

/** What a redacted question is replaced with. Rendered verbatim on the gap report. */
export const REDACTED_HEALTH = '[withheld: a question about health or wellness]';
export const REDACTED_PERSON = '[withheld: a question naming another person]';

const REQUIRED_COLUMNS = [
  'id', 'asked_at', 'surface', 'scope_class', 'intent', 'question', 'status',
  'cleared_floor', 'degraded', 'production', 'citation_count', 'sources', 'looked', 'asker_user_id',
];

export interface AskLogSchemaState {
  ok: boolean;
  present: boolean;
  missingColumns: string[];
  error: string | null;
  checkedAt: string;
}

let verified: AskLogSchemaState | null = null;
let inflight: Promise<AskLogSchemaState> | null = null;

async function createTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ask_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      surface VARCHAR(16) NOT NULL,
      scope_class VARCHAR(32) NOT NULL,
      intent VARCHAR(48) NOT NULL,
      question TEXT NOT NULL,
      status VARCHAR(16) NOT NULL,
      cleared_floor BOOLEAN NOT NULL DEFAULT FALSE,
      degraded BOOLEAN NOT NULL DEFAULT FALSE,
      production VARCHAR(24) NOT NULL DEFAULT 'templated',
      citation_count INT NOT NULL DEFAULT 0,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      looked JSONB NOT NULL DEFAULT '[]'::jsonb,
      asker_user_id UUID
    )`);
  // Additive, for a table created by an earlier version of this file. Never a DROP.
  for (const col of [
    `status VARCHAR(16) NOT NULL DEFAULT 'unknown'`,
    `degraded BOOLEAN NOT NULL DEFAULT FALSE`,
    `production VARCHAR(24) NOT NULL DEFAULT 'templated'`,
    `citation_count INT NOT NULL DEFAULT 0`,
    `sources JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `looked JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `asker_user_id UUID`,
  ]) {
    try {
      await db.execute(sql.raw('ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS ' + col));
    } catch (e: any) {
      logFail('addColumn ' + col, e);
    }
  }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ask_log_asked_idx ON ask_log (asked_at DESC)`);
  // THE GAP REPORT'S INDEX. The whole point of the table is the unanswered questions, so the query
  // that finds them is the one that gets the index.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ask_log_gap_idx ON ask_log (cleared_floor, asked_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ask_log_asker_idx ON ask_log (asker_user_id, asked_at DESC)`);
}

/**
 * Create the table, then ASK THE DATABASE whether it is there. Only a verified-ok state is cached.
 */
export function ensureAskLogSchema(): Promise<AskLogSchemaState> {
  if (verified?.ok) return Promise.resolve(verified);
  if (inflight) return inflight;
  inflight = (async (): Promise<AskLogSchemaState> => {
    const checkedAt = new Date().toISOString();
    try {
      await createTable();
    } catch (e: any) {
      logFail('createTable', e);
    }
    try {
      const found = rows(await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ask_log'`))
        .map((r) => String(r.column_name));
      const state: AskLogSchemaState = {
        ok: found.length > 0 && REQUIRED_COLUMNS.every((c) => found.indexOf(c) >= 0),
        present: found.length > 0,
        missingColumns: REQUIRED_COLUMNS.filter((c) => found.indexOf(c) < 0),
        error: null,
        checkedAt,
      };
      if (state.ok) verified = state;
      return state;
    } catch (e: any) {
      logFail('verify', e);
      return { ok: false, present: false, missingColumns: REQUIRED_COLUMNS.slice(), error: reasonOf(e), checkedAt };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// -------------------------------------------------------------------------------------------------
// THE WRITE
// -------------------------------------------------------------------------------------------------

export interface RecordAskInput {
  surface: AskSurface;
  question: string;
  answer: AskAnswer;
  /** users.id, and ONLY for a signed-in asker. Never derived from a header, a cookie or an IP. */
  askerUserId?: string | null;
}

export interface RecordAskResult {
  ok: boolean;
  /** Present exactly when ok is false. Already unwrapped from `.cause`. */
  reason: string | null;
}

/**
 * Store one question and what happened to it.
 *
 * THE FAILURE IS RETURNED, NOT SWALLOWED. A log write is not the user's own write — nothing they
 * asked for is lost when it fails — but a silent failure here means the gap report quietly stops
 * being the truth, and the first anybody knows is a handbook that never gets written. The surfaces
 * show a small line when this comes back not-ok rather than pretending it was stored.
 */
export async function recordAsk(input: RecordAskInput): Promise<RecordAskResult> {
  const schema = await ensureAskLogSchema();
  if (!schema.ok) {
    return { ok: false, reason: schema.error || ('the question log is not ready: ' + (schema.missingColumns.join(', ') || 'table missing')) };
  }
  const a = input.answer;

  // REDACTION HAPPENS HERE, BEFORE THE INSERT, not on the way out. A read-side filter is one
  // forgotten WHERE clause away from being no filter at all, and the row would already exist.
  const question =
    a.scopeClass === 'health' ? REDACTED_HEALTH
    : a.scopeClass === 'about-another' ? REDACTED_PERSON
    : String(input.question || '').slice(0, 500);

  // And the asker is dropped with it. A redacted question with a name attached is not redacted.
  const asker =
    a.scopeClass === 'health' || a.scopeClass === 'about-another' ? null
    : (isUuid(input.askerUserId) ? String(input.askerUserId) : null);

  // WHAT GOES INTO `sources`: the SHAPE of what was cited, never the passages. The gap report needs
  // to know that an answer came from two policies and a leave record; it does not need the words,
  // and storing them would put policy text and one person's balances in a second place.
  const sources = a.citations.map((c) => ({ kind: c.kind, title: c.title.slice(0, 160), href: c.href }));
  const looked = a.looked.map((l) => ({ label: l.label, outcome: l.outcome, count: l.count }));

  try {
    await db.execute(sql`
      INSERT INTO ask_log
        (surface, scope_class, intent, question, status, cleared_floor, degraded, production,
         citation_count, sources, looked, asker_user_id)
      VALUES
        (${input.surface}, ${a.scopeClass}, ${a.intent}, ${question}, ${a.status}, ${a.clearedFloor},
         ${a.degraded}, ${a.production}, ${a.citations.length},
         ${JSON.stringify(sources)}::jsonb, ${JSON.stringify(looked)}::jsonb,
         ${asker ? sql`${asker}::uuid` : sql`NULL`})`);
    return { ok: true, reason: null };
  } catch (e: any) {
    logFail('recordAsk', e);
    return { ok: false, reason: reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// THE PERSON'S OWN HISTORY — not gated on any capability, because it is nobody else's business
// -------------------------------------------------------------------------------------------------

export interface MyAsk {
  askedAt: string | null;
  question: string;
  status: string;
  clearedFloor: boolean;
}

export interface MyAsksRead {
  read: 'ok' | 'unreadable' | 'not-configured';
  asks: MyAsk[];
  reason: string | null;
}

/**
 * The signed-in person's own recent questions. Narrowed on their own user id in the WHERE clause.
 *
 * There is no variant of this that takes somebody else's id, and there must never be one: the moment
 * a function here accepts an arbitrary user id, the only thing standing between it and a screen
 * showing what one named employee has been asking is a caller remembering to pass the right one.
 */
export async function myRecentAsks(userId: string, limit = 10): Promise<MyAsksRead> {
  if (!isUuid(userId)) return { read: 'ok', asks: [], reason: null };
  const schema = await ensureAskLogSchema();
  if (!schema.ok) {
    return { read: 'not-configured', asks: [], reason: schema.error || 'the question log has not been created yet' };
  }
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
  try {
    const r = rows(await db.execute(sql`
      SELECT asked_at, question, status, cleared_floor
        FROM ask_log
       WHERE asker_user_id = ${userId}::uuid
       ORDER BY asked_at DESC
       LIMIT ${cap}`));
    return {
      read: 'ok',
      reason: null,
      asks: r.map((x) => ({
        askedAt: x.asked_at ? new Date(x.asked_at).toISOString() : null,
        question: String(x.question || ''),
        status: String(x.status || ''),
        clearedFloor: x.cleared_floor === true,
      })),
    };
  } catch (e: any) {
    logFail('myRecentAsks', e);
    return { read: 'unreadable', asks: [], reason: reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// THE GAP REPORT — gated on `ask.logs.view`, and structurally unable to name anybody
// -------------------------------------------------------------------------------------------------

export interface GapRow {
  question: string;
  surface: string;
  scopeClass: string;
  intent: string;
  /** How many times this exact question has been asked and gone unanswered. */
  times: number;
  lastAskedAt: string | null;
}

export interface AskVolume {
  total: number;
  answered: number;
  unanswered: number;
  refused: number;
  degraded: number;
  modelRephrased: number;
}

export interface GapReport {
  read: 'ok' | 'unreadable' | 'not-configured';
  gaps: GapRow[];
  volume: AskVolume;
  reason: string | null;
  /** The schema check, so the admin screen can say WHICH of the three empty states it is in. */
  schema: AskLogSchemaState;
}

/**
 * THE UNANSWERED QUESTIONS, grouped, most-asked first — and a count of everything else.
 *
 * READ THE SELECT LISTS. Neither query names asker_user_id, and neither joins another table. This is
 * not a convention to be tidied up later: it is the reason this report is allowed to exist. A future
 * edit that adds "and who asked" to either of them turns a list of missing policies into a list of
 * worried people, and it would pass every test in this repository while doing so.
 *
 * `days` bounds the window so the report is about the handbook as it is now, not as it was.
 */
export async function gapReport(opts: { days?: number; limit?: number } = {}): Promise<GapReport> {
  const schema = await ensureAskLogSchema();
  const emptyVolume: AskVolume = { total: 0, answered: 0, unanswered: 0, refused: 0, degraded: 0, modelRephrased: 0 };
  if (!schema.ok) {
    return {
      read: 'not-configured', gaps: [], volume: emptyVolume, schema,
      reason: schema.error || 'the question log has not been created yet, so nothing has been recorded',
    };
  }
  const days = Math.min(Math.max(Number(opts.days) || 90, 1), 365);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  try {
    const g = rows(await db.execute(sql`
      SELECT question, surface, scope_class, intent, COUNT(*)::int AS times, MAX(asked_at) AS last_asked
        FROM ask_log
       WHERE cleared_floor = FALSE
         AND status <> 'refused'
         AND asked_at > NOW() - (${days} * INTERVAL '1 day')
       GROUP BY question, surface, scope_class, intent
       ORDER BY times DESC, MAX(asked_at) DESC
       LIMIT ${limit}`));
    const v = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE cleared_floor = TRUE)::int AS answered,
             COUNT(*) FILTER (WHERE cleared_floor = FALSE AND status <> 'refused')::int AS unanswered,
             COUNT(*) FILTER (WHERE status = 'refused')::int AS refused,
             COUNT(*) FILTER (WHERE degraded = TRUE)::int AS degraded,
             COUNT(*) FILTER (WHERE production = 'model-rephrased')::int AS model_rephrased
        FROM ask_log
       WHERE asked_at > NOW() - (${days} * INTERVAL '1 day')`))[0];
    return {
      read: 'ok',
      reason: null,
      schema,
      gaps: g.map((x) => ({
        question: String(x.question || ''),
        surface: String(x.surface || ''),
        scopeClass: String(x.scope_class || ''),
        intent: String(x.intent || ''),
        times: Number(x.times) || 0,
        lastAskedAt: x.last_asked ? new Date(x.last_asked).toISOString() : null,
      })),
      volume: {
        total: Number(v?.total) || 0,
        answered: Number(v?.answered) || 0,
        unanswered: Number(v?.unanswered) || 0,
        refused: Number(v?.refused) || 0,
        degraded: Number(v?.degraded) || 0,
        modelRephrased: Number(v?.model_rephrased) || 0,
      },
    };
  } catch (e: any) {
    logFail('gapReport', e);
    return { read: 'unreadable', gaps: [], volume: emptyVolume, schema, reason: reasonOf(e) };
  }
}

/** The scope classes, for a legend on the admin screen. Kept beside the writer that produces them. */
export const SCOPE_CLASS_LABELS: Record<ScopeClass, string> = {
  visitor: 'Public visitor',
  'employee-self': 'Employee, about their own record',
  'employee-general': 'Employee, a policy or how-to question',
  'no-workspace': 'Signed in, no employee record',
  'about-another': 'Refused: about another person',
  health: 'Refused: health or wellness',
  action: 'Refused: asked for an action',
};
