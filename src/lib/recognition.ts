// src/lib/recognition.ts — PEER RECOGNITION. One person thanks another for something specific.
//
// =================================================================================================
// NOT src/lib/recognition-event.ts
// =================================================================================================
//
// That file is the live-classroom CAPTURE CONTRACT — speech, ink, gesture and equation events on
// their way from a browser to the board compiler. It has nothing to do with this, shares no table
// and no type, and the only thing the two have in common is an English word. Neither imports the
// other. If you are looking for the board, it is over there.
//
// =================================================================================================
// WHAT THIS IS, AND THE TWO THINGS IT REFUSES TO BE
// =================================================================================================
//
// IT IS PEER-TO-PEER, NOT A MANAGER'S PRIVILEGE. There is no capability required to send one, no
// relationship tested, and NO CHECK ANYWHERE that the sender is senior to the recipient — because
// recognition that only flows downward is not recognition, it is performance feedback with a nicer
// name. An intern may thank the founder. The only rule about who may send is that a person cannot
// send one to themselves, and that is enforced in the write.
//
// IT IS NOT A LEADERBOARD. src/lib/announcements.ts is where the company's notices live; this is
// where its thank-yous do, and there is deliberately NO query in this file that ranks people. HR
// sees AGGREGATES — how many, in which month, under which tag, across which departments, suppressed
// below the platform minimum group size — because "is this being used at all" is a real question an
// aggregate answers. "Who got the fewest" is not a question this product will answer, so the
// function that would answer it does not exist. A ranking is one ORDER BY away from being a public
// list of the people nobody thanked, and that is a thing done TO somebody.
//
// =================================================================================================
// WHO SEES ONE IS A WHERE CLAUSE
// =================================================================================================
//
// The sender chooses `team` or `company` at the moment of writing:
//
//   team      the sender's department and the recipient's department, plus the two of them.
//   company   everybody with a workspace.
//
// visibilityClause() builds that into the SQL of every read. A recognition this person may not see
// is NEVER FETCHED. THE ADMIN OVERVIEW IS NOT AN EXCEPTION AND HAS NO BACK DOOR: it shows counts,
// and the only messages it lists are the ones the sender already made company-wide. A moderator
// acting on a team-scoped one does it from the feed where they can see it, like everybody else —
// giving the moderation screen a wider read than the sender granted would quietly turn "visible to
// my team" into "visible to my team and to HR", which is not what the sender was told.
//
// =================================================================================================
// WHAT THIS MODULE CONSUMES AND DOES NOT REBUILD
// =================================================================================================
//
//   FeedViewer      src/lib/announcements.ts. ONE viewer for the whole company feed — one employee
//                   lookup, one department fact, one project list, one capability answer. A second
//                   copy here would be a second thing to keep in step.
//   SUPPRESSION     suppressBands()/MIN_GROUP from src/lib/analytics-workforce.ts, which takes them
//                   from src/lib/wellness.ts where this platform's minimum group size is defined.
//                   No second floor, no second rule, no second opinion about when a count stops
//                   being a statistic and starts being a description of somebody.
//   AUDIT           logAudit(). NOTIFICATIONS notifyUser(). No second log and no second notifier.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { holdsCapability } from '@/lib/auth/capability';
import { suppressBands, MIN_GROUP, TOO_FEW_LABEL, type Band } from '@/lib/analytics-workforce';
import type { FeedViewer, WriteResult } from '@/lib/announcements';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — declared ABOVE everything that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never an object with `rows`. `r.rows[0]` is always a bug. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[recognition] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED =
  'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const NOT_AVAILABLE = 'That recognition is not available.';

const MESSAGE_MIN = 12;
const MESSAGE_MAX = 1200;
const REASON_MAX = 300;
const SEARCH_MAX = 80;

/** Rolling window for the "is this being used" figures. Ninety days, stated once. */
const WINDOW_DAYS = 90;

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * OPTIONAL, and short on purpose.
 *
 * A long list of corporate virtues turns a thank-you into a form, and the specific sentence is the
 * part that matters — which is why the message is required and the tag is not. 'none' is a real
 * choice and the default.
 */
