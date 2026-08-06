// src/lib/benefits.ts — THE BENEFITS CATALOGUE, AND ELECTING ONE.
//
// WHAT THIS IS FOR. An employee should be able to read what the company actually offers them: what
// it is, whether it applies to them, how to claim it, and where the policy document lives. Today
// that knowledge is in somebody's head and in a mail thread, so people either do not claim what they
// are entitled to or ask HR the same five questions every joining week.
//
// -------------------------------------------------------------------------------------------------
// THE CATALOGUE SHIPS EMPTY, AND THAT IS THE POINT.
// -------------------------------------------------------------------------------------------------
// There is NO seed data in this file and there must never be. Writing a plausible-looking insurance
// policy or a learning allowance into a live HR system creates an entitlement the company never
// agreed to, which somebody will read, believe, and act on — and the first anybody hears of it is
// when a person claims against a benefit that does not exist. An empty catalogue with an honest
// sentence saying HR has not configured anything yet is a smaller, truthful failure. /admin/hr/benefits
// is where a real one gets recorded, by the people entitled to decide what the company offers.
//
// -------------------------------------------------------------------------------------------------
// ELIGIBILITY IS DATA, NOT A ROLE TEST AND NOT AN `if` IN A COMPONENT.
// -------------------------------------------------------------------------------------------------
// Every benefit carries zero or more RULES in hr_benefit_rules, and evaluateEligibility() below is
// the only thing that reads them. A component asking `emp.employment_type === 'Full-Time'` would be a
// second, invisible policy that nobody can change without a deploy, and the two would disagree within
// a release — so no page in this product may make that test itself.
//
//   ACROSS rule types the test is AND. WITHIN one rule type it is OR.
//
// So "Full-Time or Part-Time, in Engineering, after 90 days" is four rows, and it reads the way a
// person would say it out loud. NO RULES AT ALL MEANS EVERYONE — an empty rule set is "open to
// everyone", never "nobody qualifies", because a benefit somebody bothered to record is offered until
// it is narrowed.
//
// A person is told WHY they do not qualify yet ("you have been here 12 days; this needs 90"), because
// "not eligible" with no reason is how a real entitlement gets quietly lost.
//
// -------------------------------------------------------------------------------------------------
// ELECTING ONE IS AN APPROVAL, AND THIS FILE DOES NOT DECIDE IT.
// -------------------------------------------------------------------------------------------------
// Some benefits have to be chosen — a cover level, an allowance a person opts into. That is a request
// somebody has to say yes to, so it goes to src/lib/workflow.ts in the `benefits` domain and NOWHERE
// ELSE. There is no branch in this file that marks an enrolment active because a rule passed. If the
// Organization Graph names nobody, the enrolment HALTS carrying the engine's own sentence; it is
// never auto-approved, and hr_benefit_enrolments has no path that writes 'active' except mirroring a
// decision the engine already made.
//
// -------------------------------------------------------------------------------------------------
// HOUSE RULES OBSERVED HERE
// -------------------------------------------------------------------------------------------------
//   - postgres-js returns PLAIN ARRAYS. rowsOf() normalises; nothing reads r.rows[0].
//   - The real Postgres reason is on e.cause. logFail prints e?.cause?.message || e?.message.
//   - DDL lives in ONE ensureOnce guard that logs the cause and RE-THROWS, so a failed run retries.
//   - No write path swallows an exception: a failure returns a sentence, never a silent success.
//   - departments.id is compared as ::text, never cast ::uuid — it is a slug in one schema file and a
//     UUID in the other, and a cast throws on half the values in this product.
//   - hr_employees uses full_name.
//   - The policy document is a GOOGLE DRIVE LINK. Nothing is uploaded here, ever; the link format is
//     validated by src/lib/hr-onboarding.ts, which already owns that rule, rather than re-implemented.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { startWorkflow, getInstance } from '@/lib/workflow';
import { isDriveLink, linkProblem } from '@/lib/hr-onboarding';

// Declared BEFORE anything that uses them. `const` is not hoisted, and a declaration below its first
// use throws on the first line of a handler while the page still reports success.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function logFail(where: string, e: any): void {
  console.error('[benefits] ' + where + ':', reasonOf(e));
}

/** What a person is shown when a write fails. The database's own words go to the log, not to them. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * How a benefit is filed. A grouping for the catalogue and nothing more — it confers no eligibility,
 * no entitlement and no amount. 'other' exists so HR is never blocked from recording something real
 * because this list did not anticipate it.
 */
export const BENEFIT_CATEGORIES = [
  { key: 'insurance', label: 'Insurance and cover' },
  { key: 'leave', label: 'Leave beyond the statutory minimum' },
  { key: 'learning', label: 'Learning and development' },
  { key: 'equipment', label: 'Equipment and workspace' },
  { key: 'wellbeing', label: 'Health and wellbeing' },
  { key: 'financial', label: 'Financial and retirement' },
  { key: 'family', label: 'Family and care' },
  { key: 'other', label: 'Other' },
] as const;

export type BenefitCategory = (typeof BENEFIT_CATEGORIES)[number]['key'];

const CATEGORY_KEYS = new Set<string>(BENEFIT_CATEGORIES.map((c) => c.key));

export function benefitCategoryLabel(key: string): string {
  const found = BENEFIT_CATEGORIES.find((c) => c.key === key);
  return found ? found.label : 'Other';
}

/**
 * THE ELIGIBILITY VOCABULARY. Four rule types, and each one is a fact already recorded on the
 * employee's own HR row — so evaluating a rule is a comparison, never a lookup somebody has to keep
 * in sync.
 *
 * WHY THERE IS NO 'role' RULE TYPE, and why there must never be one. users.role answers "what may
 * this account do in the admin console", not "what is this person engaged as". An employee's account
 * very often carries the `applicant` role, which holds nothing at all — so a role-based eligibility
 * rule would silently withhold a real entitlement from most of the workforce. Employment type, work
 * mode, department and tenure are the facts HR actually records about an engagement, and they are the
 * facts a benefits policy is actually written against.
 */
