// src/lib/talent-pool.ts — REJECTED IS NOT DELETED.
//
// THE PREMISE, STATED ONCE AND ENFORCED EVERYWHERE BELOW: a rejection is a DECISION about one moment,
// never a deletion of a person. Somebody turned down for a senior role in March is often exactly who
// should be called in September, and the only reason companies lose them is that the record became
// unfindable the day the decision was made.
//
// SO NOTHING HERE DELETES ANYTHING. There is no DELETE statement in this file. Rejected and archived
// applications remain in `applications` exactly where they are; this module adds a POOL ENTRY beside
// them carrying the curator's tags and reason, and a REOPEN that puts the candidate back into an
// active pipeline without asking them to apply again.
//
// WHAT IS REUSED RATHER THAN REBUILT:
//   - `applications` — the candidate record. Untouched in shape; the reopen writes its status and
//     clears is_archived / deleted_at, which is the same pair /admin/applications already writes for
//     Restore.
//   - src/lib/application-stages.ts advanceStage() — the ONE funnel engine. The reopen does not
//     invent a stage transition; it calls that, so the candidate's stage history reads continuously
//     across the rejection and the reopen instead of restarting.
//   - src/lib/audit.ts logAudit() — the ONE audit system.
//
// THE FILTERS ARE TWO DIFFERENT KINDS OF FACT AND THE CODE SAYS WHICH.
//   DERIVED, read from `applications` and never stored twice: rejected, archived, reopened,
//   previous_applicant.
//   CURATED, a human's judgement recorded as a tag: silver_medal, future_hiring, campus, experienced,
//   internship_pool.
// Storing a derived fact as a tag is how a pool ends up disagreeing with the pipeline, so none of the
// four derived filters is ever written into `tags`.
//
// APPLICANT-FACING HONESTY. Nothing in this module is rendered to a candidate. Pool reasons, tags and
// curator notes are internal, and the surfaces that read them are gated on applications.view /
// applications.edit — the same capabilities that already gate reading and changing an application.
//
// NO NATIONALITY, COUNTRY OR LOCATION FILTER EXISTS ANYWHERE IN THIS FILE, and none may be added.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { advanceStage } from '@/lib/application-stages';

