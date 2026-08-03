// src/lib/projects.ts — PROJECTS: what the company is working on, who is on it, and what it costs.
//
// =================================================================================================
// WHAT WAS HERE BEFORE THIS FILE: NOTHING, AND TWO MODULES SAID SO IN WORDS
// =================================================================================================
//
// src/lib/search-global.ts returns an honest note for the `projects` source — "no projects table, and
// tasks do not belong to a project" — and src/lib/workforce/navigation.ts carries the same finding in
// NAV_BACKLOG. src/lib/attendance-schema.ts records a project as FREE TEXT on a daily report and says
// out loud that it is free text because no project register exists to point at. Three modules
// independently discovered the same hole. This file is the hole being filled, and the first
// consequence is that those three notes are now wrong in the right direction — the attendance column
// finally has something a migration could resolve it against.
//
// =================================================================================================
// THE THREE LAYERS, AND WHERE EVERY QUESTION THIS MODULE ASKS IS ANSWERED
// =================================================================================================
//
//   Layer 1  ORGANIZATION   who runs this project, who heads this department  -> src/lib/org-graph.ts
//   Layer 2  AUTHORIZATION  may this account open the portfolio at all        -> auth/permissions.ts
//   Layer 3  WORKFLOW       how an approval moves                             -> src/lib/workflow.ts
//
// THIS FILE IS NONE OF THEM. It owns project FACTS — the register, the membership, the milestones,
// the deliverables, the risks — and it asks the three layers for everything else. Specifically:
//
//   A PROJECT MANAGER IS A RELATIONSHIP, NOT A ROLE AND NOT A COLUMN. There is deliberately no
//   `owner_user_id` on `projects`. Who runs a project is the `project_manager` edge in
//   org_relationships, scoped to that one project and effective-dated, and it is read through
//   org-graph.ts (getProjectManager / isProjectManager / getManagedProjectIds) and written through
//   org-graph.ts (openRelationship / closeRelationship). Two consequences, both intended:
//     - "who ran this project when that decision was taken" stays answerable after a handover,
//       because the graph closes an edge instead of overwriting a column;
//     - there is no place in this schema where a role name could be mistaken for an owner. Nothing
//       in this file reads users.role. The single string comparison against a role anywhere near
//       this module is inside holdsCapability(), which is Layer 2 doing its own job.
//
//   NO APPROVAL ENGINE. Projects do not route anything. The money attached to a project already
//   routes: an expense claim goes through src/lib/expenses.ts and a purchase through
//   src/lib/procurement.ts, both of which start a workflow instance whose approver comes from the
//   graph. A second approval path for "project spend" would be a second engine disagreeing with the
//   first about who signs off the same rupee.
//
//   NO SECOND LEDGER. Planned budget is a number on the project. ACTUAL spend is never stored here:
//   projectBudget() SUMS the existing expense_claims and procurement_orders rows that carry a
//   project reference. Copying an amount out of those tables into this one would create two records
//   of the same money, and the day they disagreed nobody could say which was the company's.
//
// =================================================================================================
// SCOPE IS IN THE WHERE CLAUSE. ALWAYS.
// =================================================================================================
//
//   1. A MEMBER SEES THEIR PROJECTS. project_members, by the employee id resolved from the SESSION.
//   2. A PROJECT MANAGER SEES THE PROJECTS THEY RUN. From the graph, as a list of ids, bound into
//      the query.
//   3. A DEPARTMENT HEAD SEES THEIR DEPARTMENT'S. From the graph — getHeadedDepartmentIds — never
//      from users.role or users.assigned_department_id.
//   4. NOBODY SEES THE COMPANY'S WITHOUT projects.view.
//
// Every one of those is a bound list inside the SQL. A row this viewer may not see is never fetched;
// filtering afterwards is not access control, and hiding a row in CSS is not even filtering.
//
// AN EMPTY GRAPH IS NOT AN EMPTY PORTFOLIO. Until the founder runs db/org-graph-backfill.sql,
// org_relationships has no rows: no project has a manager and no department has a head, so routes 2
// and 3 answer nothing for everybody. A screen that rendered that as "you have no projects" would be
// telling people their work does not exist. Every read here returns `graphReady` from isInitialized()
// and every surface must render "Organization Graph not yet initialized" instead. Route 1 —
// membership — is this module's own table and keeps working regardless, which is why a project is
// still usable on day one.
import { db } from '@/lib/db';
import { sql, type SQL } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { holdsCapability, type CapabilityUser } from '@/lib/auth/capability';
import {
  isInitialized,
  employeeIdForUser,
  getProjectManagers,
  getManagedProjectIds,
  getHeadedDepartmentIds,
  openRelationship,
  closeRelationship,
  type OrgPerson,
} from '@/lib/org-graph';
import { ensureExpenseSchema } from '@/lib/expenses';
import { ensureProcurementSchema } from '@/lib/procurement';
import { ensureTaskSchema, projectTaskProgress, type ProjectTaskProgress } from '@/lib/employee-tasks';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Every one declared ABOVE the function that reads it — `const` is not hoisted, and
// a const declared under the handler that uses it throws on that handler's first line while the page
// still reports success. That is what took down apply step 5 and the /admin/roles/diagnose Repair
// button on this project.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never a { rows } object. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. Never a bare catch. */
const logFail = (tag: string, e: any) =>
  console.error('[projects] ' + tag, e?.cause?.message || e?.message);

/** One sentence for every refusal, so probing ids cannot distinguish "no such project" from "not yours". */
const NOT_AVAILABLE = 'That project is not available.';

/**
 * What a person sees when a write fails. NOT the database's own words: the real reason is logged
 * every time, and 'column "budget_planned" of relation "projects" does not exist' names the schema to
 * whoever asks while telling the reader nothing they can act on.
 */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** The sentence every relationship-dependent surface renders when the graph has no rows at all. */
export const GRAPH_NOT_READY =
  'Organization Graph not yet initialized. Until the reporting and project relationships are recorded, ' +
  'nobody can be resolved as the manager of a project and no department scope can be worked out. ' +
  'You still see every project you are a member of. Nothing is hidden from you by this.';

/** A value going into a ::uuid cast must look like one, or the cast throws on the render path. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

export const DEFAULT_CURRENCY = 'INR';

/** A typo guard, not a policy. One hundred million, in whatever currency the project is kept in. */
const MAX_BUDGET = 100000000;

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled' | 'archived';

export const PROJECT_STATUSES: ProjectStatus[] = [
  'planning', 'active', 'on_hold', 'completed', 'cancelled', 'archived',
];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

/** Nothing is owed on these. They are never late and never counted as work in flight. */
export const CLOSED_PROJECT_STATUSES: ProjectStatus[] = ['completed', 'cancelled', 'archived'];

/**
 * THE PROJECT LIFECYCLE, as an explicit graph rather than a free string.
 *
 * A status column anything can be written into is a shared text box, not a lifecycle: there is no
 * way to say a cancelled project was cancelled rather than mis-clicked, and nothing refuses a move
 * that makes no sense. An edge that is absent is absent on purpose — `planning -> completed` is not
 * here, because a project nobody ever started cannot have been finished.
 */
const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  planning: ['active', 'on_hold', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'completed', 'cancelled'],
  completed: ['active', 'archived'],
  cancelled: ['planning', 'archived'],
  archived: ['planning'],
};

/** Statuses that mean nothing unless somebody says why. Enforced in setProjectStatus, before the write. */
const PROJECT_REASON_REQUIRED: ProjectStatus[] = ['on_hold', 'cancelled'];
const REASON_MIN = 5;

export function projectStatusNeedsReason(status: ProjectStatus): boolean {
  return PROJECT_REASON_REQUIRED.indexOf(status) >= 0;
}

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === 'string' && PROJECT_STATUSES.indexOf(v as ProjectStatus) >= 0;
}

export function projectStatusLabel(v: string): string {
  return isProjectStatus(v) ? PROJECT_STATUS_LABELS[v] : String(v || '');
}

export interface ProjectTransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
}

export function canMoveProject(from: string, to: string): ProjectTransitionCheck {
  if (!isProjectStatus(from)) return { ok: false, reason: 'This project is in a state the lifecycle does not recognise.' };
  if (!isProjectStatus(to)) return { ok: false, reason: 'That is not a project status we track.' };
  if (from === to) return { ok: false, reason: 'It is already ' + PROJECT_STATUS_LABELS[to].toLowerCase() + '.' };
  const onward = PROJECT_TRANSITIONS[from] || [];
  if (onward.indexOf(to) < 0) {
    const names = onward.map((s) => PROJECT_STATUS_LABELS[s]).join(', ');
    return {
      ok: false,
      reason: names
        ? PROJECT_STATUS_LABELS[from] + ' does not move to ' + PROJECT_STATUS_LABELS[to] + '. From here it can go to: ' + names + '.'
        : PROJECT_STATUS_LABELS[from] + ' is where a project ends.',
    };
  }
  return { ok: true, reason: null };
}

export function allowedProjectStatuses(from: string): ProjectStatus[] {
  return isProjectStatus(from) ? (PROJECT_TRANSITIONS[from] || []) : [];
}

/**
 * WHAT SOMEBODY IS ON A PROJECT FOR. A capacity, deliberately not a permission.
 *
 * None of these grants anything. `lead` on this list does NOT make somebody the project manager —
 * that is the graph's `project_manager` edge and nothing else — it records that they lead a strand of
 * the work. Reading a capacity as authority is exactly the collapse this architecture forbids, so it
 * is written down here where somebody adding a value will see it.
 */
export type MemberCapacity = 'lead' | 'contributor' | 'specialist' | 'reviewer' | 'sponsor' | 'observer';

export const MEMBER_CAPACITIES: MemberCapacity[] = [
  'lead', 'contributor', 'specialist', 'reviewer', 'sponsor', 'observer',
];

export const MEMBER_CAPACITY_LABELS: Record<MemberCapacity, string> = {
  lead: 'Workstream lead',
  contributor: 'Contributor',
  specialist: 'Specialist',
  reviewer: 'Reviewer',
  sponsor: 'Sponsor',
  observer: 'Observer',
};

export function isMemberCapacity(v: unknown): v is MemberCapacity {
  return typeof v === 'string' && MEMBER_CAPACITIES.indexOf(v as MemberCapacity) >= 0;
}

export function memberCapacityLabel(v: string): string {
  return isMemberCapacity(v) ? MEMBER_CAPACITY_LABELS[v] : String(v || '');
}

export type MilestoneStatus = 'planned' | 'in_progress' | 'met' | 'missed' | 'cancelled';

export const MILESTONE_STATUSES: MilestoneStatus[] = ['planned', 'in_progress', 'met', 'missed', 'cancelled'];

export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  met: 'Met',
  missed: 'Missed',
  cancelled: 'Cancelled',
};

export function isMilestoneStatus(v: unknown): v is MilestoneStatus {
  return typeof v === 'string' && MILESTONE_STATUSES.indexOf(v as MilestoneStatus) >= 0;
}

export function milestoneStatusLabel(v: string): string {
  return isMilestoneStatus(v) ? MILESTONE_STATUS_LABELS[v] : String(v || '');
}

export type DeliverableStatus = 'planned' | 'in_progress' | 'submitted' | 'accepted' | 'rejected' | 'cancelled';

export const DELIVERABLE_STATUSES: DeliverableStatus[] =
  ['planned', 'in_progress', 'submitted', 'accepted', 'rejected', 'cancelled'];

export const DELIVERABLE_STATUS_LABELS: Record<DeliverableStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Sent back',
  cancelled: 'Cancelled',
};

export function isDeliverableStatus(v: unknown): v is DeliverableStatus {
  return typeof v === 'string' && DELIVERABLE_STATUSES.indexOf(v as DeliverableStatus) >= 0;
}

export function deliverableStatusLabel(v: string): string {
  return isDeliverableStatus(v) ? DELIVERABLE_STATUS_LABELS[v] : String(v || '');
}

export type RiskGrade = 'low' | 'medium' | 'high';
export const RISK_GRADES: RiskGrade[] = ['low', 'medium', 'high'];
export const RISK_GRADE_LABELS: Record<RiskGrade, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export function isRiskGrade(v: unknown): v is RiskGrade {
  return typeof v === 'string' && RISK_GRADES.indexOf(v as RiskGrade) >= 0;
}

export function riskGradeLabel(v: string): string {
  return isRiskGrade(v) ? RISK_GRADE_LABELS[v] : String(v || '');
}

export type RiskStatus = 'open' | 'mitigating' | 'accepted' | 'closed' | 'realised';

export const RISK_STATUSES: RiskStatus[] = ['open', 'mitigating', 'accepted', 'closed', 'realised'];

export const RISK_STATUS_LABELS: Record<RiskStatus, string> = {
  open: 'Open',
  mitigating: 'Being mitigated',
  accepted: 'Accepted',
  closed: 'Closed',
  realised: 'It happened',
};

export function isRiskStatus(v: unknown): v is RiskStatus {
  return typeof v === 'string' && RISK_STATUSES.indexOf(v as RiskStatus) >= 0;
}

export function riskStatusLabel(v: string): string {
  return isRiskStatus(v) ? RISK_STATUS_LABELS[v] : String(v || '');
}

