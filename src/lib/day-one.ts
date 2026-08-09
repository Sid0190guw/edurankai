// src/lib/day-one.ts — THE THREE STATES OF AN EMPTY PANEL, AND THE ORDER THE PLATFORM IS SET UP IN.
//
// WHY THIS EXISTS. A blank panel on this console can mean three different things and, until now,
// looked the same in all three:
//
//   1. NOT CONFIGURED  — the module has never been set up. There is no holiday calendar, no salary
//                        component, no department. Nothing is wrong; nobody has done it yet.
//   2. CONFIGURED, EMPTY — the register exists and is genuinely empty. An empty "pending leave" list
//                        is the best news on the screen.
//   3. COULD NOT READ  — the query failed. We do not know what is there. Every sentence rendered in
//                        this state is a guess printed in the typography of an answer.
//
// The third one rendered as the second is the pattern that let four months of failed messages sit
// behind the word "none" on this project. src/lib/page-safety.ts already separates 2 from 3
// mechanically (ReadResult.ok). It has no vocabulary for 1, so every "nothing has been set up yet,
// and here is how" sentence in the product was hand-written prose on one page at a time — which is
// why only three screens out of two hundred had one.
//
// This module adds the missing state and, with src/components/admin/DayOne.astro, one shape for
// saying it: what is not there, what does not work until it is, and the link to the screen that
// fixes it.
//
// IT TOUCHES NO DATABASE ON IMPORT and it runs no DDL. Every read here is a COUNT behind safeRows,
// so a missing table degrades to a stated fact rather than a 500 — and a missing table is itself
// evidence of state 1, not of state 3, which is the one inference this module is allowed to make.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { safeRows } from '@/lib/page-safety';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted, and a binding declared under its first reader has taken
// pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Which of the three (plus "there is something here") a panel is in. */
export type DayOneState = 'ready' | 'empty' | 'unconfigured' | 'unreadable';

/**
 * A thing that has to exist before some other screen can work.
 *
 * `blocks` is written as the CONSEQUENCE, not as a warning. "A holiday inside a week off costs
 * somebody a day of their allowance" tells them what goes wrong; "please configure holidays" tells
 * them only that a form is empty, which they can already see.
 */
export interface Prerequisite {
  id: string;
  /** The thing itself, as a noun phrase that can start a sentence. */
  label: string;
  href: string;
  /** The link text. A verb phrase: "Create the first department". */
  action: string;
  /** One sentence: what does not work until this exists. */
  blocks: string;
}

/**
 * THE PREREQUISITES, NAMED ONCE.
 *
 * Screens import from here rather than writing their own sentence, so the same missing thing is
 * described in the same words on the ten screens it blocks, and a change of route is one edit.
 */
export const PREREQUISITE: Record<string, Prerequisite> = {
  departments: {
    id: 'departments',
    label: 'Departments',
    href: '/admin/departments',
    action: 'Create the first department',
    blocks:
      'An employee record, a team, a job role, a project scope and a regional holiday all attach to a department. Until one exists, every one of those forms offers an empty picker.',
  },
  employees: {
    id: 'employees',
    label: 'Employee records',
    href: '/admin/hr/employees',
    action: 'Add the first employee',
    blocks:
      'Payroll, leave, attendance, assets and the organization graph all address a person by their employee record. Nothing in HR can name somebody who has none.',
  },
  orgGraph: {
    id: 'orgGraph',
    label: 'The organization graph',
    href: '/admin/setup#org-graph',
    action: 'See what the organization graph needs',
    blocks:
      'Every approval in this product routes through a relationship on the graph — reporting manager, department head, approval owner, delegate. Until it carries at least one active relationship, a probation confirmation, a transfer, a claim, a loan, a promotion, a purchase and a timesheet all halt with nobody to send them to.',
  },
  payrollComponents: {
    id: 'payrollComponents',
    label: 'Salary components',
    href: '/admin/hr/payroll/components',
    action: 'Configure salary components',
    blocks:
      'A payroll run applies exactly the components configured here and assumes none. Until they exist, a run deducts no provident fund, no state insurance, no professional tax and no withholding — and a run cannot be regenerated once it has been created.',
  },
  holidays: {
    id: 'holidays',
    label: 'The holiday calendar',
    href: '/admin/hr/holidays',
    action: 'Fill in the holiday calendar',
    blocks:
      'Until the calendar is filled in, every day inside a leave request is charged as an ordinary day, so a public holiday that falls inside a week off costs that person a day of their allowance.',
  },
  salaryStructure: {
    id: 'salaryStructure',
    label: 'Recorded pay',
    href: '/admin/hr/payroll?tab=salary',
    action: 'Record pay on Salary Setup',
    blocks:
      'A payroll run refuses to write a payslip for anybody with no base salary and no salary structure. They are left out of the run by name rather than paid a zero that balances.',
  },
  publishedCourse: {
    id: 'publishedCourse',
    label: 'A published course',
    href: '/admin/courses',
    action: 'Publish a course',
    blocks:
      'A knowledge unit attaches to a course that has been bridged into the kernel, and only a published course can be bridged. Until one is published there is nothing to adopt.',
  },
};

/**
 * A missing table is EVIDENCE OF STATE 1, NOT OF STATE 3.
 *
 * Postgres 42P01 (relation does not exist) on a self-bootstrapping module means the module has never
 * been opened, which is exactly "not configured yet". Reporting that as "we could not read it" would
 * be true but useless — it sends somebody to look for an outage that is not there. Every other
 * failure stays state 3, because every other failure genuinely means we do not know.
 */
export function isMissingRelation(error: string | null | undefined): boolean {
  const s = String(error || '');
  return /does not exist/i.test(s) && /relation|table/i.test(s);
}