export const RECOGNITION_TAGS = [
  'none',
  'helped_me_out',
  'quality_of_work',
  'went_the_extra_mile',
  'teamwork',
  'initiative',
  'mentoring',
  'steady_under_pressure',
  'care_for_people',
] as const;
export type RecognitionTag = (typeof RECOGNITION_TAGS)[number];

const TAG_SET = new Set<string>(RECOGNITION_TAGS);
export function isRecognitionTag(v: unknown): v is RecognitionTag {
  return typeof v === 'string' && TAG_SET.has(v);
}

/** Plain words from a FUNCTION — a typed map read inside .astro JSX is a known parse hazard here. */
export function recognitionTagLabel(tag: string): string {
  const t = String(tag || '');
  if (t === 'helped_me_out') return 'Helped me out';
  if (t === 'quality_of_work') return 'Quality of work';
  if (t === 'went_the_extra_mile') return 'Went the extra mile';
  if (t === 'teamwork') return 'Teamwork';
  if (t === 'initiative') return 'Initiative';
  if (t === 'mentoring') return 'Mentoring';
  if (t === 'steady_under_pressure') return 'Steady under pressure';
  if (t === 'care_for_people') return 'Care for people';
  return 'No tag';
}

export const RECOGNITION_VISIBILITIES = ['team', 'company'] as const;
export type RecognitionVisibility = (typeof RECOGNITION_VISIBILITIES)[number];

export function isRecognitionVisibility(v: unknown): v is RecognitionVisibility {
  return v === 'team' || v === 'company';
}

export function visibilityLabel(v: string): string {
  return String(v || '') === 'company' ? 'Everyone in the company' : 'Our teams only';
}

export const RECOGNITION_STATUSES = ['visible', 'withdrawn', 'removed'] as const;

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, asserted column by column, inside ONE ensureOnce guard.
// -------------------------------------------------------------------------------------------------

/**
 * THERE IS EXACTLY ONE DEFINITION OF `recognitions`, AND IT IS HERE.
 *
 * Grepped before it was written: the only near-miss in this codebase is `cr_recognitions` in
 * src/lib/credential-store.ts, which records that one INSTITUTION recognises another's credentials.
 * Different domain, different columns, different name — nothing here touches it.
 *
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS, so
 * every column past the primary key is asserted again with ADD COLUMN IF NOT EXISTS.
 *
 * The catch RE-THROWS after logging the real cause, because ensureOnce() drops a rejected promise
 * from its cache and retries next call — swallowing here would cache a half-built schema instead.
 */
