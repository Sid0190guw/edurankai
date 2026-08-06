// src/lib/announcements.ts — COMPANY ANNOUNCEMENTS. Scoped notices, versions, expiry, pinning,
// Drive links, and a record of who has read which VERSION.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   THE HANDBOOK    src/lib/knowledge-base.ts holds ARTICLES AND POLICIES — standing text that is
//                   searched, answers a recurring question, and stays true until it is rewritten.
//                   An announcement is DATED: it is news, it is scoped to an audience, and it is
//                   meant to stop being shown. That is why it carries expires_at and the handbook
//                   does not, and why nothing here writes to kb_articles.
//   THE LEARNER FEED src/pages/portal/feed.astro and its feed_posts table are the LEARNER social
//                   feed — reels, clips, AR filters, likes. Different audience (students), different
//                   lifecycle, different authorization. Nothing here reads or writes feed_posts.
//   COMMUNITY       src/lib/community.ts is study groups, clubs, hackathons and collaboration
//                   boards, again for learners. Untouched.
//   AUTHORIZATION   src/lib/auth/permissions.ts. One new capability, `announcements.publish`, for
//                   WRITING. READING is scoped IN THE WHERE CLAUSE from the reader's own
//                   organization facts — never from users.role, and never hidden client-side.
//   AUDIT           logAudit() (src/lib/audit.ts). No second log.
//   NOTIFICATIONS   notifyUser() (src/lib/notify.ts). No second notifier and no second table.
//   MARKDOWN        mdLite() (src/lib/content-render.ts), rendered on the SERVER. No client parser,
//                   no bytes shipped to draw text.
//   APPROVALS       there are none here, deliberately. Publishing a notice is capability-gated, not
//                   routed: src/lib/workflow.ts exists for decisions that belong to a PERSON the
//                   Organization Graph names, and "may this notice go out" is a standing authority,
//                   not a per-row routing question. Nothing in this file approves anything, and
//                   nothing in it can auto-approve because there is no approval to grant.
//
// =================================================================================================
// WHO SEES A NOTICE IS A WHERE CLAUSE, NEVER A HIDDEN ROW
// =================================================================================================
//
// Every announcement carries an `audience` and, for three of the four, a `scope_id`:
//
//   company      everybody with a workspace here.
//   department   one department. scope_id is departments.id READ AS TEXT.
//   project      one project. scope_id is projects.id.
//   location     one working city. scope_id is the city as hr_employees.city records it.
//
// visibilityClause() builds that filter into the SQL of every read, and no reader in this file can
// be called without a viewer. A notice this person may not see is NEVER FETCHED, so it cannot be
// leaked by a rendering mistake, a JSON dump or a "view source". Filtering after the fetch would put
// the whole body in the response and hide it with CSS, which is not privacy.
//
// WHERE THE SCOPE COMES FROM, AND WHAT IT IS NOT:
//
//   * A department audience resolves through hr_employees.department_id — the ORGANIZATION RECORD of
//     which department a person is in. It is NEVER users.role. There is no `department_head` role
//     test anywhere in this file, and holding any role grants sight of no department's notices.
//   * A project audience resolves through project_members (src/lib/projects.ts) UNION the
//     `project_manager` edges src/lib/org-graph.ts records for that project. The graph is the only
//     source consulted for "who runs this", exactly as every other surface consults it.
//   * WHO HEADS a department, and WHO RUNS a project, are asked of the Organization Graph and of
//     nothing else — and the graph is EMPTY until the founder runs the backfill. Every surface that
//     shows those two facts asks isInitialized() first and says so honestly rather than printing
//     "no head on record", which is a different and much worse claim.
//
// =================================================================================================
// VERSIONS, EXPIRY AND ACKNOWLEDGEMENT
// =================================================================================================
//
// An acknowledgement is recorded AGAINST A VERSION, because "Priya read the travel notice" is
// worthless if the travel notice has been rewritten twice since. Editing a PUBLISHED announcement
// writes the outgoing text to announcement_versions and increments version — which re-opens the
// acknowledgement for everybody. That is the point of tracking it at all, and the editor is told so
// in words before they save.
//
// WHAT THE ADMIN SURFACE MAY SHOW, and this line is deliberate: the people who HAVE acknowledged are
// NAMED, because an acknowledgement is an act a person deliberately performed and being able to show
// they did it is the whole purpose of the record. The people who have NOT are a COUNT — never a list
// of names. A screen that prints "these eleven have not read the code of conduct" is a shame list,
// and this product does not build one.
//
// EXPIRY IS THE READ, NOT A SWEEPER. `expires_at` is applied in the WHERE clause of every reader, so
// a stale notice disappears on its own with no cron, no job and nothing to forget to run. The row
// stays for the record; it simply stops being shown.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { holdsCapability } from '@/lib/auth/capability';
import { mdLite } from '@/lib/content-render';
import {
  isInitialized, getDepartmentHead, getProjectManagers, getManagedProjectIds, type OrgPerson,
} from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that read it. `const` is not hoisted,
// and a const declared under its first use throws on the first line of whatever reads it. That is
// the failure that took down apply step 5 and the /admin/roles/diagnose Repair button here.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never an object with `rows`. `r.rows[0]` is always a bug. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[announcements] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Shown when a write fails. Deliberately NOT the database's own words — those go to the log. */
const WRITE_FAILED =
  'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found / not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That announcement is not available.';

/** The sentence a caller without the capability gets. Same words at every write. */
const NOT_YOURS =
  'Publishing a company announcement needs the announcements capability. Nothing was changed.';

const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const BODY_MAX = 40000;
const SCOPE_MAX = 120;
const LABEL_MAX = 120;
const URL_MAX = 600;
const MAX_LINKS = 12;
const NOTE_MAX = 300;

/**
 * How many notification inserts run at once when a notice goes out.
 *
 * notify.ts unrolls its recipient list inside Postgres for exactly one reason: notifying sixty
 * people used to be sixty SEQUENTIAL round-trips on a path an applicant was waiting on. This path is
 * different — an administrator pressing Publish, not a visitor mid-request — but sixty serial
 * round-trips is still sixty, so they go out in waves. The list is NEVER CAPPED: dropping a
 * recipient would silently fail to tell a real member of staff something urgent, which is a
 * correctness bug wearing a performance costume.
 */
const NOTIFY_BATCH = 12;

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY. Plain functions rather than exported `Record<string, string>` maps: a typed map
// read inside .astro JSX is one of this project's known parse hazards, and every surface here is
// .astro.
// -------------------------------------------------------------------------------------------------