export const RULE_TYPES = [
  {
    key: 'employment_type',
    label: 'Employment type',
    hint: 'Full-Time, Part-Time, Contract, Internship and so on, exactly as it is written on the employee record. Matched without regard to case or spacing.',
  },
  {
    key: 'work_mode',
    label: 'Work mode',
    hint: 'Remote, Hybrid or On-Site. Use this for anything tied to where somebody actually works.',
  },
  {
    key: 'department',
    label: 'Department',
    hint: 'The department id on the employee record. Add one row per department that qualifies.',
  },
  {
    key: 'min_tenure_days',
    label: 'Minimum tenure (days since joining)',
    hint: 'A whole number of days. Somebody with no joining date recorded cannot satisfy this, and is told so rather than quietly refused.',
  },
] as const;

export type RuleType = (typeof RULE_TYPES)[number]['key'];

const RULE_TYPE_KEYS = new Set<string>(RULE_TYPES.map((r) => r.key));

export function ruleTypeLabel(key: string): string {
  const found = RULE_TYPES.find((r) => r.key === key);
  return found ? found.label : String(key || 'Rule');
}

/** The states an election can be in. Each is something a person can be told in one sentence. */
export const ENROLMENT_STATES = ['pending', 'halted', 'active', 'rejected', 'cancelled', 'ended'] as const;
export type EnrolmentState = (typeof ENROLMENT_STATES)[number];

export const ENROLMENT_STATE_LABELS: Record<EnrolmentState, string> = {
  pending: 'Waiting for approval',
  halted: 'Halted - nobody could be asked',
  active: 'Enrolled',
  rejected: 'Not approved',
  cancelled: 'Withdrawn',
  ended: 'Ended',
};

export function enrolmentStateLabel(state: string): string {
  const k = String(state || '') as EnrolmentState;
  return ENROLMENT_STATE_LABELS[k] || 'Unknown';
}

/** The states in which an election is still live, so a second one for the same benefit is refused. */
const OPEN_ENROLMENT_STATES: EnrolmentState[] = ['pending', 'halted', 'active'];

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------
//
// THREE TABLES. Before adding anything here, grep for the table name across the repo: two
// CREATE TABLE statements for one table with different shapes silently break every write for
// whichever module lost the race, and that fault has already cost this codebase four months of
// unsent messages. These three names appear nowhere else.
//
//   hr_benefits            what the company offers: the words an employee reads, and the Drive link
//                          to the policy document. No amounts are held here on purpose — a benefit is
//                          a description and a claim route, and putting a number on it would make
//                          this table a second, unaudited pay record.
//   hr_benefit_rules       ELIGIBILITY AS ROWS. One row per condition. Deleting every row for a
//                          benefit makes it open to everyone, which is the honest reading of "nobody
//                          has narrowed this".
//   hr_benefit_enrolments  one election per person per benefit, carrying the workflow instance that
//                          decides it. There is no approved_by column here: who approved it lives in
//                          the workflow engine, and copying it would create a second answer.

export function ensureBenefitsSchema(): Promise<void> {
  return ensureOnce('hr_benefits_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_benefits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        category VARCHAR(32) NOT NULL DEFAULT 'other',
        summary TEXT NOT NULL DEFAULT '',
        details TEXT,
        provider TEXT,
        policy_drive_url TEXT,
        claim_how TEXT NOT NULL DEFAULT '',
        claim_contact TEXT,
        enrolment_required BOOLEAN NOT NULL DEFAULT FALSE,
        enrolment_options TEXT,
        enrolment_note TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 100,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_benefits_active_idx
        ON hr_benefits(is_active, sort_order, name)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_benefit_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        benefit_id UUID NOT NULL REFERENCES hr_benefits(id) ON DELETE CASCADE,
        rule_type VARCHAR(32) NOT NULL,
        rule_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // One condition recorded once. Adding the same rule twice would double it in the explanation an
      // employee reads without changing the answer, which reads as a bug in the policy itself.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_benefit_rules_uniq
        ON hr_benefit_rules(benefit_id, rule_type, rule_value)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_benefit_rules_benefit_idx
        ON hr_benefit_rules(benefit_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_benefit_enrolments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        benefit_id UUID NOT NULL REFERENCES hr_benefits(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        option_chosen TEXT,
        reason TEXT,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        decided_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // ONE LIVE ELECTION PER PERSON PER BENEFIT, enforced by the database and not only by this file.
      // A double-submitted form therefore cannot produce two approvals for one thing. Settled rows are
      // outside the index, so somebody whose election was rejected can ask again next window.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_benefit_enrolments_open_uniq
        ON hr_benefit_enrolments(employee_id, benefit_id)
        WHERE state IN ('pending', 'halted', 'active')`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_benefit_enrolments_emp_idx
        ON hr_benefit_enrolments(employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_benefit_enrolments_state_idx
        ON hr_benefit_enrolments(state, created_at DESC)`);
    } catch (e: any) {
      logFail('ensureBenefitsSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries instead of staying broken.
    }
  });
}

