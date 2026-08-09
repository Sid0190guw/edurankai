// src/lib/eims-activity.ts — WHAT THE INTERN DID. The activity taxonomy, and the three hour states.
//
// =================================================================================================
// THE THING THIS FILE EXISTS TO REPLACE
// =================================================================================================
//
// Until now every hour credited to an intern came out of hr_attendance.work_hours — a clock-in, a
// clock-out, minus breaks. That answers "was the intern logged in". It does not answer "what did the
// intern do", and the two give different answers about the same week: a full genuine day of project
// work counts for nothing when a phone fails to fire clock-out, and a clock left running counts for
// a full day nobody worked.
//
// An ACTIVITY is the unit that answers the real question. It has a title, a type from a configurable
// taxonomy, a number of ALLOCATED hours, a deadline, a named mentor, an evidence requirement, the
// learning outcomes it is meant to serve, and a record of who allocated it.
//
// =================================================================================================
// THREE HOUR STATES, NEVER COLLAPSED INTO ONE COLUMN
// =================================================================================================
//
//   ALLOCATED   the plan. Written when the work is handed out, by the person handing it out, and
//               only ever through src/lib/eims-workload.ts allocateActivity() — because an
//               allocation that has not been projected against the weekly ceiling is exactly the
//               overload this system exists to refuse. There is no other writer of allocated_hours
//               in this codebase and this file deliberately does not export one.
//
//   COMPLETED   what the intern REPORTS they actually spent. Stored honestly, including when it is
//               more than was allocated. Storing 5 against an allocation of 4 is not a fault to be
//               truncated away; it is information a mentor needs.
//
//   VERIFIED    what a MENTOR says actually happened, having looked at the evidence. Written by
//               exactly one function in this file, which requires a named human verifier, a written
//               note, and refuses when the verifier is the intern themself. No cron writes it. No
//               bulk verifier exists. No status transition sets it as a side effect.
//
// They are three columns because they are three different facts. One column would mean the moment
// somebody edits the number, the record can no longer say whether it was a plan, a claim or a
// finding — which is the whole reason a completion letter with a bare hours total is worthless.
//
// =================================================================================================
// REPORTED IS RECORDED. RECOGNISED IS CAPPED.
// =================================================================================================
//
// An intern may report five hours against a four-hour allocation. Five is stored. FOUR IS
// RECOGNISED. Recognising the fifth requires an explicit uplift by the mentor or the manager, WITH A
// REASON, recorded against the activity and in the audit log. That is what "reported effort above
// allocated is recorded but not automatically recognised" means in storage rather than in prose, and
// it is why recognitionCap() is a pure exported function: the form that shows somebody what will be
// recognised and the write that decides it are THE SAME RULE.
//
// =================================================================================================
// WHY THIS EXTENDS employee_tasks INSTEAD OF CREATING AN ACTIVITY TABLE
// =================================================================================================
//
// src/lib/employee-tasks.ts already owns assigned work: one canonical status vocabulary, one
// TRANSITIONS map, one visibleToSql() answer to who may see a piece of work, one answer to who may
// assign it. Its own header argues at length against a second task table, and every word of that
// argument applies here: an "activity" that was a separate row would need a second status
// vocabulary, a second visibility rule and a second answer to who may assign, and those three would
// start out agreeing and end up disagreeing. An activity IS a task with hours, a type, a mentor and
// an evidence requirement recorded on it.
//
// THE COLUMNS ARE ASSERTED FROM HERE, NOT FROM employee-tasks.ts, and that follows the pattern
// src/lib/attendance-verify.ts already set when it added its outcome columns to hr_attendance: a
// feature that extends another module's table brings its own ensureOnce key. 'employee_tasks_v3' is
// SPENT — a key that has already run in a process never runs again — so statements appended to it
// would never appear on any environment that has booted the current code. This file's key is
// 'eims_activity_v1' and it calls ensureTaskSchema() first, so the table it alters exists.
//
// =================================================================================================
// WHAT THIS FILE WILL NOT DO
// =================================================================================================
//
//   - IT STORES NO EVIDENCE LINK. An activity carries the evidence REQUIREMENT — whether evidence
//     must be produced at all. The links themselves (a Drive document, a pull request, an LMS entry,
//     a notebook) belong to the evidence graph, which must reference this activity's id. A link
//     column here would become a second place evidence lives, next to hr_daily_reports.report_url
//     and project_deliverables.link_url, and the second one is always the one that goes stale.
//   - IT ACCEPTS NO UPLOAD, of any kind. Documents on this platform are links.
//   - IT RECORDS NOTHING ABOUT A PERSON BEYOND THE HOURS. Holistic fitness and well-being hours are
//     counted; what anybody actually did in them is not stored, asked for, or inferred. No webcam,
//     no screenshot, no keystroke, and no column here that one could later be written into.
//   - IT NEVER DECIDES. Nothing in this file labels anybody. A discrepancy between reported and
//     verified hours is a number a mentor reads; it is not a verdict, and no function here produces
//     one.
//
// =================================================================================================
// WHERE THE NEIGHBOURING MODULES STAND, SO NOBODY HAS TO GUESS LATER
// =================================================================================================
//
// THE HOUR OF RECORD IS employee_tasks.verified_hours, WRITTEN ONLY BY verifyActivity() BELOW. That
// is the figure src/lib/eims-workload.ts caps at the ceiling and returns as the week's recognised
// hours, and it is the figure a credit week and a completion letter must read.
//
//   src/lib/eims-evidence.ts owns EVIDENCE: the links, their review trail, and the verdict a mentor
//   records against a piece of evidence. Its `eims_evidence_links` table also carries
//   `hours_claimed` and `hours_verified` columns, written by its own recordVerdict(). THOSE ARE NOT
//   A SECOND HOUR OF RECORD AND MUST NOT BECOME ONE. The reconciliation is one direction:
//   recordVerdict() should call verifyActivity() so a mentor's verdict lands on the activity, and
//   those two columns should be a display of it. Two writers of "verified hours" is the exact defect
//   this phase exists to remove, and it is listed as a follow-up rather than resolved silently here.
//
//   src/lib/eims-outcomes.ts owns LEARNING OUTCOMES: the catalogue, the many-to-many mapping
//   (eims_outcome_links, keyed by source and activity id), coverage and attainment. See the note on
//   the learning_outcomes column below for what this module still stores and why that column is
//   temporary.
//
// EduRankAI is the technology platform. Hours recorded here are a record of work done on this
// platform; accredited partners award credentials, and nothing in this file confers one.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { ensureTaskSchema, STATUS_LABELS, canonicalStatus, type TaskStatus } from '@/lib/employee-tasks';
import { weekStartOf, weekEndOf } from '@/lib/credit-week';
import {
  isInitialized as orgIsInitialized, getManager, getMentor, getDepartmentHead, getReviewSubjects,
  employeeIdForUser,
} from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the function that reads it. `const` is not hoisted,
// and on this project a const declared below its first use threw on the first line of two production
// surfaces while both reported success.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never { rows }. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-activity] ' + tag, e?.cause?.message || e?.message);

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found and not-yours refusal, so probing ids cannot tell them apart. */
const NOT_AVAILABLE = 'That activity is not available.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** A reason attached to a decision has to be a sentence somebody wrote, not a keystroke. */
export const REASON_MIN = 10;

/** Nobody works 168 hours on one activity. A refusal, never a silent truncation. */
const MAX_HOURS_PER_ACTIVITY = 168;

/** Activities read for one person for one week. A cohort console pages rather than widening this. */
const MAX_ACTIVITIES_PER_WEEK = 200;

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

const stamp = (d: any): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
};