/**
 * The state of one panel, from one read.
 *
 * `configured` is the caller's own answer to "has this module been set up?" — usually a count of the
 * thing that has to exist first. Pass false and an empty list reads as state 1; omit it and an empty
 * list reads as state 2, which is correct for a register that configures itself.
 */
export function dayOneState(
  read: { ok: boolean; rows: unknown[]; error: string | null },
  configured?: boolean,
): DayOneState {
  if (!read.ok) return isMissingRelation(read.error) ? 'unconfigured' : 'unreadable';
  if (read.rows.length > 0) return 'ready';
  return configured === false ? 'unconfigured' : 'empty';
}

// -------------------------------------------------------------------------------------------------
// THE SETUP ORDER
// -------------------------------------------------------------------------------------------------

/**
 * One step of first-run setup.
 *
 * `order` is the order it has to be done in, and the order is the whole point: an employee record
 * wants a department, payroll wants employees with pay recorded, an approval wants the graph. A
 * console that offers "New Role", "Add Employee" and "Run Payroll" as unordered peers is asking
 * somebody who has never seen the product to guess which of eleven pages they were supposed to open
 * first.
 */
export interface SetupStep extends Prerequisite {
  order: number;
  /** Why this one comes where it does. Written for somebody who has never seen the product. */
  why: string;
  /** What is counted, named the way an operator would say it: "3 departments". */
  unit: string;
  /** True when this step is not required to operate the platform, only to use one module. */
  optional?: boolean;
}

/** The answer to "has this step been done?", with "we could not tell" kept apart from "no". */
export interface SetupStatus {
  step: SetupStep;
  state: 'done' | 'todo' | 'unknown';
  /** Null when the count could not be read. NEVER rendered as 0 in that case. */
  count: number | null;
  error: string | null;
}

/**
 * THE ORDER, and the only place it is written down.
 *
 * The org graph sits at 3 rather than at 1 because it addresses employees: a relationship is between
 * two employee records, so it cannot be recorded before they exist.
 */
export const SETUP_STEPS: SetupStep[] = [
  {
    ...PREREQUISITE.departments,
    order: 1,
    why: 'Everything else in the organization hangs off a department, so this is the first thing that exists.',
    unit: 'department',
  },
  {
    ...PREREQUISITE.employees,
    order: 2,
    why: 'A person has to have a record before anything can be addressed to them — pay, leave, an approval, an asset.',
    unit: 'employee record',
  },
  {
    ...PREREQUISITE.orgGraph,
    order: 3,
    why: 'Approvals do not read a job title or an account role. They read a relationship between two employee records, which is why this comes after both.',
    unit: 'active relationship',
  },
  {
    ...PREREQUISITE.payrollComponents,
    order: 4,
    why: 'A payroll run cannot be regenerated. Configure what it deducts before the first run, not after it.',
    unit: 'component',
  },
  {
    ...PREREQUISITE.holidays,
    order: 5,
    why: 'Leave approvals start working immediately and charge every day in a request. An empty calendar quietly overcharges allowances from the first approval onwards.',
    unit: 'holiday this year',
  },
  {
    ...PREREQUISITE.publishedCourse,
    order: 6,
    why: 'Only needed if you are authoring teaching content. Nothing in HR or finance waits on it.',
    unit: 'published course',
    optional: true,
  },
];

/**
 * Count each step, one read at a time.
 *
 * ONE READ PER STEP, DELIBERATELY. A single statement with six sub-selects is one missing table away
 * from answering nothing at all — which is the exact failure the dashboard's eight-tile statement has
 * and the reason its banner had to be written. Six counts on a page opened at the start of a
 * deployment is a price worth paying for six independent answers.
 *
 * Never throws. A step whose count fails is 'unknown' and says why; it is never silently 'todo'.
 */
export async function readSetupStatus(): Promise<SetupStatus[]> {
  const reads = await Promise.all([
    safeRows('[day-one] department count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM departments`)),
    safeRows('[day-one] employee count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM hr_employees WHERE is_active = true`)),
    safeRows('[day-one] org relationship count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM org_relationships WHERE status = 'active'`)),
    safeRows('[day-one] payroll component count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM payroll_components WHERE is_active = true`)),
    safeRows('[day-one] holiday count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM hr_holidays
        WHERE holiday_date >= date_trunc('year', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
          AND holiday_date <  date_trunc('year', (NOW() AT TIME ZONE 'Asia/Kolkata')::date) + INTERVAL '1 year'`)),
    safeRows('[day-one] published course count', () =>
      db.execute(sql`SELECT COUNT(*)::int AS n FROM training_courses WHERE is_published = true`)),
  ]);

  return SETUP_STEPS.map((step, i) => {
    const read = reads[i];
    if (!read.ok) {
      // A table that does not exist yet is an answer, not an outage: nothing has been configured.
      if (isMissingRelation(read.error)) {
        return { step, state: 'todo' as const, count: 0, error: null };
      }
      return { step, state: 'unknown' as const, count: null, error: read.error };
    }
    const n = Number((read.rows[0] as any)?.n ?? 0) || 0;
    return { step, state: n > 0 ? ('done' as const) : ('todo' as const), count: n, error: null };
  });
}

/** How many steps are not done, for a one-line banner. Steps we could not check are NOT counted. */
export function outstandingSteps(statuses: SetupStatus[]): SetupStatus[] {
  return statuses.filter((s) => s.state === 'todo' && !s.step.optional);
}

/** Steps whose answer is unknown. A banner that omits these is overstating what it knows. */
export function uncheckableSteps(statuses: SetupStatus[]): SetupStatus[] {
  return statuses.filter((s) => s.state === 'unknown');
}