/** Provision, but never throw into a reader — a read that cannot run returns an empty list. */
async function safeEnsure(): Promise<boolean> {
  try {
    await ensureBenefitsSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface BenefitRule {
  id: string;
  benefitId: string;
  ruleType: string;
  ruleValue: string;
}

export interface Benefit {
  id: string;
  name: string;
  category: string;
  summary: string;
  details: string | null;
  provider: string | null;
  policyDriveUrl: string | null;
  claimHow: string;
  claimContact: string | null;
  enrolmentRequired: boolean;
  /** The choices an employee picks between, one per line. Empty when the election is a plain yes. */
  enrolmentOptions: string[];
  enrolmentNote: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string | null;
  rules: BenefitRule[];
}

/** The facts eligibility is evaluated against. Read from hr_employees, never from users.role. */
export interface EligibilitySubject {
  employeeId: string;
  fullName: string | null;
  employmentType: string | null;
  workMode: string | null;
  departmentId: string | null;
  departmentName: string | null;
  joiningDate: string | null;
  tenureDays: number | null;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** True when the benefit carries no rules — offered to everybody. Rendered differently. */
  openToEveryone: boolean;
  /** Conditions this person satisfies, in words. */
  met: string[];
  /** Conditions this person does not satisfy yet, in words, each saying what is missing. */
  unmet: string[];
}

export interface Enrolment {
  id: string;
  benefitId: string;
  benefitName: string | null;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  optionChosen: string | null;
  reason: string | null;
  state: EnrolmentState;
  haltReason: string | null;
  workflowInstanceId: string | null;
  createdAt: string | null;
  decidedAt: string | null;
}

export interface BenefitResult {
  ok: boolean;
  id?: string;
  changed?: boolean;
  error?: string;
  haltReason?: string | null;
}

function mapRule(r: any): BenefitRule {
  return {
    id: String(r?.id ?? ''),
    benefitId: String(r?.benefit_id ?? ''),
    ruleType: String(r?.rule_type ?? ''),
    ruleValue: String(r?.rule_value ?? ''),
  };
}

function splitOptions(raw: any): string[] {
  return String(raw || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 20);
}

function mapBenefit(r: any, rules: BenefitRule[]): Benefit {
  return {
    id: String(r?.id ?? ''),
    name: String(r?.name ?? ''),
    category: CATEGORY_KEYS.has(String(r?.category)) ? String(r.category) : 'other',
    summary: String(r?.summary ?? ''),
    details: r?.details ? String(r.details) : null,
    provider: r?.provider ? String(r.provider) : null,
    policyDriveUrl: r?.policy_drive_url ? String(r.policy_drive_url) : null,
    claimHow: String(r?.claim_how ?? ''),
    claimContact: r?.claim_contact ? String(r.claim_contact) : null,
    enrolmentRequired: r?.enrolment_required === true,
    enrolmentOptions: splitOptions(r?.enrolment_options),
    enrolmentNote: r?.enrolment_note ? String(r.enrolment_note) : null,
    isActive: r?.is_active !== false,
    sortOrder: Number(r?.sort_order) || 100,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    rules,
  };
}

function mapEnrolment(r: any): Enrolment {
  const state = String(r?.state ?? 'pending');
  return {
    id: String(r?.id ?? ''),
    benefitId: String(r?.benefit_id ?? ''),
    benefitName: r?.benefit_name ? String(r.benefit_name) : null,
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    employeeCode: r?.employee_code ? String(r.employee_code) : null,
    optionChosen: r?.option_chosen ? String(r.option_chosen) : null,
    reason: r?.reason ? String(r.reason) : null,
    state: (ENROLMENT_STATES as readonly string[]).indexOf(state) >= 0 ? (state as EnrolmentState) : 'pending',
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    decidedAt: r?.decided_at ? new Date(r.decided_at).toISOString() : null,
  };
}

// -------------------------------------------------------------------------------------------------
// ELIGIBILITY — the only implementation, and it takes DATA
// -------------------------------------------------------------------------------------------------

/** Loose comparison for values a human typed into a free-text HR field. */
function looseEq(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

/** Whole days between a joining date and a moment. Null when no joining date is recorded. */
export function tenureDaysFrom(joiningDate: any, asOf: Date = new Date()): number | null {
  if (!joiningDate) return null;
  const d = joiningDate instanceof Date ? joiningDate : new Date(String(joiningDate));
  if (isNaN(d.getTime())) return null;
  const ms = asOf.getTime() - d.getTime();
  return Math.floor(ms / 86400000);
}

/**
 * DOES THIS PERSON QUALIFY, AND WHY OR WHY NOT.
 *
 * The ONLY place this question is answered in the product. It is a pure function of two pieces of
 * data — the benefit's rules and the employee's own HR facts — so it can be unit-reasoned, reused by
 * both the employee page and the HR console, and changed in one place when a policy changes.
 *
 * AND across rule types, OR within one. No rules means everyone. Every branch produces a SENTENCE, so
 * a person is never told "not eligible" with nothing to act on.
 */
export function evaluateEligibility(
  rules: BenefitRule[],
  subject: EligibilitySubject | null,
): EligibilityVerdict {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) {
    return { eligible: true, openToEveryone: true, met: ['Open to everyone.'], unmet: [] };
  }
  if (!subject) {
    return {
      eligible: false,
      openToEveryone: false,
      met: [],
      unmet: ['This account is not linked to an employee record, so eligibility cannot be worked out.'],
    };
  }

  const met: string[] = [];
  const unmet: string[] = [];
  const byType = new Map<string, BenefitRule[]>();
  for (const r of list) {
    const arr = byType.get(r.ruleType) || [];
    arr.push(r);
    byType.set(r.ruleType, arr);
  }

  const employmentRules = byType.get('employment_type') || [];
  if (employmentRules.length) {
    const wanted = employmentRules.map((r) => r.ruleValue);
    const ok = wanted.some((w) => looseEq(w, subject.employmentType));
    const asList = wanted.join(', ');
    if (ok) met.push('Employment type: ' + String(subject.employmentType || '') + '.');
    else if (!subject.employmentType) {
      unmet.push('No employment type is recorded on your employee record. This benefit is for ' + asList + '.');
    } else {
      unmet.push('This benefit is for ' + asList + '. Yours is recorded as ' + subject.employmentType + '.');
    }
  }

  const modeRules = byType.get('work_mode') || [];
  if (modeRules.length) {
    const wanted = modeRules.map((r) => r.ruleValue);
    const ok = wanted.some((w) => looseEq(w, subject.workMode));
    const asList = wanted.join(', ');
    if (ok) met.push('Work mode: ' + String(subject.workMode || '') + '.');
    else if (!subject.workMode) {
      unmet.push('No work mode is recorded on your employee record. This benefit is for ' + asList + '.');
    } else {
      unmet.push('This benefit is for people working ' + asList + '. Yours is recorded as ' + subject.workMode + '.');
    }
  }

  const deptRules = byType.get('department') || [];
  if (deptRules.length) {
    // ::text on both sides, always. departments.id is a varchar slug in one schema file and a UUID in
    // the other, so these are compared as the strings they are and never cast.
    const wanted = deptRules.map((r) => r.ruleValue);
    const ok = wanted.some((w) => looseEq(w, subject.departmentId));
    if (ok) met.push('Department: ' + String(subject.departmentName || subject.departmentId || '') + '.');
    else if (!subject.departmentId) {
      unmet.push('No department is recorded on your employee record, and this benefit is limited to particular departments.');
    } else {
      unmet.push('This benefit is limited to particular departments, and yours is not one of them.');
    }
  }

  const tenureRules = byType.get('min_tenure_days') || [];
  if (tenureRules.length) {
    // OR within a type means the EASIEST of several thresholds wins. Two minimum-tenure rows on one
    // benefit is a policy nobody meant to write, so the smallest is used and the behaviour is stated
    // here rather than left to whichever row the database happened to return first.
    const thresholds = tenureRules
      .map((r) => Number(r.ruleValue))
      .filter((n) => isFinite(n) && n >= 0);
    const need = thresholds.length ? Math.min(...thresholds) : 0;
    const have = subject.tenureDays;
    if (have === null) {
      unmet.push('No joining date is recorded on your employee record, so your service cannot be worked out. This benefit needs ' + need + ' days.');
    } else if (have >= need) {
      met.push('Service: ' + have + ' day' + (have === 1 ? '' : 's') + ' (needs ' + need + ').');
    } else {
      unmet.push('You have been here ' + have + ' day' + (have === 1 ? '' : 's') + '; this needs ' + need + '.');
    }
  }

  // A rule type this build does not recognise is NOT ignored. Silently dropping it would widen a
  // benefit past what HR wrote down, which is the one direction this must never fail in.
  for (const [type, group] of byType) {
    if (RULE_TYPE_KEYS.has(type)) continue;
    unmet.push('This benefit carries a condition this page does not know how to check ('
      + type + '). Ask HR before relying on it.');
    if (group.length === 0) break;
  }

  return { eligible: unmet.length === 0, openToEveryone: false, met, unmet };
}

/** Read the facts eligibility is evaluated against. Null when the id names nobody. */
export async function eligibilitySubject(employeeId: string, asOf: Date = new Date()): Promise<EligibilitySubject | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, e.employment_type, e.work_mode,
             e.department_id::text AS department_id, e.joining_date,
             d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.id = ${employeeId}::uuid
       LIMIT 1`));
    if (!list.length) return null;
    const r = list[0] as any;
    return {
      employeeId: String(r.id),
      fullName: r.full_name ? String(r.full_name) : null,
      employmentType: r.employment_type ? String(r.employment_type) : null,
      workMode: r.work_mode ? String(r.work_mode) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      departmentName: r.department_name ? String(r.department_name) : null,
      joiningDate: r.joining_date ? new Date(r.joining_date).toISOString().slice(0, 10) : null,
      tenureDays: tenureDaysFrom(r.joining_date, asOf),
    };
  } catch (e: any) {
    logFail('eligibilitySubject', e);
    return null;
  }
}

/** The conditions on a benefit, written out for anybody reading the catalogue. */
export function describeRules(rules: BenefitRule[]): string[] {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return ['Open to everyone.'];
  const out: string[] = [];
  const byType = new Map<string, string[]>();
  for (const r of list) {
    const arr = byType.get(r.ruleType) || [];
    arr.push(r.ruleValue);
    byType.set(r.ruleType, arr);
  }
  const employment = byType.get('employment_type');
  if (employment) out.push('Employment type: ' + employment.join(' or ') + '.');
  const mode = byType.get('work_mode');
  if (mode) out.push('Work mode: ' + mode.join(' or ') + '.');
  const dept = byType.get('department');
  if (dept) out.push('Limited to ' + dept.length + ' department' + (dept.length === 1 ? '' : 's') + '.');
  const tenure = byType.get('min_tenure_days');
  if (tenure) {
    const nums = tenure.map((v) => Number(v)).filter((n) => isFinite(n) && n >= 0);
    if (nums.length) out.push('After ' + Math.min(...nums) + ' days of service.');
  }
  for (const [type] of byType) {
    if (!RULE_TYPE_KEYS.has(type)) out.push('An additional condition recorded as ' + type + '.');
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

async function rulesByBenefit(benefitIds: string[]): Promise<Map<string, BenefitRule[]>> {
  const out = new Map<string, BenefitRule[]>();
  const ids = benefitIds.filter(isUuid);
  if (ids.length === 0) return out;
  try {
    // ONE STATEMENT, NOT ONE PER BENEFIT. A per-benefit query here would be an N+1 on a page that
    // renders on a phone. The id list is passed as JSON and unpacked inside Postgres — interpolating
    // a JS array into a drizzle template and casting it does NOT work with postgres-js.
    const list = rowsOf(await db.execute(sql`
      SELECT r.* FROM hr_benefit_rules r
       WHERE r.benefit_id IN (
         SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)
       )
       ORDER BY r.rule_type ASC, r.rule_value ASC`));
    for (const raw of list) {
      const rule = mapRule(raw);
      const arr = out.get(rule.benefitId) || [];
      arr.push(rule);
      out.set(rule.benefitId, arr);
    }
  } catch (e: any) {
    logFail('rulesByBenefit', e);
  }
  return out;
}

/** The catalogue. Active only unless asked otherwise. Empty list on any failure, never a throw. */
export async function listBenefits(opts: { includeInactive?: boolean } = {}): Promise<Benefit[]> {
  if (!(await safeEnsure())) return [];
  try {
    const activeClause = opts.includeInactive ? sql`` : sql` WHERE is_active = true`;
    const list = rowsOf(await db.execute(sql`
      SELECT * FROM hr_benefits${activeClause}
       ORDER BY is_active DESC, sort_order ASC, name ASC
       LIMIT 300`));
    const rules = await rulesByBenefit(list.map((r: any) => String(r.id)));
    return list.map((r: any) => mapBenefit(r, rules.get(String(r.id)) || []));
  } catch (e: any) {
    logFail('listBenefits', e);
    return [];
  }
}

export async function getBenefit(id: string): Promise<Benefit | null> {
  if (!isUuid(id)) return null;
  if (!(await safeEnsure())) return null;
  try {
    const list = rowsOf(await db.execute(sql`SELECT * FROM hr_benefits WHERE id = ${id}::uuid LIMIT 1`));
    if (!list.length) return null;
    const rules = await rulesByBenefit([id]);
    return mapBenefit(list[0], rules.get(id) || []);
  } catch (e: any) {
    logFail('getBenefit', e);
    return null;
  }
}

/** One benefit as one person sees it: the words, whether they qualify, and where their election got to. */
export interface CatalogueEntry {
  benefit: Benefit;
  eligibility: EligibilityVerdict;
  enrolment: Enrolment | null;
}

/**
 * THE EMPLOYEE'S CATALOGUE. Every active benefit, each evaluated against this person's own record.
 *
 * Ineligible benefits are RETURNED, not filtered out, and the page shows them greyed with the reason.
 * Hiding them would mean somebody who is three weeks short of qualifying never learns the benefit
 * exists, and never asks.
 */
export async function catalogueFor(employeeId: string | null): Promise<{
  entries: CatalogueEntry[];
  subject: EligibilitySubject | null;
}> {
  const benefits = await listBenefits();
  const subject = employeeId ? await eligibilitySubject(employeeId) : null;
  const mine = employeeId ? await enrolmentsForEmployee(employeeId) : [];
  const latest = new Map<string, Enrolment>();
  for (const e of mine) if (!latest.has(e.benefitId)) latest.set(e.benefitId, e);
  return {
    subject,
    entries: benefits.map((b) => ({
      benefit: b,
      eligibility: evaluateEligibility(b.rules, subject),
      enrolment: latest.get(b.id) || null,
    })),
  };
}

/** This person's elections, newest first. Narrowed by employee_id in the WHERE clause. */
export async function enrolmentsForEmployee(employeeId: string): Promise<Enrolment[]> {
  if (!isUuid(employeeId)) return [];
  if (!(await safeEnsure())) return [];
  try {
    return rowsOf(await db.execute(sql`
      SELECT en.*, b.name AS benefit_name
        FROM hr_benefit_enrolments en
        JOIN hr_benefits b ON b.id = en.benefit_id
       WHERE en.employee_id = ${employeeId}::uuid
       ORDER BY en.created_at DESC
       LIMIT 200`)).map(mapEnrolment);
  } catch (e: any) {
    logFail('enrolmentsForEmployee', e);
    return [];
  }
}

/** The HR queue. Optionally narrowed to one set of states. */
export async function listEnrolments(opts: { states?: EnrolmentState[]; limit?: number } = {}): Promise<Enrolment[]> {
  if (!(await safeEnsure())) return [];
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 250));
  try {
    const wanted = (opts.states || []).filter((s) => (ENROLMENT_STATES as readonly string[]).indexOf(s) >= 0);
    const stateClause = wanted.length
      ? sql` WHERE en.state IN (${sql.join(wanted.map((s) => sql`${s}`), sql`, `)})`
      : sql``;
    return rowsOf(await db.execute(sql`
      SELECT en.*, b.name AS benefit_name, e.full_name AS employee_name, e.employee_code
        FROM hr_benefit_enrolments en
        JOIN hr_benefits b ON b.id = en.benefit_id
        JOIN hr_employees e ON e.id = en.employee_id${stateClause}
       ORDER BY en.created_at DESC
       LIMIT ${limit}`)).map(mapEnrolment);
  } catch (e: any) {
    logFail('listEnrolments', e);
    return [];
  }
}

/**
 * How many people currently hold each benefit. AGGREGATE ONLY — a count per benefit, never a row per
 * person, which is what an HR overview actually needs to see.
 */
export async function enrolmentCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!(await safeEnsure())) return out;
  try {
    const list = rowsOf(await db.execute(sql`
      SELECT benefit_id, COUNT(*)::int AS c
        FROM hr_benefit_enrolments
       WHERE state = 'active'
       GROUP BY benefit_id`));
    for (const r of list) out[String((r as any).benefit_id)] = Number((r as any).c) || 0;
  } catch (e: any) {
    logFail('enrolmentCounts', e);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// WRITES — the catalogue
// -------------------------------------------------------------------------------------------------

export interface BenefitInput {
  name: string;
  category: string;
  summary: string;
  details?: string | null;
  provider?: string | null;
  policyDriveUrl?: string | null;
  claimHow: string;
  claimContact?: string | null;
  enrolmentRequired?: boolean;
  enrolmentOptions?: string | null;
  enrolmentNote?: string | null;
  sortOrder?: number | null;
  actorUserId: string | null;
}

/** Shared validation, so the create and the edit path cannot drift apart. */
function validateBenefit(input: BenefitInput): { ok: true } | { ok: false; error: string } {
  const name = String(input?.name || '').trim();
  if (name.length < 2) return { ok: false, error: 'Give the benefit a name an employee would recognise.' };
  if (name.length > 200) return { ok: false, error: 'That name is too long — keep it under 200 characters.' };
  if (String(input?.summary || '').trim().length < 5) {
    return { ok: false, error: 'Write one line saying what this benefit actually is. An employee reads this first.' };
  }
  if (String(input?.claimHow || '').trim().length < 5) {
    return { ok: false, error: 'Say how somebody claims this. A benefit nobody knows how to claim is a benefit nobody claims.' };
  }
  const url = String(input?.policyDriveUrl || '').trim();
  if (url) {
    // Documents of any kind are Google Drive links here, never uploads. hr-onboarding.ts owns that
    // rule and its wording; this re-uses it rather than writing a second, slightly different one.
    const problem = linkProblem(url);
    if (problem) return { ok: false, error: 'Policy document: ' + problem };
    if (!isDriveLink(url)) return { ok: false, error: 'Share the policy document from Google Drive.' };
  }
  return { ok: true };
}

export async function createBenefit(input: BenefitInput): Promise<BenefitResult> {
  const check = validateBenefit(input);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    await ensureBenefitsSchema();
    const category = CATEGORY_KEYS.has(String(input.category)) ? String(input.category) : 'other';
    const actor = isUuid(input.actorUserId) ? String(input.actorUserId) : null;
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_benefits
        (name, category, summary, details, provider, policy_drive_url, claim_how, claim_contact,
         enrolment_required, enrolment_options, enrolment_note, sort_order, created_by_user_id)
      VALUES
        (${String(input.name).trim().slice(0, 200)}, ${category},
         ${String(input.summary).trim().slice(0, 500)},
         ${String(input.details || '').trim().slice(0, 4000) || null},
         ${String(input.provider || '').trim().slice(0, 200) || null},
         ${String(input.policyDriveUrl || '').trim() || null},
         ${String(input.claimHow).trim().slice(0, 2000)},
         ${String(input.claimContact || '').trim().slice(0, 200) || null},
         ${input.enrolmentRequired === true},
         ${String(input.enrolmentOptions || '').trim().slice(0, 2000) || null},
         ${String(input.enrolmentNote || '').trim().slice(0, 1000) || null},
         ${Number(input.sortOrder) || 100}, ${actor}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);
    await logAudit({
      userId: actor,
      action: 'benefit.created',
      entity: 'hr_benefit',
      entityId: id,
      diff: { name: String(input.name).trim().slice(0, 200), category, enrolmentRequired: input.enrolmentRequired === true },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    // NEVER SWALLOWED. The caller gets a sentence carrying the real reason, not a silent success.
    logFail('createBenefit', e);
    return { ok: false, error: 'The benefit was not saved: ' + reasonOf(e) };
  }
}

export async function updateBenefit(id: string, input: BenefitInput): Promise<BenefitResult> {
  if (!isUuid(id)) return { ok: false, error: 'That benefit could not be identified.' };
  const check = validateBenefit(input);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    await ensureBenefitsSchema();
    const category = CATEGORY_KEYS.has(String(input.category)) ? String(input.category) : 'other';
    const actor = isUuid(input.actorUserId) ? String(input.actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_benefits SET
        name = ${String(input.name).trim().slice(0, 200)},
        category = ${category},
        summary = ${String(input.summary).trim().slice(0, 500)},
        details = ${String(input.details || '').trim().slice(0, 4000) || null},
        provider = ${String(input.provider || '').trim().slice(0, 200) || null},
        policy_drive_url = ${String(input.policyDriveUrl || '').trim() || null},
        claim_how = ${String(input.claimHow).trim().slice(0, 2000)},
        claim_contact = ${String(input.claimContact || '').trim().slice(0, 200) || null},
        enrolment_required = ${input.enrolmentRequired === true},
        enrolment_options = ${String(input.enrolmentOptions || '').trim().slice(0, 2000) || null},
        enrolment_note = ${String(input.enrolmentNote || '').trim().slice(0, 1000) || null},
        sort_order = ${Number(input.sortOrder) || 100},
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id`));
    if (!upd.length) return { ok: false, error: 'That benefit could not be found.' };
    await logAudit({
      userId: actor, action: 'benefit.updated', entity: 'hr_benefit', entityId: id,
      diff: { name: String(input.name).trim().slice(0, 200), category },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('updateBenefit', e);
    return { ok: false, error: 'The change was not saved: ' + reasonOf(e) };
  }
}