/** '4 hours', '1 hour', '4.5 hours'. Used in every sentence this engine returns. */
export function hoursWord(n: number): string {
  const v = round2(Math.max(0, Number(n) || 0));
  return v === 1 ? '1 hour' : v + ' hours';
}

// -------------------------------------------------------------------------------------------------
// THE TAXONOMY
// -------------------------------------------------------------------------------------------------

/**
 * WHAT MUST BE PRODUCED FOR AN ACTIVITY TO BE VERIFIABLE.
 *
 *   'required'  a mentor may not verify hours without naming what they looked at.
 *   'optional'  evidence helps and is asked for, but its absence does not block verification.
 *   'none'      no artefact is expected at all.
 *
 * 'none' exists for exactly one seeded category and the reason is a privacy rule, not a convenience:
 * holistic fitness and well-being hours are counted, and what a person actually did in them is
 * nobody's business. Requiring proof of a personal health practice would make this system ask for
 * the one class of data it must never hold.
 */
export const EVIDENCE_REQUIREMENTS = ['required', 'optional', 'none'] as const;
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number];

const EVIDENCE_SET = new Set<string>(EVIDENCE_REQUIREMENTS);

export function isEvidenceRequirement(v: unknown): v is EvidenceRequirement {
  return typeof v === 'string' && EVIDENCE_SET.has(v);
}

/** Plain words for a screen. No emoji anywhere in this codebase — inline monochrome SVG only. */
export const EVIDENCE_REQUIREMENT_LABELS: Record<EvidenceRequirement, string> = {
  required: 'Evidence required',
  optional: 'Evidence helpful',
  none: 'No evidence expected',
};

export interface ActivityType {
  /** Stable lowercase key. Stored on the activity; never renamed once it is in use. */
  key: string;
  label: string;
  description: string;
  /**
   * True for the holistic well-being category, for ONE purpose: a screen can show the split between
   * project work and well-being the way the published policy states it.
   *
   * IT IS NOT AN EXEMPTION, and there is deliberately no column that could become one. Well-being
   * hours sit INSIDE the weekly ceiling. Forty plus two is the arithmetic this product refuses.
   */
  wellbeing: boolean;
  defaultEvidence: EvidenceRequirement;
  sortOrder: number;
  active: boolean;
}

/**
 * THE SEEDED CATEGORIES, in the founder specification's own order.
 *
 * The taxonomy is CONFIGURABLE — these rows are written with ON CONFLICT DO NOTHING, so an
 * administrator's edit is never overwritten by a deploy, and a category can be retired by making it
 * inactive rather than deleted (deleting one would orphan every activity already recorded against
 * it). These are the starting vocabulary, not the permitted vocabulary.
 */
export const SEED_ACTIVITY_TYPES: ActivityType[] = [
  {
    key: 'technical_project',
    label: 'Technical and project work',
    description: 'Building, engineering and delivery work on a project or a department responsibility.',
    wellbeing: false, defaultEvidence: 'required', sortOrder: 10, active: true,
  },
  {
    key: 'assignment',
    label: 'Assignment',
    description: 'A set piece of work with a deliverable and a deadline.',
    wellbeing: false, defaultEvidence: 'required', sortOrder: 20, active: true,
  },
  {
    key: 'lecture',
    label: 'Lecture',
    description: 'A taught session attended, live or recorded.',
    wellbeing: false, defaultEvidence: 'optional', sortOrder: 30, active: true,
  },
  {
    key: 'learning',
    label: 'Learning and training',
    description: 'Structured self-directed study, a course module, or an assigned training path.',
    wellbeing: false, defaultEvidence: 'required', sortOrder: 40, active: true,
  },
  {
    key: 'meeting',
    label: 'Meeting',
    description: 'A standup, a review, a mentor session, or a working discussion.',
    wellbeing: false, defaultEvidence: 'optional', sortOrder: 50, active: true,
  },
  {
    key: 'assessment',
    label: 'Assessment',
    description: 'A test, a viva, a code review under assessment, or a graded exercise.',
    wellbeing: false, defaultEvidence: 'required', sortOrder: 60, active: true,
  },
  {
    key: 'documentation',
    label: 'Documentation',
    description: 'Writing that is the deliverable: notes, specifications, runbooks, reports.',
    wellbeing: false, defaultEvidence: 'required', sortOrder: 70, active: true,
  },
  {
    key: 'professional_development',
    label: 'Professional development',
    description: 'Communication, collaboration and career skills practised deliberately.',
    wellbeing: false, defaultEvidence: 'optional', sortOrder: 80, active: true,
  },
  {
    key: 'holistic_fitness',
    label: 'Holistic fitness and well-being',
    description: 'Physical fitness, mindfulness, reading, reflective learning, leadership development '
      + 'and community engagement. The hours are counted and sit inside the weekly ceiling. What was '
      + 'done in them is not recorded here and is never asked for.',
    wellbeing: true, defaultEvidence: 'none', sortOrder: 90, active: true,
  },
];

/** Fallback when the taxonomy table cannot be read. A missing table is not an empty vocabulary. */
const SEED_BY_KEY: Map<string, ActivityType> = new Map(SEED_ACTIVITY_TYPES.map((t) => [t.key, t]));

/** The key an activity carries when nobody classified it. Never written; only read back. */
export const UNCLASSIFIED_TYPE_KEY = 'unclassified';

export const UNCLASSIFIED_TYPE: ActivityType = {
  key: UNCLASSIFIED_TYPE_KEY,
  label: 'Not classified',
  description: 'No activity type was recorded on this work. It is listed so it is not invisible, and '
    + 'it contributes no hours until somebody classifies it.',
  wellbeing: false, defaultEvidence: 'optional', sortOrder: 999, active: false,
};

const normaliseKey = (v: unknown): string =>
  String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, additive, inside ONE ensureOnce guard with a key of its own.
// -------------------------------------------------------------------------------------------------

/**
 * Create the taxonomy table and assert the activity columns on employee_tasks.
 *
 * Re-throws after logging, exactly as ensureTaskSchema() does: ensureOnce() drops a failed run from
 * its cache so the next call retries, and swallows the rejection for callers so a reader that
 * tolerates missing schema keeps tolerating it. Without the try/catch a failed CREATE leaves no
 * trace anywhere and the only symptom is an empty screen.
 */
export function ensureActivitySchema(): Promise<void> {
  return ensureOnce('eims_activity_v1', async () => {
    try {
      await createActivityTables();
    } catch (e: any) {
      logFail('ensureActivitySchema', e);
      throw e;
    }
  });
}