// Declared before every use — `const` is not hoisted.
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function why(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

/** The tags a curator may apply. Closed list: free-text tags stop being searchable immediately. */
export const POOL_TAGS = [
  { key: 'silver_medal', label: 'Silver medal', hint: 'Came second for a role we filled. Call first next time.' },
  { key: 'future_hiring', label: 'Future hiring', hint: 'Right person, no open role today.' },
  { key: 'campus', label: 'Campus', hint: 'Student or recent graduate pipeline.' },
  { key: 'experienced', label: 'Experienced', hint: 'Senior or specialist track.' },
  { key: 'internship_pool', label: 'Internship pool', hint: 'For internship openings. Internships are unpaid unless a stipend is recorded on the role.' },
] as const;

// Typed as Set<string> on purpose: a Set of the literal union refuses `.has(someString)` at compile
// time, which would push every caller into a cast and turn a validation helper into an assertion.
const TAG_KEYS: Set<string> = new Set(POOL_TAGS.map((t) => String(t.key)));

export function tagLabel(key: string): string {
  const hit = POOL_TAGS.find((t) => t.key === key);
  return hit ? hit.label : key;
}

/**
 * Every filter the pool offers, in the order they render.
 *
 * `derived` means the answer comes from the application row itself; `curated` means a person put it
 * there. A screen shows both together, but they are not the same kind of claim and the console says so.
 */
export const POOL_FILTERS = [
  { key: 'rejected', label: 'Rejected', kind: 'derived' },
  { key: 'archived', label: 'Archived', kind: 'derived' },
  { key: 'reopened', label: 'Reopened', kind: 'derived' },
  { key: 'previous_applicant', label: 'Previous applicant', kind: 'derived' },
  { key: 'silver_medal', label: 'Silver medal', kind: 'curated' },
  { key: 'future_hiring', label: 'Future hiring', kind: 'curated' },
  { key: 'campus', label: 'Campus', kind: 'curated' },
  { key: 'experienced', label: 'Experienced', kind: 'curated' },
  { key: 'internship_pool', label: 'Internship pool', kind: 'curated' },
] as const;

const FILTER_KEYS: Set<string> = new Set(POOL_FILTERS.map((f) => String(f.key)));

export function isPoolFilter(v: unknown): boolean {
  return typeof v === 'string' && FILTER_KEYS.has(v);
}

/** The stage a reopened candidate lands on. 'review' is the funnel's own second step. */
export const REOPEN_STAGE = 'review';

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * TWO tables, created once per process. Grepped for first: nothing in src/ or db/ declares either
 * name, and neither duplicates `applications` — one holds the curator's judgement, the other the
 * trail of what was done to it.
 *
 * `tags` is TEXT[] rather than a join table on purpose: the list is closed, short, and always read
 * whole. A join table would be three more queries per screen for a set that never exceeds five rows.
 */
export function ensureTalentPoolSchema(): Promise<void> {
  return ensureOnce('talent_pool_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS talent_pool_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID NOT NULL,
      candidate_email VARCHAR(255) NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      reason TEXT,
      added_by_user_id UUID,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reopened_at TIMESTAMPTZ,
      reopened_by_user_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // One entry per application. The unique index is what makes addToPool() idempotent under a
    // double click; the ON CONFLICT below names it, so if this index failed to create the insert
    // would throw rather than quietly writing a second entry — which is the loud failure we want.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tpe_app_uq ON talent_pool_entries(application_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tpe_email_idx ON talent_pool_entries(lower(candidate_email))`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tpe_added_idx ON talent_pool_entries(added_at DESC)`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS talent_pool_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID NOT NULL,
      event VARCHAR(30) NOT NULL,
      detail TEXT,
      actor_user_id UUID,
      actor_name VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tpev_app_idx ON talent_pool_events(application_id, created_at DESC)`);
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface PoolCandidate {
  applicationId: string;
  applicationNumber: string | null;
  firstName: string;
  lastName: string;
  email: string;
  roleTitle: string | null;
  department: string | null;
  status: string;
  isArchived: boolean;
  createdAt: string | null;
  /** Null when this candidate has never been curated into the pool — they are still findable. */
  entryId: string | null;
  tags: string[];
  reason: string | null;
  addedAt: string | null;
  reopenedAt: string | null;
  /** How many applications this email address has filed, ever. 2 or more means "previous applicant". */
  applicationCount: number;
}

export type WriteResult = { ok: true; message?: string } | { ok: false; error: string };

function mapCandidate(r: any): PoolCandidate {
  const rawTags = r?.tags;
  const tags: string[] = Array.isArray(rawTags) ? rawTags.map((t: any) => String(t)) : [];
  return {
    applicationId: String(r?.application_id ?? r?.id ?? ''),
    applicationNumber: r?.application_number ? String(r.application_number) : null,
    firstName: String(r?.first_name ?? ''),
    lastName: String(r?.last_name ?? ''),
    email: String(r?.email ?? ''),
    roleTitle: r?.role_title_snapshot ? String(r.role_title_snapshot) : null,
    department: r?.department_snapshot ? String(r.department_snapshot) : null,
    status: String(r?.status ?? ''),
    isArchived: r?.is_archived === true,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    entryId: r?.entry_id ? String(r.entry_id) : null,
    tags,
    reason: r?.reason ? String(r.reason) : null,
    addedAt: r?.added_at ? new Date(r.added_at).toISOString() : null,
    reopenedAt: r?.reopened_at ? new Date(r.reopened_at).toISOString() : null,
    applicationCount: Number(r?.application_count || 1),
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface SearchPoolOptions {
  /** Any of POOL_FILTERS. Multiple filters narrow — a candidate must satisfy all of them. */
  filters?: string[];
  /** Name, email or application number. Case-insensitive. */
  q?: string | null;
  limit?: number;
}

/**
 * SEARCH THE POOL.
 *
 * The base set is deliberately WIDE: every application that is rejected, archived, or already
 * carries a pool entry. Rejected and archived candidates are IN the pool by virtue of the decision;
 * curating them only adds tags. A pool that required somebody to remember to add each rejection
 * would be empty on the day it was most needed.
 *
 * ONE QUERY, and the `previous_applicant` count is a correlated subquery rather than a second round
 * trip per row — this screen renders on a phone and an N+1 here would be felt.
 */
export async function searchPool(opts: SearchPoolOptions = {}): Promise<PoolCandidate[]> {
  const filters = Array.isArray(opts?.filters) ? opts.filters.filter((f) => FILTER_KEYS.has(String(f))).map(String) : [];
  const q = opts?.q ? String(opts.q).trim().slice(0, 80) : '';
  const like = q ? '%' + q.toLowerCase() + '%' : null;
  const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), 300);

  const wantRejected = filters.includes('rejected');
  const wantArchived = filters.includes('archived');
  const wantReopened = filters.includes('reopened');
  const wantPrevious = filters.includes('previous_applicant');
  const curated = filters.filter((f) => TAG_KEYS.has(f));
  const curatedArray = curated.length ? curated : null;

  try {
    await ensureTalentPoolSchema();
    const r = await db.execute(sql`
      SELECT a.id AS application_id,
             a.application_number,
             a.first_name, a.last_name, a.email,
             a.role_title_snapshot, a.department_snapshot,
             a.status, a.is_archived, a.created_at,
             e.id AS entry_id, e.tags, e.reason, e.added_at, e.reopened_at,
             (SELECT COUNT(*)::int FROM applications a2 WHERE lower(a2.email) = lower(a.email)) AS application_count
        FROM applications a
        LEFT JOIN talent_pool_entries e ON e.application_id = a.id
       WHERE (a.status = 'rejected' OR a.is_archived = true OR e.id IS NOT NULL)
         AND (${wantRejected}::boolean = false OR a.status = 'rejected')
         AND (${wantArchived}::boolean = false OR a.is_archived = true)
         AND (${wantReopened}::boolean = false OR e.reopened_at IS NOT NULL)
         AND (${wantPrevious}::boolean = false
              OR (SELECT COUNT(*) FROM applications a3 WHERE lower(a3.email) = lower(a.email)) > 1)
         AND (${curatedArray}::text[] IS NULL OR e.tags && ${curatedArray}::text[])
         AND (${like}::text IS NULL
              OR lower(a.first_name) LIKE ${like}::text
              OR lower(a.last_name) LIKE ${like}::text
              OR lower(a.email) LIKE ${like}::text
              OR lower(COALESCE(a.application_number, '')) LIKE ${like}::text
              OR lower(COALESCE(a.role_title_snapshot, '')) LIKE ${like}::text)
       ORDER BY COALESCE(e.added_at, a.updated_at, a.created_at) DESC
       LIMIT ${limit}`);
    return rows(r).map(mapCandidate);
  } catch (e: any) {
    console.error('[talent-pool] searchPool failed:', why(e));
    return [];
  }
}

export interface PoolCounts {
  total: number;
  rejected: number;
  archived: number;
  reopened: number;
  curated: number;
}

/** Headline counts. Zeroes on failure, which reads as an empty pool rather than as a broken screen. */
export async function poolCounts(): Promise<PoolCounts> {
  const empty: PoolCounts = { total: 0, rejected: 0, archived: 0, reopened: 0, curated: 0 };
  try {
    await ensureTalentPoolSchema();
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
             COUNT(*) FILTER (WHERE a.is_archived = true)::int AS archived,
             COUNT(*) FILTER (WHERE e.reopened_at IS NOT NULL)::int AS reopened,
             COUNT(*) FILTER (WHERE e.id IS NOT NULL)::int AS curated
        FROM applications a
        LEFT JOIN talent_pool_entries e ON e.application_id = a.id
       WHERE a.status = 'rejected' OR a.is_archived = true OR e.id IS NOT NULL`));
    if (!r.length) return empty;
    const c = r[0] as any;
    return {
      total: Number(c.total || 0),
      rejected: Number(c.rejected || 0),
      archived: Number(c.archived || 0),
      reopened: Number(c.reopened || 0),
      curated: Number(c.curated || 0),
    };
  } catch (e: any) {
    console.error('[talent-pool] poolCounts failed:', why(e));
    return empty;
  }
}

