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
 * A SUGGESTED starting checklist. NOTHING IN HERE IS WRITTEN ANYWHERE UNTIL AN HR USER PRESSES THE
 * BUTTON on /admin/hr/onboarding/journey, and every step is editable and deletable afterwards.
 *
 * It is a suggestion rather than a seed because an onboarding checklist is a statement about what
 * this company promises a new person, and inventing one on a live HR system would have people
 * working through obligations nobody agreed to. It carries no dates, no equipment models, no named
 * people and no policy links — HR supplies all of those, because only HR knows them.
 */
export const STARTER_STEPS: Array<{
  title: string;
  description: string;
  category: StepCategory;
  ownerVia: OwnerVia;
  dueDay: number;
  requiresAcknowledgement?: boolean;
}> = [
  {
    title: 'Submit joining documents',
    description: 'Share your credentials as Google Drive links on the joining documents screen. Nothing is uploaded to us; the files stay in your own Drive.',
    category: 'documents',
    ownerVia: 'the_joiner',
    dueDay: 0,
  },
  {
    title: 'Verify the joining documents',
    description: 'Open each link and verify or send it back with a reason.',
    category: 'documents',
    ownerVia: 'onboarding_owner',
    dueDay: 3,
  },
  {
    title: 'Issue equipment',
    description: 'Whatever this person needs to do the work. Record it on the asset register so it is on their exit checklist too.',
    category: 'equipment',
    ownerVia: 'onboarding_owner',
    dueDay: 0,
  },
  {
    title: 'Create work accounts and access',
    description: 'Mail and the systems this role actually needs. Nothing broader.',
    category: 'accounts',
    ownerVia: 'onboarding_owner',
    dueDay: 0,
  },
  {
    title: 'Introduce the joiner to the team',
    description: 'The people they will work with day to day, and who to ask when they are stuck.',
    category: 'introductions',
    ownerVia: 'reporting_manager',
    dueDay: 2,
  },
  {
    title: 'First-week reading',
    description: 'Add the Drive link to what this person should read in their first week.',
    category: 'reading',
    ownerVia: 'the_joiner',
    dueDay: 5,
  },
  {
    title: 'Read and acknowledge the required policies',
    description: 'Add the Drive link to the policy document. The joiner acknowledges it here and the acknowledgement is recorded against their record.',
    category: 'policy',
    ownerVia: 'the_joiner',
    dueDay: 7,
    requiresAcknowledgement: true,
  },
  {
    title: 'First-week check-in',
    description: 'A conversation about how the first week actually went, before problems become habits.',
    category: 'other',
    ownerVia: 'reporting_manager',
    dueDay: 7,
  },
];

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

async function safeEnsure(): Promise<boolean> {
  try {
    await ensureJourneySchema();
    return true;
  } catch {
    return false;
  }
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
  return { ok: true };
}