export function ensureRecognitionSchema(): Promise<void> {
  return ensureOnce('recognition_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS recognitions (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user_id         UUID,
        from_employee_id     UUID,
        from_name            TEXT NOT NULL DEFAULT '',
        from_department_id   TEXT,
        to_employee_id       UUID NOT NULL,
        to_user_id           UUID,
        to_name              TEXT NOT NULL DEFAULT '',
        to_department_id     TEXT,
        message              TEXT NOT NULL DEFAULT '',
        tag                  TEXT NOT NULL DEFAULT 'none',
        visibility           TEXT NOT NULL DEFAULT 'team',
        status               TEXT NOT NULL DEFAULT 'visible',
        removed_by_user_id   UUID,
        removed_reason       TEXT NOT NULL DEFAULT '',
        removed_at           TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      for (const q of [
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS from_user_id UUID`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS from_employee_id UUID`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS from_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS from_department_id TEXT`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS to_user_id UUID`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS to_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS to_department_id TEXT`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS tag TEXT NOT NULL DEFAULT 'none'`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team'`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'visible'`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS removed_by_user_id UUID`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS removed_reason TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`,
        sql`ALTER TABLE recognitions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      // NO CHECK CONSTRAINT and no foreign keys, for the reasons every other module here states: no
      // migration runner means a CHECK can never be widened, the vocabulary is enforced in
      // TypeScript above, and a foreign key would take a thank-you with a deleted employee row.

      await db.execute(sql`CREATE INDEX IF NOT EXISTS recognitions_feed_idx
        ON recognitions (status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS recognitions_to_idx
        ON recognitions (to_employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS recognitions_from_idx
        ON recognitions (from_employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS recognitions_scope_idx
        ON recognitions (visibility, status, created_at DESC)`);
    } catch (e: any) {
      logFail('ensureRecognitionSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface Recognition {
  id: string;
  fromUserId: string | null;
  fromEmployeeId: string | null;
  fromName: string;
  toEmployeeId: string;
  toUserId: string | null;
  toName: string;
  message: string;
  tag: string;
  visibility: string;
  status: string;
  createdAt: string | null;
  /** True when the signed-in reader wrote it — the only person who may withdraw it. */
  mine?: boolean;
}

function mapRecognition(row: any): Recognition {
  return {
    id: String(row?.id || ''),
    fromUserId: row?.from_user_id ? String(row.from_user_id) : null,
    fromEmployeeId: row?.from_employee_id ? String(row.from_employee_id) : null,
    fromName: String(row?.from_name || 'A colleague'),
    toEmployeeId: String(row?.to_employee_id || ''),
    toUserId: row?.to_user_id ? String(row.to_user_id) : null,
    toName: String(row?.to_name || 'A colleague'),
    message: String(row?.message || ''),
    tag: String(row?.tag || 'none'),
    visibility: String(row?.visibility || 'team'),
    status: String(row?.status || 'visible'),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    mine: row?.mine === true ? true : row?.mine === false ? false : undefined,
  };
}

/**
 * THE VISIBILITY CLAUSE, against a table aliased `r`. The only place a recognition's audience is
 * enforced, and it is enforced in SQL.
 *
 * `team` means the sender's department OR the recipient's department — both, because a thank-you
 * that crosses two teams belongs to both of them, and showing it to only one half would hide from a
 * person's own colleagues that they were thanked.
 */
function visibilityClause(viewer: FeedViewer) {
  if (!viewer.hasWorkspace) return sql`AND FALSE`;
  return sql`AND r.status = 'visible' AND (
    r.visibility = 'company'
    OR (${viewer.departmentId}::text IS NOT NULL
        AND (r.from_department_id = ${viewer.departmentId}::text
             OR r.to_department_id = ${viewer.departmentId}::text))
    OR (${viewer.employeeId}::text IS NOT NULL
        AND (r.from_employee_id::text = ${viewer.employeeId}::text
             OR r.to_employee_id::text = ${viewer.employeeId}::text))
  )`;
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface RecognitionListOptions {
  limit?: number;
  /** Only what this person received. Their own record, always visible to them. */
  toEmployeeId?: string | null;
  tag?: string | null;
}

/** The feed's recognitions, newest first, scoped in the query to what this reader may see. */
export async function listRecognition(
  viewer: FeedViewer,
  opts: RecognitionListOptions = {},
): Promise<Recognition[]> {
  if (!viewer.hasWorkspace) return [];
  const limit = Math.min(Math.max(Number(opts.limit || 40), 1), 150);
  try {
    await ensureRecognitionSchema();
    const toPart = opts.toEmployeeId && isUuid(opts.toEmployeeId)
      ? sql`AND r.to_employee_id = ${opts.toEmployeeId}::uuid`
      : sql``;
    const tagPart = opts.tag && isRecognitionTag(opts.tag) && opts.tag !== 'none'
      ? sql`AND r.tag = ${opts.tag}`
      : sql``;
    return rows(await db.execute(sql`
      SELECT r.*,
             (${viewer.userId}::text IS NOT NULL AND r.from_user_id::text = ${viewer.userId}::text) AS mine
        FROM recognitions r
       WHERE 1=1
         ${visibilityClause(viewer)}
         ${toPart}
         ${tagPart}
       ORDER BY r.created_at DESC
       LIMIT ${limit}`)).map(mapRecognition);
  } catch (e: any) {
    logFail('listRecognition', e);
    return [];
  }
}

export interface MyRecognition {
  received: number;
  sent: number;
}

/** This person's own two numbers. Their own record — no capability, no ranking, no comparison. */
export async function myRecognitionCounts(viewer: FeedViewer): Promise<MyRecognition> {
  if (!viewer.employeeId) return { received: 0, sent: 0 };
  try {
    await ensureRecognitionSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE to_employee_id = ${viewer.employeeId}::uuid AND status = 'visible')::int AS received,
        COUNT(*) FILTER (WHERE from_employee_id = ${viewer.employeeId}::uuid AND status = 'visible')::int AS sent
      FROM recognitions`));
    return { received: Number(r[0]?.received || 0), sent: Number(r[0]?.sent || 0) };
  } catch (e: any) {
    logFail('myRecognitionCounts', e);
    return { received: 0, sent: 0 };
  }
}

export interface ColleagueOption {
  employeeId: string;
  name: string;
  designation: string | null;
  departmentName: string | null;
}

/**
 * WHO CAN BE THANKED: any active colleague except yourself.
 *
 * No department filter, no seniority filter, no relationship test. The whole point of peer
 * recognition is that it crosses the lines an org chart draws, so this list deliberately does not
 * consult the Organization Graph at all — the graph answers who is RESPONSIBLE for whom, and being
 * grateful to somebody is not a responsibility question.
 *
 * The search is a name prefix over active employees. It returns names and designations, which are
 * the ordinary directory facts every employee surface already shows; it returns no contact detail,
 * no salary, no date of birth and no personal address.
 */
export async function searchColleagues(viewer: FeedViewer, q: string, limit = 20): Promise<ColleagueOption[]> {
  if (!viewer.hasWorkspace) return [];
  const term = String(q || '').trim().slice(0, SEARCH_MAX);
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  try {
    const pattern = '%' + term.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    const selfPart = viewer.employeeId
      ? sql`AND e.id <> ${viewer.employeeId}::uuid`
      : sql``;
    const searchPart = term
      ? sql`AND e.full_name ILIKE ${pattern}`
      : sql``;
    return rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name AS name, e.designation AS designation,
             d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = true
         ${selfPart}
         ${searchPart}
       ORDER BY e.full_name ASC
       LIMIT ${n}`)).map((r) => ({
      employeeId: String(r.id),
      name: String(r.name || ''),
      designation: r.designation ? String(r.designation) : null,
      departmentName: r.department_name ? String(r.department_name) : null,
    }));
  } catch (e: any) {
    logFail('searchColleagues', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface RecognitionInput {
  toEmployeeId: string;
  message: string;
  tag?: string;
  visibility?: string;
}

/**
 * SEND ONE.
 *
 * NO CAPABILITY IS REQUIRED AND NONE IS CHECKED. Having a workspace and an employee record is the
 * whole test, because gating a thank-you on a permission would make it a management instrument. The
 * three real rules are enforced here and nowhere else:
 *
 *   1. NOT TO YOURSELF. Compared on employee id, server side, against the SESSION viewer — a posted
 *      id cannot get round it.
 *   2. SOMETHING SPECIFIC. A message under MESSAGE_MIN characters is refused, because "thanks!" with
 *      a name attached is a click, not recognition, and a feed of those is worth nothing to read.
 *   3. THE RECIPIENT MUST BE A REAL ACTIVE COLLEAGUE, re-read from hr_employees at write time. The
 *      name and department stored on the row are read from THAT lookup, never from the form.
 */
export async function sendRecognition(viewer: FeedViewer, input: RecognitionInput): Promise<WriteResult> {
  if (!viewer.hasWorkspace || !viewer.userId) {
    return { ok: false, error: 'You need to be signed in to thank somebody.' };
  }
  if (!viewer.employeeId) {
    return {
      ok: false,
      error:
        'Recognition is between colleagues on the employee record, and there is no employee record ' +
        'linked to this account yet. Nothing was sent.',
    };
  }

  const toId = String(input.toEmployeeId || '').trim();
  if (!isUuid(toId)) return { ok: false, error: 'Pick the colleague you want to thank.' };
  if (toId === viewer.employeeId) {
    return {
      ok: false,
      error: 'Recognition goes to somebody else. You cannot send one to yourself.',
    };
  }

  const message = String(input.message || '').trim().slice(0, MESSAGE_MAX);
  if (message.length < MESSAGE_MIN) {
    return {
      ok: false,
      error:
        'Say what they actually did — a sentence is enough. A bare "thanks" tells the person nothing ' +
        'and tells their colleagues less.',
    };
  }

  const tag = isRecognitionTag(input.tag) ? String(input.tag) : 'none';
  const visibility = isRecognitionVisibility(input.visibility) ? String(input.visibility) : 'team';

  try {
    await ensureRecognitionSchema();
    const target = rows(await db.execute(sql`
      SELECT id::text AS id, full_name, user_id::text AS user_id, department_id::text AS department_id
        FROM hr_employees
       WHERE id = ${toId}::uuid AND is_active = true
       LIMIT 1`))[0];
    if (!target) return { ok: false, error: 'That colleague is not on the active employee list.' };

    const r = rows(await db.execute(sql`
      INSERT INTO recognitions
        (from_user_id, from_employee_id, from_name, from_department_id,
         to_employee_id, to_user_id, to_name, to_department_id,
         message, tag, visibility, status)
      VALUES
        (${viewer.userId}::uuid, ${viewer.employeeId}::uuid, ${viewer.fullName}, ${viewer.departmentId},
         ${toId}::uuid, ${target.user_id}::uuid, ${String(target.full_name || '')},
         ${target.department_id ? String(target.department_id) : null},
         ${message}, ${tag}, ${visibility}, 'visible')
      RETURNING id`));
    const id = r[0]?.id ? String(r[0].id) : '';
    if (!id) return { ok: false, error: WRITE_FAILED };

    await logAudit({
      userId: viewer.userId,
      action: 'recognition.send',
      entity: 'recognition',
      entityId: id,
      diff: { toEmployeeId: toId, tag, visibility },
    });

    // The one notification this module sends, and it goes to ONE person: the person being thanked.
    // Nothing here notifies a manager, and nothing copies it to HR — a thank-you that arrives in
    // somebody's manager's inbox is a performance note, not a thank-you.
    if (target.user_id) {
      await notifyUser(String(target.user_id), {
        title: viewer.fullName ? viewer.fullName + ' thanked you' : 'Someone thanked you',
        body: message.slice(0, 180),
        type: 'info',
        actionUrl: '/portal/feed/company#recognition',
        entityType: 'recognition',
        entityId: id,
      });
    }

    return { ok: true, id, changed: true };
  } catch (e: any) {
    // NEVER SWALLOWED — the real cause to the log, a sentence to the caller.
    logFail('sendRecognition', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * WITHDRAW YOUR OWN. Only the sender, matched on the SESSION user id inside the UPDATE itself, so a
 * posted id belonging to somebody else changes nothing rather than being caught by a prior read.
 */
export async function withdrawRecognition(viewer: FeedViewer, id: string): Promise<WriteResult> {
  if (!viewer.userId) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureRecognitionSchema();
    const r = rows(await db.execute(sql`
      UPDATE recognitions
         SET status = 'withdrawn', removed_at = NOW()
       WHERE id = ${id}::uuid
         AND from_user_id::text = ${viewer.userId}::text
         AND status = 'visible'
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: NOT_AVAILABLE };
    await logAudit({
      userId: viewer.userId,
      action: 'recognition.withdraw',
      entity: 'recognition',
      entityId: id,
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('withdrawRecognition', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * TAKE ONE DOWN, with a reason on the record.
 *
 * Needs `recognition.moderate`, re-checked HERE against the posted id and never against whatever
 * page rendered the button. It is not a delete: the row stays, with who removed it and why, because
 * "somebody took down a thank-you about me" is a thing the person it was about is entitled to have
 * a record of.
 */
export async function removeRecognition(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null,
  viewer: FeedViewer,
  id: string,
  reason: string,
): Promise<WriteResult> {
  if (!viewer.canModerateRecognition || !holdsCapability(user as any, 'recognition.moderate')) {
    return {
      ok: false,
      error: 'Taking down somebody else\'s recognition needs the recognition-moderation capability.',
    };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  const why = String(reason || '').trim().slice(0, REASON_MAX);
  if (!why) {
    return { ok: false, error: 'Say why it is coming down. The reason is kept with the row.' };
  }
  try {
    await ensureRecognitionSchema();
    const r = rows(await db.execute(sql`
      UPDATE recognitions
         SET status = 'removed', removed_by_user_id = ${viewer.userId}::uuid,
             removed_reason = ${why}, removed_at = NOW()
       WHERE id = ${id}::uuid AND status = 'visible'
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: NOT_AVAILABLE };
    await logAudit({
      userId: viewer.userId,
      action: 'recognition.remove',
      entity: 'recognition',
      entityId: id,
      diff: { reason: why },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('removeRecognition', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE AGGREGATE VIEW. Counts, and nothing that names a person.
// -------------------------------------------------------------------------------------------------

export interface RecognitionOverview {
  available: boolean;
  total: number;
  last30: number;
  windowDays: number;
  /** Distinct people who SENT one in the window. Participation, not performance. */
  distinctSenders: number;
  /** Distinct people who RECEIVED one in the window. */
  distinctReceivers: number;
  /** Active headcount, so the two numbers above mean something. */
  headcount: number;
  /** Company-wide versus team-scoped. A fact about how people choose to use it. */
  companyWide: number;
  teamScoped: number;
  /** Withdrawn by their sender, and taken down by a moderator. Honest, not hidden. */
  withdrawn: number;
  removed: number;
  tagBands: Band[];
  tagSuppressed: number;
  departmentBands: Band[];
  departmentSuppressed: number;
  minGroup: number;
  tooFewLabel: string;
  /** One sentence about this whole result, rendered verbatim. */
  note: string;
}

/**
 * THE HR VIEW, AND THE SHAPE OF IT IS THE POINT.
 *
 * Every figure here is a COUNT or a COUNT OF DISTINCT PEOPLE. There is no row per person, no ORDER
 * BY that ranks anybody, and no drill-down to an individual — not because a filter hides one, but
 * because the query that would produce one is not written. The breakdowns go through suppressBands()
 * with the platform minimum group size, so a department of three does not become a description of
 * three named people, and when any band is withheld its total is withheld with it — otherwise the
 * missing number can be subtracted back out.
 *
 * WHAT THIS IS FOR: answering "is anybody using this, and is it reaching more than one corner of the
 * company". Both are questions about the PROGRAMME. Neither is a question about a person, and a
 * screen that answered one about a person would be the shame list this module refuses to build.
 */
export async function recognitionOverview(): Promise<RecognitionOverview> {
  const base: RecognitionOverview = {
    available: false,
    total: 0,
    last30: 0,
    windowDays: WINDOW_DAYS,
    distinctSenders: 0,
    distinctReceivers: 0,
    headcount: 0,
    companyWide: 0,
    teamScoped: 0,
    withdrawn: 0,
    removed: 0,
    tagBands: [],
    tagSuppressed: 0,
    departmentBands: [],
    departmentSuppressed: 0,
    minGroup: MIN_GROUP,
    tooFewLabel: TOO_FEW_LABEL,
    note: 'Recognition figures could not be read just now. This is a degraded read, not a zero.',
  };
  try {
    await ensureRecognitionSchema();

    const totals = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'visible')::int AS total,
        COUNT(*) FILTER (WHERE status = 'visible' AND created_at >= NOW() - INTERVAL '30 days')::int AS last30,
        COUNT(*) FILTER (WHERE status = 'visible' AND visibility = 'company')::int AS company_wide,
        COUNT(*) FILTER (WHERE status = 'visible' AND visibility = 'team')::int AS team_scoped,
        COUNT(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
        COUNT(*) FILTER (WHERE status = 'removed')::int AS removed,
        COUNT(DISTINCT from_employee_id) FILTER (
          WHERE status = 'visible' AND created_at >= NOW() - (${WINDOW_DAYS} * INTERVAL '1 day'))::int AS senders,
        COUNT(DISTINCT to_employee_id) FILTER (
          WHERE status = 'visible' AND created_at >= NOW() - (${WINDOW_DAYS} * INTERVAL '1 day'))::int AS receivers
      FROM recognitions`))[0] || {};

    let headcount = 0;
    try {
      const h = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_employees WHERE is_active = true`));
      headcount = Number(h[0]?.n || 0);
    } catch (e: any) {
      logFail('recognitionOverview headcount', e);
    }

    const tagRows = rows(await db.execute(sql`
      SELECT tag, COUNT(*)::int AS n
        FROM recognitions
       WHERE status = 'visible'
       GROUP BY tag`));
    const tags = suppressBands(
      tagRows.map((r) => ({ label: recognitionTagLabel(String(r.tag || 'none')), count: Number(r.n || 0) })),
    );

    // BY THE DEPARTMENT THAT RECEIVED, not by person. Departments with no name on record are
    // collected under one honest label rather than dropped, so the bands still add up.
    const deptRows = rows(await db.execute(sql`
      SELECT COALESCE(d.name, 'No department recorded') AS label, COUNT(*)::int AS n
        FROM recognitions r
        LEFT JOIN departments d ON d.id::text = r.to_department_id
       WHERE r.status = 'visible'
       GROUP BY COALESCE(d.name, 'No department recorded')`));
    const depts = suppressBands(
      deptRows.map((r) => ({ label: String(r.label || 'No department recorded'), count: Number(r.n || 0) })),
    );

    const total = Number(totals.total || 0);
    return {
      available: true,
      total,
      last30: Number(totals.last30 || 0),
      windowDays: WINDOW_DAYS,
      distinctSenders: Number(totals.senders || 0),
      distinctReceivers: Number(totals.receivers || 0),
      headcount,
      companyWide: Number(totals.company_wide || 0),
      teamScoped: Number(totals.team_scoped || 0),
      withdrawn: Number(totals.withdrawn || 0),
      removed: Number(totals.removed || 0),
      tagBands: tags.bands,
      tagSuppressed: tags.suppressedBands,
      departmentBands: depts.bands,
      departmentSuppressed: depts.suppressedBands,
      minGroup: MIN_GROUP,
      tooFewLabel: TOO_FEW_LABEL,
      note:
        total === 0
          ? 'Nobody has sent one yet. That is an empty programme, not a broken screen.'
          : 'Counts only. Nothing on this page names who received the most or the fewest, and no ' +
            'query behind it can produce that list. Any breakdown covering fewer than ' + MIN_GROUP +
            ' is withheld, and its total is withheld with it so the missing number cannot be ' +
            'subtracted back out.',
    };
  } catch (e: any) {
    logFail('recognitionOverview', e);
    return base;
  }
}

/**
 * The company-wide recognitions, for a moderator.
 *
 * COMPANY-WIDE ONLY, AND THAT IS DELIBERATE. A team-scoped one was sent by somebody who chose a
 * narrower audience, and listing it on an HR screen would quietly widen that choice after the fact.
 * A moderator who can see a team-scoped one — because it is their team — removes it from the feed,
 * with the same capability and the same reason field.
 */
export async function listCompanyWideForModeration(
  viewer: FeedViewer,
  limit = 60,
): Promise<Recognition[]> {
  if (!viewer.canModerateRecognition) return [];
  const n = Math.min(Math.max(Number(limit) || 60, 1), 200);
  try {
    await ensureRecognitionSchema();
    return rows(await db.execute(sql`
      SELECT r.*, false AS mine
        FROM recognitions r
       WHERE r.status = 'visible' AND r.visibility = 'company'
       ORDER BY r.created_at DESC
       LIMIT ${n}`)).map(mapRecognition);
  } catch (e: any) {
    logFail('listCompanyWideForModeration', e);
    return [];
  }
}