/**
 * Likelihood times impact, as a 1-9 number and a word.
 *
 * ADVISORY, and it decides nothing. It orders the register so the worst thing is at the top; it does
 * not close a risk, escalate one, or tell anybody what to do. The same rule the proctoring module
 * lives under applies here: a computed signal informs a person, it never replaces one.
 */
export function riskScore(likelihood: string, impact: string): number {
  const grade = (v: string): number => (v === 'high' ? 3 : v === 'medium' ? 2 : v === 'low' ? 1 : 0);
  return grade(likelihood) * grade(impact);
}

export function riskSeverityLabel(score: number): string {
  if (score >= 6) return 'Severe';
  if (score >= 3) return 'Material';
  if (score >= 1) return 'Minor';
  return 'Not graded';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * Self-bootstrapped, no migration runner on this project.
 *
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS. That is
 * how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live table,
 * which locked every administrator out of /admin twice in one day. So every column past the primary
 * key is ALSO asserted with ADD COLUMN IF NOT EXISTS: no-ops on a fresh database, and the difference
 * between working and a 500 on a database carrying an older revision.
 *
 * NO CHECK CONSTRAINTS on any status column and no foreign keys to hr_employees, for the two reasons
 * workflow-schema.ts and procurement.ts both give: with no migration runner a CHECK could never be
 * widened, and a foreign key to an employee row would delete the record of what somebody built when
 * they leave. The vocabulary is enforced in TypeScript, at every write, where it can be extended.
 *
 * ensureOnce() SWALLOWS what this callback throws, so the try/catch below is what puts the real
 * Postgres reason in the log — and the re-throw is what makes ensureOnce drop its cache entry and
 * retry on the next request instead of remembering a failure for the life of the process.
 */
export function ensureProjectSchema(): Promise<void> {
  return ensureOnce('projects_v1', async () => {
    try {
      await ensureProjectTables();
    } catch (e: any) {
      logFail('ensureProjectSchema', e);
      throw e;
    }
  });
}

async function ensureProjectTables(): Promise<void> {
  // -----------------------------------------------------------------------------------------
  // projects — THE REGISTER.
  //
  // NOTE WHAT IS NOT HERE: there is no owner_user_id, owner_employee_id or manager column of any
  // kind. Who runs a project is the graph's `project_manager` edge, effective-dated, so a handover
  // closes one row and opens another and "who ran it in March" stays answerable. A column would have
  // exactly one value, forever, and would be the obvious thing for somebody to fill in from a role
  // name six months from now.
  //
  // department_id is TEXT. departments.id is a varchar(50) slug in src/lib/db/schema.ts and a UUID in
  // db/hr-schema.sql, and it is compared ::text everywhere in this file. A ::uuid cast throws
  // "invalid input syntax for type uuid" the first time a slug arrives.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS projects (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    description       TEXT,
    department_id     TEXT,
    status            TEXT NOT NULL DEFAULT 'planning',
    start_on          DATE,
    target_on         DATE,
    actual_end_on     DATE,
    budget_planned    NUMERIC(14,2),
    currency          TEXT NOT NULL DEFAULT 'INR',
    status_reason     TEXT,
    created_by_user_id UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS department_id TEXT`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planning'`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_on DATE`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_on DATE`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS actual_end_on DATE`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_planned NUMERIC(14,2)`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_reason TEXT`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status, target_on)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS projects_department_idx ON projects (department_id)`);

  // Its own try/catch: a UNIQUE index is the one piece of DDL here that can fail on DATA rather than
  // on syntax, and createProject() does not depend on it — the insert is an INSERT ... SELECT WHERE
  // NOT EXISTS, correct with or without the constraint. This is insurance against a double-click.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS projects_code_uq ON projects (lower(code))`);
  } catch (e: any) {
    logFail('ensureProjectSchema code unique index', e);
  }

  // -----------------------------------------------------------------------------------------
  // project_members — MEMBERSHIP AND RESOURCING, ON ONE ROW.
  //
  // allocation_pct + from_on/to_on are what make over-allocation VISIBLE. They are a record of what
  // was agreed, never an instruction: nothing in this module reassigns anybody, reduces anybody's
  // percentage, or refuses a membership because a total went over 100. It surfaces the number and a
  // human decides. Auto-levelling somebody's week is a decision about a person's working life, and a
  // sum in a database is not entitled to take it.
  //
  // removed_at rather than DELETE: "who was on this in March" is the question a project record exists
  // to answer, and a deleted row answers nothing.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_members (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL,
    employee_id       UUID NOT NULL,
    capacity          TEXT NOT NULL DEFAULT 'contributor',
    allocation_pct    INT NOT NULL DEFAULT 0,
    from_on           DATE,
    to_on             DATE,
    note              TEXT,
    added_by_user_id  UUID,
    added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at        TIMESTAMPTZ,
    removed_by_user_id UUID
  )`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS capacity TEXT NOT NULL DEFAULT 'contributor'`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS allocation_pct INT NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS from_on DATE`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS to_on DATE`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS note TEXT`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS added_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS removed_by_user_id UUID`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members (project_id, removed_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_members_employee_idx ON project_members (employee_id, removed_at)`);

  try {
    // ONE OPEN MEMBERSHIP PER PERSON PER PROJECT. Partial, over the rows that are still current, so a
    // person can be on a project, come off it, and go back on later without the index objecting.
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS project_members_open_uq
      ON project_members (project_id, employee_id) WHERE removed_at IS NULL`);
  } catch (e: any) {
    logFail('ensureProjectSchema member unique index', e);
  }

  // -----------------------------------------------------------------------------------------
  // project_milestones and project_deliverables.
  //
  // A milestone is a DATE somebody committed to. A deliverable is a THING produced against one.
  // Splitting them is what lets a milestone slip while its deliverables stay listed, instead of the
  // two facts overwriting each other in a single "progress" field nobody can audit.
  //
  // link_url on a deliverable is a LINK — a Drive link with "anyone with the link" access — and never
  // an upload. That is the standing rule for documents of any kind in this product, and it is why
  // there is no bytes column here for somebody to reach for later.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_milestones (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    due_on        DATE,
    completed_on  DATE,
    status        TEXT NOT NULL DEFAULT 'planned',
    sort_order    INT NOT NULL DEFAULT 0,
    created_by_user_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS description TEXT`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS due_on DATE`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS completed_on DATE`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned'`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS created_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_milestones_project_idx
    ON project_milestones (project_id, sort_order, due_on)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_deliverables (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL,
    milestone_id  UUID,
    name          TEXT NOT NULL,
    description   TEXT,
    link_url      TEXT,
    owner_employee_id UUID,
    due_on        DATE,
    status        TEXT NOT NULL DEFAULT 'planned',
    accepted_on   DATE,
    created_by_user_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS milestone_id UUID`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS description TEXT`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS link_url TEXT`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS owner_employee_id UUID`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS due_on DATE`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned'`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS accepted_on DATE`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS created_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE project_deliverables ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_deliverables_project_idx
    ON project_deliverables (project_id, due_on)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_deliverables_milestone_idx
    ON project_deliverables (milestone_id)`);

  // -----------------------------------------------------------------------------------------
  // project_risks — THE RISK REGISTER.
  //
  // owner_employee_id is a NAMED PERSON, not a role and not a queue. A risk owned by "the team" is a
  // risk owned by nobody, which is how a register becomes a list of things everyone read and no one
  // did anything about. It is an employee id because that is what every hr_* table is keyed by.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_risks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT,
    likelihood    TEXT NOT NULL DEFAULT 'medium',
    impact        TEXT NOT NULL DEFAULT 'medium',
    owner_employee_id UUID,
    mitigation    TEXT,
    status        TEXT NOT NULL DEFAULT 'open',
    raised_by_user_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at     TIMESTAMPTZ
  )`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS description TEXT`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS likelihood TEXT NOT NULL DEFAULT 'medium'`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS impact TEXT NOT NULL DEFAULT 'medium'`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS owner_employee_id UUID`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS mitigation TEXT`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS raised_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_risks_project_idx ON project_risks (project_id, status)`);

  // -----------------------------------------------------------------------------------------
  // THE SPEND REFERENCE — ONE NULLABLE COLUMN ON EACH OF TWO TABLES THIS MODULE DOES NOT OWN.
  //
  // READ THIS BEFORE CHANGING IT. The alternative was a project_costs table, and a project_costs
  // table is a SECOND LEDGER: the same rupee written down twice, once by the person who claimed it
  // and once by whoever remembered to copy it across. The day the two disagree, nobody can say which
  // is the company's record. So actual spend is never stored here — projectBudget() sums the rows
  // that already exist, and all these two columns do is say which project a claim or a purchase was
  // for.
  //
  // WHY THIS IS NOT THE DUPLICATE-TABLE FAULT. There is exactly one CREATE TABLE for expense_claims
  // (src/lib/expenses.ts) and one for procurement_requests (src/lib/procurement.ts), and this is not
  // another one. ADD COLUMN IF NOT EXISTS is additive and idempotent, both of those modules assert
  // their own columns the same way, and neither names project_id in any query — their column lists
  // are explicit, so this column is invisible to every read and write they perform.
  //
  // THEIR ensure RUNS FIRST, deliberately: ALTER TABLE on a table that does not exist yet throws, and
  // on a fresh database this module can easily be the first thing loaded. The whole block is in its
  // own try/catch, so if either module's schema is unavailable the projects module still works and
  // the budget panel says which source it could not read instead of quietly reporting zero.
  // -----------------------------------------------------------------------------------------
  try {
    await ensureExpenseSchema();
    await db.execute(sql`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS project_id UUID`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS expense_claims_project_idx ON expense_claims (project_id)`);
  } catch (e: any) {
    logFail('ensureProjectSchema expense project_id', e);
  }

  try {
    await ensureProcurementSchema();
    await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS project_id UUID`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS procurement_requests_project_idx ON procurement_requests (project_id)`);
  } catch (e: any) {
    logFail('ensureProjectSchema procurement project_id', e);
  }

  // employee_tasks.project_id is declared in src/lib/employee-tasks.ts, in the module that owns that
  // table, and asserted here only by asking that module to run its own ensure. One declaration, one
  // owner: two files asserting one column with different types is the fault this codebase already
  // paid four months for.
  try {
    await ensureTaskSchema();
  } catch (e: any) {
    logFail('ensureProjectSchema task schema', e);
  }
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  code: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  departmentName: string | null;
  status: ProjectStatus;
  statusLabel: string;
  statusReason: string | null;
  startOn: string | null;
  targetOn: string | null;
  actualEndOn: string | null;
  budgetPlanned: number | null;
  currency: string;
  memberCount: number;
  openRiskCount: number;
  milestoneCount: number;
  milestonesMet: number;
  /** Past its target date and not closed. Never "late" for a completed or cancelled project. */
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  employeeId: string;
  fullName: string | null;
  designation: string | null;
  capacity: MemberCapacity;
  capacityLabel: string;
  allocationPct: number;
  fromOn: string | null;
  toOn: string | null;
  note: string | null;
  addedAt: string | null;
  removedAt: string | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueOn: string | null;
  completedOn: string | null;
  status: MilestoneStatus;
  statusLabel: string;
  sortOrder: number;
  isOverdue: boolean;
  deliverableCount: number;
  deliverablesAccepted: number;
}

export interface Deliverable {
  id: string;
  projectId: string;
  milestoneId: string | null;
  milestoneName: string | null;
  name: string;
  description: string | null;
  linkUrl: string | null;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  dueOn: string | null;
  status: DeliverableStatus;
  statusLabel: string;
  acceptedOn: string | null;
  isOverdue: boolean;
}

export interface Risk {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  likelihood: RiskGrade;
  impact: RiskGrade;
  score: number;
  severityLabel: string;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  mitigation: string | null;
  status: RiskStatus;
  statusLabel: string;
  createdAt: string;
  closedAt: string | null;
}

/** What one person is committed to, across every project, for an overlapping window. */
export interface AllocationEntry {
  projectId: string;
  projectCode: string;
  projectName: string;
  capacity: MemberCapacity;
  allocationPct: number;
  fromOn: string | null;
  toOn: string | null;
}

export interface AllocationPerson {
  employeeId: string;
  fullName: string | null;
  totalPct: number;
  overAllocated: boolean;
  entries: AllocationEntry[];
}

export interface AllocationView {
  /** False means the read did not happen. An empty list with ok:true means nobody is committed. */
  ok: boolean;
  from: string;
  to: string;
  people: AllocationPerson[];
  /** Just the people over 100%. The same objects, not copies with different numbers. */
  conflicts: AllocationPerson[];
}

export interface ProjectBudget {
  ok: boolean;
  planned: number | null;
  currency: string;
  /** Approved and paid claims carrying this project reference. */
  expenseActual: number;
  expenseCount: number;
  expenseOk: boolean;
  /** Purchase orders raised against requests carrying this project reference. */
  procurementCommitted: number;
  procurementCount: number;
  procurementOk: boolean;
  actual: number;
  /** planned - actual. Positive is underspend. Null when no budget was planned. */
  variance: number | null;
  variancePct: number | null;
  /** Honest sentences about anything that could not be read, or that carries no linked records. */
  notes: string[];
}

