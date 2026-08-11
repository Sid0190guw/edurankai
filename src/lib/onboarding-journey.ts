// src/lib/onboarding-journey.ts — ONBOARDING AS A TRACKED SEQUENCE, NOT A FORM.
//
// WHAT WAS WRONG. Onboarding in this product was one form: a new joiner typed their bank details and
// their emergency contact into /portal/employee/onboarding, the row was marked 'submitted', and that
// was the whole of it. Everything that ACTUALLY has to happen in somebody's first fortnight — a
// laptop, a mail account, an introduction to the team, the policies they are required to read and
// acknowledge — happened in mail threads and in somebody's memory, owned by nobody in particular. So
// nobody could answer the two questions that matter: what is still outstanding for this joiner, and
// who is it waiting on.
//
// This module answers both. A JOURNEY is a checklist instantiated for one joiner from a template HR
// controls, where every item carries an OWNER resolved from the Organization Graph and a DUE DATE
// computed from that person's joining date.
//
// -------------------------------------------------------------------------------------------------
// IT EXTENDS src/lib/hr-onboarding.ts — IT DOES NOT REPLACE IT.
// -------------------------------------------------------------------------------------------------
// hr-onboarding.ts owns the joining CREDENTIALS: the Google Drive links a hire submits and HR
// verifies, capped at MAX_DOCS. That is still the only place those live, and this module does not
// copy, re-check or re-implement any of it. A journey item in the `documents` category POINTS AT the
// credential screen; joiningDocumentsProgress() below reads hr-onboarding's own progress() so the two
// can never report different numbers.
//
// -------------------------------------------------------------------------------------------------
// A STEP NOBODY OWNS IS THE STEP THAT NEVER HAPPENS.
// -------------------------------------------------------------------------------------------------
// Every item resolves an owner through src/lib/org-graph.ts, or it says PLAINLY that it cannot yet
// and why. There are exactly two "cannot yet" sentences and they are different facts:
//
//   - the graph has NO ROWS AT ALL              -> "the organization graph has not been built yet"
//   - the graph is live but this edge is absent -> "no reporting manager is recorded for <name>"
//
// Only the founder can fix the first, by running the backfill; HR fixes the second by recording one
// relationship. Printing the second when the first is true sends somebody hunting for a data problem
// that does not exist, which is why resolveOwner() checks initialization once, first, and passes the
// answer down. NOTHING here falls back to users.role: an account's admin role is not a statement
// about who manages a person, and an employee's account very often carries `applicant`.
//
// An unowned item is NOT hidden and NOT auto-completed. It sits on the checklist saying what is
// missing, and reresolveOwners() picks it up the moment the relationship exists.
//
// -------------------------------------------------------------------------------------------------
// WHY THESE ARE NOT employee_tasks ROWS.
// -------------------------------------------------------------------------------------------------
// src/lib/employee-tasks.ts is the only task engine in this codebase and this module does not become
// a second one — it assigns nothing through employee_tasks and defines no statuses that compete with
// TASK_STATUSES. The reason it does not simply CREATE tasks is mechanical rather than philosophical:
// createTask() only inserts when the assigner is the assignee's own account, their recorded manager,
// or in their department (that is the visibility rule the task board is built on). HR starting a
// journey is none of those for the department head who owes the introductions, so every such call
// would return "not available" and the step would silently never appear. A checklist item bound to
// one joiner's journey is also a different object from a task: it has a template it came from, a due
// date derived from a joining date, and an acknowledgement. The owner is told about it through
// src/lib/notify.ts, which is the notifier this codebase already has.
//
// -------------------------------------------------------------------------------------------------
// THE TEMPLATE SHIPS EMPTY.
// -------------------------------------------------------------------------------------------------
// No step is written to the database by this file at import time or on first use. STARTER_STEPS below
// is a SUGGESTION an HR user can choose to add with one press on /admin/hr/onboarding/journey, and
// every one of them is editable and deletable afterwards. Seeding a live HR system with invented
// obligations would create a checklist nobody agreed to, that people would work through believing it
// was policy.
//
// HOUSE RULES: postgres-js returns PLAIN ARRAYS; the real Postgres reason is on e.cause; all DDL sits
// in ONE ensureOnce guard that logs the cause and re-throws; no write path swallows an exception;
// departments.id is compared ::text and never cast ::uuid; hr_employees uses full_name.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { isInitialized, getManager, getDepartmentHead, getApprovalOwner } from '@/lib/org-graph';
import { listDocs, progress as docProgress, isDriveLink, linkProblem } from '@/lib/hr-onboarding';
import { ensureClassificationSchema, INTERNSHIP_CLASSIFICATIONS } from '@/lib/hr-classification';
// WHAT WE ASK OF SOMEBODY DEPENDS ON WHAT THEY ARE.
//
// src/lib/onboarding-packs.ts holds the step packs, the control each step asserts, the exclusions and
// the reason for every one of them. It is pure data and pure functions and it never touches the
// database. This file is the only thing that writes any of it onto a person's checklist, and the
// reason it may is that a pack is chosen from the REVIEWED classification and from nothing else.
import {
  ENGAGEMENT_PACKS, packFor, isEngagementKey, engagementKeys, engagementLabelFor, engagementRiskFor,
  stepsForEngagement, documentsForEngagement, resolveEngagementKey, exclusionFor, controlLabel,
  CONTROL_LABELS,
  type EngagementKey, type PackStep, type ControlSignal,
} from '@/lib/onboarding-packs';
// AN OVERDUE FLAG IS A DAY BOUNDARY, AND THIS PROCESS IS NOT IN THE COMPANY'S ZONE.
import { civilToday } from '@/lib/page-safety';

// Declared BEFORE anything that uses them. `const` is not hoisted.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function logFail(where: string, e: any): void {
  console.error('[onboarding-journey] ' + where + ':', reasonOf(e));
}

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

/** What kind of thing a step is. Used to group the checklist, and for nothing else. */
export const STEP_CATEGORIES = [
  { key: 'documents', label: 'Documents', hint: 'Joining credentials and paperwork. Links only; nothing is uploaded here.' },
  { key: 'equipment', label: 'Equipment', hint: 'Laptop, phone, access card, anything physical that has to reach the person.' },
  { key: 'accounts', label: 'Accounts and access', hint: 'Mail, systems, the tools their work actually needs.' },
  { key: 'introductions', label: 'Introductions', hint: 'The people they need to have met by the end of the first week.' },
  { key: 'reading', label: 'First-week reading', hint: 'What to read to understand the work. A Drive link.' },
  { key: 'policy', label: 'Policy acknowledgement', hint: 'A policy the joiner must read AND acknowledge. Their acknowledgement is recorded.' },
  { key: 'other', label: 'Other', hint: 'Anything else this company does for a new joiner.' },
] as const;

export type StepCategory = (typeof STEP_CATEGORIES)[number]['key'];
const CATEGORY_KEYS = new Set<string>(STEP_CATEGORIES.map((c) => c.key));

export function stepCategoryLabel(key: string): string {
  const found = STEP_CATEGORIES.find((c) => c.key === key);
  return found ? found.label : 'Other';
}

/**
 * WHO OWNS A STEP — expressed as a RELATIONSHIP, resolved per joiner from the Organization Graph.
 *
 * Not a role name, not a named person on the template. A template that named "Priya" would be wrong
 * the day Priya changed teams, and a template that said "hr" would be reading users.role, which
 * answers a different question entirely (see this file's header).
 */
export const OWNER_VIA = [
  {
    key: 'reporting_manager',
    label: 'Their reporting manager',
    hint: 'Resolved from the Organization Graph for this joiner, on the day the journey starts.',
  },
  {
    key: 'department_head',
    label: 'Their department head',
    hint: 'Resolved from the head of the department on the joiner employee record.',
  },
  {
    key: 'onboarding_owner',
    label: 'The onboarding owner',
    hint: 'Whoever this organisation has recorded as the approval owner for the domain "onboarding". One edge covers every joiner.',
  },
  {
    key: 'the_joiner',
    label: 'The joiner themselves',
    hint: 'Something only the new person can do — submitting their documents, reading and acknowledging a policy.',
  },
] as const;

export type OwnerVia = (typeof OWNER_VIA)[number]['key'];
const OWNER_VIA_KEYS = new Set<string>(OWNER_VIA.map((o) => o.key));

export function ownerViaLabel(key: string): string {
  const found = OWNER_VIA.find((o) => o.key === key);
  return found ? found.label : 'Owner';
}

/** Where one item has got to. 'blocked' carries a note saying what is in the way. */
export const ITEM_STATES = ['pending', 'done', 'blocked', 'not_applicable'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  pending: 'Outstanding',
  done: 'Done',
  blocked: 'Blocked',
  not_applicable: 'Not applicable',
};

export function itemStateLabel(state: string): string {
  const k = String(state || '') as ItemState;
  return ITEM_STATE_LABELS[k] || 'Outstanding';
}

/**
 * THE CONTROLS A STEP CAN ASSERT, for the template form. Read from the packs module rather than
 * restated, so a control added there appears on the form without anybody remembering to add it.
 *
 * A hand-written step tagged with one of these is withheld from every engagement whose pack excludes
 * that control, and the pack's own reason is what the screen prints. That is the whole mechanism:
 * eligibility as DATA on the step, judged against the pack, rather than an `if` in a page.
 */
export const STEP_CONTROLS: Array<{ key: string; label: string }> =
  Object.keys(CONTROL_LABELS).map((k) => ({ key: k, label: (CONTROL_LABELS as any)[k] as string }));
const CONTROL_KEYS = new Set<string>(STEP_CONTROLS.map((c) => c.key));

/** Every engagement on the spine, with its pack, for a picker and for the reference panel. */
// key is EngagementKey, not string. Typed at the SOURCE rather than cast at each use site: the page
// was writing `ENGAGEMENT_PACKS[eng.key as any]` in three places, and `as any` on the way into a
// keyed Record defeats the one check that would catch an engagement having no pack — which is
// exactly the invariant the packs are built around. The import is type-only, so it erases at
// runtime and creates no cycle with onboarding-packs.
export const ENGAGEMENT_CHOICES: Array<{ key: EngagementKey; label: string; risk: string; summary: string }> =
  engagementKeys().map((k) => ({
    key: k,
    label: engagementLabelFor(k),
    risk: engagementRiskFor(k),
    summary: ENGAGEMENT_PACKS[k].summary,
  }));

/**
 * THE FLAT SUGGESTED CHECKLIST IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * STARTER_STEPS was one list of eight steps offered to every joiner: equipment, an employee
 * induction, a first week of reading and a recorded policy acknowledgement, for an unpaid intern, a
 * freelancer and a permanent employee alike. Onboarding steps are EVIDENCE OF THE RELATIONSHIP, so
 * that list was not merely untidy: for anybody who is not an employee it was this company writing
 * down, with dates and names against it, the control that makes somebody an employee in fact.
 *
 * What replaces it is src/lib/onboarding-packs.ts — one pack per engagement on the classification
 * spine, each with the steps that engagement genuinely needs and an explicit list of the controls it
 * must NOT assert, with the reason for each. seedPackSteps() below writes those packs onto the
 * template. Still on a button, still editable and retirable afterwards, and still writing nothing at
 * import time or on first use.
 */
export const PACK_TEMPLATE_NOTE =
  'Steps are seeded per engagement from the packs, not from one flat list. What a contractor is '
  + 'asked to do is a different set from what a permanent employee is asked to do, and the '
  + 'difference is not a preference.';

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------
//
// THREE TABLES, and none of these names appears anywhere else in the repo (checked before writing —
// two CREATE TABLE statements for one table with different shapes silently break every write for
// whichever module lost the race).
//
//   hr_onboarding_journey_steps   THE TEMPLATE. What this company does for every joiner.
//   hr_onboarding_journeys        one row per joiner, carrying the joining date the dates came from.
//   hr_onboarding_journey_items   THE CHECKLIST ITSELF. One row per step per joiner.
//
// THE ITEMS SNAPSHOT THE TEMPLATE'S WORDS (title, description, category, owner_via, reading_url).
// That is deliberate and it is not denormalisation for speed: a journey is a record of what a person
// was actually asked to do. Editing the template in March must not silently rewrite what a joiner was
// told in January, and deleting a template step must not erase the item somebody already completed.
// step_id is ON DELETE SET NULL for exactly that reason.