export const ANNOUNCEMENT_AUDIENCES = ['company', 'department', 'project', 'location'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

const AUDIENCE_SET = new Set<string>(ANNOUNCEMENT_AUDIENCES);
export function isAnnouncementAudience(v: unknown): v is AnnouncementAudience {
  return typeof v === 'string' && AUDIENCE_SET.has(v);
}

/** Does this audience need a scope id? Company does not; the other three cannot work without one. */
export function audienceNeedsScope(audience: string): boolean {
  const a = String(audience || '');
  return a === 'department' || a === 'project' || a === 'location';
}

export function audienceLabel(audience: string, scopeLabel?: string | null): string {
  const a = String(audience || '');
  const s = String(scopeLabel || '').trim();
  if (a === 'department') return s ? 'Department: ' + s : 'One department';
  if (a === 'project') return s ? 'Project: ' + s : 'One project';
  if (a === 'location') return s ? 'Location: ' + s : 'One location';
  return 'Everyone in the company';
}

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export function statusLabel(status: string): string {
  const s = String(status || '');
  if (s === 'published') return 'Published';
  if (s === 'archived') return 'Archived';
  return 'Draft';
}

/** Traffic colours for a status pill. A function, not a map, for the JSX reason above. */
export function statusColour(status: string): string {
  const s = String(status || '');
  if (s === 'published') return '#047857';
  if (s === 'archived') return '#6b7280';
  return '#b45309';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, asserted column by column, inside ONE ensureOnce guard.
// -------------------------------------------------------------------------------------------------

/**
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS — which
 * is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
 * table, locking every administrator out of /admin for a day. Every column past the primary key is
 * therefore asserted again with ADD COLUMN IF NOT EXISTS.
 *
 * THERE IS EXACTLY ONE DEFINITION OF EACH OF THESE THREE TABLES, AND IT IS IN THIS FILE. Two CREATE
 * TABLE IF NOT EXISTS statements for one table with different shapes silently breaks every write for
 * whichever module lost the race — the fault that meant no encrypted message went out for four
 * months here. Before adding a table anywhere, grep for its name; `announcements`,
 * `announcement_versions` and `announcement_acks` appear nowhere else in src, db or scripts.
 *
 * ensureOnce() memoises the in-flight promise per process and DELETES the cache entry if the
 * callback rejects, so a transient failure retries on the next call instead of poisoning the
 * process. That is why the catch below RE-THROWS after logging the real cause.
 */
export function ensureAnnouncementSchema(): Promise<void> {
  return ensureOnce('announcements_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS announcements (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title               TEXT NOT NULL,
        summary             TEXT NOT NULL DEFAULT '',
        body                TEXT NOT NULL DEFAULT '',
        audience            TEXT NOT NULL DEFAULT 'company',
        scope_id            TEXT,
        scope_label         TEXT NOT NULL DEFAULT '',
        urgent              BOOLEAN NOT NULL DEFAULT false,
        pinned              BOOLEAN NOT NULL DEFAULT false,
        expires_at          TIMESTAMPTZ,
        ack_required        BOOLEAN NOT NULL DEFAULT false,
        status              TEXT NOT NULL DEFAULT 'draft',
        version             INT NOT NULL DEFAULT 1,
        links               JSONB NOT NULL DEFAULT '[]'::jsonb,
        author_user_id      UUID,
        author_employee_id  UUID,
        author_name         TEXT NOT NULL DEFAULT '',
        published_at        TIMESTAMPTZ,
        archived_at         TIMESTAMPTZ,
        archive_reason      TEXT NOT NULL DEFAULT '',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      for (const q of [
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'company'`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS scope_id TEXT`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS scope_label TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS ack_required BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS author_user_id UUID`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS author_employee_id UUID`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS author_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS archive_reason TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      // NO CHECK CONSTRAINT on audience or status, and no foreign keys — the same reason
      // knowledge-base.ts, helpdesk.ts and workflow-schema.ts all give: this project has no migration
      // runner, so a CHECK could never be widened to admit a new audience without one; the vocabulary
      // is enforced in TypeScript above; and a foreign key to departments or projects would take an
      // announcement's history with a deleted row, which is the one thing the record exists to keep.

      // The reading surface: what is live, newest first, pinned first.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS announcements_read_idx
        ON announcements (status, pinned DESC, published_at DESC)`);
      // The scope filter every reader applies.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS announcements_scope_idx
        ON announcements (audience, scope_id)`);
      // Expiry, so the "still live" test does not scan.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS announcements_expiry_idx
        ON announcements (expires_at)`);

      // -------------------------------------------------------------------------------------
      // VERSION HISTORY. One row per superseded version, written BEFORE the announcement row moves
      // on, so the history is the record of what people actually read rather than a diff
      // reconstructed later.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS announcement_versions (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        announcement_id  UUID NOT NULL,
        version          INT NOT NULL,
        title            TEXT NOT NULL DEFAULT '',
        summary          TEXT NOT NULL DEFAULT '',
        body             TEXT NOT NULL DEFAULT '',
        links            JSONB NOT NULL DEFAULT '[]'::jsonb,
        change_note      TEXT NOT NULL DEFAULT '',
        author_user_id   UUID,
        author_name      TEXT NOT NULL DEFAULT '',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS change_note TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS author_user_id UUID`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS author_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcement_versions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS announcement_versions_key
        ON announcement_versions (announcement_id, version)`);

      // -------------------------------------------------------------------------------------
      // ACKNOWLEDGEMENTS. Keyed by (announcement, version, user): a new version re-opens the
      // question, which is the whole reason to record it at all. UNIQUE so a double tap on a phone
      // cannot write two rows.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS announcement_acks (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        announcement_id  UUID NOT NULL,
        version          INT NOT NULL,
        user_id          UUID NOT NULL,
        employee_id      UUID,
        person_name      TEXT NOT NULL DEFAULT '',
        acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE announcement_acks ADD COLUMN IF NOT EXISTS employee_id UUID`,
        sql`ALTER TABLE announcement_acks ADD COLUMN IF NOT EXISTS person_name TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE announcement_acks ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS announcement_acks_key
        ON announcement_acks (announcement_id, version, user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS announcement_acks_user_idx
        ON announcement_acks (user_id, announcement_id)`);

      // -------------------------------------------------------------------------------------
      // CELEBRATION CONSENT. Default OFF for every column, and that is the entire point.
      //
      // A DATE OF BIRTH IS PERSONAL DATA. Surfacing it to the whole company by default is a privacy
      // failure dressed up as a nice touch, and "nobody complained" is not consent. So the feed
      // shows a birthday, a work anniversary or a new joiner ONLY where a row here says that person
      // asked for it — and the absence of a row means no.
      //
      // The DEFAULT false on every column is load-bearing twice over: a row created for one opt-in
      // does not switch the other two on, and a column added later cannot arrive switched on.
      // -------------------------------------------------------------------------------------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS feed_celebration_optin (
        employee_id      UUID PRIMARY KEY,
        user_id          UUID,
        show_birthday    BOOLEAN NOT NULL DEFAULT false,
        show_anniversary BOOLEAN NOT NULL DEFAULT false,
        show_joining     BOOLEAN NOT NULL DEFAULT false,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE feed_celebration_optin ADD COLUMN IF NOT EXISTS user_id UUID`,
        sql`ALTER TABLE feed_celebration_optin ADD COLUMN IF NOT EXISTS show_birthday BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE feed_celebration_optin ADD COLUMN IF NOT EXISTS show_anniversary BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE feed_celebration_optin ADD COLUMN IF NOT EXISTS show_joining BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE feed_celebration_optin ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
    } catch (e: any) {
      logFail('ensureAnnouncementSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE VIEWER. Everything a read is allowed to know about who is asking.
// -------------------------------------------------------------------------------------------------

/**
 * WHO IS READING, reduced to the facts a query may use.
 *
 * NO ROLE FIELD, ON PURPOSE. A reader that cannot reach a role cannot test one, and "never resolve a
 * manager, reviewer or owner from users.role" is the standing rule this shape enforces mechanically
 * rather than by reminder. The only authorization fact carried is `canPublish`, which is a
 * CAPABILITY answer, asked once here so no surface has to remember to ask it.
 */
export interface FeedViewer {
  userId: string | null;
  employeeId: string | null;
  fullName: string;
  /** Does this person have a workspace here at all? Nothing is readable without one. */
  hasWorkspace: boolean;
  /** hr_employees.department_id, ALWAYS read as ::text. Never cast to uuid — the two schemas differ. */
  departmentId: string | null;
  departmentName: string | null;
  /** hr_employees.city. The working location an announcement can be scoped to. */
  city: string | null;
  /** Project ids this person is on: project_members UNION the graph's project_manager edges. */
  projectIds: readonly string[];
  /** May this person publish an announcement? `announcements.publish`, asked once. */
  canPublish: boolean;
  /** May this person withdraw somebody else's recognition? `recognition.moderate`, asked once. */
  canModerateRecognition: boolean;
}

/**
 * Build a viewer from a signed-in account.
 *
 * The employee lookup is the same two-step the rest of the employee portal uses — user_id first,
 * then any of the three email columns — because hr_employees.user_id is empty for anybody HR added
 * by hand, and a viewer built without their record would see the company feed and none of their own
 * department's notices.
 *
 * NO EMPLOYEE RECORD IS AN HONEST STATE, NOT AN ERROR. An admin account or the founder frequently
 * has no hr_employees row; they still have a workspace, so they still read company-wide notices.
 * They are simply in no department, on no project and in no location, and see nothing scoped to one.
 */
export async function buildFeedViewer(
  user: { id?: string | null; email?: string | null; name?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
): Promise<FeedViewer> {
  const userId = String(user?.id || '').trim() || null;
  const canPublish = holdsCapability(user as any, 'announcements.publish');
  const canModerateRecognition = holdsCapability(user as any, 'recognition.moderate');

  const empty: FeedViewer = {
    userId,
    employeeId: null,
    fullName: String(user?.name || '').trim(),
    // An admin-capable account with no employee record still has a workspace. Gating the company
    // feed on the record alone would hide the company's own notices from the people who write them.
    hasWorkspace: !!userId && (canPublish || !!user),
    departmentId: null,
    departmentName: null,
    city: null,
    projectIds: [],
    canPublish,
    canModerateRecognition,
  };
  if (!userId) return { ...empty, hasWorkspace: false };

  try {
    await ensureAnnouncementSchema();
    const email = String(user?.email || '').trim();
    let emp = rows(await db.execute(sql`
      SELECT e.id AS id,
             e.full_name AS full_name,
             e.department_id::text AS department_id,
             e.city AS city,
             d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.user_id = ${userId}::uuid AND e.is_active = true
       LIMIT 1`))[0] || null;

    if (!emp && email) {
      emp = rows(await db.execute(sql`
        SELECT e.id AS id,
               e.full_name AS full_name,
               e.department_id::text AS department_id,
               e.city AS city,
               d.name AS department_name
          FROM hr_employees e
          LEFT JOIN departments d ON d.id::text = e.department_id::text
         WHERE (e.work_email = ${email} OR e.personal_email = ${email} OR e.email = ${email})
           AND e.is_active = true
         LIMIT 1`))[0] || null;
    }

    if (!emp) return empty;

    const employeeId = String(emp.id);
    const projectIds = await projectIdsForEmployee(employeeId);

    return {
      userId,
      employeeId,
      fullName: String(emp.full_name || user?.name || '').trim(),
      hasWorkspace: true,
      departmentId: emp.department_id ? String(emp.department_id) : null,
      departmentName: emp.department_name ? String(emp.department_name) : null,
      city: emp.city ? String(emp.city).trim() : null,
      projectIds,
      canPublish,
      canModerateRecognition,
    };
  } catch (e: any) {
    logFail('buildFeedViewer', e);
    // Fail CLOSED on the scoped audiences and open only on what a workspace already grants:
    // company-wide notices. A degraded lookup must never widen what somebody sees.
    return empty;
  }
}

/**
 * Every project this employee is on — MEMBERSHIP from project_members, plus the projects the
 * Organization Graph records them as RUNNING.
 *
 * Both halves are needed and neither substitutes for the other: a project manager is frequently not
 * listed as a member of their own project, and a member is not a manager. The graph half returns
 * nothing at all until the founder runs the backfill, which is why the member half is not built on
 * it — an un-backfilled graph must degrade to "you see your project's notices because you are on
 * it", not to silence.
 */
async function projectIdsForEmployee(employeeId: string): Promise<string[]> {
  if (!isUuid(employeeId)) return [];
  const ids = new Set<string>();
  try {
    const memberRows = rows(await db.execute(sql`
      SELECT DISTINCT project_id::text AS project_id
        FROM project_members
       WHERE employee_id = ${employeeId}::uuid
         AND removed_at IS NULL`));
    for (const r of memberRows) {
      if (r?.project_id) ids.add(String(r.project_id));
    }
  } catch (e: any) {
    // project_members may not exist yet in a fresh environment. That is a missing module, not a
    // failure of this one, and it must not take the feed down.
    logFail('projectIdsForEmployee members', e);
  }
  try {
    for (const id of await getManagedProjectIds(employeeId)) ids.add(String(id));
  } catch (e: any) {
    logFail('projectIdsForEmployee graph', e);
  }
  return [...ids];
}

/**
 * THE VISIBILITY CLAUSE. The only place an announcement's audience is enforced, and it is enforced
 * in SQL, against a table aliased `a`.
 *
 * Read the branches:
 *   - no workspace   -> AND FALSE. Nothing at all, and the surface says so honestly.
 *   - anybody else   -> company-wide notices, plus the department, projects and location THIS
 *                       person is actually in, plus anything they wrote themselves.
 *
 * The project id list is passed as a JSON string and unpacked by jsonb_array_elements_text. That is
 * the pattern src/lib/pg-array.ts documents: interpolating a JS array into a drizzle template and
 * casting it does NOT work — postgres-js serialises it as a record literal and Postgres rejects the
 * cast. Every value here is a BOUND PARAMETER; nothing is interpolated as text.
 */
function visibilityClause(viewer: FeedViewer) {
  if (!viewer.hasWorkspace) return sql`AND FALSE`;
  const projectsJson = JSON.stringify((viewer.projectIds || []).filter(isUuid));
  return sql`AND (
    a.audience = 'company'
    OR (a.audience = 'department' AND ${viewer.departmentId}::text IS NOT NULL
        AND a.scope_id = ${viewer.departmentId}::text)
    OR (a.audience = 'project' AND a.scope_id IN (
          SELECT t.x FROM jsonb_array_elements_text(${projectsJson}::jsonb) AS t(x)))
    OR (a.audience = 'location' AND ${viewer.city}::text IS NOT NULL
        AND lower(a.scope_id) = lower(${viewer.city}::text))
    OR (${viewer.userId}::text IS NOT NULL AND a.author_user_id::text = ${viewer.userId}::text)
  )`;
}

/** Still being shown: published, and not past its expiry. Expiry is a READ, never a sweeper job. */
function liveClause() {
  return sql`AND a.status = 'published'
    AND (a.expires_at IS NULL OR a.expires_at > NOW())`;
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface AnnouncementLink {
  label: string;
  url: string;
}

export interface Announcement {
  id: string;
  title: string;
  summary: string;
  body: string;
  audience: string;
  scopeId: string | null;
  scopeLabel: string;
  urgent: boolean;
  pinned: boolean;
  expiresAt: string | null;
  ackRequired: boolean;
  status: string;
  version: number;
  links: AnnouncementLink[];
  authorUserId: string | null;
  authorName: string;
  publishedAt: string | null;
  archivedAt: string | null;
  archiveReason: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Filled by the readers that ask: has THIS viewer acknowledged the CURRENT version? */
  acknowledged?: boolean;
}

export interface AnnouncementVersion {
  version: number;
  title: string;
  summary: string;
  changeNote: string;
  authorName: string;
  createdAt: string | null;
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** True when the write actually changed something. A repeat acknowledgement is ok:true, false. */
  changed?: boolean;
  /**
   * How many people a notification was ISSUED FOR when a notice went out.
   *
   * NOT A DELIVERY RECEIPT, and the surfaces say so in words. notify.ts catches and logs its own
   * failure by design, so no caller of it can know that a row landed — claiming "60 people were
   * notified" from a number this function cannot verify is exactly the reported-success-versus-
   * observable-result gap that has bitten this project before.
   */
  notified?: number;
}

function toLinks(raw: any): AnnouncementLink[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: AnnouncementLink[] = [];
  for (const item of list) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    out.push({ label: String(item?.label || '').trim() || url, url });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

function mapAnnouncement(row: any): Announcement {
  return {
    id: String(row?.id || ''),
    title: String(row?.title || ''),
    summary: String(row?.summary || ''),
    body: String(row?.body || ''),
    audience: String(row?.audience || 'company'),
    scopeId: row?.scope_id ? String(row.scope_id) : null,
    scopeLabel: String(row?.scope_label || ''),
    urgent: row?.urgent === true,
    pinned: row?.pinned === true,
    expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null,
    ackRequired: row?.ack_required === true,
    status: String(row?.status || 'draft'),
    version: Number(row?.version || 1),
    links: toLinks(row?.links),
    authorUserId: row?.author_user_id ? String(row.author_user_id) : null,
    authorName: String(row?.author_name || ''),
    publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null,
    archivedAt: row?.archived_at ? new Date(row.archived_at).toISOString() : null,
    archiveReason: String(row?.archive_reason || ''),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    acknowledged: row?.acknowledged === true ? true : row?.acknowledged === false ? false : undefined,
  };
}

// -------------------------------------------------------------------------------------------------
// INPUT PARSING. Every one of these runs on the SERVER against the posted form, never against the
// rendered page.
// -------------------------------------------------------------------------------------------------

const clip = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/**
 * Attachments are LINKS. Documents of any kind live on Google Drive with "anyone with the link"
 * access — that is the standing rule in this product, and it is why there is no bytes column here
 * for somebody to reach for later.
 *
 * Accepted format, one per line:  Label | https://...     (the label is optional)
 * ONLY http(s) is accepted. A javascript: or data: URL in an announcement body would be a stored
 * cross-site scripting hole with company-wide distribution, which is about the worst possible place
 * for one, so anything that is not an http(s) URL is DROPPED rather than "sanitised".
 */
export function parseLinks(raw: unknown): AnnouncementLink[] {
  const text = String(raw ?? '');
  const out: AnnouncementLink[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bar = trimmed.indexOf('|');
    const label = bar >= 0 ? trimmed.slice(0, bar).trim().slice(0, LABEL_MAX) : '';
    const url = (bar >= 0 ? trimmed.slice(bar + 1) : trimmed).trim().slice(0, URL_MAX);
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    out.push({ label: label || url, url });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Turn the stored links back into the one-per-line text the editor form shows. */
export function linksToText(links: AnnouncementLink[] | null | undefined): string {
  return (links || []).map((l) => (l.label && l.label !== l.url ? l.label + ' | ' + l.url : l.url)).join('\n');
}

/** A date or datetime from a form, or null. An unparseable value is null, never silently "now". */
function parseWhen(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export interface AnnouncementInput {
  title: string;
  summary?: string;
  body: string;
  audience: string;
  scopeId?: string | null;
  scopeLabel?: string | null;
  urgent?: boolean;
  ackRequired?: boolean;
  expiresAt?: string | null;
  links?: AnnouncementLink[];
  changeNote?: string;
}

interface NormalisedInput {
  ok: boolean;
  error?: string;
  value?: {
    title: string;
    summary: string;
    body: string;
    audience: string;
    scopeId: string | null;
    scopeLabel: string;
    urgent: boolean;
    ackRequired: boolean;
    expiresAt: string | null;
    linksJson: string;
    changeNote: string;
  };
}

function normalise(input: AnnouncementInput): NormalisedInput {
  const title = clip(input.title, TITLE_MAX);
  if (!title) return { ok: false, error: 'An announcement needs a title.' };

  const body = clip(input.body, BODY_MAX);
  if (!body) return { ok: false, error: 'An announcement needs something to say.' };

  const audience = String(input.audience || 'company');
  if (!isAnnouncementAudience(audience)) {
    return { ok: false, error: 'That is not an audience this page can address.' };
  }

  let scopeId = clip(input.scopeId, SCOPE_MAX) || null;
  if (audienceNeedsScope(audience)) {
    if (!scopeId) {
      return {
        ok: false,
        error:
          'Pick the ' + audience + ' this is for. An announcement scoped to nothing would reach nobody, ' +
          'so it is refused rather than saved and quietly seen by no one.',
      };
    }
    if ((audience === 'department' || audience === 'project') && !isUuid(scopeId)) {
      return { ok: false, error: 'That is not a ' + audience + ' on record.' };
    }
  } else {
    scopeId = null;
  }

  const expiresAt = parseWhen(input.expiresAt);
  if (input.expiresAt && !expiresAt) {
    return { ok: false, error: 'That expiry date could not be read. Nothing was saved.' };
  }

  return {
    ok: true,
    value: {
      title,
      summary: clip(input.summary, SUMMARY_MAX),
      body,
      audience,
      scopeId,
      scopeLabel: clip(input.scopeLabel, LABEL_MAX),
      urgent: input.urgent === true,
      ackRequired: input.ackRequired === true,
      expiresAt,
      linksJson: JSON.stringify((input.links || []).slice(0, MAX_LINKS)),
      changeNote: clip(input.changeNote, NOTE_MAX),
    },
  };
}

// -------------------------------------------------------------------------------------------------
// SCOPE PICKERS AND REACH. What the compose form offers, and how many people a choice reaches.
// -------------------------------------------------------------------------------------------------

export interface ScopeOption {
  id: string;
  label: string;
  /** How many ACTIVE employees this scope covers right now. Shown so nobody publishes into a void. */
  people: number;
}

/** Departments, with how many active people are in each. departments.id is read ::text, never cast. */
export async function departmentOptions(): Promise<ScopeOption[]> {
  try {
    await ensureAnnouncementSchema();
    return rows(await db.execute(sql`
      SELECT d.id::text AS id,
             d.name AS name,
             COUNT(e.id) FILTER (WHERE e.is_active = true) AS people
        FROM departments d
        LEFT JOIN hr_employees e ON e.department_id::text = d.id::text
       WHERE d.is_active = true
       GROUP BY d.id, d.name
       ORDER BY d.name ASC`)).map((r) => ({
      id: String(r.id),
      label: String(r.name || 'Unnamed department'),
      people: Number(r.people || 0),
    }));
  } catch (e: any) {
    logFail('departmentOptions', e);
    return [];
  }
}

/** Projects that are not finished, with their current member count. */
export async function projectOptions(): Promise<ScopeOption[]> {
  try {
    return rows(await db.execute(sql`
      SELECT p.id::text AS id,
             p.name AS name,
             p.code AS code,
             COUNT(m.id) FILTER (WHERE m.removed_at IS NULL) AS people
        FROM projects p
        LEFT JOIN project_members m ON m.project_id = p.id
       WHERE p.status NOT IN ('closed', 'cancelled')
       GROUP BY p.id, p.name, p.code
       ORDER BY p.name ASC
       LIMIT 200`)).map((r) => ({
      id: String(r.id),
      label: String(r.name || 'Unnamed project') + (r.code ? ' (' + String(r.code) + ')' : ''),
      people: Number(r.people || 0),
    }));
  } catch (e: any) {
    logFail('projectOptions', e);
    return [];
  }
}

/** The working cities on record, with headcount. The value IS the city string, so scope_id is text. */
export async function locationOptions(): Promise<ScopeOption[]> {
  try {
    return rows(await db.execute(sql`
      SELECT btrim(city) AS city, COUNT(*) AS people
        FROM hr_employees
       WHERE is_active = true AND city IS NOT NULL AND btrim(city) <> ''
       GROUP BY btrim(city)
       ORDER BY btrim(city) ASC
       LIMIT 200`)).map((r) => ({
      id: String(r.city),
      label: String(r.city),
      people: Number(r.people || 0),
    }));
  } catch (e: any) {
    logFail('locationOptions', e);
    return [];
  }
}

export interface ScopeChoice {
  audience: AnnouncementAudience;
  scopeId: string | null;
  scopeLabel: string;
}

/**
 * ONE SELECT, NOT TWO, AND NO CLIENT JAVASCRIPT.
 *
 * The compose form offers a single list — "Everyone in the company", then the departments, then the
 * projects, then the locations — and the value carries both halves as `audience:scope`. Two coupled
 * selects would need a script to keep them in step, and a script inside a JSX conditional breaks
 * .astro parsing here; three always-visible scope selects would ask the publisher to ignore two of
 * them. This asks one question once.
 *
 * THE LABEL IS RESOLVED FROM THE OPTIONS THE SERVER BUILT, never from the posted text, so a hand-
 * crafted request cannot put an arbitrary string on an announcement, and an id that is not in the
 * list falls back to "everyone in the company" being REFUSED rather than silently published to all.
 */
export function parseScopeChoice(raw: unknown, options: {
  departments?: ScopeOption[];
  projects?: ScopeOption[];
  locations?: ScopeOption[];
}): { ok: boolean; error?: string; value?: ScopeChoice } {
  const s = String(raw ?? '').trim();
  if (!s || s === 'company') {
    return { ok: true, value: { audience: 'company', scopeId: null, scopeLabel: '' } };
  }
  const cut = s.indexOf(':');
  if (cut < 0) return { ok: false, error: 'Pick who this announcement is for.' };
  const audience = s.slice(0, cut);
  const scopeId = s.slice(cut + 1).trim().slice(0, SCOPE_MAX);
  if (!isAnnouncementAudience(audience) || audience === 'company' || !scopeId) {
    return { ok: false, error: 'Pick who this announcement is for.' };
  }
  const pool =
    audience === 'department' ? options.departments || []
    : audience === 'project' ? options.projects || []
    : options.locations || [];
  const found = pool.find((o) => o.id === scopeId);
  if (!found) {
    return {
      ok: false,
      error: 'That ' + audience + ' is not on the list any more. Pick again — nothing was saved.',
    };
  }
  return { ok: true, value: { audience, scopeId, scopeLabel: found.label } };
}

/** The value a stored announcement corresponds to, so the edit form re-selects the right option. */
export function scopeChoiceValue(a: Announcement): string {
  if (a.audience === 'company' || !a.scopeId) return 'company';
  return a.audience + ':' + a.scopeId;
}

/**
 * THE USER IDS AN AUDIENCE REACHES. Used to notify, and to count.
 *
 * A person with no `users` row cannot be notified in-app — there is nowhere to put the row — so they
 * are absent here by construction rather than by a filter somebody could remove. That is a real
 * limit and the admin screen prints it rather than implying full coverage.
 */
export async function audienceUserIds(audience: string, scopeId: string | null): Promise<string[]> {
  const a = String(audience || 'company');
  try {
    if (a === 'company') {
      return rows(await db.execute(sql`
        SELECT user_id::text AS user_id FROM hr_employees
         WHERE is_active = true AND user_id IS NOT NULL`)).map((r) => String(r.user_id));
    }
    const scope = String(scopeId || '').trim();
    if (!scope) return [];
    if (a === 'department') {
      if (!isUuid(scope)) return [];
      return rows(await db.execute(sql`
        SELECT user_id::text AS user_id FROM hr_employees
         WHERE is_active = true AND user_id IS NOT NULL
           AND department_id::text = ${scope}`)).map((r) => String(r.user_id));
    }
    if (a === 'location') {
      return rows(await db.execute(sql`
        SELECT user_id::text AS user_id FROM hr_employees
         WHERE is_active = true AND user_id IS NOT NULL
           AND lower(btrim(city)) = lower(${scope})`)).map((r) => String(r.user_id));
    }
    if (a === 'project') {
      if (!isUuid(scope)) return [];
      const members = rows(await db.execute(sql`
        SELECT e.user_id::text AS user_id
          FROM project_members m
          JOIN hr_employees e ON e.id = m.employee_id
         WHERE m.project_id = ${scope}::uuid
           AND m.removed_at IS NULL
           AND e.is_active = true
           AND e.user_id IS NOT NULL`)).map((r) => String(r.user_id));
      // Plus whoever the Organization Graph records as RUNNING it. Empty until the backfill runs,
      // which is why membership above is not built on the graph.
      const managers = (await getProjectManagers(scope)).map((p) => p.userId).filter(Boolean) as string[];
      return [...new Set([...members, ...managers])];
    }
    return [];
  } catch (e: any) {
    logFail('audienceUserIds', e);
    return [];
  }
}

/** How many ACTIVE employees an audience covers, whether or not they have a sign-in. */
export async function audienceReach(audience: string, scopeId: string | null): Promise<number> {
  const a = String(audience || 'company');
  try {
    if (a === 'company') {
      const r = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_employees WHERE is_active = true`));
      return Number(r[0]?.n || 0);
    }
    const scope = String(scopeId || '').trim();
    if (!scope) return 0;
    if (a === 'department') {
      if (!isUuid(scope)) return 0;
      const r = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_employees
         WHERE is_active = true AND department_id::text = ${scope}`));
      return Number(r[0]?.n || 0);
    }
    if (a === 'location') {
      const r = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_employees
         WHERE is_active = true AND lower(btrim(city)) = lower(${scope})`));
      return Number(r[0]?.n || 0);
    }
    if (a === 'project') {
      if (!isUuid(scope)) return 0;
      const r = rows(await db.execute(sql`
        SELECT COUNT(DISTINCT m.employee_id)::int AS n
          FROM project_members m
          JOIN hr_employees e ON e.id = m.employee_id
         WHERE m.project_id = ${scope}::uuid AND m.removed_at IS NULL AND e.is_active = true`));
      return Number(r[0]?.n || 0);
    }
    return 0;
  } catch (e: any) {
    logFail('audienceReach', e);
    return 0;
  }
}

/**
 * WHO ANSWERS FOR THIS AUDIENCE, ACCORDING TO THE ORGANIZATION GRAPH — and an honest word when the
 * graph has nothing to answer with.
 *
 * This is not authorization and it decides nothing. It is shown beside a scoped announcement so the
 * person publishing can see who the graph says leads the group they are about to address. Where the
 * graph is not initialized the answer is `initialized: false` and the surface says
 * "Organization Graph not yet initialized" — which is a DIFFERENT statement from "this department
 * has no head", and printing the second when the first is true tells everybody they answer to
 * nobody.
 */
export interface ScopeLeadership {
  initialized: boolean;
  people: OrgPerson[];
  /** What to print when there is nobody. Never invented from a role. */
  note: string;
}

export async function scopeLeadership(audience: string, scopeId: string | null): Promise<ScopeLeadership> {
  const ready = await isInitialized();
  if (!ready) {
    return {
      initialized: false,
      people: [],
      note:
        'Organization Graph not yet initialized, so who leads this group is not on record yet. ' +
        'This does not affect who receives the announcement — that is resolved from the employee ' +
        'records and project membership.',
    };
  }
  const a = String(audience || '');
  const scope = String(scopeId || '').trim();
  try {
    if (a === 'department' && scope) {
      const head = await getDepartmentHead(scope);
      return {
        initialized: true,
        people: head ? [head] : [],
        note: head ? '' : 'No department head on record for this department.',
      };
    }
    if (a === 'project' && scope) {
      const managers = await getProjectManagers(scope);
      return {
        initialized: true,
        people: managers,
        note: managers.length ? '' : 'No project manager on record for this project.',
      };
    }
  } catch (e: any) {
    logFail('scopeLeadership', e);
  }
  return { initialized: true, people: [], note: '' };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface ListOptions {
  audience?: string | null;
  limit?: number;
  /** Admin surface only, and re-checked against the viewer rather than trusted. */
  includeUnpublished?: boolean;
  includeExpired?: boolean;
}

/**
 * The reader's list. Pinned first, then urgent, then newest — and expiry applied in the query, so a
 * notice that has run out simply is not there.
 */
export async function listAnnouncements(
  viewer: FeedViewer,
  opts: ListOptions = {},
): Promise<Announcement[]> {
  if (!viewer.hasWorkspace) return [];
  const limit = Math.min(Math.max(Number(opts.limit || 60), 1), 200);
  const admin = opts.includeUnpublished === true && viewer.canPublish;
  try {
    await ensureAnnouncementSchema();
    // A publisher's console shows drafts, expired notices and every scope — that is what the console
    // is for, and `admin` is derived from viewer.canPublish above rather than from the caller's flag.
    // Everybody else gets the live read narrowed by their own organization facts, in the query.
    const statusPart = admin ? sql`` : liveClause();
    const scopePart = admin ? sql`` : visibilityClause(viewer);
    const audiencePart = opts.audience && isAnnouncementAudience(opts.audience)
      ? sql`AND a.audience = ${opts.audience}`
      : sql``;
    return rows(await db.execute(sql`
      SELECT a.*,
             EXISTS (
               SELECT 1 FROM announcement_acks k
                WHERE k.announcement_id = a.id
                  AND k.version = a.version
                  AND k.user_id::text = ${viewer.userId}::text
             ) AS acknowledged
        FROM announcements a
       WHERE 1=1
         ${statusPart}
         ${scopePart}
         ${audiencePart}
       ORDER BY a.pinned DESC, a.urgent DESC,
                COALESCE(a.published_at, a.created_at) DESC
       LIMIT ${limit}`)).map(mapAnnouncement);
  } catch (e: any) {
    logFail('listAnnouncements', e);
    return [];
  }
}

/**
 * One announcement, re-scoped through the SAME visibility clause.
 *
 * A missing id and one this person may not read give the SAME answer, on purpose: "you are not
 * allowed to see this" confirms it exists, which is a disclosure in itself.
 */
export async function getAnnouncement(viewer: FeedViewer, id: string): Promise<Announcement | null> {
  if (!isUuid(id) || !viewer.hasWorkspace) return null;
  try {
    await ensureAnnouncementSchema();
    // A publisher may open a draft or an expired notice; everybody else gets the live scoped read.
    const gate = viewer.canPublish ? sql`` : sql`${liveClause()} ${visibilityClause(viewer)}`;
    const list = rows(await db.execute(sql`
      SELECT a.*,
             EXISTS (
               SELECT 1 FROM announcement_acks k
                WHERE k.announcement_id = a.id
                  AND k.version = a.version
                  AND k.user_id::text = ${viewer.userId}::text
             ) AS acknowledged
        FROM announcements a
       WHERE a.id = ${id}::uuid
         ${gate}
       LIMIT 1`));
    return list.length ? mapAnnouncement(list[0]) : null;
  } catch (e: any) {
    logFail('getAnnouncement', e);
    return null;
  }
}

/** Live notices this person must acknowledge and has not, at the CURRENT version. */
export async function outstandingAcks(viewer: FeedViewer): Promise<Announcement[]> {
  if (!viewer.hasWorkspace || !viewer.userId) return [];
  try {
    await ensureAnnouncementSchema();
    return rows(await db.execute(sql`
      SELECT a.*, false AS acknowledged
        FROM announcements a
       WHERE a.ack_required = true
         ${liveClause()}
         ${visibilityClause(viewer)}
         AND NOT EXISTS (
           SELECT 1 FROM announcement_acks k
            WHERE k.announcement_id = a.id
              AND k.version = a.version
              AND k.user_id::text = ${viewer.userId}::text
         )
       ORDER BY a.urgent DESC, COALESCE(a.published_at, a.created_at) DESC
       LIMIT 25`)).map(mapAnnouncement);
  } catch (e: any) {
    logFail('outstandingAcks', e);
    return [];
  }
}

export interface AnnouncementCounts {
  published: number;
  drafts: number;
  urgent: number;
  expired: number;
  awaitingAck: number;
}

export async function announcementCounts(): Promise<AnnouncementCounts> {
  const empty: AnnouncementCounts = { published: 0, drafts: 0, urgent: 0, expired: 0, awaitingAck: 0 };
  try {
    await ensureAnnouncementSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'published' AND (expires_at IS NULL OR expires_at > NOW()))::int AS published,
        COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
        COUNT(*) FILTER (WHERE status = 'published' AND urgent = true AND (expires_at IS NULL OR expires_at > NOW()))::int AS urgent,
        COUNT(*) FILTER (WHERE status = 'published' AND expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
        COUNT(*) FILTER (WHERE status = 'published' AND ack_required = true AND (expires_at IS NULL OR expires_at > NOW()))::int AS awaiting_ack
      FROM announcements`));
    const row = r[0] || {};
    return {
      published: Number(row.published || 0),
      drafts: Number(row.drafts || 0),
      urgent: Number(row.urgent || 0),
      expired: Number(row.expired || 0),
      awaitingAck: Number(row.awaiting_ack || 0),
    };
  } catch (e: any) {
    logFail('announcementCounts', e);
    return empty;
  }
}

export interface AckRecord {
  /** The people who DID acknowledge this version, named, most recent first. */
  acknowledged: { name: string; at: string | null }[];
  /** How many of the audience have not. A NUMBER, never a list of names. */
  outstanding: number;
  /** How many people the audience covers right now. */
  reach: number;
  /** How many of those have a sign-in and could therefore be notified in-app. */
  reachable: number;
}

/**
 * THE ACKNOWLEDGEMENT RECORD FOR ONE VERSION.
 *
 * The people who HAVE acknowledged are named — that is an act each of them deliberately performed,
 * and showing it is the entire purpose of the record. The people who have NOT are a COUNT. A screen
 * that lists the names of everybody who has not read the code of conduct is a shame list, and the
 * count is what the person who owns the notice actually needs: it tells them a reminder is due.
 */
export async function ackRecord(viewer: FeedViewer, announcement: Announcement): Promise<AckRecord> {
  const blank: AckRecord = { acknowledged: [], outstanding: 0, reach: 0, reachable: 0 };
  if (!viewer.canPublish || !isUuid(announcement.id)) return blank;
  try {
    await ensureAnnouncementSchema();
    const list = rows(await db.execute(sql`
      SELECT COALESCE(NULLIF(k.person_name, ''), e.full_name, 'Someone') AS name,
             k.acknowledged_at AS at
        FROM announcement_acks k
        LEFT JOIN hr_employees e ON e.id = k.employee_id
       WHERE k.announcement_id = ${announcement.id}::uuid
         AND k.version = ${announcement.version}
       ORDER BY k.acknowledged_at DESC
       LIMIT 500`)).map((r) => ({
      name: String(r.name || 'Someone'),
      at: r.at ? new Date(r.at).toISOString() : null,
    }));

    const reach = await audienceReach(announcement.audience, announcement.scopeId);
    const reachable = (await audienceUserIds(announcement.audience, announcement.scopeId)).length;
    return {
      acknowledged: list,
      outstanding: Math.max(reach - list.length, 0),
      reach,
      reachable,
    };
  } catch (e: any) {
    logFail('ackRecord', e);
    return blank;
  }
}

/** The superseded versions, newest first. Titles and change notes — the record of what changed. */
export async function listVersions(viewer: FeedViewer, id: string): Promise<AnnouncementVersion[]> {
  if (!viewer.canPublish || !isUuid(id)) return [];
  try {
    await ensureAnnouncementSchema();
    return rows(await db.execute(sql`
      SELECT version, title, summary, change_note, author_name, created_at
        FROM announcement_versions
       WHERE announcement_id = ${id}::uuid
       ORDER BY version DESC
       LIMIT 50`)).map((r) => ({
      version: Number(r.version || 0),
      title: String(r.title || ''),
      summary: String(r.summary || ''),
      changeNote: String(r.change_note || ''),
      authorName: String(r.author_name || ''),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail('listVersions', e);
    return [];
  }
}

/** Markdown, rendered on the SERVER. No client parser, no library, no bytes shipped to draw text. */
export function renderAnnouncementHtml(body: string): string {
  return mdLite(String(body || ''));
}

/** A short plain-text preview for a list row. */
export function excerpt(a: Announcement, max = 180): string {
  const raw = (a.summary || a.body || '').replace(/[#*_>`\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}

// -------------------------------------------------------------------------------------------------
// WRITES. Every one re-checks the capability against the POSTED id, never against the rendered page.
// A page gate is a door, not a lock.
// -------------------------------------------------------------------------------------------------

/** Save a NEW announcement as a draft. Nothing is visible to anybody until it is published. */
export async function createAnnouncement(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null; name?: string | null } | null,
  viewer: FeedViewer,
  input: AnnouncementInput,
): Promise<WriteResult> {
  if (!viewer.canPublish || !holdsCapability(user as any, 'announcements.publish')) {
    return { ok: false, error: NOT_YOURS };
  }
  const n = normalise(input);
  if (!n.ok || !n.value) return { ok: false, error: n.error || WRITE_FAILED };
  const v = n.value;
  try {
    await ensureAnnouncementSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO announcements
        (title, summary, body, audience, scope_id, scope_label, urgent, ack_required,
         expires_at, links, author_user_id, author_employee_id, author_name, status)
      VALUES
        (${v.title}, ${v.summary}, ${v.body}, ${v.audience}, ${v.scopeId}, ${v.scopeLabel},
         ${v.urgent}, ${v.ackRequired}, ${v.expiresAt}::timestamptz, ${v.linksJson}::jsonb,
         ${viewer.userId}::uuid, ${viewer.employeeId}::uuid, ${viewer.fullName}, 'draft')
      RETURNING id`));
    const id = r[0]?.id ? String(r[0].id) : '';
    if (!id) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: viewer.userId,
      action: 'announcement.draft',
      entity: 'announcement',
      entityId: id,
      diff: { title: v.title, audience: v.audience, scopeId: v.scopeId },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    // NEVER SWALLOWED. A write path that hides its own failure is how a total sign-in outage stayed
    // invisible for hours here. The real cause goes to the log; the caller gets a sentence.
    logFail('createAnnouncement', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Edit an announcement.
 *
 * ON A PUBLISHED ONE THIS BUMPS THE VERSION AND RE-OPENS EVERY ACKNOWLEDGEMENT, and the outgoing
 * text is written to announcement_versions FIRST so the history is what people actually read. On a
 * draft nothing is versioned — a draft is somebody mid-sentence, and nobody has read it.
 */
export async function updateAnnouncement(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null,
  viewer: FeedViewer,
  id: string,
  input: AnnouncementInput,
): Promise<WriteResult> {
  if (!viewer.canPublish || !holdsCapability(user as any, 'announcements.publish')) {
    return { ok: false, error: NOT_YOURS };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  const n = normalise(input);
  if (!n.ok || !n.value) return { ok: false, error: n.error || WRITE_FAILED };
  const v = n.value;
  try {
    await ensureAnnouncementSchema();
    const current = rows(await db.execute(sql`
      SELECT id, title, summary, body, links, status, version, author_name
        FROM announcements WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!current) return { ok: false, error: NOT_AVAILABLE };

    const wasPublished = String(current.status || '') === 'published';

    if (wasPublished) {
      // The OUTGOING text, kept before it is overwritten.
      await db.execute(sql`
        INSERT INTO announcement_versions
          (announcement_id, version, title, summary, body, links, change_note, author_user_id, author_name)
        VALUES
          (${id}::uuid, ${Number(current.version || 1)}, ${String(current.title || '')},
           ${String(current.summary || '')}, ${String(current.body || '')},
           ${JSON.stringify(toLinks(current.links))}::jsonb, ${v.changeNote},
           ${viewer.userId}::uuid, ${viewer.fullName})
        ON CONFLICT (announcement_id, version) DO NOTHING`);
    }

    await db.execute(sql`
      UPDATE announcements
         SET title = ${v.title},
             summary = ${v.summary},
             body = ${v.body},
             audience = ${v.audience},
             scope_id = ${v.scopeId},
             scope_label = ${v.scopeLabel},
             urgent = ${v.urgent},
             ack_required = ${v.ackRequired},
             expires_at = ${v.expiresAt}::timestamptz,
             links = ${v.linksJson}::jsonb,
             version = version + (${wasPublished ? 1 : 0})::int,
             updated_at = NOW()
       WHERE id = ${id}::uuid`);

    await logAudit({
      userId: viewer.userId,
      action: wasPublished ? 'announcement.revise' : 'announcement.edit',
      entity: 'announcement',
      entityId: id,
      diff: { title: v.title, audience: v.audience, scopeId: v.scopeId, changeNote: v.changeNote },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('updateAnnouncement', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Publish a draft, and notify the people who need telling.
 *
 * WHO IS NOTIFIED, AND WHO IS NOT. An ordinary notice creates no notification at all — the feed is
 * where it belongs, and a company that pings everybody about everything trains everybody to ignore
 * the ping. An URGENT notice, or one that asks for an acknowledgement, IS notified to its audience,
 * because both of those are the publisher saying "this needs you to do something".
 *
 * A FAILED NOTIFICATION DOES NOT UNDO THE PUBLISH, and the caller is told the number that got
 * through rather than a claim that everybody was reached.
 */
export async function publishAnnouncement(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null,
  viewer: FeedViewer,
  id: string,
): Promise<WriteResult> {
  if (!viewer.canPublish || !holdsCapability(user as any, 'announcements.publish')) {
    return { ok: false, error: NOT_YOURS };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureAnnouncementSchema();
    const current = rows(await db.execute(sql`
      SELECT id, title, summary, audience, scope_id, scope_label, urgent, ack_required, status, expires_at
        FROM announcements WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!current) return { ok: false, error: NOT_AVAILABLE };
    if (String(current.status || '') === 'published') {
      return { ok: true, id, changed: false, notified: 0 };
    }
    if (current.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
      return {
        ok: false,
        error:
          'That expiry has already passed, so publishing it would show it to nobody. Move the expiry ' +
          'date first.',
      };
    }

    await db.execute(sql`
      UPDATE announcements
         SET status = 'published',
             published_at = COALESCE(published_at, NOW()),
             updated_at = NOW()
       WHERE id = ${id}::uuid`);

    await logAudit({
      userId: viewer.userId,
      action: 'announcement.publish',
      entity: 'announcement',
      entityId: id,
      diff: {
        title: String(current.title || ''),
        audience: String(current.audience || ''),
        scopeId: current.scope_id ? String(current.scope_id) : null,
        urgent: current.urgent === true,
        ackRequired: current.ack_required === true,
      },
    });

    let notified = 0;
    if (current.urgent === true || current.ack_required === true) {
      notified = await notifyAudience({
        audience: String(current.audience || 'company'),
        scopeId: current.scope_id ? String(current.scope_id) : null,
        title: (current.urgent === true ? 'Urgent: ' : '') + String(current.title || 'Announcement'),
        body: current.ack_required === true
          ? String(current.summary || '') + ' This one asks you to confirm you have read it.'
          : String(current.summary || ''),
        announcementId: id,
      });
    }

    return { ok: true, id, changed: true, notified };
  } catch (e: any) {
    logFail('publishAnnouncement', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Pin or unpin. Pinned notices sort to the top of every feed that may see them. */
export async function setPinned(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null,
  viewer: FeedViewer,
  id: string,
  pinned: boolean,
): Promise<WriteResult> {
  if (!viewer.canPublish || !holdsCapability(user as any, 'announcements.publish')) {
    return { ok: false, error: NOT_YOURS };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureAnnouncementSchema();
    await db.execute(sql`
      UPDATE announcements SET pinned = ${pinned === true}, updated_at = NOW()
       WHERE id = ${id}::uuid`);
    await logAudit({
      userId: viewer.userId,
      action: pinned ? 'announcement.pin' : 'announcement.unpin',
      entity: 'announcement',
      entityId: id,
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('setPinned', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Archive with a reason. NOT a delete — there is no delete anywhere in this module.
 *
 * "What did the company tell people in March" is a question this record exists to answer, and a
 * deleted row answers nothing.
 */
export async function archiveAnnouncement(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null,
  viewer: FeedViewer,
  id: string,
  reason: string,
): Promise<WriteResult> {
  if (!viewer.canPublish || !holdsCapability(user as any, 'announcements.publish')) {
    return { ok: false, error: NOT_YOURS };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  const why = clip(reason, NOTE_MAX);
  if (!why) {
    return { ok: false, error: 'Say why it is being taken down. It stays on the record either way.' };
  }
  try {
    await ensureAnnouncementSchema();
    await db.execute(sql`
      UPDATE announcements
         SET status = 'archived', archived_at = NOW(), archive_reason = ${why}, pinned = false,
             updated_at = NOW()
       WHERE id = ${id}::uuid`);
    await logAudit({
      userId: viewer.userId,
      action: 'announcement.archive',
      entity: 'announcement',
      entityId: id,
      diff: { reason: why },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('archiveAnnouncement', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * ACKNOWLEDGE. The reader's own act.
 *
 * The user id comes from the SESSION and never from a form field, so no shape of request
 * acknowledges a notice on somebody else's behalf. The announcement is re-read through the same
 * visibility clause first, so a notice this person may not see cannot be acknowledged by posting its
 * id, and the row is written against the CURRENT version — acknowledging version 2 says nothing
 * about version 3.
 */
export async function acknowledgeAnnouncement(viewer: FeedViewer, id: string): Promise<WriteResult> {
  if (!viewer.userId || !viewer.hasWorkspace) {
    return { ok: false, error: 'You need to be signed in to confirm you have read this.' };
  }
  if (!isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureAnnouncementSchema();
    const live = rows(await db.execute(sql`
      SELECT a.id, a.version, a.ack_required, a.title
        FROM announcements a
       WHERE a.id = ${id}::uuid
         ${liveClause()}
         ${visibilityClause(viewer)}
       LIMIT 1`))[0];
    if (!live) return { ok: false, error: NOT_AVAILABLE };
    if (live.ack_required !== true) {
      return { ok: false, error: 'This announcement does not ask for a confirmation.' };
    }

    const r = rows(await db.execute(sql`
      INSERT INTO announcement_acks (announcement_id, version, user_id, employee_id, person_name)
      VALUES (${id}::uuid, ${Number(live.version || 1)}, ${viewer.userId}::uuid,
              ${viewer.employeeId}::uuid, ${viewer.fullName})
      ON CONFLICT (announcement_id, version, user_id) DO NOTHING
      RETURNING id`));
    const changed = r.length > 0;
    if (changed) {
      await logAudit({
        userId: viewer.userId,
        action: 'announcement.acknowledge',
        entity: 'announcement',
        entityId: id,
        diff: { version: Number(live.version || 1) },
      });
    }
    return { ok: true, id, changed };
  } catch (e: any) {
    logFail('acknowledgeAnnouncement', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Notify an audience through notify.ts — THE notifier. No second table, no second de-duplication
 * rule, no second retry policy.
 *
 * Waves of NOTIFY_BATCH rather than one-at-a-time, and never capped: see the note on the constant.
 *
 * THE RETURN IS AN ISSUE COUNT, NOT A DELIVERY COUNT. notifyUser() swallows and logs its own
 * failures, so a fulfilled promise means "the call did not throw", never "the row is there". The
 * number is reported to the publisher with that caveat attached rather than dressed up as delivery.
 */
async function notifyAudience(opts: {
  audience: string;
  scopeId: string | null;
  title: string;
  body: string;
  announcementId: string;
}): Promise<number> {
  const ids = await audienceUserIds(opts.audience, opts.scopeId);
  let sent = 0;
  for (let i = 0; i < ids.length; i += NOTIFY_BATCH) {
    const wave = ids.slice(i, i + NOTIFY_BATCH);
    const results = await Promise.allSettled(
      wave.map((uid) =>
        notifyUser(uid, {
          title: opts.title,
          body: opts.body,
          type: 'info',
          actionUrl: '/portal/feed/company?a=' + encodeURIComponent(opts.announcementId),
          entityType: 'announcement',
          entityId: opts.announcementId,
        }),
      ),
    );
    sent += results.filter((r) => r.status === 'fulfilled').length;
  }
  return sent;
}

// -------------------------------------------------------------------------------------------------
// CELEBRATION CONSENT. Read and written by the person themselves, and by nobody else.
// -------------------------------------------------------------------------------------------------

export interface CelebrationOptIn {
  showBirthday: boolean;
  showAnniversary: boolean;
  showJoining: boolean;
  /** Does this person even have the dates the settings refer to? An honest empty state needs this. */
  hasBirthday: boolean;
  hasJoiningDate: boolean;
}

/** THE DEFAULT IS OFF, and the absence of a row means off. Never inferred, never assumed. */
export async function getCelebrationOptIn(viewer: FeedViewer): Promise<CelebrationOptIn> {
  const off: CelebrationOptIn = {
    showBirthday: false,
    showAnniversary: false,
    showJoining: false,
    hasBirthday: false,
    hasJoiningDate: false,
  };
  if (!viewer.employeeId) return off;
  try {
    await ensureAnnouncementSchema();
    const pref = rows(await db.execute(sql`
      SELECT show_birthday, show_anniversary, show_joining
        FROM feed_celebration_optin WHERE employee_id = ${viewer.employeeId}::uuid LIMIT 1`))[0];
    const dates = rows(await db.execute(sql`
      SELECT (date_of_birth IS NOT NULL) AS has_dob, (joining_date IS NOT NULL) AS has_join
        FROM hr_employees WHERE id = ${viewer.employeeId}::uuid LIMIT 1`))[0];
    return {
      showBirthday: pref?.show_birthday === true,
      showAnniversary: pref?.show_anniversary === true,
      showJoining: pref?.show_joining === true,
      hasBirthday: dates?.has_dob === true,
      hasJoiningDate: dates?.has_join === true,
    };
  } catch (e: any) {
    logFail('getCelebrationOptIn', e);
    return off;
  }
}

/**
 * Set the three switches. THE EMPLOYEE ID COMES FROM THE SESSION VIEWER, never from a form field —
 * so no shape of request switches somebody else's birthday on, and there is no admin surface
 * anywhere in this module that can do it either. Consent that an administrator can grant on your
 * behalf is not consent.
 */
export async function setCelebrationOptIn(
  viewer: FeedViewer,
  next: { showBirthday: boolean; showAnniversary: boolean; showJoining: boolean },
): Promise<WriteResult> {
  if (!viewer.employeeId) {
    return {
      ok: false,
      error:
        'These settings belong to an employee record, and there is no employee record linked to this ' +
        'account yet.',
    };
  }
  try {
    await ensureAnnouncementSchema();
    await db.execute(sql`
      INSERT INTO feed_celebration_optin
        (employee_id, user_id, show_birthday, show_anniversary, show_joining, updated_at)
      VALUES
        (${viewer.employeeId}::uuid, ${viewer.userId}::uuid, ${next.showBirthday === true},
         ${next.showAnniversary === true}, ${next.showJoining === true}, NOW())
      ON CONFLICT (employee_id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            show_birthday = EXCLUDED.show_birthday,
            show_anniversary = EXCLUDED.show_anniversary,
            show_joining = EXCLUDED.show_joining,
            updated_at = NOW()`);
    await logAudit({
      userId: viewer.userId,
      action: 'feed.celebration_optin',
      entity: 'employee',
      entityId: viewer.employeeId,
      diff: {
        showBirthday: next.showBirthday === true,
        showAnniversary: next.showAnniversary === true,
        showJoining: next.showJoining === true,
      },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('setCelebrationOptIn', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// MILESTONES. Derived from the employee record at read time, and shown ONLY with consent.
// -------------------------------------------------------------------------------------------------

export const MILESTONE_KINDS = ['birthday', 'anniversary', 'joiner'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export interface Milestone {
  kind: MilestoneKind;
  employeeId: string;
  name: string;
  departmentName: string | null;
  designation: string | null;
  /** Years, for an anniversary. Zero for the other two. */
  years: number;
  /** The day it falls on, ISO date. NEVER the year of birth — that is not published anywhere. */
  on: string;
}

/**
 * WHAT IS AND IS NOT PUBLISHED HERE.
 *
 * A birthday milestone carries the DAY AND MONTH and never the year, because the year is the piece
 * that makes a date of birth an identifier. An anniversary carries the number of years, which is a
 * fact about employment rather than about a body. Neither appears at all without an explicit opt-in
 * row, and the opt-in defaults to off.
 *
 * The window is deliberately narrow — the coming week and the last two days — so the feed shows
 * "this week" rather than becoming a searchable calendar of everybody's date of birth.
 */
export async function upcomingMilestones(viewer: FeedViewer, days = 7): Promise<Milestone[]> {
  if (!viewer.hasWorkspace) return [];
  const window = Math.min(Math.max(Number(days) || 7, 1), 31);
  try {
    await ensureAnnouncementSchema();
    const out: Milestone[] = [];

    const birthdays = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name AS name, e.designation AS designation,
             d.name AS department_name,
             to_char(e.date_of_birth, 'MM-DD') AS md
        FROM hr_employees e
        JOIN feed_celebration_optin o ON o.employee_id = e.id AND o.show_birthday = true
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = true
         AND e.date_of_birth IS NOT NULL
         AND (
           to_char(e.date_of_birth, 'MM-DD') = ANY (
             SELECT to_char(gs, 'MM-DD')
               FROM generate_series(NOW() - INTERVAL '2 days',
                                    NOW() + ((${window})::int * INTERVAL '1 day'),
                                    INTERVAL '1 day') AS gs
           )
         )
       ORDER BY to_char(e.date_of_birth, 'MM-DD') ASC
       LIMIT 60`));
    for (const r of birthdays) {
      out.push({
        kind: 'birthday',
        employeeId: String(r.id),
        name: String(r.name || ''),
        departmentName: r.department_name ? String(r.department_name) : null,
        designation: r.designation ? String(r.designation) : null,
        years: 0,
        on: String(r.md || ''),
      });
    }

    const anniversaries = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name AS name, e.designation AS designation,
             d.name AS department_name,
             to_char(e.joining_date, 'MM-DD') AS md,
             (EXTRACT(YEAR FROM AGE(NOW(), e.joining_date)))::int AS years
        FROM hr_employees e
        JOIN feed_celebration_optin o ON o.employee_id = e.id AND o.show_anniversary = true
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = true
         AND e.joining_date IS NOT NULL
         AND e.joining_date < NOW() - INTERVAL '11 months'
         AND (
           to_char(e.joining_date, 'MM-DD') = ANY (
             SELECT to_char(gs, 'MM-DD')
               FROM generate_series(NOW() - INTERVAL '2 days',
                                    NOW() + ((${window})::int * INTERVAL '1 day'),
                                    INTERVAL '1 day') AS gs
           )
         )
       ORDER BY to_char(e.joining_date, 'MM-DD') ASC
       LIMIT 60`));
    for (const r of anniversaries) {
      const years = Number(r.years || 0);
      if (years < 1) continue;
      out.push({
        kind: 'anniversary',
        employeeId: String(r.id),
        name: String(r.name || ''),
        departmentName: r.department_name ? String(r.department_name) : null,
        designation: r.designation ? String(r.designation) : null,
        years,
        on: String(r.md || ''),
      });
    }

    const joiners = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name AS name, e.designation AS designation,
             d.name AS department_name,
             to_char(e.joining_date, 'YYYY-MM-DD') AS on_date
        FROM hr_employees e
        JOIN feed_celebration_optin o ON o.employee_id = e.id AND o.show_joining = true
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = true
         AND e.joining_date IS NOT NULL
         AND e.joining_date >= (NOW() - INTERVAL '30 days')
         AND e.joining_date <= NOW()
       ORDER BY e.joining_date DESC
       LIMIT 40`));
    for (const r of joiners) {
      out.push({
        kind: 'joiner',
        employeeId: String(r.id),
        name: String(r.name || ''),
        departmentName: r.department_name ? String(r.department_name) : null,
        designation: r.designation ? String(r.designation) : null,
        years: 0,
        on: String(r.on_date || ''),
      });
    }

    return out;
  } catch (e: any) {
    logFail('upcomingMilestones', e);
    return [];
  }
}

export function milestoneLabel(m: Milestone): string {
  if (m.kind === 'birthday') return 'Birthday';
  if (m.kind === 'anniversary') return m.years === 1 ? 'One year here' : m.years + ' years here';
  return 'Joined us';
}