/**
 * Retire or restore a benefit. NOT a delete: people are enrolled in it and those rows are the record
 * of what the company offered them. Retiring takes it off the catalogue and leaves the history intact.
 */
export async function setBenefitActive(id: string, active: boolean, actorUserId: string | null): Promise<BenefitResult> {
  if (!isUuid(id)) return { ok: false, error: 'That benefit could not be identified.' };
  try {
    await ensureBenefitsSchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_benefits SET is_active = ${active === true}, updated_at = NOW()
       WHERE id = ${id}::uuid RETURNING id, name`));
    if (!upd.length) return { ok: false, error: 'That benefit could not be found.' };
    await logAudit({
      userId: actor, action: active ? 'benefit.restored' : 'benefit.retired',
      entity: 'hr_benefit', entityId: id, diff: { name: String(upd[0].name || '') },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('setBenefitActive', e);
    return { ok: false, error: 'That was not changed: ' + reasonOf(e) };
  }
}

/** Add one eligibility condition. Adding the same one twice is a no-op, not an error. */
export async function addRule(
  benefitId: string,
  ruleType: string,
  ruleValue: string,
  actorUserId: string | null,
): Promise<BenefitResult> {
  if (!isUuid(benefitId)) return { ok: false, error: 'That benefit could not be identified.' };
  const type = String(ruleType || '').trim();
  if (!RULE_TYPE_KEYS.has(type)) return { ok: false, error: 'That is not a condition this product can check.' };
  const value = String(ruleValue || '').trim();
  if (!value) return { ok: false, error: 'Give the condition a value.' };
  if (type === 'min_tenure_days') {
    const n = Number(value);
    if (!isFinite(n) || n < 0 || n > 36500 || Math.floor(n) !== n) {
      return { ok: false, error: 'Minimum tenure must be a whole number of days between 0 and 36500.' };
    }
  }
  try {
    await ensureBenefitsSchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_benefit_rules (benefit_id, rule_type, rule_value)
      VALUES (${benefitId}::uuid, ${type}, ${value.slice(0, 200)})
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!ins.length) return { ok: true, changed: false };
    await logAudit({
      userId: actor, action: 'benefit.rule_added', entity: 'hr_benefit', entityId: benefitId,
      diff: { ruleType: type, ruleValue: value.slice(0, 200) },
    });
    return { ok: true, id: String(ins[0].id), changed: true };
  } catch (e: any) {
    logFail('addRule', e);
    return { ok: false, error: 'The condition was not saved: ' + reasonOf(e) };
  }
}

/** Remove one condition. Removing the last one makes the benefit open to everyone, by design. */
export async function removeRule(ruleId: string, actorUserId: string | null): Promise<BenefitResult> {
  if (!isUuid(ruleId)) return { ok: false, error: 'That condition could not be identified.' };
  try {
    await ensureBenefitsSchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const del = rowsOf(await db.execute(sql`
      DELETE FROM hr_benefit_rules WHERE id = ${ruleId}::uuid
      RETURNING benefit_id, rule_type, rule_value`));
    if (!del.length) return { ok: false, error: 'That condition could not be found.' };
    await logAudit({
      userId: actor, action: 'benefit.rule_removed', entity: 'hr_benefit',
      entityId: String(del[0].benefit_id),
      diff: { ruleType: String(del[0].rule_type), ruleValue: String(del[0].rule_value) },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('removeRule', e);
    return { ok: false, error: 'The condition was not removed: ' + reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES — electing a benefit
// -------------------------------------------------------------------------------------------------

export interface EnrolInput {
  benefitId: string;
  employeeId: string;
  option?: string | null;
  reason?: string | null;
  requestedByUserId: string | null;
}

/**
 * ELECT A BENEFIT — a REQUEST, and nothing more.
 *
 * Reading this function, the thing to notice is what is absent: there is no branch that sets the
 * enrolment to 'active'. Eligibility passing does not enrol anybody, and neither does the person
 * pressing the button. The election goes to src/lib/workflow.ts in the `benefits` domain, which
 * resolves the approver from the Organization Graph per row.
 *
 * IF NOBODY RESOLVES, THE ELECTION HALTS carrying the engine's own sentence, and stays visible on the
 * HR queue until the missing relationship is recorded. It is never approved because routing failed —
 * that is the outcome the approval engine exists to make impossible.
 *
 * ELIGIBILITY IS RE-EVALUATED HERE, ON THE SERVER, against the rules as they stand at this moment.
 * The employee page also evaluates it, to decide what to offer; that is a courtesy to the reader and
 * is not the check. A page can be stale or edited.
 */
export async function requestEnrolment(input: EnrolInput): Promise<BenefitResult> {
  const benefitId = String(input?.benefitId || '').trim();
  const employeeId = String(input?.employeeId || '').trim();
  if (!isUuid(benefitId)) return { ok: false, error: 'That benefit could not be identified.' };
  if (!isUuid(employeeId)) return { ok: false, error: 'This account is not linked to an employee record.' };
  const requestedBy = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureBenefitsSchema();

    const benefit = await getBenefit(benefitId);
    if (!benefit) return { ok: false, error: 'That benefit could not be found.' };
    if (!benefit.isActive) return { ok: false, error: 'That benefit is no longer offered.' };
    if (!benefit.enrolmentRequired) {
      return {
        ok: false,
        error: 'This benefit does not need electing — it already applies to everyone who qualifies. '
          + 'Read the claim instructions on the benefit instead.',
      };
    }

    const subject = await eligibilitySubject(employeeId);
    if (!subject) return { ok: false, error: 'That employee record could not be read.' };
    const verdict = evaluateEligibility(benefit.rules, subject);
    if (!verdict.eligible) {
      return { ok: false, error: 'You do not qualify for this yet. ' + verdict.unmet.join(' ') };
    }

    // The chosen option must be one HR actually offered. A free-text value here would let somebody
    // elect a cover level that does not exist and be approved into it.
    const option = String(input?.option || '').trim();
    if (benefit.enrolmentOptions.length > 0) {
      if (!option) return { ok: false, error: 'Choose one of the options offered.' };
      if (!benefit.enrolmentOptions.some((o) => o === option)) {
        return { ok: false, error: 'That is not one of the options offered for this benefit.' };
      }
    }

    const openAlready = rowsOf(await db.execute(sql`
      SELECT id, state FROM hr_benefit_enrolments
       WHERE employee_id = ${employeeId}::uuid AND benefit_id = ${benefitId}::uuid
         AND state IN ('pending', 'halted', 'active') LIMIT 1`));
    if (openAlready.length) {
      const state = String(openAlready[0].state);
      return {
        ok: false,
        id: String(openAlready[0].id),
        error: state === 'active'
          ? 'You are already enrolled in this.'
          : 'You already have an election for this waiting to be decided.',
      };
    }

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO hr_benefit_enrolments
        (benefit_id, employee_id, option_chosen, reason, state, requested_by_user_id)
      VALUES
        (${benefitId}::uuid, ${employeeId}::uuid, ${option || null},
         ${String(input?.reason || '').trim().slice(0, 1000) || null}, 'pending', ${requestedBy}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!ins.length) {
      // The partial unique index won a race the read above could not see. The person's intent is
      // satisfied either way, so this reports what happened rather than a failure they cannot act on.
      return { ok: false, error: 'An election for this benefit was already recorded a moment ago.' };
    }
    const enrolmentId = String(ins[0].id);

    const wf = await startWorkflow({
      domain: 'benefits',
      recordId: enrolmentId,
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary: 'Benefit election: ' + benefit.name + (option ? ' (' + option + ')' : '')
        + ' for ' + (subject.fullName || 'an employee'),
    });

    if (!wf.ok) {
      // The engine refused to start at all. The row stays, marked halted with the reason, so the
      // election is visible on the HR queue instead of disappearing.
      const why = String(wf.error || 'The approval could not be started.');
      await db.execute(sql`
        UPDATE hr_benefit_enrolments SET state = 'halted', halt_reason = ${why}, updated_at = NOW()
         WHERE id = ${enrolmentId}::uuid`);
      return { ok: false, id: enrolmentId, error: why, haltReason: why };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_benefit_enrolments
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${enrolmentId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'benefit.enrolment_requested',
      entity: 'hr_benefit_enrolment',
      entityId: enrolmentId,
      diff: {
        benefitId, benefitName: benefit.name, employeeId, option: option || null,
        workflowInstanceId: wf.instanceId || null,
        state: halted ? 'halted' : 'pending', haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: enrolmentId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logFail('requestEnrolment', e);
    return { ok: false, error: 'The election was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw an election that has not been decided. An active enrolment is ended, not withdrawn. */
export async function cancelEnrolment(id: string, actorUserId: string | null): Promise<BenefitResult> {
  if (!isUuid(id)) return { ok: false, error: 'That election could not be identified.' };
  try {
    await ensureBenefitsSchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_benefit_enrolments
         SET state = 'cancelled', updated_at = NOW()
       WHERE id = ${id}::uuid AND state IN ('pending', 'halted')
       RETURNING id, benefit_id, employee_id`));
    if (!upd.length) {
      return { ok: false, error: 'Only an election still waiting to be decided can be withdrawn.' };
    }
    await logAudit({
      userId: actor, action: 'benefit.enrolment_cancelled', entity: 'hr_benefit_enrolment', entityId: id,
      diff: { benefitId: String(upd[0].benefit_id), employeeId: String(upd[0].employee_id) },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('cancelEnrolment', e);
    return { ok: false, error: 'The election was not withdrawn: ' + reasonOf(e) };
  }
}