export function ensureJourneySchema(): Promise<void> {
  return ensureOnce('hr_onboarding_journey_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_onboarding_journey_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT,
        category VARCHAR(32) NOT NULL DEFAULT 'other',
        owner_via VARCHAR(32) NOT NULL DEFAULT 'reporting_manager',
        due_day INT NOT NULL DEFAULT 0,
        reading_url TEXT,
        requires_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
        employment_type TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 100,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_onb_journey_steps_active_idx
        ON hr_onboarding_journey_steps(is_active, sort_order, due_day)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_onboarding_journeys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        joining_date DATE,
        started_by_user_id UUID,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // ONE JOURNEY PER PERSON, enforced by the database. Two would mean two checklists, and the
      // owner of a step would have no way to know which one anybody was looking at.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_onb_journeys_emp_uniq
        ON hr_onboarding_journeys(employee_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_onboarding_journey_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        journey_id UUID NOT NULL REFERENCES hr_onboarding_journeys(id) ON DELETE CASCADE,
        step_id UUID REFERENCES hr_onboarding_journey_steps(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        category VARCHAR(32) NOT NULL DEFAULT 'other',
        owner_via VARCHAR(32) NOT NULL DEFAULT 'reporting_manager',
        owner_employee_id UUID,
        owner_user_id UUID,
        owner_name TEXT,
        owner_unresolved_reason TEXT,
        due_on DATE,
        reading_url TEXT,
        requires_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        note TEXT,
        completed_by_user_id UUID,
        completed_at TIMESTAMPTZ,
        acknowledged_at TIMESTAMPTZ,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // One item per template step per journey. Re-running the instantiation therefore tops a journey
      // up with steps added to the template since it started, and cannot duplicate the ones already
      // on it. NULLs are distinct in a Postgres unique index, so an item whose template step was
      // later deleted (step_id NULL) never blocks anything.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_onb_journey_items_step_uniq
        ON hr_onboarding_journey_items(journey_id, step_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_onb_journey_items_journey_idx
        ON hr_onboarding_journey_items(journey_id, sort_order, due_on)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_onb_journey_items_owner_idx
        ON hr_onboarding_journey_items(owner_employee_id, state)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_onb_journey_items_state_idx
        ON hr_onboarding_journey_items(state, due_on)`);
    } catch (e: any) {
      logFail('ensureJourneySchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries instead of staying broken.
    }
  });
}

/**
 * THE ENGAGEMENT COLUMNS. A SEPARATE ensureOnce KEY, BECAUSE A SPENT KEY NEVER RUNS AGAIN.
 *
 * 'hr_onboarding_journey_v1' has already run to completion in every environment this code has been
 * deployed to. Adding these ALTERs inside that block would have added them to a guard that is
 * permanently satisfied, so the columns would never appear and every write below would fail against
 * a column that does not exist. Additive only: nothing is dropped and nothing is renamed.
 *
 *   hr_onboarding_journey_steps.engagement_key   which pack this template row came from. NULL means
 *                                                it was written by hand and belongs to no pack.
 *   hr_onboarding_journey_steps.pack_step_key    the pack step's stable key, so re-seeding is
 *                                                idempotent even after HR has renamed the title.
 *   hr_onboarding_journey_steps.asserts_control  the control a hand-written step evidences, if any.
 *   hr_onboarding_journeys.engagement_key        A SNAPSHOT: what this person was when their
 *                                                checklist was built. Without it, changing somebody's
 *                                                classification and pressing start again would top
 *                                                the journey up with the new pack while every step of
 *                                                the old one stayed on it forever, because the insert
 *                                                is ON CONFLICT DO NOTHING and nothing ever deletes.
 *   hr_onboarding_journey_items.engagement_key   which pack each item came from.
 *   hr_onboarding_journey_items.added_despite_reason  set only where somebody added a withheld step
 *                                                back, carrying the exclusion they overrode and the
 *                                                reason they gave for it.
 */
export function ensureJourneyEngagementSchema(): Promise<void> {
  return ensureOnce('hr_onboarding_journey_engagement_v1', async () => {
    try {
      await db.execute(sql`ALTER TABLE hr_onboarding_journey_steps ADD COLUMN IF NOT EXISTS engagement_key VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_onboarding_journey_steps ADD COLUMN IF NOT EXISTS pack_step_key VARCHAR(80)`);
      await db.execute(sql`ALTER TABLE hr_onboarding_journey_steps ADD COLUMN IF NOT EXISTS asserts_control VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_onboarding_journeys ADD COLUMN IF NOT EXISTS engagement_key VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_onboarding_journey_items ADD COLUMN IF NOT EXISTS engagement_key VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_onboarding_journey_items ADD COLUMN IF NOT EXISTS added_despite_reason TEXT`);
      // One row per pack step per engagement, so pressing the seed button twice cannot double the
      // template. PARTIAL, because the hand-written rows carry neither column and their NULLs would
      // otherwise be indistinguishable from one another.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_onb_journey_steps_packstep_uniq
        ON hr_onboarding_journey_steps(engagement_key, pack_step_key)
        WHERE engagement_key IS NOT NULL AND pack_step_key IS NOT NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_onb_journey_steps_engagement_idx
        ON hr_onboarding_journey_steps(engagement_key, is_active, sort_order)`);
    } catch (e: any) {
      logFail('ensureJourneyEngagementSchema', e);
      throw e;
    }
  });
}

/**
 * NEVER TRUST AN ENSURE RETURN. ensureOnce() ends with `p.catch(() => {})`, so a DDL failure inside
 * either block resolves to the caller exactly as a success does — which is why safeEnsure() has
 * always answered true even when the tables were absent, and why the schema banner on the admin
 * screen has never once fired. The columns are asked for BY NAME, against information_schema.
 *
 * Only a positive answer is cached. Caching a negative would leave a process that raced one cold
 * start permanently convinced the feature is unavailable.
 *
 * The IN list is spelled out as individual literals on purpose: `= ANY($jsArray)` fails against this
 * driver with "op ANY/ALL (array) requires array on right side", and that exact mistake silently
 * broke the health check on this project for weeks.
 */
let engagementColumnsCached = false;
async function engagementColumnsReady(): Promise<boolean> {
  if (engagementColumnsCached) return true;
  try {
    await ensureJourneySchema();
    await ensureJourneyEngagementSchema();
    const have = new Set(
      rowsOf(await db.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name IN ('hr_onboarding_journey_steps', 'hr_onboarding_journeys', 'hr_onboarding_journey_items')
           AND column_name IN ('engagement_key', 'pack_step_key', 'asserts_control', 'added_despite_reason')`))
        .map((r: any) => String(r.table_name) + '.' + String(r.column_name)),
    );
    engagementColumnsCached = have.has('hr_onboarding_journey_steps.engagement_key')
      && have.has('hr_onboarding_journey_steps.pack_step_key')
      && have.has('hr_onboarding_journey_steps.asserts_control')
      && have.has('hr_onboarding_journeys.engagement_key')
      && have.has('hr_onboarding_journey_items.engagement_key')
      && have.has('hr_onboarding_journey_items.added_despite_reason');
    return engagementColumnsCached;
  } catch (e: any) {
    logFail('engagementColumnsReady', e);
    return false;
  }
}

/**
 * The same check for the classification columns, which live on hr_employees and are provisioned by a
 * different module under a different key. A journey is built from `classification`, so where that
 * column is missing the honest answer is "the engagement cannot be read", never "assume employee".
 */
let classificationColumnsCached = false;
async function classificationColumnsReady(): Promise<boolean> {
  if (classificationColumnsCached) return true;
  try {
    await ensureClassificationSchema();
    const have = new Set(
      rowsOf(await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'hr_employees'
           AND column_name IN ('classification', 'classification_reviewed_at')`))
        .map((r: any) => String(r.column_name)),
    );
    classificationColumnsCached = have.has('classification') && have.has('classification_reviewed_at');
    return classificationColumnsCached;
  } catch (e: any) {
    logFail('classificationColumnsReady', e);
    return false;
  }
}

export const SCHEMA_UNAVAILABLE =
  'The onboarding tables are not fully provisioned in this database, so nothing on this screen is a '
  + 'statement about anybody. The reason is in the server log under [onboarding-journey]. Nothing was '
  + 'changed and nothing was lost.';

/**
 * True when the tables AND the engagement columns are genuinely there.
 *
 * This used to call ensureJourneySchema() and return true unless it threw — which it cannot, because
 * ensureOnce swallows. So a read against missing tables drew an empty template and an empty joiner
 * list on the one screen that answers whether a new starter has been set up at all, and reported it
 * as "nobody has a checklist".
 */