/** Who runs this project, and whether the graph was in a position to answer. */
export interface ProjectOwner {
  graphReady: boolean;
  owner: OrgPerson | null;
  others: OrgPerson[];
}

export interface ProjectDetail {
  project: Project;
  owner: ProjectOwner;
  members: ProjectMember[];
  milestones: Milestone[];
  deliverables: Deliverable[];
  risks: Risk[];
  budget: ProjectBudget;
  tasks: ProjectTaskProgress;
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// -------------------------------------------------------------------------------------------------
// AUTHORITY AND SCOPE.
//
// Both are resolved HERE, from the graph and from the capability matrix, and handed to the SQL as
// bound lists. No page passes a boolean saying who it is: every function below re-derives the answer
// from the session user id it is given.
// -------------------------------------------------------------------------------------------------

/** The signed-in account, as much of it as any decision here needs. */
export type ProjectActor = CapabilityUser & { id?: string | null };

export interface ProjectScope {
  /** False = org_relationships has no rows at all. Render GRAPH_NOT_READY, never an empty list. */
  graphReady: boolean;
  employeeId: string | null;
  managedProjectIds: string[];
  headedDepartmentIds: string[];
  /** projects.view — the portfolio. */
  seesAll: boolean;
  /** projects.manage — the register. */
  registrar: boolean;
}

/**
 * Everything about this viewer that the WHERE clause needs, in a fixed number of queries.
 *
 * Three round trips regardless of how many projects come back: the graph's initialisation check, the
 * managed-project ids and the headed-department ids. Asking per row would be an N+1 on a page that
 * renders on a phone.
 */
export async function resolveProjectScope(actor: ProjectActor | null | undefined): Promise<ProjectScope> {
  const userId = String(actor?.id || '').trim();
  const seesAll = holdsCapability(actor, 'projects.view');
  const registrar = holdsCapability(actor, 'projects.manage');

  const empty: ProjectScope = {
    graphReady: false, employeeId: null, managedProjectIds: [], headedDepartmentIds: [], seesAll, registrar,
  };
  if (!isUuid(userId)) return empty;

  try {
    const graphReady = await isInitialized();
    const employeeId = await employeeIdForUser(userId);
    if (!employeeId) return { ...empty, graphReady };
    // Both of these return [] on an empty graph, which is exactly why graphReady is carried
    // separately: "you run no projects" and "the graph cannot answer yet" are different sentences.
    const managedProjectIds = await getManagedProjectIds(employeeId);
    const headedDepartmentIds = await getHeadedDepartmentIds(employeeId);
    return { graphReady, employeeId, managedProjectIds, headedDepartmentIds, seesAll, registrar };
  } catch (e: any) {
    logFail('resolveProjectScope', e);
    // Fail closed: no employee, no managed projects, no departments. A failure must never widen.
    return empty;
  }
}

/** A bound `IN (...)` list, or `false` when the list is empty. `IN ()` is a syntax error. */
const inList = (column: SQL, values: string[]): SQL => {
  const clean = (values || []).map((v) => String(v || '').trim()).filter(Boolean);
  if (clean.length === 0) return sql`false`;
  return sql`${column}::text IN (${sql.join(clean.map((v) => sql`${v}`), sql`, `)})`;
};

/**
 * THE VISIBILITY CLAUSE. Four routes, decided in the WHERE clause so a project this viewer may not
 * see is never fetched. An unresolvable viewer compiles to `false` and sees nothing, never everything.
 */
const visibleProjectsSql = (scope: ProjectScope): SQL => {
  if (scope.seesAll) return sql`true`;
  const parts: SQL[] = [];
  if (scope.employeeId) {
    parts.push(sql`EXISTS (SELECT 1 FROM project_members m
                            WHERE m.project_id = p.id
                              AND m.employee_id::text = ${scope.employeeId}
                              AND m.removed_at IS NULL)`);
  }
  if (scope.managedProjectIds.length > 0) parts.push(inList(sql`p.id`, scope.managedProjectIds));
  if (scope.headedDepartmentIds.length > 0) parts.push(inList(sql`p.department_id`, scope.headedDepartmentIds));
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
};

/** What this actor may do with ONE project. Every field re-derived; nothing taken on trust. */
export interface ProjectAuthority {
  graphReady: boolean;
  employeeId: string | null;
  /** The graph records this person as running THIS project. The only per-project authority there is. */
  runsProject: boolean;
  isMember: boolean;
  headsDepartment: boolean;
  seesAll: boolean;
  registrar: boolean;
  /** May open it. */
  maySee: boolean;
  /** May change it: run it, or keep the register. */
  mayEdit: boolean;
}

export async function projectAuthority(
  actor: ProjectActor | null | undefined,
  projectId: string,
): Promise<ProjectAuthority> {
  const scope = await resolveProjectScope(actor);
  const id = String(projectId || '').trim();

  const base: ProjectAuthority = {
    graphReady: scope.graphReady,
    employeeId: scope.employeeId,
    runsProject: false,
    isMember: false,
    headsDepartment: false,
    seesAll: scope.seesAll,
    registrar: scope.registrar,
    maySee: scope.seesAll,
    mayEdit: scope.registrar,
  };
  if (!isUuid(id)) return base;

  const runsProject = scope.managedProjectIds.indexOf(id) >= 0;

  let isMember = false;
  let headsDepartment = false;
  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM project_members m
                      WHERE m.project_id = p.id
                        AND m.employee_id::text = ${scope.employeeId || ''}
                        AND m.removed_at IS NULL) AS is_member,
             ${scope.headedDepartmentIds.length > 0
               ? inList(sql`p.department_id`, scope.headedDepartmentIds)
               : sql`false`} AS heads_dept
        FROM projects p
       WHERE p.id::text = ${id}
       LIMIT 1`))[0];
    if (r) {
      isMember = r.is_member === true;
      headsDepartment = r.heads_dept === true;
    }
  } catch (e: any) {
    logFail('projectAuthority', e);
    // Fail closed on both. A failure here must never be the reason somebody can edit something.
  }

  return {
    ...base,
    runsProject,
    isMember,
    headsDepartment,
    maySee: scope.seesAll || runsProject || isMember || headsDepartment,
    mayEdit: scope.registrar || runsProject,
  };
}

// -------------------------------------------------------------------------------------------------
// SHARED FRAGMENTS
// -------------------------------------------------------------------------------------------------

/**
 * A person's name from an employee id. Correlated subquery against hr_employees, and only full_name
 * and designation are read — the portal's existing SELECT * lookups drag gender, Aadhaar, PAN and
 * bank details into the render context of pages that show none of them, and `gender` is the exact
 * column read in the 2026-08-02 breach.
 */
const nameOfEmployee = (column: SQL): SQL => sql`(
  SELECT n.full_name FROM hr_employees n WHERE n.id = ${column} LIMIT 1
)`;

const PROJECT_COLUMNS = sql`
  p.id, p.code, p.name, p.description, p.department_id::text AS department_id, p.status,
  p.status_reason, p.start_on, p.target_on, p.actual_end_on, p.budget_planned, p.currency,
  p.created_at, p.updated_at,
  (p.target_on IS NOT NULL AND p.target_on < CURRENT_DATE
   AND p.status NOT IN ('completed', 'cancelled', 'archived')) AS is_overdue,
  (SELECT COUNT(*)::int FROM project_members m WHERE m.project_id = p.id AND m.removed_at IS NULL) AS member_count,
  (SELECT COUNT(*)::int FROM project_risks r WHERE r.project_id = p.id
    AND r.status IN ('open', 'mitigating')) AS open_risk_count,
  (SELECT COUNT(*)::int FROM project_milestones ms WHERE ms.project_id = p.id
    AND ms.status <> 'cancelled') AS milestone_count,
  (SELECT COUNT(*)::int FROM project_milestones ms WHERE ms.project_id = p.id
    AND ms.status = 'met') AS milestones_met`;

const asStatus = (v: any): ProjectStatus => (isProjectStatus(v) ? v : 'planning');
const asCapacity = (v: any): MemberCapacity => (isMemberCapacity(v) ? v : 'contributor');
const asGrade = (v: any): RiskGrade => (isRiskGrade(v) ? v : 'medium');
const dateOf = (v: any): string | null => (v ? String(v).slice(0, 10) : null);
const numOf = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function mapProject(r: any): Project {
  const status = asStatus(r.status);
  return {
    id: String(r.id),
    code: String(r.code || ''),
    name: String(r.name || ''),
    description: r.description ?? null,
    departmentId: r.department_id ? String(r.department_id) : null,
    departmentName: r.department_name ? String(r.department_name) : null,
    status,
    statusLabel: PROJECT_STATUS_LABELS[status],
    statusReason: r.status_reason ?? null,
    startOn: dateOf(r.start_on),
    targetOn: dateOf(r.target_on),
    actualEndOn: dateOf(r.actual_end_on),
    budgetPlanned: r.budget_planned === null || r.budget_planned === undefined ? null : numOf(r.budget_planned),
    currency: String(r.currency || DEFAULT_CURRENCY),
    memberCount: Number(r.member_count) || 0,
    openRiskCount: Number(r.open_risk_count) || 0,
    milestoneCount: Number(r.milestone_count) || 0,
    milestonesMet: Number(r.milestones_met) || 0,
    isOverdue: r.is_overdue === true,
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

/**
 * Department NAMES, looked up in their own query and their own try/catch.
 *
 * A name is a label, not a permission, and losing a whole project list because `departments` could
 * not be read would be the wrong failure — the same split workspace-access.ts and employee-tasks.ts
 * both make. Ids are compared ::text: departments.id is a varchar(50) slug in one schema file and a
 * UUID in the other.
 */
async function attachDepartmentNames(list: Project[]): Promise<Project[]> {
  const ids = Array.from(new Set(list.map((p) => p.departmentId).filter((v): v is string => !!v)));
  if (ids.length === 0) return list;
  try {
    const found = rows(await db.execute(sql`
      SELECT d.id::text AS id, d.name AS name FROM departments d
       WHERE ${inList(sql`d.id`, ids)}`));
    const byId = new Map<string, string>();
    for (const r of found) byId.set(String(r.id), String(r.name || ''));
    return list.map((p) => ({
      ...p,
      departmentName: p.departmentId ? (byId.get(p.departmentId) || null) : null,
    }));
  } catch (e: any) {
    logFail('attachDepartmentNames', e);
    // The projects are real and the names are missing. A screen says "department not named", never
    // "no department".
    return list;
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface ProjectListView {
  /** False means the read did not happen — never render "no projects" on this. */
  ok: boolean;
  graphReady: boolean;
  projects: Project[];
  /** The scope actually applied, so a surface can say WHY the list is what it is. */
  scope: ProjectScope;
}

export interface ListProjectsOptions {
  status?: string | null;
  departmentId?: string | null;
  includeClosed?: boolean;
  search?: string | null;
  limit?: number;
}

/**
 * EVERY PROJECT THIS VIEWER MAY SEE. The scope is in the WHERE clause, not in the page.
 *
 * A caller cannot widen this: the only input that decides scope is the actor, and resolveProjectScope
 * reads the graph and the capability matrix itself. Passing a department filter narrows the result
 * inside whatever the viewer could already see; it never adds a row.
 */
export async function listProjects(
  actor: ProjectActor | null | undefined,
  opts: ListProjectsOptions = {},
): Promise<ProjectListView> {
  const scope = await resolveProjectScope(actor);
  const failed: ProjectListView = { ok: false, graphReady: scope.graphReady, projects: [], scope };

  try {
    await ensureProjectSchema();

    const wanted = String(opts.status || '').trim().toLowerCase();
    const statusClause = isProjectStatus(wanted) ? sql`AND p.status = ${wanted}` : sql``;

    const dept = String(opts.departmentId || '').trim();
    const deptClause = dept ? sql`AND p.department_id::text = ${dept}` : sql``;

    const closedClause = opts.includeClosed === true || isProjectStatus(wanted)
      ? sql``
      : sql`AND p.status NOT IN ('archived', 'cancelled')`;

    const term = String(opts.search || '').trim().slice(0, 120);
    const searchClause = term
      ? sql`AND (p.name ILIKE ${'%' + term + '%'} OR p.code ILIKE ${'%' + term + '%'})`
      : sql``;

    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);

    const list = rows(await db.execute(sql`
      SELECT ${PROJECT_COLUMNS}
        FROM projects p
       WHERE ${visibleProjectsSql(scope)}
         ${statusClause}
         ${deptClause}
         ${closedClause}
         ${searchClause}
       ORDER BY (p.status IN ('completed', 'cancelled', 'archived')),
                (p.target_on IS NULL), p.target_on ASC,
                p.name ASC
       LIMIT ${limit}`)).map(mapProject);

    return { ok: true, graphReady: scope.graphReady, projects: await attachDepartmentNames(list), scope };
  } catch (e: any) {
    logFail('listProjects', e);
    return failed;
  }
}

/** One project, or null — with the visibility decision made in the WHERE clause, not afterwards. */
export async function getProject(
  actor: ProjectActor | null | undefined,
  projectId: string,
): Promise<Project | null> {
  const scope = await resolveProjectScope(actor);
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return null;

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      SELECT ${PROJECT_COLUMNS}
        FROM projects p
       WHERE p.id::text = ${id}
         AND ${visibleProjectsSql(scope)}
       LIMIT 1`));
    if (r.length === 0) return null;
    const list = await attachDepartmentNames([mapProject(r[0])]);
    return list[0];
  } catch (e: any) {
    logFail('getProject', e);
    return null;
  }
}