async function createActivityTables(): Promise<void> {
  // employee_tasks is created by src/lib/employee-tasks.ts. Its ensure swallows failure, so the
  // ALTERs below are what would actually surface a missing table — which is the correct direction to
  // fail: without those columns there is no activity engine, and every reader here says so.
  await ensureTaskSchema();

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_activity_types (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    wellbeing BOOLEAN NOT NULL DEFAULT FALSE,
    default_evidence TEXT NOT NULL DEFAULT 'optional',
    sort_order INT NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const stmt of [
    "ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS wellbeing BOOLEAN NOT NULL DEFAULT FALSE',
    "ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS default_evidence TEXT NOT NULL DEFAULT 'optional'",
    'ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 100',
    'ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE',
    'ALTER TABLE eims_activity_types ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  // -----------------------------------------------------------------------------------------------
  // THE ACTIVITY COLUMNS. Additive, every one nullable or defaulted, so a task written before this
  // feature existed is still a valid row and simply carries no hours.
  //
  // THREE SEPARATE HOUR COLUMNS, and that is the design rather than an accident of storage. An
  // UPDATE in this file names exactly the columns for the state it is writing: reportEffort() cannot
  // touch verified_hours because it does not mention it, and verifyActivity() cannot invent reported
  // effort because it does not mention that either.
  // -----------------------------------------------------------------------------------------------
  for (const stmt of [
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS activity_type TEXT',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS allocated_hours NUMERIC(6,2)',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS allocated_by_user_id UUID',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS allocated_at TIMESTAMPTZ',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS reported_hours NUMERIC(6,2)',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS reported_by_user_id UUID',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS reported_note TEXT',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS verified_hours NUMERIC(6,2)',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS verified_by_user_id UUID',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS verification_note TEXT',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS uplift_hours NUMERIC(6,2) NOT NULL DEFAULT 0',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS uplift_reason TEXT',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS uplift_by_user_id UUID',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS uplift_at TIMESTAMPTZ',
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS mentor_user_id UUID',
    "ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS evidence_requirement TEXT NOT NULL DEFAULT 'optional'",
    // THE OUTCOMES STATED WHEN THE WORK WAS HANDED OUT, in the allocator's own words, one per line.
    //
    // IT IS NOT THE OUTCOME CATALOGUE AND IT MUST NOT GROW INTO ONE. src/lib/eims-outcomes.ts owns
    // the catalogue and the many-to-many mapping in eims_outcome_links (an activity serves several
    // outcomes, an outcome is reached through several activities — a column on either side would
    // force one of those to be false), and it is the authority for coverage and attainment.
    //
    // This column exists for one reason: an activity allocated before anybody seeded the catalogue
    // would otherwise record NOTHING about what it was for, and "no outcome recorded" reads on a
    // completion letter exactly like "this work served no purpose". Where a mapping exists, the
    // mapping wins and this text is a note beside it. RETIRE THIS COLUMN once the allocation form
    // can reach setActivityOutcomes(); it is a stated follow-up, not a design.
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS learning_outcomes TEXT',
    // A LINK, not a copy: the learning side of an activity keeps living in hr_learning_assignments
    // and its progress keeps coming from src/lib/learning-progress.ts, which is already the single
    // definition of progress after two writers previously disagreed about it. No foreign key — this
    // module must not assume another module's table exists, and a reference to a deleted assignment
    // should lose its label rather than take the activity with it.
    'ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS learning_assignment_id UUID',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  // The week rollup reads one person's activities by deadline. Everything else rides existing
  // indexes declared by employee-tasks.ts.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_tasks_activity_week_idx
    ON employee_tasks (employee_id, due_on, activity_type)`);

  // Seeding is its own try/catch: a taxonomy that fails to seed leaves the code constants as the
  // vocabulary (listActivityTypes falls back to them), which is a degraded read rather than an
  // outage. Losing the columns above is not survivable; losing the seed rows is.
  try {
    for (const t of SEED_ACTIVITY_TYPES) {
      await db.execute(sql`
        INSERT INTO eims_activity_types (key, label, description, wellbeing, default_evidence, sort_order, active)
        VALUES (${t.key}, ${t.label}, ${t.description}, ${t.wellbeing}, ${t.defaultEvidence}, ${t.sortOrder}, ${t.active})
        ON CONFLICT (key) DO NOTHING`);
    }
  } catch (e: any) {
    logFail('seed activity types', e);
  }
}

// -------------------------------------------------------------------------------------------------
// THE TAXONOMY, AS CALLERS SEE IT
// -------------------------------------------------------------------------------------------------

function mapType(r: any): ActivityType {
  const ev = String(r.default_evidence || 'optional');
  return {
    key: String(r.key || ''),
    label: String(r.label || r.key || ''),
    description: String(r.description || ''),
    wellbeing: r.wellbeing === true || r.wellbeing === 't' || r.wellbeing === 1,
    defaultEvidence: isEvidenceRequirement(ev) ? ev : 'optional',
    sortOrder: Number(r.sort_order ?? 100),
    active: !(r.active === false || r.active === 'f' || r.active === 0),
  };
}

export interface ActivityTypeRead {
  ok: boolean;
  types: ActivityType[];
  /** True when these are the code constants because the table could not be read. Say so on screen. */
  fallback: boolean;
}

/**
 * The configured taxonomy, ordered as it is meant to be rendered.
 *
 * `includeInactive` exists so an admin screen can show a retired category and an activity recorded
 * against it can still print its label. A picker asks for the default.
 */
export async function listActivityTypes(includeInactive = false): Promise<ActivityTypeRead> {
  const seeds = SEED_ACTIVITY_TYPES.filter((t) => includeInactive || t.active);
  try {
    await ensureActivitySchema();
    const clause = includeInactive ? sql`` : sql`WHERE active = TRUE`;
    const list = rows(await db.execute(sql`
      SELECT key, label, description, wellbeing, default_evidence, sort_order, active
        FROM eims_activity_types
        ${clause}
       ORDER BY sort_order ASC, label ASC
       LIMIT 200`)).map(mapType);
    if (!list.length) return { ok: true, types: seeds, fallback: true };
    return { ok: true, types: list, fallback: false };
  } catch (e: any) {
    logFail('listActivityTypes', e);
    return { ok: false, types: seeds, fallback: true };
  }
}

/** One type by key, from the table, falling back to the code constant, then to 'unclassified'. */
export async function activityTypeFor(key: unknown): Promise<ActivityType> {
  const k = normaliseKey(key);
  if (!k) return UNCLASSIFIED_TYPE;
  try {
    await ensureActivitySchema();
    const r = rows(await db.execute(sql`
      SELECT key, label, description, wellbeing, default_evidence, sort_order, active
        FROM eims_activity_types WHERE key = ${k} LIMIT 1`))[0];
    if (r) return mapType(r);
  } catch (e: any) {
    logFail('activityTypeFor', e);
  }
  return SEED_BY_KEY.get(k) || { ...UNCLASSIFIED_TYPE, key: k, label: k };
}

export interface TypeWriteResult { ok: boolean; error: string }

/**
 * Add a category or change one. CONFIGURABLE means an administrator, not a deploy.
 *
 * The key is normalised and immutable in effect: writing an existing key updates its label,
 * description, evidence default and order, and never rewrites the key itself, because activities
 * already store it. There is NO delete — retiring a category is `active = false`, which keeps every
 * hour already recorded against it readable.
 */
export async function upsertActivityType(input: {
  key: string;
  label: string;
  description?: string | null;
  wellbeing?: boolean;
  defaultEvidence?: EvidenceRequirement;
  sortOrder?: number;
  active?: boolean;
  actorUserId?: string | null;
}): Promise<TypeWriteResult> {
  const key = normaliseKey(input.key);
  const label = String(input.label || '').trim().slice(0, 120);
  if (!key) return { ok: false, error: 'Give the category a key, in lowercase letters and underscores.' };
  if (key === UNCLASSIFIED_TYPE_KEY) {
    return { ok: false, error: 'That key is reserved for work nobody has classified yet.' };
  }
  if (label.length < 2) return { ok: false, error: 'Give the category a name.' };

  const evidence: EvidenceRequirement = isEvidenceRequirement(input.defaultEvidence)
    ? input.defaultEvidence : 'optional';
  const order = Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 100;
  const active = input.active !== false;
  const wellbeing = input.wellbeing === true;
  const description = String(input.description || '').trim().slice(0, 1000);

  try {
    await ensureActivitySchema();
    await db.execute(sql`
      INSERT INTO eims_activity_types (key, label, description, wellbeing, default_evidence, sort_order, active)
      VALUES (${key}, ${label}, ${description}, ${wellbeing}, ${evidence}, ${order}, ${active})
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        wellbeing = EXCLUDED.wellbeing,
        default_evidence = EXCLUDED.default_evidence,
        sort_order = EXCLUDED.sort_order,
        active = EXCLUDED.active,
        updated_at = NOW()`);

    await logAudit({
      userId: input.actorUserId || null,
      action: 'eims.activity_type.save',
      entity: 'eims_activity_type',
      entityId: key,
      diff: { label, wellbeing, evidence, order, active },
    });
    return { ok: true, error: '' };
  } catch (e: any) {
    // NEVER SWALLOWED. The caller is told the write did not happen, and the log carries the real
    // Postgres reason rather than the SQL that failed.
    logFail('upsertActivityType', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE PURE RULES. Same input, same answer, no database — so the form that previews what will be
// recognised and the write that decides it cannot drift apart.
// -------------------------------------------------------------------------------------------------

/**
 * The most that may be recognised on one activity.
 *
 * Null when nothing was allocated: an activity with no allocation has nothing to cap against, and
 * inventing a cap from the reported figure would make "reported" and "recognised" the same number,
 * which is the defect this engine exists to remove.
 */
export function recognitionCap(allocatedHours: number | null, upliftHours: number | null): number | null {
  const a = Number(allocatedHours);
  if (!Number.isFinite(a) || a < 0) return null;
  const u = Number(upliftHours);
  return round2(a + (Number.isFinite(u) && u > 0 ? u : 0));
}

/** What is recognised from a reported figure. Never more than the cap, never negative. */
export function recognisedFromReported(reportedHours: number | null, cap: number | null): number {
  const r = Number(reportedHours);
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (cap == null) return 0;
  return round2(Math.min(r, cap));
}

/** Reported effort above what may be recognised. Recorded, shown, and never quietly discarded. */
export function reportedAboveAllocated(reportedHours: number | null, cap: number | null): number {
  const r = Number(reportedHours);
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (cap == null) return round2(r);
  return round2(Math.max(0, r - cap));
}

/** Learning outcomes are one per line. Parsed here so every surface splits them the same way. */
export function outcomeLines(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

// -------------------------------------------------------------------------------------------------
// THE ACTIVITY, AS CALLERS SEE IT
// -------------------------------------------------------------------------------------------------

export interface ActivityRow {
  id: string;
  employeeId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  statusLabel: string;
  /** True for cancelled and archived: nothing is owed on them and they carry no allocation. */
  closed: boolean;

  activityTypeKey: string;
  activityTypeLabel: string;
  wellbeing: boolean;

  /** The deadline. It is also what puts the activity in a week — see activityWeekOf(). */
  deadline: string | null;
  weekStart: string;

  allocatedHours: number | null;
  allocatedByUserId: string | null;
  allocatedAt: string | null;

  reportedHours: number | null;
  reportedByUserId: string | null;
  reportedAt: string | null;
  reportedNote: string | null;

  verifiedHours: number | null;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  verified: boolean;

  upliftHours: number;
  upliftReason: string | null;
  upliftByUserId: string | null;
  upliftAt: string | null;

  mentorUserId: string | null;
  assignedByUserId: string | null;
  evidenceRequirement: EvidenceRequirement;
  evidenceRequirementLabel: string;
  learningOutcomes: string[];
  learningAssignmentId: string | null;

  /** Derived, never stored: allocated + uplift. Null when nothing was allocated. */
  recognitionCapHours: number | null;
  /** Derived: what would be recognised from the reported figure. */
  recognisedFromReportHours: number;
  /** Derived: reported above the cap. Recorded, not recognised. */
  aboveAllocationHours: number;
  /** Derived: allocated work not yet verified. Zero on a closed activity. */
  outstandingHours: number;
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : null;
};

function mapActivity(r: any, types: Map<string, ActivityType>): ActivityRow {
  const status = canonicalStatus(r.status) || 'assigned';
  const closed = status === 'cancelled' || status === 'archived';
  const key = normaliseKey(r.activity_type) || UNCLASSIFIED_TYPE_KEY;
  const type = types.get(key) || SEED_BY_KEY.get(key) || { ...UNCLASSIFIED_TYPE, key, label: key === UNCLASSIFIED_TYPE_KEY ? UNCLASSIFIED_TYPE.label : key };

  const allocated = closed ? null : num(r.allocated_hours);
  const uplift = closed ? 0 : (num(r.uplift_hours) ?? 0);
  const reported = num(r.reported_hours);
  const verified = closed ? null : num(r.verified_hours);
  const cap = recognitionCap(allocated, uplift);
  const deadline = iso(r.due_on) || null;
  const ev = String(r.evidence_requirement || type.defaultEvidence || 'optional');

  return {
    id: String(r.id),
    employeeId: String(r.employee_id || ''),
    title: String(r.title || 'Activity'),
    description: r.description ? String(r.description) : null,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    closed,

    activityTypeKey: key,
    activityTypeLabel: type.label,
    wellbeing: type.wellbeing === true,

    deadline,
    weekStart: deadline ? weekStartOf(deadline) : '',

    allocatedHours: allocated,
    allocatedByUserId: r.allocated_by_user_id ? String(r.allocated_by_user_id) : null,
    allocatedAt: stamp(r.allocated_at),

    reportedHours: reported,
    reportedByUserId: r.reported_by_user_id ? String(r.reported_by_user_id) : null,
    reportedAt: stamp(r.reported_at),
    reportedNote: r.reported_note ? String(r.reported_note) : null,

    verifiedHours: verified,
    verifiedByUserId: r.verified_by_user_id ? String(r.verified_by_user_id) : null,
    verifiedAt: stamp(r.verified_at),
    verificationNote: r.verification_note ? String(r.verification_note) : null,
    verified: r.verified_at != null && !closed,

    upliftHours: uplift,
    upliftReason: r.uplift_reason ? String(r.uplift_reason) : null,
    upliftByUserId: r.uplift_by_user_id ? String(r.uplift_by_user_id) : null,
    upliftAt: stamp(r.uplift_at),

    mentorUserId: r.mentor_user_id ? String(r.mentor_user_id) : null,
    assignedByUserId: r.assigned_by_user_id ? String(r.assigned_by_user_id) : null,
    evidenceRequirement: isEvidenceRequirement(ev) ? ev : 'optional',
    evidenceRequirementLabel: EVIDENCE_REQUIREMENT_LABELS[isEvidenceRequirement(ev) ? ev : 'optional'],
    learningOutcomes: outcomeLines(r.learning_outcomes),
    learningAssignmentId: r.learning_assignment_id ? String(r.learning_assignment_id) : null,

    recognitionCapHours: cap,
    recognisedFromReportHours: recognisedFromReported(reported, cap),
    aboveAllocationHours: reportedAboveAllocated(reported, cap),
    outstandingHours: closed || allocated == null ? 0 : round2(Math.max(0, allocated - (verified ?? 0))),
  };
}

/** Every column this module reads. Named explicitly, so an unrelated added column is invisible. */
const ACTIVITY_COLUMNS = sql`
  t.id, t.employee_id, t.title, t.description, t.status, t.due_on, t.assigned_by_user_id,
  t.activity_type, t.allocated_hours, t.allocated_by_user_id, t.allocated_at,
  t.reported_hours, t.reported_by_user_id, t.reported_at, t.reported_note,
  t.verified_hours, t.verified_by_user_id, t.verified_at, t.verification_note,
  t.uplift_hours, t.uplift_reason, t.uplift_by_user_id, t.uplift_at,
  t.mentor_user_id, t.evidence_requirement, t.learning_outcomes, t.learning_assignment_id`;

/**
 * WHICH WEEK AN ACTIVITY BELONGS TO: the ISO week its DEADLINE falls in, Monday to Sunday.
 *
 * This is not a new week boundary. It is the one src/lib/credit-week.ts declares and the one
 * credit-week-ledger.ts already uses for assigned work ("tasks that FELL DUE inside the range"), so
 * an activity and the credit week that recognises it can never disagree about which seven days they
 * are talking about. An activity with no deadline belongs to NO week and is counted against none —
 * inventing a week for it would make somebody's recognised hours depend on the day a colleague
 * happened to create a row.
 */
export function activityWeekOf(deadlineIso: string | null | undefined): string {
  const d = String(deadlineIso || '').slice(0, 10);
  return DATE_RE.test(d) ? weekStartOf(d) : '';
}

export interface ActivityRead {
  ok: boolean;
  activities: ActivityRow[];
  /** Names what could NOT be read, so a total is never built on a silent gap. */
  unread: string[];
  error: string;
}

/**
 * Every activity whose deadline falls inside one week, for one person.
 *
 * ON A DATABASE WHERE THE ALTERs HAVE NOT RUN the first SELECT throws because it names columns that
 * do not exist. The retry reads the base task columns and pushes 'activity hours' onto `unread` —
 * so the week renders the work with no hours on it and SAYS the hours could not be read, instead of
 * rendering zero hours as a fact about somebody's week.
 */
export async function readActivitiesForWeek(
  employeeId: string,
  weekStartIso: string,
): Promise<ActivityRead> {
  const out: ActivityRead = { ok: false, activities: [], unread: [], error: '' };
  if (!isUuid(employeeId)) return { ...out, error: NOT_AVAILABLE };

  const start = weekStartOf(String(weekStartIso || '').slice(0, 10));
  const end = weekEndOf(start);
  if (!start || !end) return { ...out, error: 'That is not a week we can read.' };

  const typeRead = await listActivityTypes(true);
  const types = new Map<string, ActivityType>(typeRead.types.map((t) => [t.key, t]));
  if (!typeRead.ok) out.unread.push('the activity taxonomy');

  try {
    await ensureActivitySchema();
    const list = rows(await db.execute(sql`
      SELECT ${ACTIVITY_COLUMNS}
        FROM employee_tasks t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.due_on BETWEEN ${start}::date AND ${end}::date
       ORDER BY t.due_on ASC, t.created_at ASC
       LIMIT ${MAX_ACTIVITIES_PER_WEEK}`));
    out.activities = list.map((r) => mapActivity(r, types));
    out.ok = true;
    return out;
  } catch (e: any) {
    logFail('readActivitiesForWeek', e);
  }

  try {
    const list = rows(await db.execute(sql`
      SELECT t.id, t.employee_id, t.title, t.description, t.status, t.due_on, t.assigned_by_user_id
        FROM employee_tasks t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.due_on BETWEEN ${start}::date AND ${end}::date
       ORDER BY t.due_on ASC, t.created_at ASC
       LIMIT ${MAX_ACTIVITIES_PER_WEEK}`));
    out.activities = list.map((r) => mapActivity(r, types));
    out.ok = true;
    out.unread.push('activity hours');
    return out;
  } catch (e: any) {
    logFail('readActivitiesForWeek fallback', e);
    out.unread.push('this week\'s activities');
    out.error = 'This week\'s activities could not be read. That is a failure to read them, not an '
      + 'empty week.';
    return out;
  }
}

/**
 * EVERY ACTIVITY WHOSE DEADLINE FALLS INSIDE A DATE RANGE, for one person.
 *
 * THE SAME MAPPER, THE SAME COLUMNS AND THE SAME FALLBACK as readActivitiesForWeek() above — this is
 * that function with the week boundary widened, and it exists because two surfaces need a span
 * rather than seven days: the intern's own ledger table (which is the authoritative record they are
 * entitled to read in full) and the advisory layer (which compares a run of weeks against each
 * other). Writing either of those against employee_tasks directly would be a second mapper, and the
 * second mapper is the one that forgets that a cancelled activity carries no allocation.
 *
 * The range is bounded by the caller and capped here, because a ledger with no limit is a page that
 * eventually stops rendering on a phone.
 */
export async function readActivitiesInRange(
  employeeId: string,
  fromIso: string,
  toIso: string,
  limit = 400,
): Promise<ActivityRead> {
  const out: ActivityRead = { ok: false, activities: [], unread: [], error: '' };
  if (!isUuid(employeeId)) return { ...out, error: NOT_AVAILABLE };

  const from = String(fromIso || '').slice(0, 10);
  const to = String(toIso || '').slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) {
    return { ...out, error: 'That is not a range of dates we can read.' };
  }
  const cap = Math.min(Math.max(Number(limit) || 400, 1), 1000);

  const typeRead = await listActivityTypes(true);
  const types = new Map<string, ActivityType>(typeRead.types.map((t) => [t.key, t]));
  if (!typeRead.ok) out.unread.push('the activity taxonomy');

  try {
    await ensureActivitySchema();
    const list = rows(await db.execute(sql`
      SELECT ${ACTIVITY_COLUMNS}
        FROM employee_tasks t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.due_on BETWEEN ${from}::date AND ${to}::date
       ORDER BY t.due_on DESC, t.created_at DESC
       LIMIT ${cap}`));
    out.activities = list.map((r) => mapActivity(r, types));
    out.ok = true;
    return out;
  } catch (e: any) {
    logFail('readActivitiesInRange', e);
  }

  try {
    const list = rows(await db.execute(sql`
      SELECT t.id, t.employee_id, t.title, t.description, t.status, t.due_on, t.assigned_by_user_id
        FROM employee_tasks t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.due_on BETWEEN ${from}::date AND ${to}::date
       ORDER BY t.due_on DESC, t.created_at DESC
       LIMIT ${cap}`));
    out.activities = list.map((r) => mapActivity(r, types));
    out.ok = true;
    // The work is real and is shown; the HOURS could not be read, and saying so is the difference
    // between an honest ledger and one that reports zero hours as a fact about somebody.
    out.unread.push('activity hours');
    return out;
  } catch (e: any) {
    logFail('readActivitiesInRange fallback', e);
    out.unread.push('activities');
    out.error = 'Those activities could not be read. That is a failure to read them, not an empty '
      + 'record.';
    return out;
  }
}

/** One activity, with its type resolved. Null when there is no such row. */
export async function getActivity(activityId: string): Promise<ActivityRow | null> {
  if (!isUuid(activityId)) return null;
  try {
    await ensureActivitySchema();
    const typeRead = await listActivityTypes(true);
    const types = new Map<string, ActivityType>(typeRead.types.map((t) => [t.key, t]));
    const r = rows(await db.execute(sql`
      SELECT ${ACTIVITY_COLUMNS} FROM employee_tasks t WHERE t.id = ${activityId}::uuid LIMIT 1`))[0];
    return r ? mapActivity(r, types) : null;
  } catch (e: any) {
    logFail('getActivity', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// WHO MAY DO WHAT. Relationships come from the Organization Graph, never from users.role and never
// from a job title.
// -------------------------------------------------------------------------------------------------

/** The user account behind an employee row, for the "nobody verifies their own work" test. */
async function userIdOfEmployee(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    return r?.user_id ? String(r.user_id) : null;
  } catch (e: any) {
    logFail('userIdOfEmployee', e);
    return null;
  }
}

export interface AuthorityCheck {
  ok: boolean;
  /** How the actor is entitled, for the record. Null when they are not. */
  via: 'reporting_manager' | 'mentor' | 'department_head' | 'reviewer' | 'named_mentor' | null;
  /** A sentence a person can act on. Empty when ok. */
  reason: string;
}

const GRAPH_NOT_READY: AuthorityCheck = {
  ok: false, via: null,
  reason: 'The Organization Graph has not been initialized yet, so who is entitled to allocate or '
    + 'verify this person\'s work is not recorded anywhere we are willing to read. Nothing is guessed '
    + 'from a job title.',
};

/**
 * May this user allocate work to this person?
 *
 * The reporting manager, the mentor, or the head of the person's department — resolved per row from
 * the graph. NOT the intern themself: an intern proposing their own week is a different act with a
 * different approval loop, and letting it in through this door would make the ceiling something a
 * person can set for themselves.
 */
export async function mayAllocateTo(userId: string, employeeId: string): Promise<AuthorityCheck> {
  if (!isUuid(userId) || !isUuid(employeeId)) return { ok: false, via: null, reason: NOT_AVAILABLE };

  const ready = await orgIsInitialized();
  if (!ready) return GRAPH_NOT_READY;

  const actor = await employeeIdForUser(userId);
  if (!actor) {
    return {
      ok: false, via: null,
      reason: 'This sign-in has no employee record linked to it, so the graph has no relationship to '
        + 'read from it. Ask HR to link the employee record.',
    };
  }
  if (actor === employeeId) {
    return {
      ok: false, via: null,
      reason: 'Hours cannot be allocated to yourself. An intern-proposed week is a separate request '
        + 'that a mentor or manager approves.',
    };
  }

  const manager = await getManager(employeeId);
  if (manager?.employeeId === actor) return { ok: true, via: 'reporting_manager', reason: '' };

  const mentor = await getMentor(employeeId);
  if (mentor?.employeeId === actor) return { ok: true, via: 'mentor', reason: '' };

  const head = await getDepartmentHead(employeeId);
  if (head?.employeeId === actor) return { ok: true, via: 'department_head', reason: '' };

  return {
    ok: false, via: null,
    reason: 'The Organization Graph does not record you as this person\'s reporting manager, mentor '
      + 'or department head, so this is not yours to allocate.',
  };
}

/**
 * May this user VERIFY this activity's hours?
 *
 * THE MENTOR NAMED ON THE ACTIVITY comes first, because an activity may be mentored by somebody
 * other than the standing mentor and that assignment is the whole point of naming one. Otherwise the
 * graph: mentor, reporting manager, department head, or a recorded reviewer edge.
 *
 * HR IS NOT ON THIS LIST, DELIBERATELY. `employee.manage` is standing authority over the HR desk and
 * over the credit-week DECISION — it is not authority to state that somebody's hours happened.
 * Verification is a mentor's finding about work they saw. Mapping the HR key here would hand the
 * desk that prints the completion letter the power to write the numbers it prints.
 */
export async function mayVerifyActivity(userId: string, activity: ActivityRow): Promise<AuthorityCheck> {
  if (!isUuid(userId) || !activity) return { ok: false, via: null, reason: NOT_AVAILABLE };

  const subjectUserId = await userIdOfEmployee(activity.employeeId);
  if (subjectUserId && subjectUserId === userId) {
    return {
      ok: false, via: null,
      reason: 'Nobody verifies their own hours. Report what you spent; your mentor verifies it.',
    };
  }

  if (activity.mentorUserId && activity.mentorUserId === userId) {
    return { ok: true, via: 'named_mentor', reason: '' };
  }

  const ready = await orgIsInitialized();
  if (!ready) return GRAPH_NOT_READY;

  const actor = await employeeIdForUser(userId);
  if (!actor) {
    return {
      ok: false, via: null,
      reason: 'This sign-in has no employee record linked to it, so the graph has no relationship to '
        + 'read from it. Ask HR to link the employee record.',
    };
  }
  if (actor === activity.employeeId) {
    return {
      ok: false, via: null,
      reason: 'Nobody verifies their own hours. Report what you spent; your mentor verifies it.',
    };
  }

  const mentor = await getMentor(activity.employeeId);
  if (mentor?.employeeId === actor) return { ok: true, via: 'mentor', reason: '' };

  const manager = await getManager(activity.employeeId);
  if (manager?.employeeId === actor) return { ok: true, via: 'reporting_manager', reason: '' };

  const head = await getDepartmentHead(activity.employeeId);
  if (head?.employeeId === actor) return { ok: true, via: 'department_head', reason: '' };

  const subjects = await getReviewSubjects(actor);
  if (subjects.some((p) => p.employeeId === activity.employeeId)) {
    return { ok: true, via: 'reviewer', reason: '' };
  }

  return {
    ok: false, via: null,
    reason: 'The Organization Graph does not record you as this person\'s mentor, reporting manager, '
      + 'department head or reviewer, so these hours are not yours to verify.',
  };
}

// -------------------------------------------------------------------------------------------------
// STATE TWO: WHAT THE INTERN REPORTS
// -------------------------------------------------------------------------------------------------

export interface ActivityWriteResult {
  ok: boolean;
  error: string;
  /** The activity as it stands after the write, so a caller never re-reads to render. */
  activity: ActivityRow | null;
  /** Sentences worth putting on the screen even when ok is true. */
  notes: string[];
}

const failed = (error: string, notes: string[] = []): ActivityWriteResult =>
  ({ ok: false, error, activity: null, notes });

/**
 * Record what the intern actually spent.
 *
 * THIS FUNCTION CANNOT WRITE A VERIFIED HOUR. Its UPDATE names reported_hours, reported_by_user_id,
 * reported_at and reported_note, and nothing else. That is not a convention, it is the mechanism.
 *
 * REPORTING MORE THAN WAS ALLOCATED IS ALLOWED AND IS KEPT. The figure is stored as given; what it
 * changes is only what may be RECOGNISED, and the returned notes say so in words rather than leaving
 * somebody to discover it on a completion letter.
 *
 * REPORTING AFTER VERIFICATION IS REFUSED. A mentor's finding was made against a stated figure, and
 * silently moving that figure underneath it would leave a verification that says something nobody
 * decided. The way back is reopenVerification(), which is a named act with a reason.
 */
export async function reportEffort(input: {
  activityId: string;
  actorUserId: string;
  hours: number;
  note?: string | null;
  ipAddress?: string | null;
}): Promise<ActivityWriteResult> {
  const activityId = String(input.activityId || '').trim();
  const actor = String(input.actorUserId || '').trim();
  if (!isUuid(activityId) || !isUuid(actor)) return failed(NOT_AVAILABLE);

  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0) {
    return failed('Give the hours you spent as a number, for example 4 or 4.5.');
  }
  if (hours > MAX_HOURS_PER_ACTIVITY) {
    return failed('That is more hours than there are in a week. Check the figure and try again. '
      + 'Nothing was changed.');
  }

  const activity = await getActivity(activityId);
  if (!activity) return failed(NOT_AVAILABLE);

  const subjectUserId = await userIdOfEmployee(activity.employeeId);
  const isOwner = subjectUserId != null && subjectUserId === actor;
  let recordedFor = '';
  if (!isOwner) {
    // Somebody recording on the intern's behalf must be entitled to, and the row remembers it was
    // not the intern who typed it.
    const check = await mayAllocateTo(actor, activity.employeeId);
    if (!check.ok) return failed(check.reason || NOT_AVAILABLE);
    recordedFor = 'Recorded on this person\'s behalf by their ' + (check.via || 'manager').replace(/_/g, ' ') + '.';
  }

  if (activity.verified) {
    return failed('These hours have already been verified by a mentor, so the reported figure can no '
      + 'longer be changed. Ask your mentor to reopen the verification if the figure is wrong. '
      + 'Nothing was changed.');
  }
  if (activity.closed) {
    return failed('This activity is ' + activity.statusLabel.toLowerCase() + ', so no effort can be '
      + 'reported against it. Nothing was changed.');
  }

  const note = String(input.note || '').trim().slice(0, 2000) || null;

  try {
    await ensureActivitySchema();
    // The precondition is repeated in the statement: two requests racing on the same activity cannot
    // both land, and a verification that arrived in between wins.
    const r = rows(await db.execute(sql`
      UPDATE employee_tasks
         SET reported_hours = ${round2(hours)},
             reported_by_user_id = ${actor}::uuid,
             reported_at = NOW(),
             reported_note = ${note},
             updated_at = NOW()
       WHERE id = ${activityId}::uuid
         AND verified_at IS NULL
         AND status NOT IN ('cancelled', 'archived')
      RETURNING id`))[0];

    if (!r?.id) {
      return failed('That could not be recorded: the activity was verified or closed while this page '
        + 'was open. Nothing was changed.');
    }

    await logAudit({
      userId: actor,
      action: 'eims.activity.report',
      entity: 'employee_task',
      entityId: activityId,
      diff: { hours: round2(hours), allocated: activity.allocatedHours, onBehalf: !isOwner },
      ipAddress: input.ipAddress || undefined,
    });

    const after = await getActivity(activityId);
    const notes: string[] = [];
    if (recordedFor) notes.push(recordedFor);
    if (after && after.aboveAllocationHours > 0) {
      notes.push('You reported ' + hoursWord(hours) + ' against an allocation of '
        + (after.recognitionCapHours == null ? 'no recorded hours' : hoursWord(after.recognitionCapHours))
        + '. The full figure is kept on the record. '
        + hoursWord(after.aboveAllocationHours) + ' of it is above the allocation and is not '
        + 'recognised automatically: your mentor can recognise it with a written reason.');
    }
    if (after && after.allocatedHours == null) {
      notes.push('No hours were allocated to this activity, so nothing can be recognised from this '
        + 'report until somebody records the allocation.');
    }
    return { ok: true, error: '', activity: after, notes };
  } catch (e: any) {
    logFail('reportEffort', e);
    return failed(WRITE_FAILED);
  }
}

// -------------------------------------------------------------------------------------------------
// THE UPLIFT: recognising more than was allocated, with a reason, by a named person.
// -------------------------------------------------------------------------------------------------

/**
 * Raise what may be recognised on one activity.
 *
 * IT WRITES NO HOURS OF ITS OWN. It moves the CAP, and the reason is stored beside it, so a
 * completion letter can always answer "why was this person recognised for six hours on a four-hour
 * task" with a sentence somebody wrote and signed.
 *
 * Anybody entitled to verify the activity may uplift it — the mentor named on it, or the mentor,
 * manager, department head or reviewer the graph names.
 */
export async function recordUplift(input: {
  activityId: string;
  actorUserId: string;
  upliftHours: number;
  reason: string;
  ipAddress?: string | null;
}): Promise<ActivityWriteResult> {
  const activityId = String(input.activityId || '').trim();
  const actor = String(input.actorUserId || '').trim();
  if (!isUuid(activityId) || !isUuid(actor)) return failed(NOT_AVAILABLE);

  const uplift = Number(input.upliftHours);
  if (!Number.isFinite(uplift) || uplift < 0) {
    return failed('Give the extra hours to recognise as a number, for example 2.');
  }
  if (uplift > MAX_HOURS_PER_ACTIVITY) {
    return failed('That is more hours than there are in a week. Nothing was changed.');
  }

  const reason = String(input.reason || '').trim().slice(0, 2000);
  if (reason.length < REASON_MIN) {
    return failed('Recognising more hours than were allocated needs a written reason. Say what the '
      + 'extra time went on. Nothing was changed.');
  }

  const activity = await getActivity(activityId);
  if (!activity) return failed(NOT_AVAILABLE);
  if (activity.closed) {
    return failed('This activity is ' + activity.statusLabel.toLowerCase() + '. Nothing was changed.');
  }
  if (activity.allocatedHours == null) {
    return failed('This activity has no allocated hours, so there is nothing to uplift. Record the '
      + 'allocation first. Nothing was changed.');
  }

  const check = await mayVerifyActivity(actor, activity);
  if (!check.ok) return failed(check.reason || NOT_AVAILABLE);

  try {
    await ensureActivitySchema();
    const r = rows(await db.execute(sql`
      UPDATE employee_tasks
         SET uplift_hours = ${round2(uplift)},
             uplift_reason = ${reason},
             uplift_by_user_id = ${actor}::uuid,
             uplift_at = NOW(),
             updated_at = NOW()
       WHERE id = ${activityId}::uuid
         AND status NOT IN ('cancelled', 'archived')
      RETURNING id`))[0];

    if (!r?.id) return failed('That could not be recorded. Nothing was changed.');

    await logAudit({
      userId: actor,
      action: 'eims.activity.uplift',
      entity: 'employee_task',
      entityId: activityId,
      diff: {
        upliftHours: round2(uplift), reason: reason.slice(0, 300),
        allocated: activity.allocatedHours, via: check.via,
      },
      ipAddress: input.ipAddress || undefined,
    });

    const after = await getActivity(activityId);
    return {
      ok: true, error: '', activity: after,
      notes: ['Up to ' + hoursWord((after?.recognitionCapHours) ?? 0) + ' may now be recognised on '
        + 'this activity. The reason is kept with the record.'],
    };
  } catch (e: any) {
    logFail('recordUplift', e);
    return failed(WRITE_FAILED);
  }
}

// -------------------------------------------------------------------------------------------------
// STATE THREE: VERIFICATION. The only writer of verified_hours in this codebase.
// -------------------------------------------------------------------------------------------------

/**
 * A MENTOR STATES WHAT ACTUALLY HAPPENED.
 *
 * FIVE THINGS ARE TRUE OF THIS FUNCTION AND EACH IS LOAD-BEARING:
 *
 *   1. A NAMED HUMAN. verifierUserId is required and is written into the row. There is no system
 *      user, no cron entry point, no bulk verifier, and nothing in this module calls it.
 *   2. NOT THE INTERN. mayVerifyActivity() refuses the subject's own account and their own employee
 *      record, before anything is read for the write.
 *   3. NEVER MORE THAN WAS REPORTED. You cannot verify effort nobody claimed. Refused in words.
 *   4. NEVER MORE THAN THE CAP unless an uplift with a reason comes with it, in which case the
 *      uplift is recorded as its own fact with its own author, in the same statement.
 *   5. EVIDENCE WHERE THE TYPE REQUIRES IT. The mentor must say what they looked at. This module
 *      stores that sentence; the LINKS belong to the evidence graph and are not copied here.
 *
 * It states nothing about the person. A mentor who cannot verify the hours records the hours they
 * can verify and says why in the note; nothing here labels anybody, and nothing here penalises.
 */
export async function verifyActivity(input: {
  activityId: string;
  verifierUserId: string;
  hours: number;
  /** What the mentor looked at. Required when the activity's type requires evidence. */
  evidenceSeen?: string | null;
  note?: string | null;
  /** Supply BOTH to recognise above the allocation in the same act. */
  upliftHours?: number | null;
  upliftReason?: string | null;
  ipAddress?: string | null;
}): Promise<ActivityWriteResult> {
  const activityId = String(input.activityId || '').trim();
  const verifier = String(input.verifierUserId || '').trim();
  if (!isUuid(activityId) || !isUuid(verifier)) return failed(NOT_AVAILABLE);

  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0) {
    return failed('Give the hours you are verifying as a number, for example 4 or 4.5.');
  }
  if (hours > MAX_HOURS_PER_ACTIVITY) {
    return failed('That is more hours than there are in a week. Nothing was changed.');
  }

  const activity = await getActivity(activityId);
  if (!activity) return failed(NOT_AVAILABLE);
  if (activity.closed) {
    return failed('This activity is ' + activity.statusLabel.toLowerCase() + ', so there is nothing '
      + 'to verify. Nothing was changed.');
  }

  const check = await mayVerifyActivity(verifier, activity);
  if (!check.ok) return failed(check.reason || NOT_AVAILABLE);

  if (activity.verified) {
    return failed('These hours were already verified on ' + (activity.verifiedAt || '').slice(0, 10)
      + '. Reopen the verification first if it needs changing. Nothing was changed.');
  }

  const reported = activity.reportedHours;
  if (reported == null) {
    return failed('Nothing has been reported against this activity yet, so there are no hours to '
      + 'verify. Nothing was changed.');
  }
  if (round2(hours) > round2(reported)) {
    return failed('You are verifying ' + hoursWord(hours) + ' against ' + hoursWord(reported)
      + ' reported. Hours nobody claimed cannot be verified. Ask for the report to be corrected '
      + 'first. Nothing was changed.');
  }

  if (activity.allocatedHours == null) {
    return failed('This activity has no allocated hours, so there is no basis to recognise against. '
      + 'Record the allocation first. Nothing was changed.');
  }

  const evidenceSeen = String(input.evidenceSeen || '').trim().slice(0, 1000);
  if (activity.evidenceRequirement === 'required' && evidenceSeen.length < 3) {
    return failed('This kind of activity needs evidence. Say what you looked at — the document, the '
      + 'pull request, the notebook or the course record. Nothing was changed.');
  }

  // ---- the cap, and the only way past it -------------------------------------------------------
  const upliftRaw = Number(input.upliftHours);
  const wantsUplift = Number.isFinite(upliftRaw) && upliftRaw > 0;
  const upliftReason = String(input.upliftReason || '').trim().slice(0, 2000);
  const existingCap = activity.recognitionCapHours ?? 0;
  const newUplift = wantsUplift ? round2(upliftRaw) : activity.upliftHours;
  const cap = round2((activity.allocatedHours || 0) + newUplift);

  if (wantsUplift && upliftReason.length < REASON_MIN) {
    return failed('Recognising more hours than were allocated needs a written reason. Say what the '
      + 'extra time went on. Nothing was changed.');
  }
  if (round2(hours) > cap) {
    return failed('You are verifying ' + hoursWord(hours) + ' against an allocation of '
      + hoursWord(existingCap) + '. Recognising more than was allocated is allowed, and it needs an '
      + 'uplift with a written reason recorded against it. Add the uplift and the reason, or verify '
      + hoursWord(existingCap) + '. Nothing was changed.');
  }

  const note = String(input.note || '').trim().slice(0, 2000);
  const parts: string[] = [];
  if (evidenceSeen) parts.push('Evidence seen: ' + evidenceSeen);
  if (note) parts.push(note);
  const verificationNote = parts.join('\n') || null;

  const upliftClause = wantsUplift
    ? sql`, uplift_hours = ${newUplift}, uplift_reason = ${upliftReason},
             uplift_by_user_id = ${verifier}::uuid, uplift_at = NOW()`
    : sql``;

  try {
    await ensureActivitySchema();
    const r = rows(await db.execute(sql`
      UPDATE employee_tasks
         SET verified_hours = ${round2(hours)},
             verified_by_user_id = ${verifier}::uuid,
             verified_at = NOW(),
             verification_note = ${verificationNote},
             updated_at = NOW()
             ${upliftClause}
       WHERE id = ${activityId}::uuid
         AND verified_at IS NULL
         AND status NOT IN ('cancelled', 'archived')
      RETURNING id`))[0];

    if (!r?.id) {
      return failed('That could not be recorded: the activity was verified or closed while this page '
        + 'was open. Nothing was changed.');
    }

    await logAudit({
      userId: verifier,
      action: 'eims.activity.verify',
      entity: 'employee_task',
      entityId: activityId,
      diff: {
        verifiedHours: round2(hours), reportedHours: reported,
        allocatedHours: activity.allocatedHours,
        uplift: wantsUplift ? newUplift : null,
        upliftReason: wantsUplift ? upliftReason.slice(0, 300) : null,
        via: check.via, evidenceSeen: evidenceSeen.slice(0, 300) || null,
      },
      ipAddress: input.ipAddress || undefined,
    });

    const after = await getActivity(activityId);
    const notes: string[] = [];
    if (round2(hours) < round2(reported)) {
      notes.push('Verified ' + hoursWord(hours) + ' of the ' + hoursWord(reported) + ' reported. The '
        + 'reported figure stays on the record; the difference is simply not recognised.');
    }
    if (wantsUplift) {
      notes.push('Recognised above the allocation, with the reason recorded against this activity.');
    }
    return { ok: true, error: '', activity: after, notes };
  } catch (e: any) {
    logFail('verifyActivity', e);
    return failed(WRITE_FAILED);
  }
}

/**
 * Take a verification back, so a corrected report can be made and verified again.
 *
 * IT IS A NAMED ACT WITH A REASON, not a delete. The previous finding is kept in the verification
 * note with the name of whoever withdrew it and why, because a mentor's finding that was later
 * withdrawn is a fact about the record and erasing it would leave the week looking as though nobody
 * had ever verified anything.
 */
export async function reopenVerification(input: {
  activityId: string;
  actorUserId: string;
  reason: string;
  ipAddress?: string | null;
}): Promise<ActivityWriteResult> {
  const activityId = String(input.activityId || '').trim();
  const actor = String(input.actorUserId || '').trim();
  if (!isUuid(activityId) || !isUuid(actor)) return failed(NOT_AVAILABLE);

  const reason = String(input.reason || '').trim().slice(0, 2000);
  if (reason.length < REASON_MIN) {
    return failed('Withdrawing a verification needs a written reason. Nothing was changed.');
  }

  const activity = await getActivity(activityId);
  if (!activity) return failed(NOT_AVAILABLE);
  if (!activity.verified) {
    return failed('These hours are not verified, so there is nothing to reopen. Nothing was changed.');
  }

  const check = await mayVerifyActivity(actor, activity);
  if (!check.ok) return failed(check.reason || NOT_AVAILABLE);

  const history = 'Verification of ' + hoursWord(activity.verifiedHours ?? 0) + ' recorded on '
    + (activity.verifiedAt || '').slice(0, 10) + ' was withdrawn. Reason: ' + reason;
  const keptNote = [activity.verificationNote || '', history].filter(Boolean).join('\n').slice(0, 4000);

  try {
    await ensureActivitySchema();
    const r = rows(await db.execute(sql`
      UPDATE employee_tasks
         SET verified_hours = NULL,
             verified_by_user_id = NULL,
             verified_at = NULL,
             verification_note = ${keptNote},
             updated_at = NOW()
       WHERE id = ${activityId}::uuid
         AND verified_at IS NOT NULL
      RETURNING id`))[0];

    if (!r?.id) return failed('That could not be recorded. Nothing was changed.');

    await logAudit({
      userId: actor,
      action: 'eims.activity.verify.reopen',
      entity: 'employee_task',
      entityId: activityId,
      diff: { previousVerifiedHours: activity.verifiedHours, reason: reason.slice(0, 300), via: check.via },
      ipAddress: input.ipAddress || undefined,
    });

    return {
      ok: true, error: '', activity: await getActivity(activityId),
      notes: ['The verification was withdrawn and the reason kept with the record. The reported '
        + 'figure can be corrected and verified again.'],
    };
  } catch (e: any) {
    logFail('reopenVerification', e);
    return failed(WRITE_FAILED);
  }
}