async function safeEnsure(): Promise<boolean> {
  return engagementColumnsReady();
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface TemplateStep {
  id: string;
  title: string;
  description: string | null;
  category: string;
  ownerVia: string;
  dueDay: number;
  readingUrl: string | null;
  requiresAcknowledgement: boolean;
  employmentType: string | null;
  /** The engagement whose pack this row came from. NULL means it belongs to no pack. */
  engagementKey: string | null;
  /** The pack step's stable key, where this row was seeded from a pack. */
  packStepKey: string | null;
  /** The control a hand-written step evidences, where somebody has said. NULL means untagged. */
  assertsControl: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface JourneyItem {
  id: string;
  journeyId: string;
  stepId: string | null;
  title: string;
  description: string | null;
  category: string;
  ownerVia: string;
  ownerEmployeeId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  /** Present exactly when no owner resolved. A sentence, rendered verbatim. */
  ownerUnresolvedReason: string | null;
  dueOn: string | null;
  readingUrl: string | null;
  requiresAcknowledgement: boolean;
  state: ItemState;
  note: string | null;
  completedAt: string | null;
  acknowledgedAt: string | null;
  sortOrder: number;
  /** Which engagement's pack this item came from. */
  engagementKey: string | null;
  /**
   * Set ONLY on an item the engagement's pack withheld, that somebody added back anyway. Carries the
   * exclusion that was overridden and the reason they gave. It is shown wherever the item is shown,
   * because a step that was withheld for a legal reason and created regardless is the single most
   * important thing about that item.
   */
  addedDespiteReason: string | null;
  /** Derived, never stored: a stored "overdue" flag would be wrong every midnight. */
  overdue: boolean;
}

export interface JourneyProgress {
  total: number;
  done: number;
  outstanding: number;
  blocked: number;
  notApplicable: number;
  overdue: number;
  unowned: number;
  /** 0-100, counting 'not applicable' as settled. Nothing to do is 100, not 0. */
  percent: number;
  complete: boolean;
}

export interface Journey {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  joiningDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * WHAT THIS PERSON WAS WHEN THE CHECKLIST WAS BUILT — a snapshot, not a live read.
   *
   * A journey is a record of what somebody was actually asked to do, in the same way the items
   * snapshot the template's words. Reading the engagement live would mean that correcting a
   * misclassified contractor silently re-described the induction they had already been put through
   * as having been correct all along.
   */
  engagementKey: string | null;
  engagementLabel: string | null;
  items: JourneyItem[];
  progress: JourneyProgress;
}

export interface JourneyResult {
  ok: boolean;
  id?: string;
  changed?: boolean;
  error?: string;
  /** How many items could not resolve an owner. The caller says so plainly rather than hiding it. */
  unowned?: number;
  /** Items actually created on this run. */
  created?: number;
  /** Steps the engagement's pack withheld, each with a reason the caller can show. */
  withheld?: number;
  /** Withheld steps somebody added back with an acknowledged reason. */
  overridden?: number;
  engagementKey?: string | null;
  engagementLabel?: string | null;
  /** True when the refusal was "nobody has recorded what this person is". Carries fixUrl. */
  needsEngagement?: boolean;
  /** True when the refusal was "this checklist was built for a different engagement". */
  engagementChanged?: boolean;
  fixUrl?: string;
}

function mapTemplateStep(r: any): TemplateStep {
  return {
    id: String(r?.id ?? ''),
    title: String(r?.title ?? ''),
    description: r?.description ? String(r.description) : null,
    category: CATEGORY_KEYS.has(String(r?.category)) ? String(r.category) : 'other',
    ownerVia: OWNER_VIA_KEYS.has(String(r?.owner_via)) ? String(r.owner_via) : 'reporting_manager',
    dueDay: Number(r?.due_day) || 0,
    readingUrl: r?.reading_url ? String(r.reading_url) : null,
    requiresAcknowledgement: r?.requires_acknowledgement === true,
    employmentType: r?.employment_type ? String(r.employment_type) : null,
    engagementKey: r?.engagement_key ? String(r.engagement_key) : null,
    packStepKey: r?.pack_step_key ? String(r.pack_step_key) : null,
    assertsControl: r?.asserts_control ? String(r.asserts_control) : null,
    isActive: r?.is_active !== false,
    sortOrder: Number(r?.sort_order) || 100,
  };
}

/**
 * Today as the COMPANY counts it. Every due date on a journey is computed from a joining DATE — a
 * civil date — so the thing it is compared against has to be one too. `new Date().toISOString()`
 * is the date in UTC and this process runs in UTC, five and a half hours behind the joiners; a step
 * that fell due yesterday did not turn red until 05:30 local, which is most of a working morning.
 */
function todayIso(): string {
  return civilToday();
}

function mapItem(r: any): JourneyItem {
  const state = String(r?.state ?? 'pending');
  const dueOn = r?.due_on ? new Date(r.due_on).toISOString().slice(0, 10) : null;
  const settled = state === 'done' || state === 'not_applicable';
  return {
    id: String(r?.id ?? ''),
    journeyId: String(r?.journey_id ?? ''),
    stepId: r?.step_id ? String(r.step_id) : null,
    title: String(r?.title ?? ''),
    description: r?.description ? String(r.description) : null,
    category: CATEGORY_KEYS.has(String(r?.category)) ? String(r.category) : 'other',
    ownerVia: String(r?.owner_via ?? 'reporting_manager'),
    ownerEmployeeId: r?.owner_employee_id ? String(r.owner_employee_id) : null,
    ownerUserId: r?.owner_user_id ? String(r.owner_user_id) : null,
    ownerName: r?.owner_name ? String(r.owner_name) : null,
    ownerUnresolvedReason: r?.owner_unresolved_reason ? String(r.owner_unresolved_reason) : null,
    dueOn,
    readingUrl: r?.reading_url ? String(r.reading_url) : null,
    requiresAcknowledgement: r?.requires_acknowledgement === true,
    state: (ITEM_STATES as readonly string[]).indexOf(state) >= 0 ? (state as ItemState) : 'pending',
    note: r?.note ? String(r.note) : null,
    completedAt: r?.completed_at ? new Date(r.completed_at).toISOString() : null,
    acknowledgedAt: r?.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
    sortOrder: Number(r?.sort_order) || 100,
    engagementKey: r?.engagement_key ? String(r.engagement_key) : null,
    addedDespiteReason: r?.added_despite_reason ? String(r.added_despite_reason) : null,
    overdue: !settled && !!dueOn && dueOn < todayIso(),
  };
}

/** Counts a screen can print. Derived from the items every time; nothing here is a stored total. */
export function journeyProgress(items: JourneyItem[]): JourneyProgress {
  const list = Array.isArray(items) ? items : [];
  const done = list.filter((i) => i.state === 'done').length;
  const notApplicable = list.filter((i) => i.state === 'not_applicable').length;
  const blocked = list.filter((i) => i.state === 'blocked').length;
  const outstanding = list.filter((i) => i.state === 'pending' || i.state === 'blocked').length;
  const overdue = list.filter((i) => i.overdue).length;
  const unowned = list.filter((i) => !i.ownerEmployeeId && i.state !== 'not_applicable').length;
  const settled = done + notApplicable;
  return {
    total: list.length,
    done,
    outstanding,
    blocked,
    notApplicable,
    overdue,
    unowned,
    percent: list.length === 0 ? 0 : Math.round((settled / list.length) * 100),
    complete: list.length > 0 && settled === list.length,
  };
}

// -------------------------------------------------------------------------------------------------
// THE TEMPLATE
// -------------------------------------------------------------------------------------------------

export async function listTemplateSteps(opts: { includeInactive?: boolean } = {}): Promise<TemplateStep[]> {
  if (!(await safeEnsure())) return [];
  try {
    const clause = opts.includeInactive ? sql`` : sql` WHERE is_active = true`;
    return rowsOf(await db.execute(sql`
      SELECT * FROM hr_onboarding_journey_steps${clause}
       ORDER BY is_active DESC, sort_order ASC, due_day ASC, title ASC
       LIMIT 200`)).map(mapTemplateStep);
  } catch (e: any) {
    logFail('listTemplateSteps', e);
    return [];
  }
}

export interface TemplateStepInput {
  title: string;
  description?: string | null;
  category: string;
  ownerVia: string;
  dueDay: number;
  readingUrl?: string | null;
  requiresAcknowledgement?: boolean;
  employmentType?: string | null;
  /** A key of the classification spine. The step then reaches only that engagement's joiners. */
  engagementKey?: string | null;
  packStepKey?: string | null;
  /** What control this step evidences, where the author knows. See the withholding rules below. */
  assertsControl?: string | null;
  sortOrder?: number | null;
  actorUserId: string | null;
}

function validateStep(input: TemplateStepInput): { ok: true } | { ok: false; error: string } {
  const title = String(input?.title || '').trim();
  if (title.length < 3) return { ok: false, error: 'Give the step a title the owner will understand at a glance.' };
  if (title.length > 250) return { ok: false, error: 'That title is too long — keep it under 250 characters.' };
  if (!OWNER_VIA_KEYS.has(String(input?.ownerVia))) {
    return { ok: false, error: 'Choose who owns this step. A step nobody owns is the step that never happens.' };
  }
  const day = Number(input?.dueDay);
  if (!isFinite(day) || Math.floor(day) !== day || day < -30 || day > 365) {
    return { ok: false, error: 'The due day is a whole number of days relative to joining, between -30 and 365.' };
  }
  const url = String(input?.readingUrl || '').trim();
  if (url) {
    // Documents of any kind are Drive links here, never uploads. hr-onboarding.ts owns that rule.
    const problem = linkProblem(url);
    if (problem) return { ok: false, error: 'Document link: ' + problem };
    if (!isDriveLink(url)) return { ok: false, error: 'Share the document from Google Drive.' };
  }
  if (input?.requiresAcknowledgement === true && !url) {
    return {
      ok: false,
      error: 'A step that must be acknowledged needs the document link the person is acknowledging. '
        + 'Acknowledging nothing in particular is not a record of anything.',
    };
  }
  const engagement = String(input?.engagementKey || '').trim();
  if (engagement && !isEngagementKey(engagement)) {
    return {
      ok: false,
      error: 'That is not an engagement on the classification register, so no joiner could ever match '
        + 'it and the step would silently reach nobody. Leave it empty to apply to every engagement, '
        + 'or pick one from the list.',
    };
  }
  const control = String(input?.assertsControl || '').trim();
  if (control && !CONTROL_KEYS.has(control)) {
    return { ok: false, error: 'That is not a control this build knows how to withhold.' };
  }
  // THE ONE COMBINATION THAT MUST BE REFUSED. A step tagged with a control, restricted to an
  // engagement whose pack excludes that very control, is a step somebody has explicitly asked to
  // create for the one population it is explicitly wrong for. It would be withheld on every start
  // anyway, so accepting it would only bury the contradiction in a template row nobody reads.
  if (engagement && control) {
    const clash = exclusionFor(engagement as EngagementKey, control as ControlSignal);
    if (clash) {
      return {
        ok: false,
        error: 'This step asserts "' + controlLabel(control) + '", and the '
          + engagementLabelFor(engagement as EngagementKey).toLowerCase() + ' pack excludes exactly '
          + 'that. ' + clash.why + ' If the classification is wrong, change the classification. Do '
          + 'not write the step.',
      };
    }
  }
  return { ok: true };
}

export async function addTemplateStep(input: TemplateStepInput): Promise<JourneyResult> {
  const check = validateStep(input);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    if (!(await engagementColumnsReady())) return { ok: false, error: SCHEMA_UNAVAILABLE };
    const actor = isUuid(input.actorUserId) ? String(input.actorUserId) : null;
    const category = CATEGORY_KEYS.has(String(input.category)) ? String(input.category) : 'other';
    const engagementKey = String(input.engagementKey || '').trim() || null;
    const assertsControl = String(input.assertsControl || '').trim() || null;
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_onboarding_journey_steps
        (title, description, category, owner_via, due_day, reading_url, requires_acknowledgement,
         employment_type, engagement_key, pack_step_key, asserts_control, sort_order, created_by_user_id)
      VALUES
        (${String(input.title).trim().slice(0, 250)},
         ${String(input.description || '').trim().slice(0, 2000) || null},
         ${category}, ${String(input.ownerVia)}, ${Number(input.dueDay)},
         ${String(input.readingUrl || '').trim() || null},
         ${input.requiresAcknowledgement === true},
         ${String(input.employmentType || '').trim().slice(0, 100) || null},
         ${engagementKey}, ${String(input.packStepKey || '').trim().slice(0, 80) || null},
         ${assertsControl},
         ${Number(input.sortOrder) || 100}, ${actor}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!ins.length) {
      // The only conflict possible is the partial unique index on (engagement_key, pack_step_key),
      // which means this exact pack step is already on the template. That is the seeder having run
      // before, not a failure, and it must not be reported as one.
      return { ok: true, changed: false };
    }
    const id = String(ins[0].id);
    await logAudit({
      userId: actor, action: 'onboarding.step_added', entity: 'hr_onboarding_journey_step', entityId: id,
      diff: {
        title: String(input.title).trim().slice(0, 250), category, ownerVia: input.ownerVia,
        dueDay: Number(input.dueDay), engagementKey, assertsControl,
      },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('addTemplateStep', e);
    return { ok: false, error: 'The step was not saved: ' + reasonOf(e) };
  }
}

/**
 * Retire or restore a template step. NOT a delete: journeys already running carry items that came
 * from it, and the history of what somebody was asked to do is the point of keeping them.
 */
export async function setStepActive(id: string, active: boolean, actorUserId: string | null): Promise<JourneyResult> {
  if (!isUuid(id)) return { ok: false, error: 'That step could not be identified.' };
  try {
    await ensureJourneySchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_onboarding_journey_steps SET is_active = ${active === true}, updated_at = NOW()
       WHERE id = ${id}::uuid RETURNING id, title`));
    if (!upd.length) return { ok: false, error: 'That step could not be found.' };
    await logAudit({
      userId: actor, action: active ? 'onboarding.step_restored' : 'onboarding.step_retired',
      entity: 'hr_onboarding_journey_step', entityId: id, diff: { title: String(upd[0].title || '') },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('setStepActive', e);
    return { ok: false, error: 'That was not changed: ' + reasonOf(e) };
  }
}

/**
 * SEED THE TEMPLATE FROM THE PACKS — one engagement at a time, or all of them.
 *
 * This replaces addStarterSteps(), which wrote ONE flat list of eight steps that then applied to
 * every joiner regardless of what they were. Each row written here carries its engagement, so a
 * contractor's checklist is built from the contractor pack and a permanent employee's from the
 * employee pack, and neither can reach the other.
 *
 * IDEMPOTENT ON (engagement, pack step key), enforced by a partial unique index rather than by
 * reading the table first and hoping. Pressing the button twice adds nothing; pressing it after a
 * pack has gained a step adds that step; and a row HR has since renamed or retired is left exactly
 * as they left it, because what matches is the key and not the words.
 *
 * NOTHING IS WRITTEN UNTIL SOMEBODY PRESSES THE BUTTON. That has always been true of this template
 * and it stays true: an onboarding checklist is a statement about what this company promises a new
 * person, and seeding a live HR system with obligations nobody agreed to would have people working
 * through them believing they were policy.
 */
export interface SeedResult {
  ok: boolean;
  added: number;
  skipped: number;
  /** Per engagement, how many rows were added, so the screen says what happened. */
  byEngagement: Array<{ key: string; label: string; added: number; total: number }>;
  error?: string;
}

export async function seedPackSteps(
  actorUserId: string | null,
  engagement?: string | null,
): Promise<SeedResult> {
  const empty: SeedResult = { ok: false, added: 0, skipped: 0, byEngagement: [] };
  try {
    if (!(await engagementColumnsReady())) return { ...empty, error: SCHEMA_UNAVAILABLE };
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;

    const wanted = String(engagement || '').trim();
    if (wanted && !isEngagementKey(wanted)) {
      return { ...empty, error: 'That is not an engagement on the classification register.' };
    }
    const keys: readonly EngagementKey[] = wanted ? [wanted as EngagementKey] : engagementKeys();

    let added = 0;
    let skipped = 0;
    const byEngagement: SeedResult['byEngagement'] = [];

    for (const key of keys) {
      const steps = stepsForEngagement(key);
      let here = 0;
      let order = 0;
      for (const step of steps) {
        order += 10;
        const r = await addTemplateStep({
          title: step.title,
          description: step.description,
          category: step.category,
          ownerVia: step.ownerVia,
          dueDay: step.dueDay,
          // A step that must be acknowledged needs the document link the person is acknowledging,
          // and only HR knows which document that is. It is seeded WITHOUT the requirement and HR
          // turns it on when they attach the link — rather than being refused by validateStep() and
          // silently never appearing, which is what seeding the flag as true would cause.
          requiresAcknowledgement: false,
          engagementKey: key,
          packStepKey: step.key,
          assertsControl: step.asserts || null,
          sortOrder: order,
          actorUserId: actor,
        });
        if (r.ok && r.changed) { added += 1; here += 1; }
        else if (r.ok) skipped += 1;
        else return { ...empty, added, skipped, byEngagement, error: r.error };
      }
      byEngagement.push({ key, label: engagementLabelFor(key), added: here, total: steps.length });
    }

    if (added > 0) {
      await logAudit({
        userId: actor, action: 'onboarding.packs_seeded', entity: 'hr_onboarding_journey_step',
        entityId: wanted || 'all', diff: { added, skipped, engagements: keys.length },
      });
    }
    return { ok: true, added, skipped, byEngagement };
  } catch (e: any) {
    logFail('seedPackSteps', e);
    return { ...empty, error: 'The packs were not added to the template: ' + reasonOf(e) };
  }
}

/**
 * Tag a hand-written template step with the engagement it belongs to and the control it asserts.
 *
 * THIS IS THE ONLY WAY A LEGACY ROW BECOMES SAFE. The eight steps the old starter button wrote carry
 * no engagement and no control, so nothing can tell whether "Issue equipment" is the employee one or
 * something harmless with a similar name. Until somebody says, an untagged row is withheld from every
 * engagement whose pack excludes anything — see selectStepsFor() — and this is how they say.
 */
export async function setStepEngagement(
  id: string,
  engagementKey: string | null,
  assertsControl: string | null,
  actorUserId: string | null,
): Promise<JourneyResult> {
  if (!isUuid(id)) return { ok: false, error: 'That step could not be identified.' };
  const engagement = String(engagementKey || '').trim();
  const control = String(assertsControl || '').trim();
  if (engagement && !isEngagementKey(engagement)) {
    return { ok: false, error: 'That is not an engagement on the classification register.' };
  }
  if (control && !CONTROL_KEYS.has(control)) {
    return { ok: false, error: 'That is not a control this build knows how to withhold.' };
  }
  if (engagement && control) {
    const clash = exclusionFor(engagement as EngagementKey, control as ControlSignal);
    if (clash) {
      return {
        ok: false,
        error: 'This step asserts "' + controlLabel(control) + '" and the '
          + engagementLabelFor(engagement as EngagementKey).toLowerCase() + ' pack excludes it. '
          + clash.why,
      };
    }
  }
  try {
    if (!(await engagementColumnsReady())) return { ok: false, error: SCHEMA_UNAVAILABLE };
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_onboarding_journey_steps
         SET engagement_key = ${engagement || null}, asserts_control = ${control || null},
             updated_at = NOW()
       WHERE id = ${id}::uuid
       RETURNING id, title`));
    if (!upd.length) return { ok: false, error: 'That step could not be found.' };
    await logAudit({
      userId: actor, action: 'onboarding.step_engagement_set', entity: 'hr_onboarding_journey_step',
      entityId: id,
      diff: {
        title: String(upd[0].title || ''), engagementKey: engagement || null,
        assertsControl: control || null,
      },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('setStepEngagement', e);
    return { ok: false, error: 'That was not saved: ' + reasonOf(e) };
  }
}

/** Attach or change the document link on a step, and whether it must be acknowledged. */
export async function setStepDocument(
  id: string,
  readingUrl: string,
  requiresAcknowledgement: boolean,
  actorUserId: string | null,
): Promise<JourneyResult> {
  if (!isUuid(id)) return { ok: false, error: 'That step could not be identified.' };
  const url = String(readingUrl || '').trim();
  if (url) {
    const problem = linkProblem(url);
    if (problem) return { ok: false, error: 'Document link: ' + problem };
    if (!isDriveLink(url)) return { ok: false, error: 'Share the document from Google Drive.' };
  } else if (requiresAcknowledgement) {
    return { ok: false, error: 'A step that must be acknowledged needs the document link the person is acknowledging.' };
  }
  try {
    await ensureJourneySchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_onboarding_journey_steps
         SET reading_url = ${url || null}, requires_acknowledgement = ${requiresAcknowledgement === true},
             updated_at = NOW()
       WHERE id = ${id}::uuid RETURNING id`));
    if (!upd.length) return { ok: false, error: 'That step could not be found.' };
    await logAudit({
      userId: actor, action: 'onboarding.step_document_set', entity: 'hr_onboarding_journey_step',
      entityId: id, diff: { readingUrl: url || null, requiresAcknowledgement: requiresAcknowledgement === true },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('setStepDocument', e);
    return { ok: false, error: 'The document link was not saved: ' + reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// OWNER RESOLUTION — the org graph, and nothing else
// -------------------------------------------------------------------------------------------------

interface ResolvedOwner {
  employeeId: string | null;
  userId: string | null;
  name: string | null;
  /** Null when an owner was found. A sentence otherwise. */
  unresolvedReason: string | null;
}

/**
 * Who owns this step for this joiner, right now.
 *
 * `graphReady` is passed IN rather than asked here, so one journey costs one isInitialized() call
 * instead of one per step, and so every item on a journey agrees about which of the two "cannot yet"
 * facts is true.
 */
async function resolveOwner(
  ownerVia: string,
  joiner: { employeeId: string; userId: string | null; fullName: string | null; departmentId: string | null },
  graphReady: boolean,
): Promise<ResolvedOwner> {
  const name = joiner.fullName || 'this joiner';

  // The joiner owns it themselves. No graph lookup is involved — this is the subject of the journey,
  // not a relationship — so it resolves even before the backfill has run.
  if (ownerVia === 'the_joiner') {
    return { employeeId: joiner.employeeId, userId: joiner.userId, name: joiner.fullName, unresolvedReason: null };
  }

  if (!graphReady) {
    return {
      employeeId: null, userId: null, name: null,
      unresolvedReason: 'The organization graph has not been built yet, so nobody can be resolved as '
        + ownerViaLabel(ownerVia).toLowerCase() + '. The founder runs the backfill; this step then '
        + 'picks up its owner without being re-created.',
    };
  }

  try {
    if (ownerVia === 'reporting_manager') {
      const person = await getManager(joiner.employeeId);
      if (person?.employeeId) {
        return { employeeId: person.employeeId, userId: person.userId, name: person.fullName, unresolvedReason: null };
      }
      return {
        employeeId: null, userId: null, name: null,
        unresolvedReason: 'No reporting manager is recorded for ' + name + ', so this step has no owner yet.',
      };
    }

    if (ownerVia === 'department_head') {
      if (!joiner.departmentId) {
        return {
          employeeId: null, userId: null, name: null,
          unresolvedReason: 'No department is recorded on ' + name + "'s employee record, so no department head can be resolved.",
        };
      }
      const person = await getDepartmentHead(joiner.departmentId);
      if (person?.employeeId) {
        return { employeeId: person.employeeId, userId: person.userId, name: person.fullName, unresolvedReason: null };
      }
      return {
        employeeId: null, userId: null, name: null,
        unresolvedReason: 'No department head is recorded for ' + name + "'s department, so this step has no owner yet.",
      };
    }

    if (ownerVia === 'onboarding_owner') {
      const person = await getApprovalOwner('onboarding', { employeeId: joiner.employeeId });
      if (person?.employeeId) {
        return { employeeId: person.employeeId, userId: person.userId, name: person.fullName, unresolvedReason: null };
      }
      return {
        employeeId: null, userId: null, name: null,
        unresolvedReason: 'Nobody is recorded as the onboarding owner. One approval-owner relationship '
          + 'scoped to the domain "onboarding" covers every joiner; until it exists, this step has no owner.',
      };
    }

    return {
      employeeId: null, userId: null, name: null,
      unresolvedReason: 'This step was recorded with an owner this build does not know how to resolve ('
        + String(ownerVia) + ').',
    };
  } catch (e: any) {
    // A FAILED LOOKUP AND AN ABSENT RELATIONSHIP ARE DIFFERENT FACTS. Reporting the second when the
    // first happened would send somebody hunting for a relationship that is already there.
    logFail('resolveOwner', e);
    return {
      employeeId: null, userId: null, name: null,
      unresolvedReason: 'The owner could not be looked up just now (' + reasonOf(e) + '). Nothing is wrong with the step itself.',
    };
  }
}

function dueOnFor(joiningDate: string | null, dueDay: number): string | null {
  if (!joiningDate) return null;
  const d = new Date(joiningDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + (Number(dueDay) || 0));
  return d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// THE JOURNEY
// -------------------------------------------------------------------------------------------------

interface JoinerFacts {
  employeeId: string;
  userId: string | null;
  fullName: string | null;
  employeeCode: string | null;
  departmentId: string | null;
  joiningDate: string | null;
  employmentType: string | null;
  designation: string | null;
  /** hr_employees.classification. Carries the ALTER's default for everybody nobody has reviewed. */
  classification: string | null;
  /** Only its PRESENCE is read. It is the difference between a default and a decision. */
  classificationReviewedAt: string | null;
  /** False when the classification columns are not provisioned at all. */
  classificationReadable: boolean;
}

/**
 * The facts about one joiner that a checklist is built from.
 *
 * The classification columns are read in a SECOND statement, on purpose. They are provisioned by
 * src/lib/hr-classification.ts under its own ensureOnce key, so on a database where that key has not
 * run they do not exist — and naming a column that does not exist makes the WHOLE statement throw.
 * Exactly that mistake, with hr_employees.work_email, denied /admin to every administrator including
 * the founder. A missing classification must degrade to "the engagement cannot be read", never take
 * the joining date and the department down with it.
 */
async function joinerFacts(employeeId: string): Promise<JoinerFacts | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT id, user_id, full_name, employee_code, department_id::text AS department_id,
             joining_date, employment_type, designation
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!list.length) return null;
    const r = list[0] as any;

    let classification: string | null = null;
    let classificationReviewedAt: string | null = null;
    let classificationReadable = false;
    if (await classificationColumnsReady()) {
      try {
        const c = rowsOf(await db.execute(sql`
          SELECT classification, classification_reviewed_at
            FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
        if (c.length) {
          classificationReadable = true;
          classification = c[0].classification ? String(c[0].classification) : null;
          classificationReviewedAt = c[0].classification_reviewed_at
            ? new Date(c[0].classification_reviewed_at).toISOString() : null;
        }
      } catch (e: any) {
        logFail('joinerFacts.classification', e);
      }
    }

    return {
      employeeId: String(r.id),
      userId: r.user_id ? String(r.user_id) : null,
      fullName: r.full_name ? String(r.full_name) : null,
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
      employmentType: r.employment_type ? String(r.employment_type) : null,
      designation: r.designation ? String(r.designation) : null,
      classification,
      classificationReviewedAt,
      classificationReadable,
    };
  } catch (e: any) {
    logFail('joinerFacts', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// WHICH PACK — OR A PLAIN REFUSAL
// -------------------------------------------------------------------------------------------------

export const CLASSIFICATION_REGISTER_URL = '/admin/hr/classification';
export const CLASSIFICATION_REGISTER_LABEL = 'Worker Classification Register';

export interface EngagementDecision {
  /**
   * 'ready'          the engagement is recorded and a pack was chosen from it
   * 'not_recorded'   nobody has reviewed this person's classification. NOT a default to employee.
   * 'unreadable'     the classification columns could not be read at all
   * 'no_pack'        a recorded engagement this build has no pack for
   */
  state: 'ready' | 'not_recorded' | 'unreadable' | 'no_pack';
  engagementKey: EngagementKey | null;
  engagementLabel: string | null;
  risk: string | null;
  packSummary: string | null;
  /** A sentence, rendered verbatim on the admin screen and on the joiner's own page. */
  reason: string;
  /** What employment_type SUGGESTS. Never what the pack was chosen from. Null when it says nothing. */
  hint: string | null;
  /** Set when employment_type and the reviewed classification disagree. Never auto-resolved. */
  conflict: string | null;
  /** Where the engagement is recorded: the single writer of hr_employees.classification. */
  fixUrl: string;
  fixLabel: string;
}

/**
 * THE REVIEW STAMP IS THE LOAD-BEARING LINE IN THIS FILE.
 *
 * hr_employees.classification was added by an ALTER carrying DEFAULT 'permanent', so every row nobody
 * has ever looked at reads "permanent employee". If that default chose a pack, every unreviewed
 * person in this company would be handed the full employee induction — equipment, an induction, a
 * reporting manager, a recorded policy acknowledgement — and it would be worst for exactly the
 * population where it matters most, because a contractor nobody has classified is a contractor whose
 * file quietly fills up with evidence of employment. That is the generous-direction failure: it does
 * not over-serve anybody, it manufactures liability.
 *
 * classification_reviewed_at is stamped by the one screen that writes the value, so its PRESENCE is
 * the difference between a default and a decision. src/lib/auth/intern-signals.ts reaches the same
 * conclusion for the same reason, and this is deliberately the same test.
 *
 * employment_type is read ONLY to say what it suggests, and resolveEngagementKey() refuses on the
 * word "contract" — which means either a fixed-term employee or an independent contractor, opposite
 * risk ratings and opposite packs. A hint is never promoted to a decision here.
 */
function decideEngagement(joiner: JoinerFacts): EngagementDecision {
  const who = String(joiner.fullName || '').trim() || 'this person';
  const base = { fixUrl: CLASSIFICATION_REGISTER_URL, fixLabel: CLASSIFICATION_REGISTER_LABEL };

  const guess = resolveEngagementKey(joiner.employmentType);
  const hint = (joiner.employmentType || joiner.designation)
    ? 'The employee record has the employment type "' + String(joiner.employmentType || '(blank)')
      + '". ' + guess.reason + ' That is a starting point for the review and not a substitute for '
      + 'it: employment type is free text, written by five different screens in five different '
      + 'vocabularies, and it is never what a checklist is built from.'
    : null;

  if (!joiner.classificationReadable) {
    return {
      ...base,
      state: 'unreadable',
      engagementKey: null, engagementLabel: null, risk: null, packSummary: null,
      hint, conflict: null,
      reason:
        'The classification columns on the employee record could not be read in this database, so the '
        + 'engagement for ' + who + ' is unknown. That is a provisioning problem rather than a missing '
        + 'decision, and the reason is in the server log under [onboarding-journey]. No checklist is '
        + 'built from a guess.',
    };
  }

  const reviewed = !!(joiner.classificationReviewedAt && String(joiner.classificationReviewedAt).trim());
  const stored = String(joiner.classification || '').trim();

  if (!reviewed) {
    return {
      ...base,
      state: 'not_recorded',
      engagementKey: null, engagementLabel: null, risk: null, packSummary: null,
      hint, conflict: null,
      reason:
        'The engagement is not recorded for ' + who + ', so no checklist is built. The classification '
        + 'column carries the value the column was created with rather than a decision anybody made — '
        + 'it reads "permanent employee" for every person nobody has reviewed, which is not the same '
        + 'as somebody saying so. Nothing falls back to the employee pack here, on purpose: giving a '
        + 'contractor equipment, a reporting manager and a recorded policy acknowledgement produces '
        + 'the written record of control that a misclassification claim is made of, and doing it by '
        + 'default is how that happens without anybody deciding to. The people desk records the '
        + 'engagement on the ' + CLASSIFICATION_REGISTER_LABEL + ', and the checklist can be started '
        + 'the moment it is there.',
    };
  }

  if (!isEngagementKey(stored)) {
    return {
      ...base,
      state: 'no_pack',
      engagementKey: null, engagementLabel: null, risk: null, packSummary: null,
      hint, conflict: null,
      reason:
        'The engagement stored against ' + who + ' is "' + (stored || '(empty)') + '", which is not '
        + 'one the register recognises, so no pack can be chosen from it. Re-record it on the '
        + CLASSIFICATION_REGISTER_LABEL + '.',
    };
  }

  const key = stored as EngagementKey;
  const pack = packFor(key);
  if (!pack) {
    return {
      ...base,
      state: 'no_pack',
      engagementKey: key, engagementLabel: engagementLabelFor(key), risk: engagementRiskFor(key),
      packSummary: null, hint, conflict: null,
      reason:
        'The register records ' + who + ' as ' + engagementLabelFor(key).toLowerCase() + ', and this '
        + 'build has no onboarding pack for that engagement, so it will not guess at one.',
    };
  }

  const conflict = guess.key && guess.key !== key
    ? 'Two columns on one record disagree. The register says ' + engagementLabelFor(key).toLowerCase()
      + '; the employment type on the same row says "' + String(joiner.employmentType || '')
      + '", which reads as ' + engagementLabelFor(guess.key).toLowerCase() + '. The pack is built from '
      + 'the register, because that is the reviewed column and the one with a risk rating attached — '
      + 'but one of the two is wrong, and somebody should settle which.'
    : null;

  return {
    ...base,
    state: 'ready',
    engagementKey: key,
    engagementLabel: engagementLabelFor(key),
    risk: engagementRiskFor(key),
    packSummary: pack.summary,
    hint,
    conflict,
    reason:
      who + ' is recorded as ' + engagementLabelFor(key).toLowerCase() + ' on the '
      + CLASSIFICATION_REGISTER_LABEL + ', so the checklist is built from that pack.',
  };
}

/**
 * The engagement decision for one employee, for any screen that has to say which pack applies BEFORE
 * a checklist exists. Never throws: a failure is a state with a sentence, not a null.
 */
export async function engagementForEmployee(employeeId: string): Promise<EngagementDecision & {
  employeeId: string; employeeName: string | null; joiningDate: string | null; found: boolean;
}> {
  const missing = {
    state: 'unreadable' as const,
    engagementKey: null, engagementLabel: null, risk: null, packSummary: null,
    hint: null, conflict: null,
    fixUrl: CLASSIFICATION_REGISTER_URL,
    fixLabel: CLASSIFICATION_REGISTER_LABEL,
    employeeId: String(employeeId || ''),
    employeeName: null,
    joiningDate: null,
    found: false,
  };
  const joiner = await joinerFacts(employeeId);
  if (!joiner) {
    return { ...missing, reason: 'That employee record could not be read, so the engagement is unknown.' };
  }
  return {
    ...decideEngagement(joiner),
    employeeId: joiner.employeeId,
    employeeName: joiner.fullName,
    joiningDate: joiner.joiningDate,
    found: true,
  };
}

// -------------------------------------------------------------------------------------------------
// WHICH STEPS THIS PERSON GETS, WHICH ARE WITHHELD, AND WHY
// -------------------------------------------------------------------------------------------------

export interface SelectedStep {
  step: TemplateStep;
  /** 'pack' when the row was seeded from this engagement's pack, 'shared' when hand-written. */
  source: 'pack' | 'shared';
}

export interface WithheldStep {
  stepId: string;
  title: string;
  category: string;
  ownerVia: string;
  /** The control this step asserts, where it is tagged. Null for an untagged row. */
  control: string | null;
  controlLabel: string | null;
  /** 'control' — the pack excludes what this asserts. 'untagged' — nobody has said what it does. */
  kind: 'control' | 'untagged';
  /** Rendered verbatim. For a control this is the pack's own reason, in the pack's own words. */
  why: string;
}

export interface StepSelection {
  included: SelectedStep[];
  withheld: WithheldStep[];
  /** Rows belonging to a different engagement's pack. Not a decision about this person. */
  otherEngagement: number;
  /** Rows dropped by the legacy per-step employment-type restriction. */
  restricted: number;
}

/**
 * THE LEGACY PER-STEP RESTRICTION, MATCHED HONESTLY.
 *
 * The template has always had a free-text "only for one employment type" box, compared by stripping
 * spacing and lower-casing. 'Full-Time' and 'full_time' matched; 'Internship' — what the HR form and
 * the offer form actually write — never matched 'intern', which is what somebody typing a restriction
 * would write. So a restricted step silently reached nobody at all, and no screen said so. Both sides
 * now go through the one resolver, so two words meaning the same engagement match.
 */
function restrictionMatches(want: string | null, engagement: EngagementKey, joiner: JoinerFacts): boolean {
  const raw = String(want || '').trim();
  if (!raw) return true;
  const a = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const b = String(joiner.employmentType || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (a === b) return true;

  const wantKey = resolveEngagementKey(raw).key;
  if (!wantKey) return false;

  // The restriction may name a spine key directly, and the ENGAGEMENT is the authoritative statement
  // of what this person is — it came from the reviewed classification, which is the column that
  // decides everything else here.
  if (wantKey === engagement) return true;

  // A FREE-TEXT WORD CANNOT TELL THE TWO INTERNSHIPS APART, AND IT IS NOT ASKED TO.
  //
  // 'intern' resolves to the stipend-paid key and 'Internship' resolves to the unpaid one, because
  // the company default is unpaid unless a stipend is explicitly recorded. Comparing those two
  // strictly would mean a template step restricted to "intern" reached paid interns and silently
  // missed every unpaid one, which is the larger population and the one the restriction was almost
  // certainly written for. Whether the stipend exists is recorded on the register, and the register
  // has already chosen the pack; this box only has to say which population the step is for.
  if (INTERNSHIP_CLASSIFICATIONS.has(wantKey) && INTERNSHIP_CLASSIFICATIONS.has(engagement)) return true;

  const haveKey = resolveEngagementKey(joiner.employmentType).key;
  return !!haveKey && haveKey === wantKey;
}

/**
 * WHAT THIS ENGAGEMENT GETS FROM THE TEMPLATE, AND WHAT IT IS DENIED.
 *
 * Three kinds of template row, three rules:
 *
 *   seeded for THIS engagement     included. It came from this pack, so the pack already decided it
 *                                  was appropriate — and a pack never contains a step asserting a
 *                                  control it excludes, which onboarding-packs.ts proves.
 *   seeded for ANOTHER engagement  never. Not "withheld with a reason" either: it is not a decision
 *                                  about this person, it is somebody else's pack.
 *   hand-written, no engagement    judged. Tagged with a control the pack excludes, it is withheld
 *                                  with the pack's own reason. UNTAGGED, and this pack excludes
 *                                  anything at all, it is withheld too.
 *
 * THE UNTAGGED RULE IS THE ONE THAT MATTERS, AND IT IS DELIBERATELY CONSERVATIVE. The eight steps the
 * old flat starter button wrote — issue equipment, first-week reading, read and acknowledge the
 * policies, an introduction owned by the reporting manager — are sitting on live templates right now
 * carrying no engagement and no control. If an untagged row defaulted to "applies to everybody",
 * every one of them would land on a contractor's checklist, which is precisely the failure this work
 * exists to end. Nothing can show such a row is safe, so it is withheld from any engagement whose
 * pack excludes something, named on screen with its reason, and either tagged or added back
 * deliberately. Withholding a harmless step costs somebody one press. Including a harmful one costs
 * a great deal more, and costs it later, when it cannot be taken back.
 */
export function selectStepsFor(
  steps: TemplateStep[],
  engagement: EngagementKey,
  joiner: JoinerFacts,
): StepSelection {
  const pack = packFor(engagement);
  const out: StepSelection = { included: [], withheld: [], otherEngagement: 0, restricted: 0 };
  if (!pack) return out;

  const excludedControls = pack.excludes.map((x) => controlLabel(x.control).toLowerCase()).join(', ');
  const untaggedWhy = pack.excludes.length === 0 ? '' :
    'Nobody has recorded what this step asserts about the relationship, and the '
    + engagementLabelFor(engagement).toLowerCase() + ' pack withholds ' + excludedControls + '. A step '
    + 'that cannot be shown to be safe for this engagement is not assumed to be: the eight steps the '
    + 'old flat checklist wrote are exactly this shape, and issuing equipment or recording a policy '
    + 'acknowledgement against somebody who is not an employee is evidence rather than admin. Tag the '
    + 'step with the control it asserts and it will be judged properly, or add it back here with a '
    + 'reason.';

  for (const step of steps) {
    if (!restrictionMatches(step.employmentType, engagement, joiner)) { out.restricted += 1; continue; }

    if (step.engagementKey) {
      if (step.engagementKey !== engagement) { out.otherEngagement += 1; continue; }
      out.included.push({ step, source: 'pack' });
      continue;
    }

    if (step.assertsControl) {
      const rule = exclusionFor(engagement, step.assertsControl as ControlSignal);
      if (rule) {
        out.withheld.push({
          stepId: step.id,
          title: step.title,
          category: step.category,
          ownerVia: step.ownerVia,
          control: step.assertsControl,
          controlLabel: controlLabel(step.assertsControl),
          kind: 'control',
          why: rule.why,
        });
        continue;
      }
      out.included.push({ step, source: 'shared' });
      continue;
    }

    if (pack.excludes.length > 0) {
      out.withheld.push({
        stepId: step.id,
        title: step.title,
        category: step.category,
        ownerVia: step.ownerVia,
        control: null,
        controlLabel: null,
        kind: 'untagged',
        why: untaggedWhy,
      });
      continue;
    }

    out.included.push({ step, source: 'shared' });
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// WHAT WOULD HAPPEN, BEFORE IT HAPPENS
// -------------------------------------------------------------------------------------------------

export interface JourneyPreview {
  ok: boolean;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  joiningDate: string | null;
  engagement: EngagementDecision;
  /** The steps that WILL be created, in the order they will appear. */
  included: Array<{
    id: string; title: string; description: string | null; category: string;
    ownerVia: string; dueDay: number; source: 'pack' | 'shared';
  }>;
  /** The steps that will NOT be created, each with a reason a person can read. */
  withheld: WithheldStep[];
  otherEngagement: number;
  restricted: number;
  templateEmpty: boolean;
  /** Whether this pack has been seeded onto the template at all. */
  packSeeded: boolean;
  /** The documents this engagement genuinely asks for. */
  documents: Array<{ docType: string; label: string; why: string; required: boolean }>;
  existing: boolean;
  /** What they were when the existing checklist was built. */
  startedAsEngagement: string | null;
  startedAsLabel: string | null;
  /** True when the recorded engagement has changed since the checklist was built. */
  engagementChanged: boolean;
  /** Step ids already on the journey, so the preview does not promise to create them twice. */
  alreadyOn: string[];
  error?: string;
}

/**
 * WHAT STARTING THIS CHECKLIST WOULD DO — the pack, its steps, and every exclusion with its reason.
 *
 * This exists so that an HR user reads that a contractor is deliberately not being given an induction,
 * and why, AT THE MOMENT THEY PRESS START rather than discovering it later. The admin screen puts the
 * Start button inside this panel and nowhere else, so a checklist cannot be created without the pack
 * being on the screen in front of the person creating it.
 *
 * Reads only. Nothing here writes anything.
 */
export async function previewJourney(employeeId: string): Promise<JourneyPreview> {
  const blank: JourneyPreview = {
    ok: false, employeeId: String(employeeId || ''), employeeName: null, employeeCode: null,
    joiningDate: null,
    engagement: {
      state: 'unreadable', engagementKey: null, engagementLabel: null, risk: null, packSummary: null,
      reason: 'The engagement could not be read.', hint: null, conflict: null,
      fixUrl: CLASSIFICATION_REGISTER_URL, fixLabel: CLASSIFICATION_REGISTER_LABEL,
    },
    included: [], withheld: [], otherEngagement: 0, restricted: 0, templateEmpty: true,
    packSeeded: false, documents: [], existing: false, startedAsEngagement: null,
    startedAsLabel: null, engagementChanged: false, alreadyOn: [],
  };
  if (!isUuid(employeeId)) return { ...blank, error: 'That employee could not be identified.' };
  try {
    if (!(await engagementColumnsReady())) return { ...blank, error: SCHEMA_UNAVAILABLE };
    const joiner = await joinerFacts(employeeId);
    if (!joiner) return { ...blank, error: 'That employee record could not be found.' };

    const decision = decideEngagement(joiner);

    const existingRows = rowsOf(await db.execute(sql`
      SELECT id, engagement_key FROM hr_onboarding_journeys
       WHERE employee_id = ${employeeId}::uuid LIMIT 1`));
    const existing = existingRows.length > 0;
    const startedAs = existing && existingRows[0].engagement_key
      ? String(existingRows[0].engagement_key) : null;
    let alreadyOn: string[] = [];
    if (existing) {
      alreadyOn = rowsOf(await db.execute(sql`
        SELECT step_id FROM hr_onboarding_journey_items
         WHERE journey_id = ${String(existingRows[0].id)}::uuid AND step_id IS NOT NULL`))
        .map((r: any) => String(r.step_id));
    }

    const head: JourneyPreview = {
      ...blank,
      ok: true,
      employeeId: joiner.employeeId,
      employeeName: joiner.fullName,
      employeeCode: joiner.employeeCode,
      joiningDate: joiner.joiningDate,
      engagement: decision,
      existing,
      startedAsEngagement: startedAs,
      startedAsLabel: startedAs && isEngagementKey(startedAs)
        ? engagementLabelFor(startedAs as EngagementKey) : startedAs,
      engagementChanged: !!(startedAs && decision.engagementKey && startedAs !== decision.engagementKey),
      alreadyOn,
    };

    if (decision.state !== 'ready' || !decision.engagementKey) return head;

    const steps = await listTemplateSteps();
    const selection = selectStepsFor(steps, decision.engagementKey, joiner);
    const onSet = new Set(alreadyOn);

    return {
      ...head,
      templateEmpty: steps.length === 0,
      packSeeded: steps.some((s) => s.engagementKey === decision.engagementKey),
      documents: documentsForEngagement(decision.engagementKey).map((d) => ({
        docType: String(d.docType), label: d.label, why: d.why, required: d.required === true,
      })),
      included: selection.included
        .filter((s) => !onSet.has(s.step.id))
        .map((s) => ({
          id: s.step.id, title: s.step.title, description: s.step.description,
          category: s.step.category, ownerVia: s.step.ownerVia, dueDay: s.step.dueDay,
          source: s.source,
        })),
      withheld: selection.withheld.filter((w) => !onSet.has(w.stepId)),
      otherEngagement: selection.otherEngagement,
      restricted: selection.restricted,
    };
  } catch (e: any) {
    logFail('previewJourney', e);
    return { ...blank, error: 'The preview could not be built: ' + reasonOf(e) };
  }
}

export interface StartJourneyOptions {
  /**
   * Template step ids that this engagement's pack withholds, which somebody is adding back anyway.
   * Sometimes the classification is simply wrong and the honest fix is to change the classification,
   * which is why the reason below is required rather than optional.
   */
  addBackStepIds?: string[];
  /** Why. Refused when missing or too short to be an explanation. Stored on every item it adds. */
  addBackReason?: string;
}

/**
 * START (or TOP UP) A JOINER'S CHECKLIST, FROM THE PACK FOR THEIR ENGAGEMENT.
 *
 * Safe to call again. The journey row is created once; the items are inserted with
 * ON CONFLICT DO NOTHING against the (journey_id, step_id) unique index, so calling this after HR has
 * added a step to the template ADDS that step to a running journey and touches nothing already there.
 * Nobody's completed item is ever reset by re-running it.
 *
 * TWO THINGS IT NOW REFUSES TO DO, both of which it used to do silently:
 *
 * 1. BUILD A CHECKLIST FOR SOMEBODY WHOSE ENGAGEMENT IS NOT RECORDED. It names the register that
 *    records it and stops. The old behaviour was to hand everybody the same flat list.
 *
 * 2. TOP UP A CHECKLIST BUILT FOR A DIFFERENT ENGAGEMENT. The journey SNAPSHOTS what the person was
 *    when it was created. Without that, converting an intern to permanent — or correcting a
 *    contractor who was mis-entered — and pressing start again would add the new pack's steps while
 *    every step of the old pack stayed on the checklist forever, because nothing here ever deletes.
 *    The result is the union of both packs, which in the contractor case is exactly the employee
 *    induction that had to be avoided. It says so and stops instead.
 */
export async function startJourney(
  employeeId: string,
  actorUserId: string | null,
  opts: StartJourneyOptions = {},
): Promise<JourneyResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That employee could not be identified.' };
  try {
    if (!(await engagementColumnsReady())) return { ok: false, error: SCHEMA_UNAVAILABLE };
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;

    const joiner = await joinerFacts(employeeId);
    if (!joiner) return { ok: false, error: 'That employee record could not be found.' };

    // THE ENGAGEMENT DECIDES, AND AN UNRECORDED ENGAGEMENT IS A REFUSAL, NOT A DEFAULT.
    const decision = decideEngagement(joiner);
    if (decision.state !== 'ready' || !decision.engagementKey) {
      return { ok: false, error: decision.reason, needsEngagement: true, fixUrl: decision.fixUrl };
    }
    const engagement = decision.engagementKey;
    const engagementName = String(decision.engagementLabel || engagement).toLowerCase();

    const addBackIds = (opts.addBackStepIds || []).map((x) => String(x || '').trim()).filter(isUuid);
    const addBackReason = String(opts.addBackReason || '').trim().slice(0, 1000);
    if (addBackIds.length > 0 && addBackReason.length < 15) {
      return {
        ok: false,
        error: 'Adding a withheld step back needs a reason, and it is recorded against every step it '
          + 'adds. The pack withholds these because creating them writes evidence of a relationship '
          + 'this person is not in, so if the classification is wrong the honest fix is to change the '
          + 'classification on the ' + CLASSIFICATION_REGISTER_LABEL + ' rather than to override the '
          + 'pack. Say in a sentence why this one is right anyway.',
      };
    }

    const steps = await listTemplateSteps();
    if (steps.length === 0) {
      return {
        ok: false,
        error: 'There are no steps on the onboarding template yet, so there is nothing to track. Seed '
          + 'the packs, or add the steps this company actually does for a joiner, first.',
      };
    }

    const selection = selectStepsFor(steps, engagement, joiner);
    const withheldById = new Map(selection.withheld.map((w) => [w.stepId, w]));
    const addingBack = addBackIds.filter((id) => withheldById.has(id));
    if (selection.included.length === 0 && addingBack.length === 0) {
      return {
        ok: false,
        error: 'Nothing on the template applies to the ' + engagementName + ' pack yet, so there is '
          + 'nothing to start. Seed that pack onto the template first. This is not a person with no '
          + 'obligations; it is a template with nothing recorded for their engagement.',
      };
    }

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_onboarding_journeys (employee_id, joining_date, started_by_user_id, engagement_key)
      VALUES (${employeeId}::uuid, ${joiner.joiningDate}::date, ${actor}::uuid, ${engagement})
      ON CONFLICT DO NOTHING
      RETURNING id`));

    let journeyId = ins.length ? String(ins[0].id) : '';
    if (!journeyId) {
      const existing = rowsOf(await db.execute(sql`
        SELECT id, engagement_key FROM hr_onboarding_journeys
         WHERE employee_id = ${employeeId}::uuid LIMIT 1`));
      if (!existing.length) return { ok: false, error: WRITE_FAILED };
      journeyId = String(existing[0].id);
      const startedAs = existing[0].engagement_key ? String(existing[0].engagement_key) : null;

      if (startedAs && startedAs !== engagement) {
        const wasLabel = isEngagementKey(startedAs)
          ? engagementLabelFor(startedAs as EngagementKey) : startedAs;
        return {
          ok: false,
          engagementChanged: true,
          error: 'This checklist was built for ' + String(wasLabel).toLowerCase() + ' and the register '
            + 'now records ' + engagementName + '. Topping it up would add the new pack on top of the '
            + 'old one and leave every step of the old pack on the checklist, because nothing here '
            + 'ever deletes what somebody was asked to do — so the person would end up holding both. '
            + 'Settle the classification first, then mark the steps that no longer apply as not '
            + 'applicable; each one stays on the record with its reason.',
        };
      }
      if (!startedAs) {
        // A journey started before engagements existed. Adopt the current one rather than leaving the
        // snapshot blank, and ONLY where it is genuinely blank.
        await db.execute(sql`
          UPDATE hr_onboarding_journeys SET engagement_key = ${engagement}, updated_at = NOW()
           WHERE id = ${journeyId}::uuid AND engagement_key IS NULL`);
      }
    }

    const graphReady = await isInitialized();
    let unowned = 0;
    let created = 0;
    let overridden = 0;
    // Owners already notified on this run, so somebody who owns four steps gets one message rather
    // than four. A notification per step is how people learn to ignore notifications.
    const notified = new Set<string>();
    // Steps added on this run that the JOINER themselves owns. See the block after the loop.
    let joinerSteps = 0;

    const toCreate: Array<{ step: TemplateStep; despite: string | null }> =
      selection.included.map((s) => ({ step: s.step, despite: null as string | null }));
    for (const id of addingBack) {
      const w = withheldById.get(id)!;
      const step = steps.find((s) => s.id === id);
      if (!step) continue;
      toCreate.push({
        step,
        despite: 'Withheld by the ' + engagementName + ' pack because: ' + w.why
          + ' Added back anyway by the people desk, who gave this reason: ' + addBackReason,
      });
    }

    for (const entry of toCreate) {
      const step = entry.step;
      const owner = await resolveOwner(step.ownerVia, joiner, graphReady);
      if (!owner.employeeId) unowned += 1;

      const added = rowsOf(await db.execute(sql`
        INSERT INTO hr_onboarding_journey_items
          (journey_id, step_id, title, description, category, owner_via, owner_employee_id,
           owner_user_id, owner_name, owner_unresolved_reason, due_on, reading_url,
           requires_acknowledgement, sort_order, engagement_key, added_despite_reason)
        VALUES
          (${journeyId}::uuid, ${step.id}::uuid, ${step.title}, ${step.description},
           ${step.category}, ${step.ownerVia}, ${owner.employeeId}::uuid, ${owner.userId}::uuid,
           ${owner.name}, ${owner.unresolvedReason},
           ${dueOnFor(joiner.joiningDate, step.dueDay)}::date, ${step.readingUrl},
           ${step.requiresAcknowledgement}, ${step.sortOrder}, ${engagement}, ${entry.despite})
        ON CONFLICT DO NOTHING
        RETURNING id`));

      if (added.length) {
        created += 1;
        if (entry.despite) {
          overridden += 1;
          // A DELIBERATE OVERRIDE OF A LEGAL EXCLUSION IS ITS OWN AUDIT EVENT, not a line in a
          // summary. Whoever reads this record later has to be able to find the moment somebody
          // decided, and what they decided it against.
          await logAudit({
            userId: actor, action: 'onboarding.exclusion_overridden',
            entity: 'hr_onboarding_journey_item', entityId: String(added[0].id),
            diff: {
              employeeId, engagement, step: step.title, reason: addBackReason,
              exclusion: withheldById.get(step.id)?.why || null,
            },
          });
        }
      }

      // Tell the owner only about steps that are NEW on this run, and only when they are somebody
      // other than the joiner. Best-effort: the item is already committed, so a notification failure
      // must never report the journey as not started.
      if (added.length && owner.userId && owner.userId !== joiner.userId && !notified.has(owner.userId)) {
        notified.add(owner.userId);
        try {
          await notifyUser(owner.userId, {
            title: 'Onboarding: ' + (joiner.fullName || 'a new joiner'),
            body: 'You own steps on their onboarding checklist.',
            type: 'hire',
            actionUrl: '/admin/hr/onboarding/journey',
            entityType: 'hr_onboarding_journey',
            entityId: journeyId,
          });
        } catch (e: any) {
          logFail('startJourney.notify', e);
        }
      }

      if (added.length && owner.userId && joiner.userId && owner.userId === joiner.userId) joinerSteps += 1;
    }

    // THE JOINER IS TOLD TOO — SEPARATELY, AND POINTING SOMEWHERE THEY CAN ACTUALLY GO.
    //
    // The guard above (`owner.userId !== joiner.userId`) correctly stops somebody who owns both an
    // HR step and their own from getting two messages. What it also did was exclude the joiner
    // ENTIRELY: four of the eight suggested steps are owned by 'the_joiner' — submit the documents,
    // the first-week reading, acknowledge the policies — and the documents step is due on day zero.
    // The one participant with same-day obligations was the only one who received no notification
    // that they had any, and the owner message points at an admin console they cannot open.
    if (joinerSteps > 0 && joiner.userId) {
      try {
        await notifyUser(joiner.userId, {
          title: 'Your onboarding checklist is ready',
          body: joinerSteps === 1
            ? 'There is one step waiting for you, with a date on it.'
            : 'There are ' + joinerSteps + ' steps waiting for you, each with a date on it.',
          type: 'hire',
          actionUrl: '/portal/employee/onboarding',
          entityType: 'hr_onboarding_journey',
          entityId: journeyId,
        });
      } catch (e: any) {
        logFail('startJourney.notifyJoiner', e);
      }
    }

    await logAudit({
      userId: actor, action: 'onboarding.journey_started', entity: 'hr_onboarding_journey',
      entityId: journeyId,
      diff: {
        employeeId, joiningDate: joiner.joiningDate, engagement,
        created, withheld: selection.withheld.length, overridden, unowned,
      },
    });

    return {
      ok: true,
      id: journeyId,
      changed: created > 0,
      unowned,
      created,
      withheld: selection.withheld.length,
      overridden,
      engagementKey: engagement,
      engagementLabel: decision.engagementLabel,
    };
  } catch (e: any) {
    logFail('startJourney', e);
    return { ok: false, error: 'The journey was not started: ' + reasonOf(e) };
  }
}

/**
 * RE-RESOLVE THE OWNERS OF EVERY UNOWNED, UNSETTLED ITEM.
 *
 * This is what makes an empty Organization Graph survivable rather than fatal. Journeys started
 * before the backfill carry items saying plainly that no owner could be resolved; once the graph has
 * rows, this fills them in without re-creating anything and without disturbing what anybody has
 * already completed. Owners that ARE already resolved are left alone — re-pointing a step somebody is
 * halfway through because a reorganisation happened this morning is not an improvement.
 */
export async function reresolveOwners(actorUserId: string | null, journeyId?: string | null): Promise<{
  ok: boolean; resolved: number; stillUnowned: number; error?: string;
}> {
  try {
    await ensureJourneySchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const scope = isUuid(journeyId) ? sql` AND i.journey_id = ${journeyId}::uuid` : sql``;
    const pending = rowsOf(await db.execute(sql`
      SELECT i.id, i.owner_via, j.employee_id
        FROM hr_onboarding_journey_items i
        JOIN hr_onboarding_journeys j ON j.id = i.journey_id
       WHERE i.owner_employee_id IS NULL
         AND i.state IN ('pending', 'blocked')${scope}
       ORDER BY i.created_at ASC
       LIMIT 500`));

    if (pending.length === 0) return { ok: true, resolved: 0, stillUnowned: 0 };

    const graphReady = await isInitialized();
    const joiners = new Map<string, Awaited<ReturnType<typeof joinerFacts>>>();
    let resolved = 0;
    let stillUnowned = 0;

    for (const raw of pending) {
      const itemId = String((raw as any).id);
      const employeeId = String((raw as any).employee_id);
      if (!joiners.has(employeeId)) joiners.set(employeeId, await joinerFacts(employeeId));
      const joiner = joiners.get(employeeId);
      if (!joiner) { stillUnowned += 1; continue; }

      const owner = await resolveOwner(String((raw as any).owner_via), joiner, graphReady);
      if (!owner.employeeId) {
        stillUnowned += 1;
        // The REASON is still refreshed, so a step that was "graph not built yet" becomes "no
        // reporting manager is recorded" the moment that stops being the true explanation.
        await db.execute(sql`
          UPDATE hr_onboarding_journey_items
             SET owner_unresolved_reason = ${owner.unresolvedReason}, updated_at = NOW()
           WHERE id = ${itemId}::uuid`);
        continue;
      }

      await db.execute(sql`
        UPDATE hr_onboarding_journey_items
           SET owner_employee_id = ${owner.employeeId}::uuid,
               owner_user_id = ${owner.userId}::uuid,
               owner_name = ${owner.name},
               owner_unresolved_reason = NULL,
               updated_at = NOW()
         WHERE id = ${itemId}::uuid`);
      resolved += 1;
    }

    if (resolved > 0) {
      await logAudit({
        userId: actor, action: 'onboarding.owners_resolved', entity: 'hr_onboarding_journey',
        entityId: isUuid(journeyId) ? String(journeyId) : 'all',
        diff: { resolved, stillUnowned },
      });
    }
    return { ok: true, resolved, stillUnowned };
  } catch (e: any) {
    logFail('reresolveOwners', e);
    return { ok: false, resolved: 0, stillUnowned: 0, error: 'The owners could not be re-resolved: ' + reasonOf(e) };
  }
}

async function itemsFor(journeyId: string): Promise<JourneyItem[]> {
  try {
    return rowsOf(await db.execute(sql`
      SELECT * FROM hr_onboarding_journey_items
       WHERE journey_id = ${journeyId}::uuid
       ORDER BY sort_order ASC, due_on ASC NULLS LAST, created_at ASC`)).map(mapItem);
  } catch (e: any) {
    logFail('itemsFor', e);
    return [];
  }
}

/** One joiner's checklist. Null when they have no journey yet — an honest absence, not an error. */
export async function journeyForEmployee(employeeId: string): Promise<Journey | null> {
  if (!isUuid(employeeId)) return null;
  if (!(await safeEnsure())) return null;
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT j.*, e.full_name AS employee_name, e.employee_code
        FROM hr_onboarding_journeys j
        JOIN hr_employees e ON e.id = j.employee_id
       WHERE j.employee_id = ${employeeId}::uuid LIMIT 1`));
    if (!list.length) return null;
    const r = list[0] as any;
    const items = await itemsFor(String(r.id));
    return {
      id: String(r.id),
      employeeId: String(r.employee_id),
      employeeName: r.employee_name ? String(r.employee_name) : null,
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      engagementKey: engagementKeyOf(r),
      engagementLabel: engagementLabelOf(r),
      items,
      progress: journeyProgress(items),
    };
  } catch (e: any) {
    logFail('journeyForEmployee', e);
    return null;
  }
}

/**
 * The engagement stamped on a journey row, read defensively.
 *
 * A journey started before the engagement column existed carries NULL, and that is a real answer —
 * "nobody recorded what this checklist was built for" — never an excuse to guess at one.
 */
function engagementKeyOf(r: any): string | null {
  return r?.engagement_key ? String(r.engagement_key) : null;
}

function engagementLabelOf(r: any): string | null {
  const key = engagementKeyOf(r);
  if (!key) return null;
  return isEngagementKey(key) ? engagementLabelFor(key as EngagementKey) : key;
}

/**
 * EVERY RUNNING JOURNEY, so HR can see who is stuck and where.
 *
 * Sorted by trouble rather than by date: unowned items first, then overdue, then everything else. The
 * whole point of the screen is that the joiner who is stuck is at the top of it, not on page three.
 */
export async function listJourneys(limit = 100): Promise<Journey[]> {
  if (!(await safeEnsure())) return [];
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT j.*, e.full_name AS employee_name, e.employee_code
        FROM hr_onboarding_journeys j
        JOIN hr_employees e ON e.id = j.employee_id
       ORDER BY j.completed_at IS NULL DESC, j.started_at DESC
       LIMIT ${Math.max(1, Math.min(300, Number(limit) || 100))}`));

    const out: Journey[] = [];
    for (const r of list) {
      const items = await itemsFor(String((r as any).id));
      out.push({
        id: String((r as any).id),
        employeeId: String((r as any).employee_id),
        employeeName: (r as any).employee_name ? String((r as any).employee_name) : null,
        employeeCode: (r as any).employee_code ? String((r as any).employee_code) : null,
        joiningDate: (r as any).joining_date ? new Date((r as any).joining_date).toISOString().slice(0, 10) : null,
        startedAt: (r as any).started_at ? new Date((r as any).started_at).toISOString() : null,
        completedAt: (r as any).completed_at ? new Date((r as any).completed_at).toISOString() : null,
        engagementKey: engagementKeyOf(r),
        engagementLabel: engagementLabelOf(r),
        items,
        progress: journeyProgress(items),
      });
    }
    out.sort((a, b) => {
      const score = (j: Journey) => (j.progress.complete ? -1 : j.progress.unowned * 100 + j.progress.overdue * 10 + j.progress.outstanding);
      return score(b) - score(a);
    });
    return out;
  } catch (e: any) {
    logFail('listJourneys', e);
    return [];
  }
}

export interface JoinerWithoutJourney {
  id: string;
  fullName: string;
  employeeCode: string | null;
  joiningDate: string | null;
  /** The engagement label where one is RECORDED, null where nobody has reviewed them. */
  engagementLabel: string | null;
  /** 'low' | 'medium' | 'high' where recorded. The high ones are the ones to read twice. */
  risk: string | null;
  /** True when the classification carries the column default rather than a decision. */
  engagementRecorded: boolean;
}

/**
 * Employees with no journey yet, so HR can start one rather than hunt for who was missed.
 *
 * The engagement comes back with them, in ONE query rather than one per person, because "who has no
 * checklist" and "who nobody has classified" turn out to be almost the same list — and a person
 * nobody has classified cannot have a checklist started at all. Saying so on the row saves an HR user
 * pressing a button to be told no.
 *
 * classification and classification_reviewed_at are named only after information_schema confirms they
 * exist. Naming a column that does not exist makes the WHOLE statement throw, which on this codebase
 * has taken /admin down for every administrator at once.
 */
export async function employeesWithoutJourney(limit = 50): Promise<JoinerWithoutJourney[]> {
  if (!(await safeEnsure())) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  try {
    const withClassification = await classificationColumnsReady();
    const rows = withClassification
      ? rowsOf(await db.execute(sql`
          SELECT e.id, e.full_name, e.employee_code, e.joining_date,
                 e.classification, e.classification_reviewed_at
            FROM hr_employees e
            LEFT JOIN hr_onboarding_journeys j ON j.employee_id = e.id
           WHERE j.id IS NULL AND e.is_active = true
           ORDER BY e.joining_date DESC NULLS LAST, e.created_at DESC
           LIMIT ${cap}`))
      : rowsOf(await db.execute(sql`
          SELECT e.id, e.full_name, e.employee_code, e.joining_date
            FROM hr_employees e
            LEFT JOIN hr_onboarding_journeys j ON j.employee_id = e.id
           WHERE j.id IS NULL AND e.is_active = true
           ORDER BY e.joining_date DESC NULLS LAST, e.created_at DESC
           LIMIT ${cap}`));

    return rows.map((r: any) => {
      const reviewed = !!(r.classification_reviewed_at && String(r.classification_reviewed_at).trim());
      const key = String(r.classification || '');
      const known = reviewed && isEngagementKey(key);
      return {
        id: String(r.id),
        fullName: String(r.full_name || ''),
        employeeCode: r.employee_code ? String(r.employee_code) : null,
        joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
        engagementLabel: known ? engagementLabelFor(key as EngagementKey) : null,
        risk: known ? engagementRiskFor(key as EngagementKey) : null,
        engagementRecorded: known,
      };
    });
  } catch (e: any) {
    logFail('employeesWithoutJourney', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WORKING THROUGH THE CHECKLIST
// -------------------------------------------------------------------------------------------------

/**
 * WHO MAY MOVE AN ITEM. Three answers, and the order matters:
 *
 *   1. the OWNER the graph resolved (by their user account),
 *   2. the JOINER themselves, for their own steps only,
 *   3. the HR desk, and ONLY because the caller has already checked a capability and says so.
 *
 * `isHrDesk` is passed IN by the page after can(user, ...) — this module never tests users.role and
 * never decides authorization itself. That check belongs to src/lib/auth/permissions.ts and asking it
 * a second way here would create two answers to one question.
 */
export interface ActOnItemInput {
  itemId: string;
  state: ItemState;
  note?: string | null;
  actorUserId: string | null;
  /** True only when the caller has already verified the acting account holds the people desk. */
  isHrDesk?: boolean;
}

export async function setItemState(input: ActOnItemInput): Promise<JourneyResult> {
  const itemId = String(input?.itemId || '').trim();
  if (!isUuid(itemId)) return { ok: false, error: 'That step could not be identified.' };
  const state = String(input?.state || '') as ItemState;
  if ((ITEM_STATES as readonly string[]).indexOf(state) < 0) {
    return { ok: false, error: 'That is not a state this checklist records.' };
  }
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!actor) return { ok: false, error: 'Sign in to update this step.' };
  const note = String(input?.note || '').trim().slice(0, 1000);
  if (state === 'blocked' && !note) {
    return { ok: false, error: 'Say what is blocking it. A blocked step with no reason is a step nobody can unblock.' };
  }

  try {
    await ensureJourneySchema();

    const list = rowsOf(await db.execute(sql`
      SELECT i.id, i.owner_user_id, i.title, i.state, i.requires_acknowledgement, i.acknowledged_at,
             j.employee_id, e.user_id AS joiner_user_id, e.full_name AS joiner_name
        FROM hr_onboarding_journey_items i
        JOIN hr_onboarding_journeys j ON j.id = i.journey_id
        JOIN hr_employees e ON e.id = j.employee_id
       WHERE i.id = ${itemId}::uuid LIMIT 1`));
    if (!list.length) return { ok: false, error: 'That step could not be found.' };
    const row = list[0] as any;

    const isOwner = row.owner_user_id && String(row.owner_user_id) === actor;
    const isJoiner = row.joiner_user_id && String(row.joiner_user_id) === actor;
    if (!isOwner && !isJoiner && input?.isHrDesk !== true) {
      // TWO DIFFERENT REFUSALS, because they need two different actions. An employee record with no
      // linked account cannot match anybody, so the joiner is refused on their own checklist and has
      // no way of knowing why — that is a broken link for HR to fix, not a permission problem.
      if (!row.joiner_user_id && !row.owner_user_id) {
        return {
          ok: false,
          error: 'This step cannot be moved yet: neither the joiner nor its owner has a sign-in '
            + 'account linked to their employee record. Ask HR to link them.',
        };
      }
      return {
        ok: false,
        error: 'This step belongs to somebody else. Only its owner, the joiner, or the people desk can move it.',
      };
    }

    // A step that must be acknowledged is completed BY the acknowledgement, not by a button. Letting
    // 'done' be pressed instead would leave a policy marked read with no record that anybody read it.
    if (state === 'done' && row.requires_acknowledgement === true && !row.acknowledged_at) {
      return {
        ok: false,
        error: 'This step is completed by the joiner acknowledging the document, not by marking it done.',
      };
    }

    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_onboarding_journey_items
         SET state = ${state},
             note = ${note || null},
             completed_by_user_id = CASE WHEN ${state} = 'done' THEN ${actor}::uuid ELSE NULL END,
             completed_at = CASE WHEN ${state} = 'done' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = ${itemId}::uuid
       RETURNING id, journey_id`));
    if (!upd.length) return { ok: false, error: WRITE_FAILED };

    await closeJourneyIfComplete(String(upd[0].journey_id));

    await logAudit({
      userId: actor, action: 'onboarding.item_' + state, entity: 'hr_onboarding_journey_item',
      entityId: itemId,
      diff: { title: String(row.title || ''), employeeId: String(row.employee_id), note: note || null },
    });
    return { ok: true, id: itemId, changed: true };
  } catch (e: any) {
    logFail('setItemState', e);
    return { ok: false, error: 'The step was not updated: ' + reasonOf(e) };
  }
}

/**
 * THE JOINER ACKNOWLEDGES A POLICY.
 *
 * ONLY the joiner, and never the owner or the HR desk. An acknowledgement is a statement that a
 * specific person read a specific document; a manager pressing it on their behalf would be a record
 * of something that did not happen, and it is precisely the kind of record that gets relied on later.
 * It also cannot be un-done here: a person did read it, and no later button changes that.
 */
export async function acknowledgeItem(itemId: string, actorUserId: string | null): Promise<JourneyResult> {
  if (!isUuid(itemId)) return { ok: false, error: 'That step could not be identified.' };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  if (!actor) return { ok: false, error: 'Sign in to acknowledge this.' };
  try {
    await ensureJourneySchema();
    const list = rowsOf(await db.execute(sql`
      SELECT i.id, i.title, i.requires_acknowledgement, i.reading_url, i.acknowledged_at,
             j.id AS journey_id, j.employee_id, e.user_id AS joiner_user_id
        FROM hr_onboarding_journey_items i
        JOIN hr_onboarding_journeys j ON j.id = i.journey_id
        JOIN hr_employees e ON e.id = j.employee_id
       WHERE i.id = ${itemId}::uuid LIMIT 1`));
    if (!list.length) return { ok: false, error: 'That step could not be found.' };
    const row = list[0] as any;

    if (!row.joiner_user_id) {
      // The employee record carries no linked sign-in account, so NOBODY can match — including the
      // joiner looking straight at their own checklist. Say which thing is broken.
      return {
        ok: false,
        error: 'This employee record has no sign-in account linked to it, so an acknowledgement '
          + 'cannot be attributed to anybody. Ask HR to link the account first.',
      };
    }
    if (String(row.joiner_user_id) !== actor) {
      return { ok: false, error: 'Only the person this checklist belongs to can acknowledge a policy on it.' };
    }
    if (row.requires_acknowledgement !== true) {
      return { ok: false, error: 'That step does not ask for an acknowledgement.' };
    }
    if (row.acknowledged_at) return { ok: true, id: itemId, changed: false };

    await db.execute(sql`
      UPDATE hr_onboarding_journey_items
         SET acknowledged_at = NOW(), state = 'done', completed_by_user_id = ${actor}::uuid,
             completed_at = NOW(), updated_at = NOW()
       WHERE id = ${itemId}::uuid`);

    await closeJourneyIfComplete(String(row.journey_id));

    await logAudit({
      userId: actor, action: 'onboarding.policy_acknowledged', entity: 'hr_onboarding_journey_item',
      entityId: itemId,
      diff: {
        title: String(row.title || ''), employeeId: String(row.employee_id),
        document: row.reading_url ? String(row.reading_url) : null,
      },
    });
    return { ok: true, id: itemId, changed: true };
  } catch (e: any) {
    logFail('acknowledgeItem', e);
    return { ok: false, error: 'The acknowledgement was not recorded: ' + reasonOf(e) };
  }
}

/** Stamp a journey complete once nothing is outstanding, and un-stamp it if something reopens. */
async function closeJourneyIfComplete(journeyId: string): Promise<void> {
  if (!isUuid(journeyId)) return;
  try {
    await db.execute(sql`
      UPDATE hr_onboarding_journeys j
         SET completed_at = CASE
               WHEN NOT EXISTS (
                 SELECT 1 FROM hr_onboarding_journey_items i
                  WHERE i.journey_id = j.id AND i.state NOT IN ('done', 'not_applicable')
               ) THEN COALESCE(j.completed_at, NOW())
               ELSE NULL END,
             updated_at = NOW()
       WHERE j.id = ${journeyId}::uuid`);
  } catch (e: any) {
    // Best-effort: the item state is already committed, and a completion stamp is derived
    // information. journeyProgress() computes `complete` from the items regardless, so a screen never
    // depends on this column being right.
    logFail('closeJourneyIfComplete', e);
  }
}

/**
 * The joining-credential numbers, read from src/lib/hr-onboarding.ts rather than recounted here, so
 * a `documents` step on the checklist and the credentials screen can never disagree.
 */
export async function joiningDocumentsProgress(userId: string | null): Promise<{
  submitted: number; verified: number; rejected: number; complete: boolean;
} | null> {
  if (!isUuid(userId)) return null;
  try {
    return docProgress(await listDocs(String(userId)));
  } catch (e: any) {
    logFail('joiningDocumentsProgress', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// THE DOCUMENTS THIS ENGAGEMENT ACTUALLY ASKS FOR
// -------------------------------------------------------------------------------------------------

export interface PackDocumentState {
  docType: string;
  label: string;
  why: string;
  required: boolean;
  shared: number;
  verified: number;
  rejected: number;
}

export interface PackDocuments {
  /** Null when the engagement is not recorded — the counts cannot be honest without it. */
  engagementKey: string | null;
  engagementLabel: string | null;
  /** The documents this engagement asks for, with what has arrived against each. */
  expected: PackDocumentState[];
  requiredCount: number;
  requiredVerified: number;
  /** Labels of required documents nothing has been shared against yet. */
  missing: string[];
  /** Documents shared that this engagement does not ask for. Not an error; worth saying. */
  extra: number;
  rejected: number;
  complete: boolean;
}

/**
 * "0 OF 3 VERIFIED" WAS COUNTING THE WRONG THING.
 *
 * The portal printed `verified of submitted` — however many links the person happened to add. Three
 * was not a requirement; it was a coincidence. A joiner reading it could not tell whether they were
 * finished, and a contractor reading it could be told they were short of a degree certificate that
 * their engagement never asked for and that the register would be wrong to hold.
 *
 * The denominator now comes from the PACK, so it is the number of documents this engagement genuinely
 * requires. Anything shared beyond that is counted separately rather than being turned into an
 * obligation, and a document type this engagement does not ask for is never named as missing.
 */
export async function packDocumentsFor(
  userId: string | null,
  engagementKey: string | null,
): Promise<PackDocuments | null> {
  if (!isUuid(userId)) return null;
  const key = String(engagementKey || '').trim();
  if (!isEngagementKey(key)) return null;
  try {
    const docs = await listDocs(String(userId));
    const wanted = documentsForEngagement(key as EngagementKey);
    const wantedTypes = new Set(wanted.map((d) => String(d.docType)));

    const expected: PackDocumentState[] = wanted.map((d) => {
      const mine = docs.filter((x) => String(x.docType) === String(d.docType));
      return {
        docType: String(d.docType),
        label: d.label,
        why: d.why,
        required: d.required === true,
        shared: mine.length,
        verified: mine.filter((x) => x.status === 'verified').length,
        rejected: mine.filter((x) => x.status === 'rejected').length,
      };
    });

    const required = expected.filter((d) => d.required);
    return {
      engagementKey: key,
      engagementLabel: engagementLabelFor(key as EngagementKey),
      expected,
      requiredCount: required.length,
      requiredVerified: required.filter((d) => d.verified > 0).length,
      missing: required.filter((d) => d.shared === 0).map((d) => d.label),
      extra: docs.filter((x) => !wantedTypes.has(String(x.docType))).length,
      rejected: docs.filter((x) => x.status === 'rejected').length,
      complete: required.length > 0 && required.every((d) => d.verified > 0),
    };
  } catch (e: any) {
    logFail('packDocumentsFor', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// "NO CHECKLIST YET" AND "WE COULD NOT LOOK" ARE DIFFERENT FACTS
// -------------------------------------------------------------------------------------------------

export interface JourneyStatus {
  /**
   * 'journey'      there is one, and it is here
   * 'none'         there genuinely is not one yet
   * 'unavailable'  the checklist could not be read. NOT the same as "not yet", and never printed
   *                to a joiner as though it were.
   */
  state: 'journey' | 'none' | 'unavailable';
  journey: Journey | null;
  /** A sentence for the screen. Always present. */
  reason: string;
}

/**
 * journeyForEmployee() answers null for three different reasons — no row, a provisioning failure, or
 * a SELECT that threw and was logged — and the portal printed the same confident sentence for all
 * three: "No onboarding checklist has been started for you yet. That is a genuine not-yet, not an
 * empty screen." For two of those three that sentence was false, and it was told to the one person
 * with no other way of finding out. This separates them.
 */
export async function journeyStatusForEmployee(employeeId: string): Promise<JourneyStatus> {
  if (!isUuid(employeeId)) {
    return { state: 'unavailable', journey: null, reason: 'That employee record could not be identified.' };
  }
  if (!(await engagementColumnsReady())) {
    return { state: 'unavailable', journey: null, reason: SCHEMA_UNAVAILABLE };
  }
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT j.*, e.full_name AS employee_name, e.employee_code
        FROM hr_onboarding_journeys j
        JOIN hr_employees e ON e.id = j.employee_id
       WHERE j.employee_id = ${employeeId}::uuid LIMIT 1`));
    if (!list.length) {
      return {
        state: 'none',
        journey: null,
        reason: 'No checklist has been started yet. That is a genuine absence, not a screen that '
          + 'failed to load.',
      };
    }
    const r = list[0] as any;
    const items = await itemsFor(String(r.id));
    return {
      state: 'journey',
      reason: 'The checklist is below.',
      journey: {
        id: String(r.id),
        employeeId: String(r.employee_id),
        employeeName: r.employee_name ? String(r.employee_name) : null,
        employeeCode: r.employee_code ? String(r.employee_code) : null,
        joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
        engagementKey: r.engagement_key ? String(r.engagement_key) : null,
        engagementLabel: r.engagement_key && isEngagementKey(String(r.engagement_key))
          ? engagementLabelFor(String(r.engagement_key) as EngagementKey) : null,
        items,
        progress: journeyProgress(items),
      },
    };
  } catch (e: any) {
    logFail('journeyStatusForEmployee', e);
    return {
      state: 'unavailable',
      journey: null,
      reason: 'Your checklist could not be read just now, so this page cannot say what is on it. '
        + 'Nothing has been lost and nothing is waiting on you because of it. The reason was recorded '
        + 'in the server log.',
    };
  }
}