/** Who runs it, from the graph, with the graph's own "I have no data yet" answer carried alongside. */
export async function projectOwner(projectId: string): Promise<ProjectOwner> {
  const id = String(projectId || '').trim();
  if (!id) return { graphReady: false, owner: null, others: [] };
  const graphReady = await isInitialized();
  if (!graphReady) return { graphReady: false, owner: null, others: [] };
  const all = await getProjectManagers(id);
  return { graphReady: true, owner: all.length ? all[0] : null, others: all.slice(1) };
}

/** The people on a project. `includeRemoved` shows the history — who was on it and is not now. */
export async function listMembers(
  projectId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<ProjectMember[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  try {
    await ensureProjectSchema();
    const removedClause = opts.includeRemoved === true ? sql`` : sql`AND m.removed_at IS NULL`;
    return rows(await db.execute(sql`
      SELECT m.id, m.project_id, m.employee_id, m.capacity, m.allocation_pct,
             m.from_on, m.to_on, m.note, m.added_at, m.removed_at,
             e.full_name AS full_name, e.designation AS designation
        FROM project_members m
        LEFT JOIN hr_employees e ON e.id = m.employee_id
       WHERE m.project_id::text = ${id}
         ${removedClause}
       ORDER BY (m.removed_at IS NOT NULL), m.allocation_pct DESC, e.full_name ASC`)).map((r: any) => {
      const capacity = asCapacity(r.capacity);
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        employeeId: String(r.employee_id),
        fullName: r.full_name ?? null,
        designation: r.designation ?? null,
        capacity,
        capacityLabel: MEMBER_CAPACITY_LABELS[capacity],
        allocationPct: Number(r.allocation_pct) || 0,
        fromOn: dateOf(r.from_on),
        toOn: dateOf(r.to_on),
        note: r.note ?? null,
        addedAt: r.added_at ? String(r.added_at) : null,
        removedAt: r.removed_at ? String(r.removed_at) : null,
      };
    });
  } catch (e: any) {
    logFail('listMembers', e);
    return [];
  }
}

export async function listMilestones(projectId: string): Promise<Milestone[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  try {
    await ensureProjectSchema();
    return rows(await db.execute(sql`
      SELECT ms.id, ms.project_id, ms.name, ms.description, ms.due_on, ms.completed_on,
             ms.status, ms.sort_order,
             (ms.due_on IS NOT NULL AND ms.due_on < CURRENT_DATE
              AND ms.status NOT IN ('met', 'cancelled')) AS is_overdue,
             (SELECT COUNT(*)::int FROM project_deliverables d WHERE d.milestone_id = ms.id) AS deliverable_count,
             (SELECT COUNT(*)::int FROM project_deliverables d WHERE d.milestone_id = ms.id
               AND d.status = 'accepted') AS deliverables_accepted
        FROM project_milestones ms
       WHERE ms.project_id::text = ${id}
       ORDER BY ms.sort_order ASC, (ms.due_on IS NULL), ms.due_on ASC, ms.name ASC`)).map((r: any) => {
      const status: MilestoneStatus = isMilestoneStatus(r.status) ? r.status : 'planned';
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        name: String(r.name || ''),
        description: r.description ?? null,
        dueOn: dateOf(r.due_on),
        completedOn: dateOf(r.completed_on),
        status,
        statusLabel: MILESTONE_STATUS_LABELS[status],
        sortOrder: Number(r.sort_order) || 0,
        isOverdue: r.is_overdue === true,
        deliverableCount: Number(r.deliverable_count) || 0,
        deliverablesAccepted: Number(r.deliverables_accepted) || 0,
      };
    });
  } catch (e: any) {
    logFail('listMilestones', e);
    return [];
  }
}

export async function listDeliverables(projectId: string): Promise<Deliverable[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  try {
    await ensureProjectSchema();
    return rows(await db.execute(sql`
      SELECT d.id, d.project_id, d.milestone_id, d.name, d.description, d.link_url,
             d.owner_employee_id, d.due_on, d.status, d.accepted_on,
             (d.due_on IS NOT NULL AND d.due_on < CURRENT_DATE
              AND d.status NOT IN ('accepted', 'cancelled')) AS is_overdue,
             ${nameOfEmployee(sql`d.owner_employee_id`)} AS owner_name,
             (SELECT ms.name FROM project_milestones ms WHERE ms.id = d.milestone_id) AS milestone_name
        FROM project_deliverables d
       WHERE d.project_id::text = ${id}
       ORDER BY (d.due_on IS NULL), d.due_on ASC, d.name ASC`)).map((r: any) => {
      const status: DeliverableStatus = isDeliverableStatus(r.status) ? r.status : 'planned';
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        milestoneId: r.milestone_id ? String(r.milestone_id) : null,
        milestoneName: r.milestone_name ?? null,
        name: String(r.name || ''),
        description: r.description ?? null,
        linkUrl: r.link_url ?? null,
        ownerEmployeeId: r.owner_employee_id ? String(r.owner_employee_id) : null,
        ownerName: r.owner_name ?? null,
        dueOn: dateOf(r.due_on),
        status,
        statusLabel: DELIVERABLE_STATUS_LABELS[status],
        acceptedOn: dateOf(r.accepted_on),
        isOverdue: r.is_overdue === true,
      };
    });
  } catch (e: any) {
    logFail('listDeliverables', e);
    return [];
  }
}

/** The register, worst first. The ordering is advisory — it decides nothing and closes nothing. */
export async function listRisks(projectId: string, opts: { includeClosed?: boolean } = {}): Promise<Risk[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  try {
    await ensureProjectSchema();
    const closedClause = opts.includeClosed === true ? sql`` : sql`AND r.status NOT IN ('closed')`;
    return rows(await db.execute(sql`
      SELECT r.id, r.project_id, r.title, r.description, r.likelihood, r.impact,
             r.owner_employee_id, r.mitigation, r.status, r.created_at, r.closed_at,
             ${nameOfEmployee(sql`r.owner_employee_id`)} AS owner_name
        FROM project_risks r
       WHERE r.project_id::text = ${id}
         ${closedClause}
       ORDER BY (r.status = 'closed'),
                (CASE r.likelihood WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
                * (CASE r.impact WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) DESC,
                r.created_at DESC`)).map((r: any) => {
      const likelihood = asGrade(r.likelihood);
      const impact = asGrade(r.impact);
      const status: RiskStatus = isRiskStatus(r.status) ? r.status : 'open';
      const score = riskScore(likelihood, impact);
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        title: String(r.title || ''),
        description: r.description ?? null,
        likelihood,
        impact,
        score,
        severityLabel: riskSeverityLabel(score),
        ownerEmployeeId: r.owner_employee_id ? String(r.owner_employee_id) : null,
        ownerName: r.owner_name ?? null,
        mitigation: r.mitigation ?? null,
        status,
        statusLabel: RISK_STATUS_LABELS[status],
        createdAt: String(r.created_at),
        closedAt: r.closed_at ? String(r.closed_at) : null,
      };
    });
  } catch (e: any) {
    logFail('listRisks', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// BUDGET — PLANNED HERE, ACTUAL FROM THE RECORDS THAT ALREADY HOLD IT
// -------------------------------------------------------------------------------------------------

/**
 * Planned against actual, where ACTUAL IS NEVER STORED IN THIS MODULE.
 *
 * expense_claims and procurement_orders are the company's record of money spent, written by
 * src/lib/expenses.ts and src/lib/procurement.ts through approval chains routed from the
 * Organization Graph. This function SUMS them by project reference. It writes nothing, it caches
 * nothing, and there is no projects table anywhere holding a copy of an amount.
 *
 * WHICH ROWS COUNT, and each choice is a judgement worth stating:
 *   - claims in `approved` or `reimbursed`. A submitted claim is a request, not a cost; counting it
 *     would let anybody inflate a project's spend by typing a number into a form.
 *   - purchase ORDERS, not requests. An order exists only for an approved request (raiseOrder
 *     refuses otherwise), so it is a commitment the company has actually made. Cancelled orders are
 *     excluded. The order's own amount wins over the request's estimate, because the order is what
 *     was agreed with the supplier.
 *
 * EACH SOURCE IS READ IN ITS OWN try/catch and reports its own ok flag. If procurement cannot be read
 * the panel says so and shows the expense figure; it never presents a partial total as the total.
 */
export async function projectBudget(projectId: string): Promise<ProjectBudget> {
  const id = String(projectId || '').trim();
  const out: ProjectBudget = {
    ok: false,
    planned: null,
    currency: DEFAULT_CURRENCY,
    expenseActual: 0, expenseCount: 0, expenseOk: false,
    procurementCommitted: 0, procurementCount: 0, procurementOk: false,
    actual: 0, variance: null, variancePct: null,
    notes: [],
  };
  if (!isUuid(id)) return out;

  try {
    await ensureProjectSchema();
    const p = rows(await db.execute(sql`
      SELECT p.budget_planned, p.currency FROM projects p WHERE p.id::text = ${id} LIMIT 1`))[0];
    if (!p) return out;
    out.ok = true;
    out.planned = p.budget_planned === null || p.budget_planned === undefined ? null : numOf(p.budget_planned);
    out.currency = String(p.currency || DEFAULT_CURRENCY);
  } catch (e: any) {
    logFail('projectBudget project', e);
    out.notes.push('The project record could not be read, so no budget figure is shown. Nothing is lost.');
    return out;
  }

  try {
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(c.amount), 0) AS total, COUNT(*)::int AS n
        FROM expense_claims c
       WHERE c.project_id::text = ${id}
         AND c.status IN ('approved', 'reimbursed')`))[0];
    out.expenseActual = numOf(r?.total);
    out.expenseCount = Number(r?.n) || 0;
    out.expenseOk = true;
  } catch (e: any) {
    logFail('projectBudget expenses', e);
    out.notes.push('Approved expense claims could not be read, so they are not in the actual figure below.');
  }

  try {
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(o.amount, req.estimated_cost, 0)), 0) AS total, COUNT(*)::int AS n
        FROM procurement_orders o
        JOIN procurement_requests req ON req.id = o.request_id
       WHERE req.project_id::text = ${id}
         AND o.status <> 'cancelled'`))[0];
    out.procurementCommitted = numOf(r?.total);
    out.procurementCount = Number(r?.n) || 0;
    out.procurementOk = true;
  } catch (e: any) {
    logFail('projectBudget procurement', e);
    out.notes.push('Purchase orders could not be read, so they are not in the actual figure below.');
  }

  out.actual = out.expenseActual + out.procurementCommitted;

  if (out.expenseOk && out.procurementOk && out.expenseCount === 0 && out.procurementCount === 0) {
    out.notes.push(
      'No expense claim or purchase order has been linked to this project yet, so actual spend reads zero ' +
      'because nothing has been recorded against it — not because nothing has been spent. Link a claim or a ' +
      'purchase to this project from its own record and it appears here.',
    );
  }

  if (out.planned !== null) {
    out.variance = out.planned - out.actual;
    out.variancePct = out.planned > 0 ? Math.round(((out.planned - out.actual) / out.planned) * 100) : null;
  }

  return out;
}

/** A plain amount, in the project's own currency. No library, no locale surprises on a phone. */
export function formatAmount(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '-';
  const cur = String(currency || DEFAULT_CURRENCY).toUpperCase();
  const n = Number(amount);
  const body = n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return cur + ' ' + body;
}

// -------------------------------------------------------------------------------------------------
// RESOURCING — SURFACED, NEVER ACTED ON
// -------------------------------------------------------------------------------------------------

/**
 * WHO IS COMMITTED TO WHAT, over a window, across EVERY project — including the ones the caller
 * cannot see.
 *
 * READ THAT LAST CLAUSE CAREFULLY, because it is a deliberate disclosure and it is bounded. To tell a
 * project manager "this person is already at 140%" the sum has to include the other projects, so this
 * returns, for the named employees only: the project code and name, the capacity and the percentage.
 * It returns no task, no description, no cost and no personal detail — a project code is not private
 * to the same degree a person's work is, and without it the number is unusable ("140%, and I cannot
 * tell you why").
 *
 * `employeeIds` is REQUIRED and is never derived from a request. Every caller passes the members of a
 * project it has already established the viewer may see, so nobody can enumerate the workforce by
 * asking with an empty list — an empty list returns an empty answer.
 *
 * NOTHING HERE REASSIGNS ANYBODY. It reports a number. Whether somebody at 140% comes off a project
 * is a conversation between people, and a sum in a database is not entitled to have it for them.
 */