/** End a live enrolment — somebody opts out, or their cover finishes. Keeps the history. */
export async function endEnrolment(id: string, actorUserId: string | null, note?: string): Promise<BenefitResult> {
  if (!isUuid(id)) return { ok: false, error: 'That enrolment could not be identified.' };
  try {
    await ensureBenefitsSchema();
    const actor = isUuid(actorUserId) ? String(actorUserId) : null;
    const upd = rowsOf(await db.execute(sql`
      UPDATE hr_benefit_enrolments
         SET state = 'ended', ended_at = NOW(), updated_at = NOW(),
             reason = COALESCE(${String(note || '').trim().slice(0, 1000) || null}, reason)
       WHERE id = ${id}::uuid AND state = 'active'
       RETURNING id, benefit_id, employee_id`));
    if (!upd.length) return { ok: false, error: 'Only a live enrolment can be ended.' };
    await logAudit({
      userId: actor, action: 'benefit.enrolment_ended', entity: 'hr_benefit_enrolment', entityId: id,
      diff: { benefitId: String(upd[0].benefit_id), employeeId: String(upd[0].employee_id), note: note || null },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('endEnrolment', e);
    return { ok: false, error: 'The enrolment was not ended: ' + reasonOf(e) };
  }
}

/**
 * Read the workflow engine's decisions back onto open elections.
 *
 * A reconcile rather than a callback, for the same reason src/lib/loans.ts is: a completion callback
 * would make the approval engine import this module, which is a dependency in the wrong direction and
 * a second place an enrolment could be activated from. IT DECIDES NOTHING. It reads a decision the
 * engine already made and writes down what that decision was.
 */
export async function syncEnrolmentApprovals(actorUserId?: string | null): Promise<{ settled: number; errors: string[] }> {
  const out = { settled: 0, errors: [] as string[] };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensureBenefitsSchema();
    const open = rowsOf(await db.execute(sql`
      SELECT id, workflow_instance_id, state FROM hr_benefit_enrolments
       WHERE state IN ('pending', 'halted') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of open) {
      const id = String((raw as any).id);
      const instanceId = String((raw as any).workflow_instance_id || '');
      if (!instanceId) continue;

      let instance = null as Awaited<ReturnType<typeof getInstance>>;
      try {
        instance = await getInstance(instanceId);
      } catch (e: any) {
        logFail('syncEnrolmentApprovals.getInstance', e);
        out.errors.push('An approval could not be read: ' + reasonOf(e));
        continue;
      }
      if (!instance) continue;

      let next: EnrolmentState | null = null;
      if (instance.state === 'approved') next = 'active';
      else if (instance.state === 'rejected') next = 'rejected';
      else if (instance.state === 'cancelled') next = 'cancelled';
      else if (instance.state === 'halted') next = 'halted';
      else if (instance.state === 'pending') next = 'pending';
      if (!next || next === String((raw as any).state)) continue;

      try {
        await db.execute(sql`
          UPDATE hr_benefit_enrolments
             SET state = ${next}, halt_reason = ${instance.haltReason}::text,
                 decided_at = CASE WHEN ${next} IN ('active', 'rejected') THEN NOW() ELSE decided_at END,
                 updated_at = NOW()
           WHERE id = ${id}::uuid`);
        out.settled += 1;
        if (next === 'active' || next === 'rejected') {
          await logAudit({
            userId: actor, action: 'benefit.enrolment_' + next, entity: 'hr_benefit_enrolment',
            entityId: id, diff: { workflowInstanceId: instanceId },
          });
        }
      } catch (e: any) {
        logFail('syncEnrolmentApprovals.write', e);
        out.errors.push('A decision could not be written down: ' + reasonOf(e));
      }
    }
  } catch (e: any) {
    logFail('syncEnrolmentApprovals', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}