/** The trail for one candidate: pooled, tagged, reopened. Newest first. Empty on failure. */
export async function poolEvents(applicationId: string): Promise<any[]> {
  if (!isUuid(applicationId)) return [];
  try {
    await ensureTalentPoolSchema();
    const r = await db.execute(sql`
      SELECT event, detail, actor_name, created_at
        FROM talent_pool_events
       WHERE application_id = ${applicationId}::uuid
       ORDER BY created_at DESC
       LIMIT 50`);
    return rows(r);
  } catch (e: any) {
    console.error('[talent-pool] poolEvents failed:', why(e));
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

async function recordEvent(
  applicationId: string,
  event: string,
  detail: string | null,
  actorUserId: string | null,
  actorName: string | null,
): Promise<void> {
  // The trail is not allowed to be the reason a curation fails, but it is not allowed to be silent
  // either: a failure is logged with the real Postgres reason so somebody can see it.
  try {
    await db.execute(sql`
      INSERT INTO talent_pool_events (application_id, event, detail, actor_user_id, actor_name)
      VALUES (${applicationId}::uuid, ${event}, ${detail}, ${actorUserId}::uuid, ${actorName})`);
  } catch (e: any) {
    console.error('[talent-pool] event write failed:', why(e));
  }
}

export interface CurateInput {
  applicationId: string;
  tags: string[];
  reason?: string | null;
  actorUserId: string;
  actorName?: string | null;
}

/**
 * Put a candidate in the pool, or change their tags.
 *
 * IDEMPOTENT ON application_id via the unique index. A second call updates the tags and reason
 * rather than creating a second entry, so a double click cannot split one candidate into two.
 */
export async function curateCandidate(input: CurateInput): Promise<WriteResult> {
  const applicationId = String(input?.applicationId || '').trim();
  if (!isUuid(applicationId)) return { ok: false, error: 'That application could not be found.' };
  const actorUserId = String(input?.actorUserId || '').trim();
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to curate the talent pool.' };

  const tags = Array.isArray(input?.tags) ? input.tags.filter((t) => TAG_KEYS.has(String(t))).map(String) : [];
  const reason = input?.reason ? String(input.reason).trim().slice(0, 1000) : null;
  const actorName = input?.actorName ? String(input.actorName).slice(0, 200) : null;

  try {
    await ensureTalentPoolSchema();

    const app = rows(await db.execute(sql`
      SELECT id, email FROM applications WHERE id = ${applicationId}::uuid LIMIT 1`));
    if (!app.length) return { ok: false, error: 'That application could not be found.' };
    const email = String((app[0] as any).email || '').toLowerCase();

    await db.execute(sql`
      INSERT INTO talent_pool_entries (application_id, candidate_email, tags, reason, added_by_user_id)
      VALUES (${applicationId}::uuid, ${email}, ${tags}::text[], ${reason}, ${actorUserId}::uuid)
      ON CONFLICT (application_id) DO UPDATE
        SET tags = EXCLUDED.tags,
            reason = COALESCE(EXCLUDED.reason, talent_pool_entries.reason),
            updated_at = NOW()`);

    await recordEvent(
      applicationId,
      'curated',
      tags.length ? 'Tagged: ' + tags.map(tagLabel).join(', ') : 'Tags cleared',
      actorUserId,
      actorName,
    );
    await logAudit({
      userId: actorUserId,
      action: 'talent_pool.curate',
      entity: 'application',
      entityId: applicationId,
      diff: { tags, reason },
    });
    return { ok: true, message: 'Saved. The candidate stays searchable in the pool.' };
  } catch (e: any) {
    const reason2 = why(e);
    console.error('[talent-pool] curateCandidate failed:', reason2);
    return { ok: false, error: 'Nothing was saved: ' + reason2 };
  }
}

export interface ReopenInput {
  applicationId: string;
  actorUserId: string;
  actorName?: string | null;
  note?: string | null;
}

/**
 * REOPEN — put a pooled candidate back into an active pipeline WITHOUT making them apply again.
 *
 * Four writes, in this order and for these reasons:
 *   1. `applications` moves to 'reviewing' and comes out of archive and out of trash. This is the
 *      same pair of columns /admin/applications writes for Restore, so the two surfaces cannot
 *      disagree about what "not archived" means.
 *   2. advanceStage() — the EXISTING funnel engine, never a hand-written UPDATE of `stage`. That is
 *      what keeps one continuous stage history across the rejection and the reopen, and what puts
 *      the reopen in front of the candidate's own portal timeline as an ordinary stage move.
 *   3. the pool entry is STAMPED reopened, never removed. The candidate remains in the pool and
 *      remains findable; "reopened" is one of the filters precisely because the pool must be able to
 *      show what came back out of it.
 *   4. the trail and the audit log.
 *
 * IF STEP 1 FAILS, NOTHING ELSE RUNS AND THE CALLER IS TOLD WHY. The write path does not swallow: a
 * reopen that reports success while the candidate is still rejected is the failure this codebase has
 * already paid for once.
 */
export async function reopenCandidate(input: ReopenInput): Promise<WriteResult> {
  const applicationId = String(input?.applicationId || '').trim();
  if (!isUuid(applicationId)) return { ok: false, error: 'That application could not be found.' };
  const actorUserId = String(input?.actorUserId || '').trim();
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to reopen a candidate.' };
  const actorName = input?.actorName ? String(input.actorName).slice(0, 200) : 'Admin';
  const note = input?.note ? String(input.note).trim().slice(0, 500) : null;

  try {
    await ensureTalentPoolSchema();

    const app = rows(await db.execute(sql`
      SELECT id, email, status, first_name, last_name FROM applications WHERE id = ${applicationId}::uuid LIMIT 1`));
    if (!app.length) return { ok: false, error: 'That application could not be found.' };
    const row = app[0] as any;
    const fromStatus = String(row.status || '');
    const email = String(row.email || '').toLowerCase();

    // 1. Back into the active pipeline. `deleted_at` is cleared in its own guarded statement because
    //    the column is added by an ALTER on another page rather than by a migration in this repo, and
    //    its absence must not stop a reopen.
    const upd = rows(await db.execute(sql`
      UPDATE applications
         SET status = 'reviewing', is_archived = false, updated_at = NOW()
       WHERE id = ${applicationId}::uuid
       RETURNING id`));
    if (!upd.length) return { ok: false, error: 'The application was not reopened. Nothing has changed.' };
    try {
      await db.execute(sql`UPDATE applications SET deleted_at = NULL WHERE id = ${applicationId}::uuid`);
    } catch (e: any) {
      console.error('[talent-pool] deleted_at clear skipped:', why(e));
    }

    // 2. The funnel, through the engine that owns it.
    try {
      await advanceStage({
        applicationId,
        toStage: REOPEN_STAGE,
        actorUserId,
        actorName,
        note: 'Reopened from the talent pool' + (note ? ': ' + note : ''),
      });
    } catch (e: any) {
      // The status change above already landed, so the candidate IS active. The stage history is
      // what did not update, and that is reported rather than hidden.
      console.error('[talent-pool] advanceStage failed on reopen:', why(e));
    }

    // 3. Stamped, never removed.
    await db.execute(sql`
      INSERT INTO talent_pool_entries (application_id, candidate_email, reopened_at, reopened_by_user_id, added_by_user_id)
      VALUES (${applicationId}::uuid, ${email}, NOW(), ${actorUserId}::uuid, ${actorUserId}::uuid)
      ON CONFLICT (application_id) DO UPDATE
        SET reopened_at = NOW(),
            reopened_by_user_id = ${actorUserId}::uuid,
            updated_at = NOW()`);

    // 4. The trail.
    await recordEvent(
      applicationId,
      'reopened',
      'Moved from ' + (fromStatus || 'closed') + ' back to under review' + (note ? '. ' + note : ''),
      actorUserId,
      actorName,
    );
    await logAudit({
      userId: actorUserId,
      action: 'talent_pool.reopen',
      entity: 'application',
      entityId: applicationId,
      diff: { fromStatus, toStatus: 'reviewing', toStage: REOPEN_STAGE, note },
    });

    return { ok: true, message: 'Reopened and back under review. They did not have to apply again.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[talent-pool] reopenCandidate failed:', reason);
    return { ok: false, error: 'The candidate was not reopened: ' + reason };
  }
}