export async function allocationFor(
  employeeIds: string[],
  window: { from?: string | null; to?: string | null } = {},
): Promise<AllocationView> {
  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(window.from) ? window.from : today;
  const to = isDate(window.to) ? window.to : from;
  const ids = Array.from(new Set((employeeIds || []).map((v) => String(v || '').trim()).filter(isUuid)));

  const empty: AllocationView = { ok: false, from, to, people: [], conflicts: [] };
  if (ids.length === 0) return { ...empty, ok: true };

  try {
    await ensureProjectSchema();
    // OVERLAP, half-open on neither end: a membership with no dates is open-ended and always counts,
    // which is the honest reading of "we did not say when this ends".
    const list = rows(await db.execute(sql`
      SELECT m.employee_id, m.capacity, m.allocation_pct, m.from_on, m.to_on,
             p.id AS project_id, p.code AS project_code, p.name AS project_name,
             e.full_name AS full_name
        FROM project_members m
        JOIN projects p ON p.id = m.project_id
        LEFT JOIN hr_employees e ON e.id = m.employee_id
       WHERE ${inList(sql`m.employee_id`, ids)}
         AND m.removed_at IS NULL
         AND p.status NOT IN ('completed', 'cancelled', 'archived')
         AND (m.from_on IS NULL OR m.from_on <= ${to}::date)
         AND (m.to_on IS NULL OR m.to_on >= ${from}::date)
       ORDER BY e.full_name ASC, m.allocation_pct DESC`));

    const byEmployee = new Map<string, AllocationPerson>();
    for (const id of ids) byEmployee.set(id, { employeeId: id, fullName: null, totalPct: 0, overAllocated: false, entries: [] });

    for (const r of list) {
      const key = String(r.employee_id);
      const person = byEmployee.get(key) || { employeeId: key, fullName: null, totalPct: 0, overAllocated: false, entries: [] };
      person.fullName = person.fullName || (r.full_name ?? null);
      const pct = Number(r.allocation_pct) || 0;
      person.totalPct += pct;
      person.entries.push({
        projectId: String(r.project_id),
        projectCode: String(r.project_code || ''),
        projectName: String(r.project_name || ''),
        capacity: asCapacity(r.capacity),
        allocationPct: pct,
        fromOn: dateOf(r.from_on),
        toOn: dateOf(r.to_on),
      });
      byEmployee.set(key, person);
    }

    const people = Array.from(byEmployee.values()).map((p) => ({ ...p, overAllocated: p.totalPct > 100 }));
    return { ok: true, from, to, people, conflicts: people.filter((p) => p.overAllocated) };
  } catch (e: any) {
    logFail('allocationFor', e);
    // ok:false, never an empty allocation presented as fact. "Nobody is over-committed" is a claim,
    // and a failed read is not in a position to make it.
    return empty;
  }
}

/** The allocation picture for one project's current members. The window defaults to today. */
export async function projectAllocation(
  projectId: string,
  window: { from?: string | null; to?: string | null } = {},
): Promise<AllocationView> {
  const members = await listMembers(projectId);
  return allocationFor(members.map((m) => m.employeeId), window);
}

// -------------------------------------------------------------------------------------------------
// TIMELINE — PURE GEOMETRY, NO DATABASE, NO CHARTING LIBRARY
// -------------------------------------------------------------------------------------------------

export interface TimelineItem {
  id: string;
  label: string;
  sublabel?: string | null;
  startOn: string | null;
  endOn: string | null;
  /** 0-100, or null when there is nothing to report. Drawn as a fill inside the bar. */
  percentComplete?: number | null;
  status?: string | null;
  overdue?: boolean;
  href?: string | null;
}

export interface TimelineBar extends TimelineItem {
  /** Percentages of the chart width. Ready to become x/width on a rect with no further arithmetic. */
  leftPct: number;
  widthPct: number;
  /** True when the item had no dates at all and is drawn as a full-width ghost with a note. */
  undated: boolean;
}

export interface TimelineTick {
  label: string;
  leftPct: number;
}

export interface Timeline {
  from: string;
  to: string;
  bars: TimelineBar[];
  ticks: TimelineTick[];
  /** Where today sits, 0-100, or null when today is outside the window. */
  todayPct: number | null;
}

const DAY_MS = 86400000;

const parseDay = (v: string | null | undefined): number | null => {
  if (!isDate(v)) return null;
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
};

const toIsoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Turn dated items into bar geometry for an INLINE SVG Gantt.
 *
 * NO CHARTING LIBRARY, and that is not only a dependency preference: a chart library ships a
 * canvas-or-nothing renderer, and at 360px this has to degrade to a readable list rather than a
 * sideways-scrolling page. Percentages are what let the same numbers drive an SVG on a laptop and a
 * plain list of dates on a phone, from one computation, with no second source of truth about where
 * anything sits.
 *
 * AN UNDATED ITEM IS NOT DROPPED. It comes back with undated:true so the surface can say "no dates
 * recorded" beside it. Silently omitting it would make a roadmap look complete while hiding the
 * work nobody has scheduled — the exact thing a roadmap is read to find.
 */