export async function addTemplateStep(input: TemplateStepInput): Promise<JourneyResult> {
  const check = validateStep(input);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    await ensureJourneySchema();
    const actor = isUuid(input.actorUserId) ? String(input.actorUserId) : null;
    const category = CATEGORY_KEYS.has(String(input.category)) ? String(input.category) : 'other';
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_onboarding_journey_steps
        (title, description, category, owner_via, due_day, reading_url, requires_acknowledgement,
         employment_type, sort_order, created_by_user_id)
      VALUES
        (${String(input.title).trim().slice(0, 250)},
         ${String(input.description || '').trim().slice(0, 2000) || null},
         ${category}, ${String(input.ownerVia)}, ${Number(input.dueDay)},
         ${String(input.readingUrl || '').trim() || null},
         ${input.requiresAcknowledgement === true},
         ${String(input.employmentType || '').trim().slice(0, 100) || null},
         ${Number(input.sortOrder) || 100}, ${actor}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);
    await logAudit({
      userId: actor, action: 'onboarding.step_added', entity: 'hr_onboarding_journey_step', entityId: id,
      diff: { title: String(input.title).trim().slice(0, 250), category, ownerVia: input.ownerVia, dueDay: Number(input.dueDay) },
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
 * Add the suggested starter checklist. Idempotent on TITLE, so pressing the button twice does not
 * produce sixteen steps — and a step HR has since renamed is left alone rather than resurrected.
 * Returns how many were actually added, so the screen reports what happened rather than "done".
 */
export async function addStarterSteps(actorUserId: string | null): Promise<{ ok: boolean; added: number; error?: string }> {
  try {
    await ensureJourneySchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const existing = new Set(
      rowsOf(await db.execute(sql`SELECT title FROM hr_onboarding_journey_steps`))
        .map((r: any) => String(r.title || '').trim().toLowerCase()),
    );
    let added = 0;
    let order = 10;
    for (const s of STARTER_STEPS) {
      order += 10;
      if (existing.has(s.title.trim().toLowerCase())) continue;
      const r = await addTemplateStep({
        title: s.title,
        description: s.description,
        category: s.category,
        ownerVia: s.ownerVia,
        dueDay: s.dueDay,
        // The acknowledgement step needs a document link before it can require an acknowledgement,
        // and only HR knows which document. It is added WITHOUT the requirement and HR turns it on
        // when they add the link — rather than being refused by validateStep and silently skipped.
        requiresAcknowledgement: false,
        sortOrder: order,
        actorUserId: actor,
      });
      if (r.ok) added += 1;
    }
    return { ok: true, added };
  } catch (e: any) {
    logFail('addStarterSteps', e);
    return { ok: false, added: 0, error: 'The starter checklist was not added: ' + reasonOf(e) };
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

async function joinerFacts(employeeId: string): Promise<
  { employeeId: string; userId: string | null; fullName: string | null; employeeCode: string | null;
    departmentId: string | null; joiningDate: string | null; employmentType: string | null } | null
> {
  if (!isUuid(employeeId)) return null;
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT id, user_id, full_name, employee_code, department_id::text AS department_id,
             joining_date, employment_type
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!list.length) return null;
    const r = list[0] as any;
    return {
      employeeId: String(r.id),
      userId: r.user_id ? String(r.user_id) : null,
      fullName: r.full_name ? String(r.full_name) : null,
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
      employmentType: r.employment_type ? String(r.employment_type) : null,
    };
  } catch (e: any) {
    logFail('joinerFacts', e);
    return null;
  }
}

/**
 * START (or TOP UP) A JOINER'S CHECKLIST.
 *
 * Safe to call again. The journey row is created once; the items are inserted with
 * ON CONFLICT DO NOTHING against the (journey_id, step_id) unique index, so calling this after HR has
 * added a step to the template ADDS that step to a running journey and touches nothing already there.
 * Nobody's completed item is ever reset by re-running it.
 *
 * A step whose template restricts it to one employment type is skipped for everybody else — that is
 * eligibility as DATA on the step, not an `if` in a page.
 */
export async function startJourney(employeeId: string, actorUserId: string | null): Promise<JourneyResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That employee could not be identified.' };
  try {
    await ensureJourneySchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;

    const joiner = await joinerFacts(employeeId);
    if (!joiner) return { ok: false, error: 'That employee record could not be found.' };

    const steps = await listTemplateSteps();
    if (steps.length === 0) {
      return {
        ok: false,
        error: 'There are no steps on the onboarding template yet, so there is nothing to track. '
          + 'Add the steps this company actually does for a joiner first.',
      };
    }

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_onboarding_journeys (employee_id, joining_date, started_by_user_id)
      VALUES (${employeeId}::uuid, ${joiner.joiningDate}::date, ${actor}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));

    let journeyId = ins.length ? String(ins[0].id) : '';
    if (!journeyId) {
      const existing = rowsOf(await db.execute(sql`
        SELECT id FROM hr_onboarding_journeys WHERE employee_id = ${employeeId}::uuid LIMIT 1`));
      if (!existing.length) return { ok: false, error: WRITE_FAILED };
      journeyId = String(existing[0].id);
    }

    const graphReady = await isInitialized();
    let unowned = 0;
    // Owners already notified on this run, so somebody who owns four steps gets one message rather
    // than four. A notification per step is how people learn to ignore notifications.
    const notified = new Set<string>();
    // Steps added on this run that the JOINER themselves owns. See the block after the loop.
    let joinerSteps = 0;

    for (const step of steps) {
      if (step.employmentType && String(step.employmentType).trim()) {
        const want = String(step.employmentType).trim().toLowerCase().replace(/[\s_-]+/g, '');
        const have = String(joiner.employmentType || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (want !== have) continue;
      }

      const owner = await resolveOwner(step.ownerVia, joiner, graphReady);
      if (!owner.employeeId) unowned += 1;

      const added = rowsOf(await db.execute(sql`
        INSERT INTO hr_onboarding_journey_items
          (journey_id, step_id, title, description, category, owner_via, owner_employee_id,
           owner_user_id, owner_name, owner_unresolved_reason, due_on, reading_url,
           requires_acknowledgement, sort_order)
        VALUES
          (${journeyId}::uuid, ${step.id}::uuid, ${step.title}, ${step.description},
           ${step.category}, ${step.ownerVia}, ${owner.employeeId}::uuid, ${owner.userId}::uuid,
           ${owner.name}, ${owner.unresolvedReason},
           ${dueOnFor(joiner.joiningDate, step.dueDay)}::date, ${step.readingUrl},
           ${step.requiresAcknowledgement}, ${step.sortOrder})
        ON CONFLICT DO NOTHING
        RETURNING id`));

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
      entityId: journeyId, diff: { employeeId, joiningDate: joiner.joiningDate, steps: steps.length, unowned },
    });

    return { ok: true, id: journeyId, changed: true, unowned };
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
      items,
      progress: journeyProgress(items),
    };
  } catch (e: any) {
    logFail('journeyForEmployee', e);
    return null;
  }
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

/** Employees with no journey yet, so HR can start one rather than hunt for who was missed. */
export async function employeesWithoutJourney(limit = 50): Promise<Array<{
  id: string; fullName: string; employeeCode: string | null; joiningDate: string | null;
}>> {
  if (!(await safeEnsure())) return [];
  try {
    return rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, e.employee_code, e.joining_date
        FROM hr_employees e
        LEFT JOIN hr_onboarding_journeys j ON j.employee_id = e.id
       WHERE j.id IS NULL AND e.is_active = true
       ORDER BY e.joining_date DESC NULLS LAST, e.created_at DESC
       LIMIT ${Math.max(1, Math.min(200, Number(limit) || 50))}`)).map((r: any) => ({
      id: String(r.id),
      fullName: String(r.full_name || ''),
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
    }));
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