export function buildTimeline(
  items: TimelineItem[],
  window: { from?: string | null; to?: string | null } = {},
): Timeline {
  const list = Array.isArray(items) ? items : [];

  const starts = list.map((i) => parseDay(i.startOn)).filter((v): v is number => v !== null);
  const ends = list.map((i) => parseDay(i.endOn)).filter((v): v is number => v !== null);
  const known = starts.concat(ends);

  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  let fromMs = parseDay(window.from) ?? (known.length ? Math.min(...known) : todayMs);
  let toMs = parseDay(window.to) ?? (known.length ? Math.max(...known) : todayMs + 30 * DAY_MS);

  // A window of zero or negative width would divide by zero and put every bar at NaN%. Two weeks is
  // an arbitrary floor and it is better than a blank chart.
  if (!(toMs > fromMs)) toMs = fromMs + 14 * DAY_MS;

  const span = toMs - fromMs;
  const pct = (ms: number): number => Math.max(0, Math.min(100, ((ms - fromMs) / span) * 100));

  const bars: TimelineBar[] = list.map((item) => {
    const s = parseDay(item.startOn);
    const e = parseDay(item.endOn);
    if (s === null && e === null) {
      return { ...item, leftPct: 0, widthPct: 100, undated: true };
    }
    // One dated end is enough to place it: a milestone has a due date and no start, and drawing it as
    // a short bar ending on its date is more honest than refusing to draw it.
    const startMs = s ?? Math.max(fromMs, (e as number) - 7 * DAY_MS);
    const endMs = e ?? Math.min(toMs, (s as number) + 7 * DAY_MS);
    const left = pct(Math.min(startMs, endMs));
    const right = pct(Math.max(startMs, endMs));
    return {
      ...item,
      leftPct: left,
      // A one-day item would otherwise be a zero-width invisible rect.
      widthPct: Math.max(right - left, 1.2),
      undated: false,
    };
  });

  // At most a tick a month, and never more than twelve, so the axis stays readable at 360px.
  const ticks: TimelineTick[] = [];
  const months = Math.max(1, Math.round(span / (30 * DAY_MS)));
  const step = Math.max(1, Math.ceil(months / 12));
  const cursor = new Date(fromMs);
  cursor.setUTCDate(1);
  for (let guard = 0; guard < 64; guard++) {
    const ms = cursor.getTime();
    if (ms > toMs) break;
    if (ms >= fromMs) {
      ticks.push({
        label: cursor.toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        leftPct: pct(ms),
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + step);
  }

  return {
    from: toIsoDay(fromMs),
    to: toIsoDay(toMs),
    bars,
    ticks,
    todayPct: todayMs >= fromMs && todayMs <= toMs ? pct(todayMs) : null,
  };
}

// -------------------------------------------------------------------------------------------------
// THE STATUS REPORT — COMPUTED, NEVER STORED
// -------------------------------------------------------------------------------------------------

export interface ProjectReport {
  project: Project;
  owner: ProjectOwner;
  tasks: ProjectTaskProgress;
  budget: ProjectBudget;
  milestonesTotal: number;
  milestonesMet: number;
  milestonesOverdue: number;
  deliverablesTotal: number;
  deliverablesAccepted: number;
  risksOpen: number;
  risksSevere: number;
  overAllocatedPeople: number;
  /** Plain sentences a person can read out in a meeting. Never a computed verdict on anybody. */
  headlines: string[];
}

/**
 * ONE PROJECT'S STATUS, PROGRESS AND BUDGET VARIANCE, assembled at read time.
 *
 * There is no project_reports table and there must not be one: a stored report is a number that was
 * true once, and the first time somebody reads a stale one in a meeting the whole module stops being
 * believed. Everything here is recomputed from the rows that hold the facts.
 *
 * The headlines describe the PROJECT and never a person. "Three people are committed beyond 100%" is
 * a resourcing fact; "X is overloaded" would be a judgement this module has no business publishing.
 */
export async function projectReport(
  actor: ProjectActor | null | undefined,
  projectId: string,
): Promise<ProjectReport | null> {
  const project = await getProject(actor, projectId);
  if (!project) return null;

  const [owner, tasks, budget, milestones, deliverables, risks, allocation] = await Promise.all([
    projectOwner(project.id),
    projectTaskProgress(project.id),
    projectBudget(project.id),
    listMilestones(project.id),
    listDeliverables(project.id),
    listRisks(project.id, { includeClosed: true }),
    projectAllocation(project.id),
  ]);

  const milestonesOverdue = milestones.filter((m) => m.isOverdue).length;
  const risksOpen = risks.filter((r) => r.status === 'open' || r.status === 'mitigating').length;
  const risksSevere = risks.filter((r) => r.score >= 6 && r.status !== 'closed').length;
  const overAllocatedPeople = allocation.conflicts.length;

  const headlines: string[] = [];
  if (project.isOverdue) {
    headlines.push('Past its target date of ' + project.targetOn + ' and still ' + project.statusLabel.toLowerCase() + '.');
  }
  if (tasks.ok && tasks.percentComplete !== null) {
    headlines.push(tasks.percentComplete + '% of the work on this project is complete (' +
      tasks.completed + ' of ' + (tasks.total - 0) + ' tasks), with ' + tasks.blocked + ' blocked.');
  } else if (!tasks.ok) {
    headlines.push('Task progress could not be read just now, so no completion figure is shown for it.');
  }
  if (milestonesOverdue > 0) {
    headlines.push(milestonesOverdue + ' milestone' + (milestonesOverdue === 1 ? ' is' : 's are') + ' past due.');
  }
  if (budget.ok && budget.planned !== null) {
    headlines.push(budget.variance !== null && budget.variance < 0
      ? 'Spend is over the planned budget by ' + formatAmount(Math.abs(budget.variance), budget.currency) + '.'
      : 'Spend is within the planned budget, ' + formatAmount(budget.variance, budget.currency) + ' remaining.');
  } else if (budget.ok) {
    headlines.push('No budget has been planned for this project, so there is no variance to report.');
  }
  if (risksSevere > 0) {
    headlines.push(risksSevere + ' risk' + (risksSevere === 1 ? '' : 's') + ' graded severe and not yet closed.');
  }
  if (overAllocatedPeople > 0) {
    headlines.push(overAllocatedPeople + ' ' + (overAllocatedPeople === 1 ? 'person is' : 'people are') +
      ' committed beyond 100% across their projects today. This is for a person to resolve, not the system.');
  }
  if (!owner.graphReady) {
    headlines.push('No project manager can be named yet: the Organization Graph has not been initialized.');
  } else if (!owner.owner) {
    headlines.push('No project manager is recorded for this project.');
  }

  return {
    project,
    owner,
    tasks,
    budget,
    milestonesTotal: milestones.length,
    milestonesMet: milestones.filter((m) => m.status === 'met').length,
    milestonesOverdue,
    deliverablesTotal: deliverables.length,
    deliverablesAccepted: deliverables.filter((d) => d.status === 'accepted').length,
    risksOpen,
    risksSevere,
    overAllocatedPeople,
    headlines,
  };
}

/** Everything one project page renders, in one call. Null when the viewer may not see the project. */
export async function projectDetail(
  actor: ProjectActor | null | undefined,
  projectId: string,
): Promise<ProjectDetail | null> {
  const project = await getProject(actor, projectId);
  if (!project) return null;
  const [owner, members, milestones, deliverables, risks, budget, tasks] = await Promise.all([
    projectOwner(project.id),
    listMembers(project.id),
    listMilestones(project.id),
    listDeliverables(project.id),
    listRisks(project.id, { includeClosed: true }),
    projectBudget(project.id),
    projectTaskProgress(project.id),
  ]);
  return { project, owner, members, milestones, deliverables, risks, budget, tasks };
}

// -------------------------------------------------------------------------------------------------
// WRITES. Every one of them re-derives the actor's authority before anything is written, and every
// one of them logs the real Postgres reason and returns a sentence. Nothing here swallows an
// exception silently — a bare catch is what hid a total sign-in outage on this project for hours.
// -------------------------------------------------------------------------------------------------

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/**
 * A link, and only ever a link. Documents of any kind are Drive links in this product, never uploads,
 * so this refuses anything that is not http(s) rather than storing a path somebody will later expect
 * to resolve to a file.
 */
export function normaliseLink(v: unknown): string | null {
  const raw = clean(v, 1000);
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

/**
 * CREATE A PROJECT, and record who runs it as a GRAPH EDGE in the same operation.
 *
 * `managerEmployeeId` does not become a column. It becomes an effective-dated `project_manager`
 * relationship through openRelationship(), which is the only way this codebase records a
 * relationship. If that write fails the project still exists and reads as "no project manager
 * recorded" — an honest state that a person can fix — rather than the project being lost because a
 * second table would not take a row.
 */
export async function createProject(
  actor: ProjectActor | null | undefined,
  input: {
    code: string;
    name: string;
    description?: string | null;
    departmentId?: string | null;
    startOn?: string | null;
    targetOn?: string | null;
    budgetPlanned?: string | number | null;
    currency?: string | null;
    managerEmployeeId?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  if (!isUuid(userId)) return { ok: false, error: NOT_AVAILABLE };
  if (!holdsCapability(actor, 'projects.manage')) {
    return { ok: false, error: 'Creating a project is for whoever keeps the project register.' };
  }

  const code = clean(input.code, 40).toUpperCase();
  const name = clean(input.name, 200);
  if (code.length < 2) return { ok: false, error: 'Give the project a short code, at least two characters.' };
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    return { ok: false, error: 'A project code can use letters, digits, dots, dashes and underscores.' };
  }
  if (name.length < 3) return { ok: false, error: 'Give the project a name.' };

  const startOn = clean(input.startOn, 10) || null;
  const targetOn = clean(input.targetOn, 10) || null;
  if (startOn && !isDate(startOn)) return { ok: false, error: 'Give the start date as YYYY-MM-DD, or leave it empty.' };
  if (targetOn && !isDate(targetOn)) return { ok: false, error: 'Give the target date as YYYY-MM-DD, or leave it empty.' };
  if (startOn && targetOn && targetOn < startOn) {
    return { ok: false, error: 'The target date is before the start date. Check them both.' };
  }

  const budgetRaw = clean(input.budgetPlanned, 20);
  let budget: number | null = null;
  if (budgetRaw) {
    const n = Number(budgetRaw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Give the planned budget as a number, or leave it empty.' };
    if (n > MAX_BUDGET) return { ok: false, error: 'That budget looks like a typo. Check the figure.' };
    budget = n;
  }

  const departmentId = clean(input.departmentId, 50) || null;
  const currency = (clean(input.currency, 8) || DEFAULT_CURRENCY).toUpperCase();
  const manager = isUuid(input.managerEmployeeId) ? String(input.managerEmployeeId) : null;

  try {
    await ensureProjectSchema();

    // INSERT ... SELECT ... WHERE NOT EXISTS, so a double-tap on a phone with one bar of signal
    // cannot produce two projects with the same code even if the unique index failed to create.
    const r = rows(await db.execute(sql`
      INSERT INTO projects (code, name, description, department_id, status, start_on, target_on,
                            budget_planned, currency, created_by_user_id)
      SELECT ${code}, ${name}, ${clean(input.description, 4000) || null}, ${departmentId}::text,
             'planning', ${startOn}::date, ${targetOn}::date, ${budget}::numeric, ${currency},
             ${userId}::uuid
       WHERE NOT EXISTS (SELECT 1 FROM projects x WHERE lower(x.code) = lower(${code}))
      RETURNING id`))[0];

    if (!r?.id) return { ok: false, error: 'A project already uses the code ' + code + '. Pick another.' };
    const projectId = String(r.id);

    await logAudit({
      userId,
      action: 'project.create',
      entity: 'project',
      entityId: projectId,
      diff: { code, name, departmentId, startOn, targetOn, budgetPlanned: budget, currency, managerEmployeeId: manager },
      ipAddress: input.ipAddress || undefined,
    });

    if (manager) {
      const edge = await openRelationship({
        type: 'project_manager',
        subjectEmployeeId: manager,
        scopeType: 'project',
        scopeId: projectId,
        effectiveFrom: startOn || null,
        createdByUserId: userId,
        note: 'Runs project ' + code,
      });
      if (!edge.ok) {
        // The project exists. Say what did not happen rather than pretending both halves worked.
        return {
          ok: true,
          id: projectId,
          error: 'The project was created, but the project manager could not be recorded: ' +
            (edge.error || 'the relationship was refused') + '. Record it from the project page.',
        };
      }
    }

    return { ok: true, id: projectId };
  } catch (e: any) {
    logFail('createProject', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Change a project's definition. The register keeper, or whoever the graph says runs it. */
export async function updateProject(
  actor: ProjectActor | null | undefined,
  projectId: string,
  input: {
    name?: string | null;
    description?: string | null;
    departmentId?: string | null;
    startOn?: string | null;
    targetOn?: string | null;
    budgetPlanned?: string | number | null;
    currency?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const id = String(projectId || '').trim();
  if (!isUuid(userId) || !isUuid(id)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, id);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Changing a project is for whoever runs it, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const name = clean(input.name, 200);
  if (name && name.length < 3) return { ok: false, error: 'Give the project a name of at least three characters.' };

  const startOn = clean(input.startOn, 10);
  const targetOn = clean(input.targetOn, 10);
  if (startOn && !isDate(startOn)) return { ok: false, error: 'Give the start date as YYYY-MM-DD, or leave it empty.' };
  if (targetOn && !isDate(targetOn)) return { ok: false, error: 'Give the target date as YYYY-MM-DD, or leave it empty.' };
  if (startOn && targetOn && targetOn < startOn) {
    return { ok: false, error: 'The target date is before the start date. Check them both.' };
  }

  const budgetRaw = clean(input.budgetPlanned, 20);
  let budget: number | null = null;
  if (budgetRaw) {
    const n = Number(budgetRaw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Give the planned budget as a number, or leave it empty.' };
    if (n > MAX_BUDGET) return { ok: false, error: 'That budget looks like a typo. Check the figure.' };
    budget = n;
  }

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      UPDATE projects
         SET name           = COALESCE(NULLIF(${name}, ''), name),
             description    = ${clean(input.description, 4000) || null},
             department_id  = ${clean(input.departmentId, 50) || null}::text,
             start_on       = ${startOn || null}::date,
             target_on      = ${targetOn || null}::date,
             budget_planned = ${budget}::numeric,
             currency       = COALESCE(NULLIF(${(clean(input.currency, 8) || '').toUpperCase()}, ''), currency),
             updated_at     = NOW()
       WHERE id::text = ${id}
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId,
      action: 'project.update',
      entity: 'project',
      entityId: id,
      diff: { name, departmentId: clean(input.departmentId, 50) || null, startOn, targetOn, budgetPlanned: budget },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail('updateProject', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Move a project through its lifecycle. Refuses a move the graph of statuses does not carry. */
export async function setProjectStatus(
  actor: ProjectActor | null | undefined,
  projectId: string,
  toStatus: string,
  opts: { reason?: string | null; ipAddress?: string | null } = {},
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const id = String(projectId || '').trim();
  if (!isUuid(userId) || !isUuid(id)) return { ok: false, error: NOT_AVAILABLE };

  const to = String(toStatus || '').trim().toLowerCase();
  if (!isProjectStatus(to)) return { ok: false, error: 'That is not a project status we track.' };

  const auth = await projectAuthority(actor, id);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Moving a project is for whoever runs it, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const reason = clean(opts.reason, 2000);
  if (projectStatusNeedsReason(to) && reason.length < REASON_MIN) {
    return {
      ok: false,
      error: to === 'on_hold'
        ? 'Say what it is waiting on, so somebody can unblock it.'
        : 'Say why it is being cancelled, so the record explains itself later.',
    };
  }

  try {
    await ensureProjectSchema();
    const current = rows(await db.execute(sql`
      SELECT status FROM projects WHERE id::text = ${id} LIMIT 1`))[0];
    if (!current) return { ok: false, error: NOT_AVAILABLE };

    const from = asStatus(current.status);
    if (from === to) return { ok: true, id };
    const check = canMoveProject(from, to);
    if (!check.ok) return { ok: false, error: check.reason || NOT_AVAILABLE };

    // Reaching 'completed' stamps the actual end date; leaving it clears it, so a reopened project
    // does not keep claiming an end date that no longer happened. The reason is cleared on any move
    // that does not need one, for the same reason: a project that is no longer on hold must not still
    // show why it once was.
    const endOn = to === 'completed' ? sql`CURRENT_DATE` : sql`NULL`;
    const reasonSql = projectStatusNeedsReason(to) ? sql`${reason}` : sql`NULL`;

    const r = rows(await db.execute(sql`
      UPDATE projects
         SET status = ${to},
             status_reason = ${reasonSql},
             actual_end_on = ${endOn},
             updated_at = NOW()
       WHERE id::text = ${id}
         AND status = ${from}
      RETURNING id`));
    // Zero rows means somebody else moved it between the read and the write. Say so; do not clobber.
    if (r.length === 0) return { ok: false, error: 'Somebody else changed this project a moment ago. Reload and try again.' };

    await logAudit({
      userId,
      action: 'project.status',
      entity: 'project',
      entityId: id,
      diff: { from, to, reason: reason || null, viaRunsProject: auth.runsProject, viaRegistrar: auth.registrar },
      ipAddress: opts.ipAddress || undefined,
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail('setProjectStatus', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * RECORD WHO RUNS A PROJECT — an effective-dated edge in the Organization Graph, never a column.
 *
 * Handing a project over CLOSES the outgoing edge and OPENS the new one, exactly as
 * supersedeReportingManager does for a reporting line, so "who ran this in March" survives the
 * handover. Passing null closes the line without opening a new one, which is how "nobody runs this
 * at the moment" is recorded honestly instead of leaving a stale name on screen.
 *
 * ONLY THE REGISTER KEEPER MAY DO THIS. Deliberately not the outgoing project manager: letting the
 * person who runs a project choose their own successor makes the graph self-appointing, and the graph
 * is what every other authority in this module is derived from.
 */
export async function setProjectManager(
  actor: ProjectActor | null | undefined,
  projectId: string,
  managerEmployeeId: string | null,
  opts: { effectiveFrom?: string | null; note?: string | null; ipAddress?: string | null } = {},
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const id = String(projectId || '').trim();
  if (!isUuid(userId) || !isUuid(id)) return { ok: false, error: NOT_AVAILABLE };
  if (!holdsCapability(actor, 'projects.manage')) {
    return { ok: false, error: 'Recording who runs a project is for whoever keeps the project register.' };
  }

  const manager = isUuid(managerEmployeeId) ? String(managerEmployeeId) : null;
  const at = isDate(opts.effectiveFrom) ? opts.effectiveFrom : new Date().toISOString();

  try {
    await ensureProjectSchema();
    const exists = rows(await db.execute(sql`SELECT id FROM projects WHERE id::text = ${id} LIMIT 1`));
    if (exists.length === 0) return { ok: false, error: NOT_AVAILABLE };

    // Close every open edge first. A project with two open managers has no single answer to "who runs
    // this", and getProjectManager() would return whichever row the planner handed back first.
    const current = await getProjectManagers(id);
    for (const person of current) {
      if (!person.employeeId) continue;
      if (manager && person.employeeId === manager) continue; // already correct; nothing to change
      const open = rows(await db.execute(sql`
        SELECT r.id FROM org_relationships r
         WHERE r.type = 'project_manager'
           AND r.scope_type = 'project'
           AND r.scope_id = ${id}
           AND r.subject_employee_id = ${person.employeeId}::uuid
           AND r.status = 'active'
           AND r.effective_to IS NULL
         LIMIT 1`));
      if (open.length > 0) await closeRelationship(String(open[0].id), { asOf: at });
    }

    if (!manager) {
      await logAudit({
        userId, action: 'project.manager.clear', entity: 'project', entityId: id,
        diff: { closed: current.map((p) => p.employeeId) }, ipAddress: opts.ipAddress || undefined,
      });
      return { ok: true, id };
    }

    if (current.some((p) => p.employeeId === manager)) return { ok: true, id };

    const edge = await openRelationship({
      type: 'project_manager',
      subjectEmployeeId: manager,
      scopeType: 'project',
      scopeId: id,
      effectiveFrom: at,
      createdByUserId: userId,
      note: clean(opts.note, 2000) || null,
    });
    if (!edge.ok) return { ok: false, error: edge.error || 'The relationship could not be recorded.' };

    await logAudit({
      userId, action: 'project.manager.set', entity: 'project', entityId: id,
      diff: { managerEmployeeId: manager, effectiveFrom: at, relationshipId: edge.id },
      ipAddress: opts.ipAddress || undefined,
    });
    return { ok: true, id: edge.id };
  } catch (e: any) {
    logFail('setProjectManager', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Put somebody on a project, at a percentage, over a period.
 *
 * IT NEVER REFUSES ON OVER-ALLOCATION. If this person is already at 90% and is being added at 50%,
 * the membership is recorded and the surface shows 140% in red. Refusing would mean a database
 * overruling two people who have agreed how somebody's month works, and the number they need to see
 * would be the one number the system would not let them write down.
 */
export async function addMember(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    employeeId: string;
    capacity?: string | null;
    allocationPct?: string | number | null;
    fromOn?: string | null;
    toOn?: string | null;
    note?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  const employeeId = String(input.employeeId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(employeeId)) return { ok: false, error: 'Choose a person to add.' };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Adding somebody to a project is for whoever runs it, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const capacity = String(input.capacity || '').trim().toLowerCase();
  const cap: MemberCapacity = isMemberCapacity(capacity) ? capacity : 'contributor';

  const pctRaw = clean(input.allocationPct, 8);
  const pct = pctRaw ? Number(pctRaw) : 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: 'Give the allocation as a whole number between 0 and 100.' };
  }

  const fromOn = clean(input.fromOn, 10);
  const toOn = clean(input.toOn, 10);
  if (fromOn && !isDate(fromOn)) return { ok: false, error: 'Give the from date as YYYY-MM-DD, or leave it empty.' };
  if (toOn && !isDate(toOn)) return { ok: false, error: 'Give the to date as YYYY-MM-DD, or leave it empty.' };
  if (fromOn && toOn && toOn < fromOn) return { ok: false, error: 'The end date is before the start date. Check them both.' };

  try {
    await ensureProjectSchema();
    // INSERT ... SELECT against hr_employees, so an id that is not a real active employee writes
    // nothing rather than creating a membership for a row that does not exist. WHERE NOT EXISTS makes
    // a double submit a no-op instead of a duplicate.
    const r = rows(await db.execute(sql`
      INSERT INTO project_members (project_id, employee_id, capacity, allocation_pct, from_on, to_on, note, added_by_user_id)
      SELECT ${projectId}::uuid, e.id, ${cap}, ${Math.round(pct)}, ${fromOn || null}::date,
             ${toOn || null}::date, ${clean(input.note, 1000) || null}, ${userId}::uuid
        FROM hr_employees e
       WHERE e.id::text = ${employeeId}
         AND e.is_active = true
         AND NOT EXISTS (SELECT 1 FROM project_members m
                          WHERE m.project_id = ${projectId}::uuid
                            AND m.employee_id = e.id
                            AND m.removed_at IS NULL)
      RETURNING id`))[0];

    if (!r?.id) {
      return { ok: false, error: 'That person is already on this project, or their employee record is not active.' };
    }

    await logAudit({
      userId, action: 'project.member.add', entity: 'project', entityId: projectId,
      diff: { employeeId, capacity: cap, allocationPct: Math.round(pct), fromOn: fromOn || null, toOn: toOn || null },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addMember', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Change somebody's capacity, percentage or dates on a project. */
export async function updateMember(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    memberId: string;
    capacity?: string | null;
    allocationPct?: string | number | null;
    fromOn?: string | null;
    toOn?: string | null;
    note?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  const memberId = String(input.memberId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId) || !isUuid(memberId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Changing an allocation is for whoever runs the project, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const capacity = String(input.capacity || '').trim().toLowerCase();
  const cap: MemberCapacity = isMemberCapacity(capacity) ? capacity : 'contributor';

  const pctRaw = clean(input.allocationPct, 8);
  const pct = pctRaw ? Number(pctRaw) : 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: 'Give the allocation as a whole number between 0 and 100.' };
  }

  const fromOn = clean(input.fromOn, 10);
  const toOn = clean(input.toOn, 10);
  if (fromOn && !isDate(fromOn)) return { ok: false, error: 'Give the from date as YYYY-MM-DD, or leave it empty.' };
  if (toOn && !isDate(toOn)) return { ok: false, error: 'Give the to date as YYYY-MM-DD, or leave it empty.' };
  if (fromOn && toOn && toOn < fromOn) return { ok: false, error: 'The end date is before the start date. Check them both.' };

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      UPDATE project_members
         SET capacity = ${cap},
             allocation_pct = ${Math.round(pct)},
             from_on = ${fromOn || null}::date,
             to_on = ${toOn || null}::date,
             note = ${clean(input.note, 1000) || null}
       WHERE id::text = ${memberId}
         AND project_id::text = ${projectId}
         AND removed_at IS NULL
      RETURNING id, employee_id`))[0];
    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId, action: 'project.member.update', entity: 'project', entityId: projectId,
      diff: { memberId, employeeId: String(r.employee_id), capacity: cap, allocationPct: Math.round(pct) },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: memberId };
  } catch (e: any) {
    logFail('updateMember', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Take somebody off a project. The row STAYS, stamped — the history is the point. */
export async function removeMember(
  actor: ProjectActor | null | undefined,
  projectId: string,
  memberId: string,
  opts: { ipAddress?: string | null } = {},
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const pid = String(projectId || '').trim();
  const mid = String(memberId || '').trim();
  if (!isUuid(userId) || !isUuid(pid) || !isUuid(mid)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, pid);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Taking somebody off a project is for whoever runs it, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      UPDATE project_members
         SET removed_at = NOW(), removed_by_user_id = ${userId}::uuid
       WHERE id::text = ${mid}
         AND project_id::text = ${pid}
         AND removed_at IS NULL
      RETURNING id, employee_id`))[0];
    if (!r?.id) return { ok: true, id: mid }; // already off; nothing happened, nothing to log

    await logAudit({
      userId, action: 'project.member.remove', entity: 'project', entityId: pid,
      diff: { memberId: mid, employeeId: String(r.employee_id) }, ipAddress: opts.ipAddress || undefined,
    });
    return { ok: true, id: mid };
  } catch (e: any) {
    logFail('removeMember', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function addMilestone(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    name: string;
    description?: string | null;
    dueOn?: string | null;
    sortOrder?: string | number | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Setting a milestone is for whoever runs the project, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const name = clean(input.name, 200);
  if (name.length < 3) return { ok: false, error: 'Give the milestone a name.' };
  const dueOn = clean(input.dueOn, 10);
  if (dueOn && !isDate(dueOn)) return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };
  const order = Number(clean(input.sortOrder, 6) || 0);

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO project_milestones (project_id, name, description, due_on, sort_order, created_by_user_id)
      SELECT ${projectId}::uuid, ${name}, ${clean(input.description, 4000) || null},
             ${dueOn || null}::date, ${Number.isFinite(order) ? Math.round(order) : 0}, ${userId}::uuid
       WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = ${projectId}::uuid)
      RETURNING id`))[0];
    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId, action: 'project.milestone.add', entity: 'project', entityId: projectId,
      diff: { milestoneId: String(r.id), name, dueOn: dueOn || null }, ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addMilestone', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Change a milestone. `met` stamps completed_on; anything else clears it, so a milestone reopened
 * because the work came back does not keep claiming a completion date that no longer happened.
 */
export async function updateMilestone(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    milestoneId: string;
    name?: string | null;
    description?: string | null;
    dueOn?: string | null;
    status?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  const milestoneId = String(input.milestoneId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId) || !isUuid(milestoneId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Changing a milestone is for whoever runs the project, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const wanted = String(input.status || '').trim().toLowerCase();
  const status: MilestoneStatus = isMilestoneStatus(wanted) ? wanted : 'planned';
  const name = clean(input.name, 200);
  const dueOn = clean(input.dueOn, 10);
  if (dueOn && !isDate(dueOn)) return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };

  try {
    await ensureProjectSchema();
    const completed = status === 'met' ? sql`COALESCE(completed_on, CURRENT_DATE)` : sql`NULL`;
    const r = rows(await db.execute(sql`
      UPDATE project_milestones
         SET name = COALESCE(NULLIF(${name}, ''), name),
             description = ${clean(input.description, 4000) || null},
             due_on = ${dueOn || null}::date,
             status = ${status},
             completed_on = ${completed},
             updated_at = NOW()
       WHERE id::text = ${milestoneId}
         AND project_id::text = ${projectId}
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId, action: 'project.milestone.update', entity: 'project', entityId: projectId,
      diff: { milestoneId, name, dueOn: dueOn || null, status }, ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: milestoneId };
  } catch (e: any) {
    logFail('updateMilestone', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function addDeliverable(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    milestoneId?: string | null;
    name: string;
    description?: string | null;
    linkUrl?: string | null;
    ownerEmployeeId?: string | null;
    dueOn?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.mayEdit) {
    return {
      ok: false,
      error: auth.graphReady
        ? 'Recording a deliverable is for whoever runs the project, or whoever keeps the project register.'
        : GRAPH_NOT_READY,
    };
  }

  const name = clean(input.name, 200);
  if (name.length < 3) return { ok: false, error: 'Give the deliverable a name.' };
  const dueOn = clean(input.dueOn, 10);
  if (dueOn && !isDate(dueOn)) return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };

  const rawLink = clean(input.linkUrl, 1000);
  const link = normaliseLink(rawLink);
  if (rawLink && !link) {
    return {
      ok: false,
      error: 'A deliverable link must be a web link starting http:// or https:// — documents here are ' +
        'links with "anyone with the link" access, never uploads.',
    };
  }

  const milestoneId = isUuid(input.milestoneId) ? String(input.milestoneId) : null;
  const owner = isUuid(input.ownerEmployeeId) ? String(input.ownerEmployeeId) : null;

  try {
    await ensureProjectSchema();
    // The milestone must belong to THIS project. Without that test a posted id could attach a
    // deliverable to another project's milestone, which is a small hole and a real one.
    const r = rows(await db.execute(sql`
      INSERT INTO project_deliverables
        (project_id, milestone_id, name, description, link_url, owner_employee_id, due_on, created_by_user_id)
      SELECT ${projectId}::uuid,
             (SELECT ms.id FROM project_milestones ms
               WHERE ms.id::text = ${milestoneId} AND ms.project_id = ${projectId}::uuid),
             ${name}, ${clean(input.description, 4000) || null}, ${link}, ${owner}::uuid,
             ${dueOn || null}::date, ${userId}::uuid
       WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = ${projectId}::uuid)
      RETURNING id`))[0];
    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId, action: 'project.deliverable.add', entity: 'project', entityId: projectId,
      diff: { deliverableId: String(r.id), name, milestoneId, ownerEmployeeId: owner, dueOn: dueOn || null },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addDeliverable', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Change a deliverable, including its status.
 *
 * THE OWNER MAY MOVE THEIR OWN. Somebody who has to ask the project manager to tick "submitted" on a
 * thing they just finished stops using the register, and a register nobody updates is worse than
 * none. Accepting one is still the project's call: 'accepted' requires mayEdit, because accepting
 * your own work is not a review.
 */
export async function updateDeliverable(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    deliverableId: string;
    name?: string | null;
    description?: string | null;
    linkUrl?: string | null;
    milestoneId?: string | null;
    ownerEmployeeId?: string | null;
    dueOn?: string | null;
    status?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  const deliverableId = String(input.deliverableId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId) || !isUuid(deliverableId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  const wanted = String(input.status || '').trim().toLowerCase();
  const status: DeliverableStatus = isDeliverableStatus(wanted) ? wanted : 'planned';

  if (!auth.mayEdit) {
    // The owner arm. Re-derived from the row below in the WHERE clause, never from this branch alone.
    if (!auth.employeeId) return { ok: false, error: auth.graphReady ? NOT_AVAILABLE : GRAPH_NOT_READY };
    if (status === 'accepted') {
      return { ok: false, error: 'Accepting a deliverable is for whoever runs the project. You can mark it submitted.' };
    }
  }

  const name = clean(input.name, 200);
  const dueOn = clean(input.dueOn, 10);
  if (dueOn && !isDate(dueOn)) return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };

  const rawLink = clean(input.linkUrl, 1000);
  const link = normaliseLink(rawLink);
  if (rawLink && !link) {
    return { ok: false, error: 'A deliverable link must be a web link starting http:// or https://.' };
  }

  const milestoneId = isUuid(input.milestoneId) ? String(input.milestoneId) : null;
  const owner = isUuid(input.ownerEmployeeId) ? String(input.ownerEmployeeId) : null;

  try {
    await ensureProjectSchema();
    // The authority is re-derived BY THE DATABASE in the same statement that writes: either this
    // actor may edit the project, or they are the recorded owner of this deliverable. A caller that
    // got past the branch above without qualifying writes zero rows here.
    const ownerClause = auth.mayEdit
      ? sql`true`
      : sql`d.owner_employee_id::text = ${auth.employeeId || ''}`;
    const accepted = status === 'accepted' ? sql`COALESCE(d.accepted_on, CURRENT_DATE)` : sql`NULL`;

    const r = rows(await db.execute(sql`
      UPDATE project_deliverables AS d
         SET name = COALESCE(NULLIF(${name}, ''), d.name),
             description = ${clean(input.description, 4000) || null},
             link_url = ${link},
             milestone_id = (SELECT ms.id FROM project_milestones ms
                              WHERE ms.id::text = ${milestoneId} AND ms.project_id = d.project_id),
             owner_employee_id = ${owner}::uuid,
             due_on = ${dueOn || null}::date,
             status = ${status},
             accepted_on = ${accepted},
             updated_at = NOW()
       WHERE d.id::text = ${deliverableId}
         AND d.project_id::text = ${projectId}
         AND ${ownerClause}
      RETURNING d.id`));
    if (r.length === 0) {
      return { ok: false, error: 'That deliverable is not yours to change. Ask whoever runs the project.' };
    }

    await logAudit({
      userId, action: 'project.deliverable.update', entity: 'project', entityId: projectId,
      diff: { deliverableId, name, status, milestoneId, ownerEmployeeId: owner, viaOwner: !auth.mayEdit },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: deliverableId };
  } catch (e: any) {
    logFail('updateDeliverable', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Raise a risk.
 *
 * ANY MEMBER MAY RAISE ONE, and that is the whole point of a register: the person who can see the
 * problem coming is usually not the person running the project. Grading and closing are separate
 * powers — see updateRisk.
 */
export async function addRisk(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    title: string;
    description?: string | null;
    likelihood?: string | null;
    impact?: string | null;
    ownerEmployeeId?: string | null;
    mitigation?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.maySee) return { ok: false, error: NOT_AVAILABLE };

  const title = clean(input.title, 200);
  if (title.length < 5) return { ok: false, error: 'Say what the risk is, in a sentence somebody else can act on.' };

  const likelihood = asGrade(String(input.likelihood || '').trim().toLowerCase());
  const impact = asGrade(String(input.impact || '').trim().toLowerCase());
  const owner = isUuid(input.ownerEmployeeId) ? String(input.ownerEmployeeId) : null;

  try {
    await ensureProjectSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO project_risks
        (project_id, title, description, likelihood, impact, owner_employee_id, mitigation, raised_by_user_id)
      SELECT ${projectId}::uuid, ${title}, ${clean(input.description, 4000) || null},
             ${likelihood}, ${impact}, ${owner}::uuid, ${clean(input.mitigation, 4000) || null}, ${userId}::uuid
       WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = ${projectId}::uuid)
      RETURNING id`))[0];
    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId, action: 'project.risk.add', entity: 'project', entityId: projectId,
      diff: { riskId: String(r.id), title, likelihood, impact, ownerEmployeeId: owner },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addRisk', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Grade, own, mitigate or close a risk.
 *
 * CLOSING IS NOT THE SAME ACT AS RAISING. Anybody on the project may raise one; only whoever runs the
 * project or keeps the register may mark it closed or accepted, because those two say "we have
 * decided to live with this" on the project's behalf. The risk OWNER may update the mitigation and
 * the grading of their own risk without either, which is the work of owning it.
 */
export async function updateRisk(
  actor: ProjectActor | null | undefined,
  input: {
    projectId: string;
    riskId: string;
    title?: string | null;
    description?: string | null;
    likelihood?: string | null;
    impact?: string | null;
    ownerEmployeeId?: string | null;
    mitigation?: string | null;
    status?: string | null;
    ipAddress?: string | null;
  },
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const projectId = String(input.projectId || '').trim();
  const riskId = String(input.riskId || '').trim();
  if (!isUuid(userId) || !isUuid(projectId) || !isUuid(riskId)) return { ok: false, error: NOT_AVAILABLE };

  const auth = await projectAuthority(actor, projectId);
  if (!auth.maySee) return { ok: false, error: NOT_AVAILABLE };

  const wanted = String(input.status || '').trim().toLowerCase();
  const status: RiskStatus = isRiskStatus(wanted) ? wanted : 'open';
  if (!auth.mayEdit && (status === 'closed' || status === 'accepted')) {
    return {
      ok: false,
      error: 'Closing or accepting a risk is for whoever runs the project. You can update the mitigation and the grading.',
    };
  }

  const likelihood = asGrade(String(input.likelihood || '').trim().toLowerCase());
  const impact = asGrade(String(input.impact || '').trim().toLowerCase());
  const owner = isUuid(input.ownerEmployeeId) ? String(input.ownerEmployeeId) : null;
  const title = clean(input.title, 200);

  try {
    await ensureProjectSchema();
    // Re-derived in the statement: the project editor, or the risk's own recorded owner.
    const authorityClause = auth.mayEdit
      ? sql`true`
      : sql`r.owner_employee_id::text = ${auth.employeeId || ''}`;
    const closedAt = status === 'closed' ? sql`COALESCE(r.closed_at, NOW())` : sql`NULL`;

    const updated = rows(await db.execute(sql`
      UPDATE project_risks AS r
         SET title = COALESCE(NULLIF(${title}, ''), r.title),
             description = ${clean(input.description, 4000) || null},
             likelihood = ${likelihood},
             impact = ${impact},
             owner_employee_id = ${owner}::uuid,
             mitigation = ${clean(input.mitigation, 4000) || null},
             status = ${status},
             closed_at = ${closedAt},
             updated_at = NOW()
       WHERE r.id::text = ${riskId}
         AND r.project_id::text = ${projectId}
         AND ${authorityClause}
      RETURNING r.id`));
    if (updated.length === 0) {
      return { ok: false, error: 'That risk is not yours to change. Ask whoever runs the project, or the risk owner.' };
    }

    await logAudit({
      userId, action: 'project.risk.update', entity: 'project', entityId: projectId,
      diff: { riskId, status, likelihood, impact, ownerEmployeeId: owner, viaOwner: !auth.mayEdit },
      ipAddress: input.ipAddress || undefined,
    });
    return { ok: true, id: riskId };
  } catch (e: any) {
    logFail('updateRisk', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// LINKING SPEND — ONE COLUMN, NO SECOND LEDGER
// -------------------------------------------------------------------------------------------------

export type SpendKind = 'expense' | 'purchase';

/**
 * Say which project an EXISTING expense claim or purchase request was for. Pass null to unlink.
 *
 * THIS IS THE ONLY THING THIS MODULE EVER WRITES TO A FINANCE TABLE, and it writes exactly one
 * column. It does not change an amount, a status, an approval or a payment; it cannot create a claim
 * and it cannot approve one. The money keeps moving through src/lib/expenses.ts and
 * src/lib/procurement.ts, routed by the workflow engine from the Organization Graph, exactly as it
 * did before this module existed.
 *
 * Authority is the project's: whoever runs it, or whoever keeps the register. Deliberately NOT the
 * claimant — letting anybody attribute their own spend to any project would make every budget figure
 * a guess.
 */
export async function linkSpendToProject(
  actor: ProjectActor | null | undefined,
  kind: SpendKind,
  recordId: string,
  projectId: string | null,
  opts: { ipAddress?: string | null } = {},
): Promise<WriteResult> {
  const userId = String(actor?.id || '').trim();
  const record = String(recordId || '').trim();
  const project = projectId === null ? null : (String(projectId || '').trim() || null);
  if (!isUuid(userId) || !isUuid(record)) return { ok: false, error: NOT_AVAILABLE };
  if (project && !isUuid(project)) return { ok: false, error: NOT_AVAILABLE };
  if (kind !== 'expense' && kind !== 'purchase') return { ok: false, error: NOT_AVAILABLE };

  // Unlinking is checked against the project the record is currently on; linking against the
  // destination. Either way the check is about a project, never about the claim.
  const target = project;
  if (target) {
    const auth = await projectAuthority(actor, target);
    if (!auth.mayEdit) {
      return {
        ok: false,
        error: auth.graphReady
          ? 'Attaching spend to a project is for whoever runs it, or whoever keeps the project register.'
          : GRAPH_NOT_READY,
      };
    }
  } else if (!holdsCapability(actor, 'projects.manage')) {
    return { ok: false, error: 'Detaching spend from a project is for whoever keeps the project register.' };
  }

  try {
    await ensureProjectSchema();
    const updated = kind === 'expense'
      ? rows(await db.execute(sql`
          UPDATE expense_claims SET project_id = ${project}::uuid
           WHERE id::text = ${record}
          RETURNING id`))
      : rows(await db.execute(sql`
          UPDATE procurement_requests SET project_id = ${project}::uuid
           WHERE id::text = ${record}
          RETURNING id`));

    if (updated.length === 0) return { ok: false, error: 'That record could not be found.' };

    await logAudit({
      userId,
      action: 'project.spend.link',
      entity: kind === 'expense' ? 'expense_claim' : 'procurement_request',
      entityId: record,
      diff: { projectId: project, kind },
      ipAddress: opts.ipAddress || undefined,
    });
    return { ok: true, id: record };
  } catch (e: any) {
    logFail('linkSpendToProject', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** One line of spend already attached to a project, for the budget panel to list. */
export interface LinkedSpend {
  kind: SpendKind;
  id: string;
  title: string;
  amount: number;
  currency: string;
  status: string;
  on: string | null;
}

/**
 * What is currently attached, so a budget figure can be read back to the row it came from.
 *
 * A total nobody can decompose is a number people stop trusting the first time it surprises them.
 * Each source is read in its own try/catch, so one unavailable module costs its own lines and not
 * the panel.
 */
export async function listLinkedSpend(projectId: string): Promise<LinkedSpend[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  const out: LinkedSpend[] = [];

  try {
    await ensureProjectSchema();
  } catch (e: any) {
    logFail('listLinkedSpend ensure', e);
    return out;
  }

  try {
    for (const r of rows(await db.execute(sql`
      SELECT c.id, c.title, c.amount, c.currency, c.status, c.incurred_on
        FROM expense_claims c
       WHERE c.project_id::text = ${id}
         AND c.status IN ('approved', 'reimbursed')
       ORDER BY c.created_at DESC
       LIMIT 100`))) {
      out.push({
        kind: 'expense',
        id: String(r.id),
        title: String(r.title || 'Expense claim'),
        amount: numOf(r.amount),
        currency: String(r.currency || DEFAULT_CURRENCY),
        status: String(r.status || ''),
        on: dateOf(r.incurred_on),
      });
    }
  } catch (e: any) {
    logFail('listLinkedSpend expenses', e);
  }

  try {
    for (const r of rows(await db.execute(sql`
      SELECT o.id, o.po_number, COALESCE(o.amount, req.estimated_cost) AS amount,
             o.currency, o.status, o.order_date, req.item
        FROM procurement_orders o
        JOIN procurement_requests req ON req.id = o.request_id
       WHERE req.project_id::text = ${id}
         AND o.status <> 'cancelled'
       ORDER BY o.created_at DESC
       LIMIT 100`))) {
      out.push({
        kind: 'purchase',
        id: String(r.id),
        title: String(r.item || 'Purchase') + ' (' + String(r.po_number || '') + ')',
        amount: numOf(r.amount),
        currency: String(r.currency || DEFAULT_CURRENCY),
        status: String(r.status || ''),
        on: dateOf(r.order_date),
      });
    }
  } catch (e: any) {
    logFail('listLinkedSpend procurement', e);
  }

  return out;
}

/**
 * The claims and purchase requests this project could attach, so the picker is not a blank field
 * somebody has to paste a uuid into. Approved spend only, and unattached or already on this project.
 */
export async function listAttachableSpend(projectId: string, limit = 50): Promise<LinkedSpend[]> {
  const id = String(projectId || '').trim();
  if (!isUuid(id)) return [];
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const out: LinkedSpend[] = [];

  try {
    await ensureProjectSchema();
  } catch (e: any) {
    logFail('listAttachableSpend ensure', e);
    return out;
  }

  try {
    for (const r of rows(await db.execute(sql`
      SELECT c.id, c.title, c.amount, c.currency, c.status, c.incurred_on
        FROM expense_claims c
       WHERE c.status IN ('approved', 'reimbursed')
         AND c.project_id IS NULL
       ORDER BY c.created_at DESC
       LIMIT ${cap}`))) {
      out.push({
        kind: 'expense',
        id: String(r.id),
        title: String(r.title || 'Expense claim'),
        amount: numOf(r.amount),
        currency: String(r.currency || DEFAULT_CURRENCY),
        status: String(r.status || ''),
        on: dateOf(r.incurred_on),
      });
    }
  } catch (e: any) {
    logFail('listAttachableSpend expenses', e);
  }

  try {
    for (const r of rows(await db.execute(sql`
      SELECT req.id, req.item, req.estimated_cost AS amount, req.currency, req.status, req.needed_by
        FROM procurement_requests req
       WHERE req.project_id IS NULL
         AND req.status = 'submitted'
       ORDER BY req.created_at DESC
       LIMIT ${cap}`))) {
      out.push({
        kind: 'purchase',
        id: String(r.id),
        title: String(r.item || 'Purchase request'),
        amount: numOf(r.amount),
        currency: String(r.currency || DEFAULT_CURRENCY),
        status: String(r.status || ''),
        on: dateOf(r.needed_by),
      });
    }
  } catch (e: any) {
    logFail('listAttachableSpend procurement', e);
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// PICKERS. Small reads a form needs so nobody has to paste a uuid into a text field.
// -------------------------------------------------------------------------------------------------

export interface EmployeeOption {
  employeeId: string;
  fullName: string;
  designation: string | null;
}

/**
 * Active employees, name and designation only.
 *
 * Only two columns, and that is deliberate: the portal's existing SELECT * lookups drag gender,
 * Aadhaar, PAN and bank details into the render context of pages that show none of them. `gender` is
 * the exact column read in the 2026-08-02 breach. A picker needs a name.
 */
export async function employeeOptions(limit = 500): Promise<EmployeeOption[]> {
  try {
    return rows(await db.execute(sql`
      SELECT e.id, e.full_name, e.designation
        FROM hr_employees e
       WHERE e.is_active = true
       ORDER BY e.full_name ASC
       LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 1000)}`)).map((r: any) => ({
      employeeId: String(r.id),
      fullName: String(r.full_name || ''),
      designation: r.designation ?? null,
    }));
  } catch (e: any) {
    logFail('employeeOptions', e);
    return [];
  }
}

export interface DepartmentOption {
  id: string;
  name: string;
}

/** Departments, id as TEXT. Never cast to uuid — the id is a slug in one schema file and a uuid in the other. */
export async function departmentOptions(): Promise<DepartmentOption[]> {
  try {
    return rows(await db.execute(sql`
      SELECT d.id::text AS id, d.name AS name FROM departments d ORDER BY d.name ASC LIMIT 200`))
      .map((r: any) => ({ id: String(r.id), name: String(r.name || '') }));
  } catch (e: any) {
    logFail('departmentOptions', e);
    return [];
  }
}
