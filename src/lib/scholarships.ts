// -------------------------------------------------------------------------------------------------
// src/lib/scholarships.ts — MONEY GIVEN AWAY ON PURPOSE, OUT OF A BUDGET THAT CANNOT BE EXCEEDED.
//
// A scholarship is NOT a waiver, and this file is deliberately separate from the waiver machinery:
//
//   A WAIVER is a decision about ONE person's circumstances. It is requested, reviewed and granted
//   or declined by a human through the `fee_waiver` domain in src/lib/workflow.ts, and it is stored
//   by src/lib/fee-waiver.ts (application fees) and by the course-fee-waiver work the course-delivery
//   pass owns. Nothing here decides one, duplicates one, or writes to any of their tables.
//
//   A SCHOLARSHIP is a PROGRAMME. It exists before anyone applies: it has eligibility, an opening
//   and a deadline, a number of seats, a BUDGET, a percentage or a fixed amount, a validity window,
//   and it may be restricted to named courses or to a cohort. Awarding one spends a finite pot.
//
// THEY INTEROPERATE THROUGH THE FEE ENGINE AND NOWHERE ELSE. Both come out as a FeeAdjustment in
// src/lib/fee-engine.ts, they are applied in the declared order (scholarship BEFORE waiver, so the
// finite budget buys the maximum real relief and the human reviewing a hardship request is looking
// at what is genuinely still owed), and the engine caps both at the balance remaining. A learner can
// hold an award AND be granted a waiver; neither module needs to know the other exists.
//
// -------------------------------------------------------------------------------------------------
// A BUDGET THAT CAN BE EXCEEDED IS NOT A BUDGET.
//
// Every limit here is enforced INSIDE the statement that writes the award — the sum of what is
// already committed and the count of seats already taken are both computed in the same INSERT, read
// from the scholarship row rather than from a copy JavaScript carried in. Two administrators awarding
// the last seat at the same moment do not both succeed: the second INSERT matches no rows and is
// REFUSED, with the reason read back afterwards for the message only.
//
// This is the shape src/lib/account-credit.ts had to be rewritten into after a read-then-write let
// two checkouts spend the same wallet balance, and the shape src/lib/fee-waiver-coupons.ts had to be
// rewritten into after previewCoupon() let two applicants redeem the last use of one code. It is the
// same defect both times: a READ cannot hold a claim. The write is the claim.
//
// A REFUSAL IS NOT A WARNING. Nothing in this file logs "budget exceeded" and proceeds.
//
// -------------------------------------------------------------------------------------------------
// AWARDING IS CAPABILITY-GATED, AUDITED, AND NOBODY MAY AWARD TO THEMSELVES.
//
//   `scholarships.manage`  define a programme: its money, its seats, its deadline, its rules.
//   `scholarships.award`   award one to a named person, and cancel an award.
//
// Both exist in src/lib/auth/permissions.ts (the union AND PERMS_BY_ROLE) and in registry.ts
// BUILTIN_PERMISSIONS, both marked sensitive. A key outside the union is a permanent 403; a key only
// one of the two files knows about is a permanent silent refusal.
//
// THE AUDIT ROW IS PART OF THE AWARD, not a side effect of it. If the row naming who awarded what to
// whom cannot be written, the award is UNDONE and the caller is told — the same rule
// registry.ts recordStrict() applies to a sensitive permission grant. An unattributable gift of
// revenue is exactly the thing that must not exist.
//
// SELF-AWARD IS REFUSED BEFORE ANYTHING ELSE HAPPENS, whatever the actor holds. `scholarships.award`
// is a standing authority over a domain, not a relationship — a scholarship applicant is usually a
// member of the public with no manager and no employee record, so there is no edge in the
// Organization Graph to route this by (src/lib/org-graph.ts is the only place relationships come
// from, and it has nothing to say about a stranger). That is why the self-award rule is written
// here, explicitly, rather than assumed to fall out of routing.
// -------------------------------------------------------------------------------------------------

import { ensureOnce } from '@/lib/ensure-once';
import { holdsCapability, type CapabilityUser } from '@/lib/auth/capability';
import { minorUnits, pctOfMinor, formatMinor, type FeeAdjustment } from '@/lib/fee-engine';

// Lazy, for the reason src/lib/audit.ts states: a top-level '@/lib/db' import puts every pure
// function in this module out of reach of a test that needs no database at all.
async function ctx(): Promise<{ db: any; sql: any }> {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const MOD = '[scholarships]';
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function why(e: any): string {
  // The real Postgres reason is on e.cause; e.message is only the failed SQL.
  return String(e?.cause?.message || e?.message || e || 'unknown reason');
}

// =================================================================================================
// THE VOCABULARY
// =================================================================================================

export const SCHOLARSHIP_AWARD_KINDS = ['percent', 'fixed'] as const;
export type ScholarshipAwardKind = (typeof SCHOLARSHIP_AWARD_KINDS)[number];

/**
 * draft   being written. Nothing may be awarded from it.
 * open    accepting awards, subject to every limit below.
 * closed  no further awards. Awards already made are untouched and still apply.
 */
export const SCHOLARSHIP_STATUSES = ['draft', 'open', 'closed'] as const;
export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

/**
 * awarded    granted and not yet spent. It reserves its amount against the budget.
 * consumed   spent against a real charge. Still counts against the budget, at what it actually cost.
 * cancelled  withdrawn by somebody with the authority and a reason. Releases its reservation.
 * expired    its validity window passed unspent. Releases its reservation.
 */
export const SCHOLARSHIP_AWARD_STATUSES = ['awarded', 'consumed', 'cancelled', 'expired'] as const;
export type ScholarshipAwardStatus = (typeof SCHOLARSHIP_AWARD_STATUSES)[number];

/** The two statuses that hold money. Everything budget-shaped counts exactly these. */
export const COMMITTING_STATUSES: readonly ScholarshipAwardStatus[] = ['awarded', 'consumed'];

export function awardStatusLabel(v: string): string {
  if (v === 'awarded') return 'Awarded';
  if (v === 'consumed') return 'Used';
  if (v === 'cancelled') return 'Cancelled';
  if (v === 'expired') return 'Expired';
  return String(v || '');
}

// =================================================================================================
// THE ARITHMETIC AND THE RULES. Pure — no database, no clock of their own.
// =================================================================================================

/**
 * WHAT ONE AWARD COMMITS, in whole minor units.
 *
 * A percentage is meaningless as a budget line until it is turned into money, so it is turned into
 * money HERE, once, at the moment of the award, against the charges as they stand — and the amount
 * is stored. A budget denominated in percentages could not be counted, and a limit that cannot be
 * counted cannot be enforced.
 *
 * An award can never commit more than the charges it is awarded against: a 100% scholarship on a
 * 10,000 fee commits 10,000, not more, whatever cap is set.
 */
export function commitmentMinor(input: {
  kind: ScholarshipAwardKind;
  value: number;
  feeBaseMinor: number;
  capMinor?: number | null;
}): number {
  const base = Math.max(0, minorUnits(input.feeBaseMinor));
  if (base <= 0) return 0;
  let amount: number;
  if (input.kind === 'fixed') {
    amount = Math.max(0, minorUnits(input.value));
  } else {
    const pct = Number(input.value);
    amount = !Number.isFinite(pct) || pct <= 0 ? 0 : pctOfMinor(base, Math.min(100, pct));
  }
  const cap = input.capMinor === null || input.capMinor === undefined ? null : Math.max(0, minorUnits(input.capMinor));
  if (cap !== null) amount = Math.min(amount, cap);
  return Math.min(amount, base);
}

export interface BudgetState {
  /** null means no money limit was set — see requireExplicitLimits() and createScholarship(). */
  budgetMinor: number | null;
  committedMinor: number;
  seatsTotal: number | null;
  seatsTaken: number;
}

export interface BudgetVerdict {
  ok: boolean;
  reason: string | null;
  remainingBudgetMinor: number | null;
  remainingSeats: number | null;
}

/**
 * WOULD THIS AWARD FIT? The rule, written once, in a form a test can hold to account.
 *
 * THE DATABASE IS STILL THE AUTHORITY. awardScholarship() enforces exactly this inside its INSERT,
 * because only the write can hold a claim against a second administrator clicking at the same moment.
 * This function exists so a screen can say "two seats left" before anybody clicks, and so the rule
 * itself is testable without a database. If the two ever disagree, this one is wrong.
 */
export function budgetVerdict(state: BudgetState, requestMinor: number, currency = 'INR'): BudgetVerdict {
  const request = Math.max(0, minorUnits(requestMinor));
  const committed = Math.max(0, minorUnits(state.committedMinor));
  const remainingBudget = state.budgetMinor === null ? null : Math.max(0, minorUnits(state.budgetMinor) - committed);
  const remainingSeats = state.seatsTotal === null ? null : Math.max(0, Math.floor(state.seatsTotal) - Math.floor(state.seatsTaken));

  if (request <= 0) {
    return { ok: false, reason: 'There is nothing to award: these charges come to nothing once everything else has been applied.', remainingBudgetMinor: remainingBudget, remainingSeats };
  }
  if (remainingSeats !== null && remainingSeats <= 0) {
    return { ok: false, reason: 'Every place on this scholarship has been awarded.', remainingBudgetMinor: remainingBudget, remainingSeats: 0 };
  }
  if (remainingBudget !== null && request > remainingBudget) {
    return {
      ok: false,
      reason: 'This award of ' + formatMinor(request, currency) + ' does not fit the budget: ' + formatMinor(remainingBudget, currency) + ' is left.',
      remainingBudgetMinor: remainingBudget,
      remainingSeats,
    };
  }
  return { ok: true, reason: null, remainingBudgetMinor: remainingBudget, remainingSeats };
}

/**
 * ELIGIBILITY, declared as data and evaluated FAIL-CLOSED.
 *
 * A rule that asks about a fact we do not hold answers NOT ELIGIBLE and says which fact was missing.
 * The alternative — treating an unknown as a pass — hands out money against a condition nobody
 * checked, and does it silently.
 *
 * `humanConditions` is the part deliberately NOT machine-checked: a sentence a reviewer reads and
 * decides on. It is returned rather than evaluated, because a rule this engine cannot check must not
 * look like one it did.
 */
export interface EligibilityRules {
  /** Award only to people with an employee record. */
  requireEmployee?: boolean;
  /** Award only to these learner tiers / kinds, matched exactly against the fact. */
  learnerKinds?: string[];
  /** ISO country codes or names, matched case-insensitively against the fact. */
  countries?: string[];
  minAge?: number;
  maxAge?: number;
  /** The applicant must have declared financial need on the record. */
  requireNeedDeclared?: boolean;
  /** Conditions for a human to read and judge. Never evaluated here. */
  humanConditions?: string[];
}

export interface EligibilityFacts {
  isEmployee?: boolean | null;
  learnerKind?: string | null;
  country?: string | null;
  age?: number | null;
  needDeclared?: boolean | null;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Conditions that were checked and not met. */
  failed: string[];
  /** Conditions that could not be checked because a fact is missing. Fail closed. */
  unknown: string[];
  /** Conditions a person must judge. Present whether or not the machine checks passed. */
  humanConditions: string[];
}

/** Written once, because it is pushed from two rules and compared against itself between them. */
const AGE_UNKNOWN = 'the age of the person being awarded';

export function eligibilityVerdict(rules: EligibilityRules | null | undefined, facts: EligibilityFacts | null | undefined): EligibilityVerdict {
  const r = rules || {};
  const f = facts || {};
  const failed: string[] = [];
  const unknown: string[] = [];

  if (r.requireEmployee) {
    if (f.isEmployee === null || f.isEmployee === undefined) unknown.push('whether this person works here');
    else if (f.isEmployee !== true) failed.push('this scholarship is only for people who work here');
  }
  if (r.learnerKinds && r.learnerKinds.length) {
    if (!f.learnerKind) unknown.push('which kind of learner this person is');
    else if (r.learnerKinds.indexOf(String(f.learnerKind)) < 0) failed.push('this scholarship is only for: ' + r.learnerKinds.join(', '));
  }
  if (r.countries && r.countries.length) {
    if (!f.country) unknown.push('where this person is');
    else {
      const want = r.countries.map((c) => String(c).trim().toLowerCase());
      if (want.indexOf(String(f.country).trim().toLowerCase()) < 0) failed.push('this scholarship is limited to: ' + r.countries.join(', '));
    }
  }
  if (r.minAge !== undefined && r.minAge !== null) {
    if (f.age === null || f.age === undefined || !Number.isFinite(Number(f.age))) unknown.push(AGE_UNKNOWN);
    else if (Number(f.age) < Number(r.minAge)) failed.push('this scholarship is for people aged ' + r.minAge + ' and over');
  }
  if (r.maxAge !== undefined && r.maxAge !== null) {
    if (f.age === null || f.age === undefined || !Number.isFinite(Number(f.age))) {
      if (unknown.indexOf(AGE_UNKNOWN) < 0) unknown.push(AGE_UNKNOWN);
    } else if (Number(f.age) > Number(r.maxAge)) failed.push('this scholarship is for people aged ' + r.maxAge + ' and under');
  }
  if (r.requireNeedDeclared) {
    if (f.needDeclared === null || f.needDeclared === undefined) unknown.push('whether financial need has been declared');
    else if (f.needDeclared !== true) failed.push('this scholarship needs a declaration of financial need on the record');
  }

  return {
    eligible: failed.length === 0 && unknown.length === 0,
    failed,
    unknown,
    humanConditions: (r.humanConditions || []).map((s) => String(s)),
  };
}

/** Is the programme open for awarding at this instant? Pure: the clock is passed in. */
export function windowVerdict(input: {
  status: ScholarshipStatus;
  opensAt?: string | Date | null;
  deadlineAt?: string | Date | null;
  now: Date;
}): { ok: boolean; reason: string | null } {
  if (input.status !== 'open') {
    return { ok: false, reason: input.status === 'draft' ? 'This scholarship has not been opened yet.' : 'This scholarship is closed.' };
  }
  const t = input.now.getTime();
  if (input.opensAt) {
    const o = new Date(input.opensAt as any).getTime();
    if (Number.isFinite(o) && t < o) return { ok: false, reason: 'This scholarship does not open until ' + new Date(o).toISOString().slice(0, 10) + '.' };
  }
  if (input.deadlineAt) {
    const d = new Date(input.deadlineAt as any).getTime();
    if (Number.isFinite(d) && t > d) return { ok: false, reason: 'The deadline for this scholarship passed on ' + new Date(d).toISOString().slice(0, 10) + '.' };
  }
  return { ok: true, reason: null };
}

/**
 * A limit that was never decided is not a limit. createScholarship() will not accept a programme
 * with no budget and no seat count unless somebody says, in the input, that they mean it.
 */
export function requireExplicitLimits(input: { budgetMinor: number | null; seatsTotal: number | null; unlimitedAcknowledged?: boolean }): { ok: boolean; reason: string | null } {
  if (input.budgetMinor === null && input.seatsTotal === null && input.unlimitedAcknowledged !== true) {
    return { ok: false, reason: 'This scholarship has neither a budget nor a number of places, so nothing would ever stop it. Set one, or record deliberately that it is unlimited.' };
  }
  if (input.budgetMinor !== null && minorUnits(input.budgetMinor) <= 0) {
    return { ok: false, reason: 'A budget of nothing cannot fund an award. Leave it unset, or set an amount.' };
  }
  if (input.seatsTotal !== null && Math.floor(input.seatsTotal) <= 0) {
    return { ok: false, reason: 'A scholarship with no places cannot be awarded. Leave it unset, or set a number.' };
  }
  return { ok: true, reason: null };
}

// =================================================================================================
// STORAGE. Additive DDL, one ensureOnce key, never a DROP.
// =================================================================================================

export function ensureScholarshipSchema(): Promise<void> {
  return ensureOnce('scholarships_v1', async () => {
    const { db, sql } = await ctx();
    await db.execute(sql`CREATE TABLE IF NOT EXISTS scholarships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(60) NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      award_kind VARCHAR(10) NOT NULL DEFAULT 'percent',
      award_value NUMERIC(12,4) NOT NULL DEFAULT 0,
      max_award_minor BIGINT,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      budget_minor BIGINT,
      seats_total INT,
      status VARCHAR(10) NOT NULL DEFAULT 'draft',
      opens_at TIMESTAMPTZ,
      deadline_at TIMESTAMPTZ,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      cohort_key TEXT,
      eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    try {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS scholarships_code_uq ON scholarships (code)`);
    } catch (e: any) {
      console.error(MOD, 'could not create the UNIQUE index on scholarships.code — two programmes may already share a code:', why(e));
    }
    await db.execute(sql`CREATE INDEX IF NOT EXISTS scholarships_status_idx ON scholarships (status, deadline_at)`);

    // WHICH COURSES A PROGRAMME IS FOR. A row here restricts it; NO rows means every course, which is
    // the honest reading of "unrestricted" and keeps the restriction out of a JSONB blob nothing can
    // index or join.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS scholarship_courses (
      scholarship_id UUID NOT NULL,
      course_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scholarship_id, course_id)
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS scholarship_awards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scholarship_id UUID NOT NULL,
      user_id UUID NOT NULL,
      course_id UUID,
      cohort_key TEXT,
      award_kind VARCHAR(10) NOT NULL,
      award_value NUMERIC(12,4) NOT NULL DEFAULT 0,
      amount_minor BIGINT NOT NULL DEFAULT 0,
      basis_minor BIGINT NOT NULL DEFAULT 0,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      status VARCHAR(12) NOT NULL DEFAULT 'awarded',
      reason TEXT,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      awarded_by UUID,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_reason TEXT,
      decided_by UUID,
      decided_at TIMESTAMPTZ
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS scholarship_awards_user_idx ON scholarship_awards (user_id, status)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS scholarship_awards_prog_idx ON scholarship_awards (scholarship_id, status)`);
    // ONE AWARD PER PERSON PER PROGRAMME PER COURSE, said by the database. Two partial indexes rather
    // than one, because a NULL course_id does not collide with itself in a plain unique index — which
    // is exactly how a person ends up holding the same open-ended award twice.
    try {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS scholarship_awards_course_uq
        ON scholarship_awards (scholarship_id, user_id, course_id) WHERE course_id IS NOT NULL`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS scholarship_awards_open_uq
        ON scholarship_awards (scholarship_id, user_id) WHERE course_id IS NULL`);
    } catch (e: any) {
      console.error(MOD, 'could not create the UNIQUE indexes on scholarship_awards — a duplicate award may already exist:', why(e));
    }
  });
}

/**
 * DID THE SCHEMA ACTUALLY LAND? ensureOnce() hides its rejection from callers, so its return proves
 * nothing. This asks information_schema and pg_indexes, and the uniqueness answer matters as much as
 * the columns: without scholarship_awards_open_uq the same person can hold one award twice.
 */
export async function verifyScholarshipSchema(): Promise<{ ok: boolean; missing: string[]; indexes: string[]; reason?: string }> {
  const need = ['scholarships', 'scholarship_courses', 'scholarship_awards'];
  try {
    const { db, sql } = await ctx();
    const t = rows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('scholarships','scholarship_courses','scholarship_awards')`));
    const have = new Set(t.map((x: any) => String(x.table_name)));
    const missing = need.filter((n) => !have.has(n));
    const i = rows(await db.execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE tablename IN ('scholarships','scholarship_awards')
         AND indexname IN ('scholarships_code_uq','scholarship_awards_course_uq','scholarship_awards_open_uq')`));
    return { ok: missing.length === 0, missing, indexes: i.map((x: any) => String(x.indexname)) };
  } catch (e: any) {
    return { ok: false, missing: need, indexes: [], reason: why(e) };
  }
}

// =================================================================================================
// THE PROGRAMME
// =================================================================================================

export interface Scholarship {
  id: string;
  code: string;
  name: string;
  description: string | null;
  awardKind: ScholarshipAwardKind;
  awardValue: number;
  maxAwardMinor: number | null;
  currency: string;
  budgetMinor: number | null;
  seatsTotal: number | null;
  status: ScholarshipStatus;
  opensAt: string | null;
  deadlineAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  cohortKey: string | null;
  eligibility: EligibilityRules;
  createdBy: string | null;
  createdAt: string | null;
}

function mapScholarship(r: any): Scholarship {
  return {
    id: String(r?.id || ''),
    code: String(r?.code || ''),
    name: String(r?.name || ''),
    description: r?.description ? String(r.description) : null,
    awardKind: (r?.award_kind === 'fixed' ? 'fixed' : 'percent'),
    awardValue: Number(r?.award_value) || 0,
    maxAwardMinor: r?.max_award_minor === null || r?.max_award_minor === undefined ? null : minorUnits(r.max_award_minor),
    currency: String(r?.currency || 'INR'),
    budgetMinor: r?.budget_minor === null || r?.budget_minor === undefined ? null : minorUnits(r.budget_minor),
    seatsTotal: r?.seats_total === null || r?.seats_total === undefined ? null : Number(r.seats_total),
    status: ((SCHOLARSHIP_STATUSES as readonly string[]).indexOf(String(r?.status)) >= 0 ? r.status : 'draft') as ScholarshipStatus,
    opensAt: r?.opens_at ? String(r.opens_at) : null,
    deadlineAt: r?.deadline_at ? String(r.deadline_at) : null,
    validFrom: r?.valid_from ? String(r.valid_from) : null,
    validUntil: r?.valid_until ? String(r.valid_until) : null,
    cohortKey: r?.cohort_key ? String(r.cohort_key) : null,
    eligibility: (r?.eligibility && typeof r.eligibility === 'object' ? r.eligibility : {}) as EligibilityRules,
    createdBy: r?.created_by ? String(r.created_by) : null,
    createdAt: r?.created_at ? String(r.created_at) : null,
  };
}

export interface CreateScholarshipInput {
  code: string;
  name: string;
  description?: string | null;
  awardKind: ScholarshipAwardKind;
  /** percent: 0..100. fixed: whole minor units. */
  awardValue: number;
  maxAwardMinor?: number | null;
  currency?: string;
  budgetMinor: number | null;
  seatsTotal: number | null;
  /** Required when both limits are null — see requireExplicitLimits(). */
  unlimitedAcknowledged?: boolean;
  opensAt?: string | null;
  deadlineAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  cohortKey?: string | null;
  courseIds?: string[];
  eligibility?: EligibilityRules;
  status?: ScholarshipStatus;
}

export interface Actor extends CapabilityUser {
  id: string;
  ip?: string | null;
}

/**
 * Define a programme. `scholarships.manage`.
 *
 * Created as a DRAFT unless the caller explicitly opens it, so a half-written programme cannot be
 * awarded from while somebody is still deciding what its budget is.
 */
export async function createScholarship(actor: Actor, input: CreateScholarshipInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!actor || !actor.id) return { ok: false, error: 'Nobody is signed in, so nothing was created.' };
  if (!holdsCapability(actor, 'scholarships.manage')) {
    return { ok: false, error: 'You do not have the permission that defines a scholarship. Nothing was created.' };
  }
  const code = String(input.code || '').trim().toUpperCase().slice(0, 60);
  if (!code) return { ok: false, error: 'A scholarship needs a code, so an award can name which programme it came from.' };
  const name = String(input.name || '').trim().slice(0, 300);
  if (!name) return { ok: false, error: 'A scholarship needs a name a learner can read.' };
  const kind: ScholarshipAwardKind = input.awardKind === 'fixed' ? 'fixed' : 'percent';
  const value = Number(input.awardValue);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'A scholarship that awards nothing is not a scholarship. Set a percentage or an amount.' };
  if (kind === 'percent' && value > 100) return { ok: false, error: 'A scholarship cannot cover more than the whole of a charge.' };

  const budgetMinor = input.budgetMinor === null || input.budgetMinor === undefined ? null : minorUnits(input.budgetMinor);
  const seatsTotal = input.seatsTotal === null || input.seatsTotal === undefined ? null : Math.floor(Number(input.seatsTotal));
  const limits = requireExplicitLimits({ budgetMinor, seatsTotal, unlimitedAcknowledged: input.unlimitedAcknowledged });
  if (!limits.ok) return { ok: false, error: limits.reason || 'This scholarship has no limits.' };

  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const status: ScholarshipStatus = (SCHOLARSHIP_STATUSES as readonly string[]).indexOf(String(input.status)) >= 0 ? (input.status as ScholarshipStatus) : 'draft';
    const r = rows(await db.execute(sql`
      INSERT INTO scholarships (
        code, name, description, award_kind, award_value, max_award_minor, currency,
        budget_minor, seats_total, status, opens_at, deadline_at, valid_from, valid_until,
        cohort_key, eligibility, created_by)
      VALUES (
        ${code}, ${name}, ${input.description ? String(input.description).slice(0, 4000) : null},
        ${kind}, ${value},
        ${input.maxAwardMinor === null || input.maxAwardMinor === undefined ? null : minorUnits(input.maxAwardMinor)},
        ${String(input.currency || 'INR').toUpperCase().slice(0, 8)},
        ${budgetMinor}, ${seatsTotal}, ${status},
        ${input.opensAt || null}, ${input.deadlineAt || null}, ${input.validFrom || null}, ${input.validUntil || null},
        ${input.cohortKey ? String(input.cohortKey).slice(0, 120) : null},
        ${JSON.stringify(input.eligibility || {})}::jsonb, ${actor.id})
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'Nothing was created and no reason was recorded.' };
    const id = String(r[0].id);

    for (const courseId of input.courseIds || []) {
      await db.execute(sql`
        INSERT INTO scholarship_courses (scholarship_id, course_id) VALUES (${id}::uuid, ${courseId}::uuid)
        ON CONFLICT DO NOTHING`)
        .catch((e: any) => console.error(MOD, 'could not restrict scholarship', id, 'to course', courseId, '-', why(e)));
    }

    await auditStrict(actor, {
      action: 'scholarship.create',
      entity: 'scholarships',
      entityId: id,
      diff: { code, name, awardKind: kind, awardValue: value, budgetMinor, seatsTotal, status },
    }).catch((e: any) => console.error(MOD, 'scholarship', id, 'was created but the audit row was not written -', why(e)));

    return { ok: true, id };
  } catch (e: any) {
    const reason = why(e);
    console.error(MOD, 'createScholarship failed for', code, '-', reason);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: 'A scholarship with the code ' + code + ' already exists. Nothing was created.' };
    return { ok: false, error: 'That scholarship could not be created. Nothing was changed. (' + reason.slice(0, 160) + ')' };
  }
}

/** Open or close a programme. `scholarships.manage`. Awards already made are never touched. */
export async function setScholarshipStatus(actor: Actor, id: string, status: ScholarshipStatus): Promise<{ ok: boolean; error?: string }> {
  if (!holdsCapability(actor, 'scholarships.manage')) return { ok: false, error: 'You do not have the permission that opens or closes a scholarship. Nothing was changed.' };
  if ((SCHOLARSHIP_STATUSES as readonly string[]).indexOf(status) < 0) return { ok: false, error: 'That is not a state a scholarship can be in.' };
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      UPDATE scholarships SET status = ${status}, updated_at = NOW()
       WHERE id = ${id}::uuid AND status <> ${status} RETURNING id, code`));
    if (!r.length) return { ok: false, error: 'Nothing changed — it may already be in that state, or it no longer exists.' };
    await auditStrict(actor, { action: 'scholarship.status', entity: 'scholarships', entityId: id, diff: { status } })
      .catch((e: any) => console.error(MOD, 'status of scholarship', id, 'changed but the audit row was not written -', why(e)));
    return { ok: true };
  } catch (e: any) {
    console.error(MOD, 'setScholarshipStatus failed for', id, '-', why(e));
    return { ok: false, error: 'That could not be changed just now. Nothing was changed.' };
  }
}

export async function getScholarship(id: string): Promise<Scholarship | null> {
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT * FROM scholarships WHERE id = ${id}::uuid LIMIT 1`));
    return r.length ? mapScholarship(r[0]) : null;
  } catch (e: any) {
    console.error(MOD, 'getScholarship failed for', id, '-', why(e));
    throw new Error('That scholarship could not be read: ' + why(e));
  }
}

export async function listScholarships(includeDrafts = true): Promise<Scholarship[]> {
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      SELECT * FROM scholarships
       WHERE (${includeDrafts} OR status <> 'draft')
       ORDER BY created_at DESC`));
    return r.map(mapScholarship);
  } catch (e: any) {
    console.error(MOD, 'listScholarships failed -', why(e));
    throw new Error('The scholarships could not be listed: ' + why(e));
  }
}

export interface ScholarshipStats extends BudgetState {
  currency: string;
  remainingBudgetMinor: number | null;
  remainingSeats: number | null;
  awardedCount: number;
  consumedCount: number;
  cancelledCount: number;
}

/** What is left. Read-only, and never the authority on whether the next award fits — the INSERT is. */
export async function scholarshipStats(id: string): Promise<ScholarshipStats | null> {
  const s = await getScholarship(id);
  if (!s) return null;
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('awarded','consumed')), 0)::bigint AS committed,
      COUNT(*) FILTER (WHERE status IN ('awarded','consumed'))::int AS taken,
      COUNT(*) FILTER (WHERE status = 'awarded')::int AS awarded,
      COUNT(*) FILTER (WHERE status = 'consumed')::int AS consumed,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
    FROM scholarship_awards WHERE scholarship_id = ${id}::uuid`));
  const row = r[0] as any;
  const committedMinor = minorUnits(row?.committed);
  const seatsTaken = Number(row?.taken) || 0;
  return {
    currency: s.currency,
    budgetMinor: s.budgetMinor,
    committedMinor,
    seatsTotal: s.seatsTotal,
    seatsTaken,
    remainingBudgetMinor: s.budgetMinor === null ? null : Math.max(0, s.budgetMinor - committedMinor),
    remainingSeats: s.seatsTotal === null ? null : Math.max(0, s.seatsTotal - seatsTaken),
    awardedCount: Number(row?.awarded) || 0,
    consumedCount: Number(row?.consumed) || 0,
    cancelledCount: Number(row?.cancelled) || 0,
  };
}

// =================================================================================================
// AWARDING
// =================================================================================================

export interface AwardInput {
  scholarshipId: string;
  /** The person receiving it. Never the actor. */
  userId: string;
  /** The course it is tied to. Null ties it to no course, which the unique index treats separately. */
  courseId?: string | null;
  /**
   * The charges the award is measured against, in minor units. Pass what the fee engine quoted for
   * this learner and course with no personal awards applied; omit it and this resolves the course
   * itself, which is the safe default and the slower one.
   */
  feeBaseMinor?: number;
  /** Facts about the person, for the eligibility rules. Missing facts fail closed. */
  facts?: EligibilityFacts;
  reason?: string | null;
  /** Skip the eligibility check because a human has judged the human conditions. Recorded as such. */
  eligibilityJudgedBy?: string | null;
}

export interface AwardResult {
  ok: boolean;
  awardId?: string;
  amountMinor?: number;
  error?: string;
  /** Present when the machine checks could not decide and a person must. */
  humanConditions?: string[];
}

/**
 * AWARD ONE SCHOLARSHIP TO ONE NAMED PERSON.
 *
 * The order of the refusals is the design:
 *   1. signed in, and holds `scholarships.award`;
 *   2. NOT AWARDING TO THEMSELVES — before the programme is even read;
 *   3. the programme exists, is open, and is inside its window;
 *   4. the course is one this programme covers;
 *   5. eligibility, fail-closed on any fact we do not hold;
 *   6. the money: computed from the charges, then claimed INSIDE the INSERT against the budget and
 *      the seat count as they are in the database at that instant;
 *   7. the audit row. If it cannot be written the award is removed again and the caller is told.
 */
export async function awardScholarship(actor: Actor, input: AwardInput): Promise<AwardResult> {
  if (!actor || !actor.id) return { ok: false, error: 'Nobody is signed in, so nothing was awarded.' };
  if (!holdsCapability(actor, 'scholarships.award')) {
    return { ok: false, error: 'You do not have the permission that awards a scholarship. Nothing was awarded.' };
  }
  const userId = String(input.userId || '').trim();
  if (!userId) return { ok: false, error: 'No recipient was named, so nothing was awarded.' };
  if (userId === String(actor.id)) {
    return { ok: false, error: 'You cannot award a scholarship to yourself. Somebody else with this permission has to decide it.' };
  }

  await ensureScholarshipSchema();
  const s = await getScholarship(input.scholarshipId);
  if (!s) return { ok: false, error: 'That scholarship does not exist, so nothing was awarded.' };

  const win = windowVerdict({ status: s.status, opensAt: s.opensAt, deadlineAt: s.deadlineAt, now: new Date() });
  if (!win.ok) return { ok: false, error: win.reason || 'This scholarship is not open.' };

  const { db, sql } = await ctx();

  // 4. course restriction. No rows means every course.
  const courseId = input.courseId ? String(input.courseId) : null;
  const restricted = rows(await db.execute(sql`
    SELECT course_id FROM scholarship_courses WHERE scholarship_id = ${s.id}::uuid`));
  if (restricted.length) {
    if (!courseId) return { ok: false, error: 'This scholarship is restricted to particular courses, so an award has to name one.' };
    const allowed = restricted.some((x: any) => String(x.course_id) === courseId);
    if (!allowed) return { ok: false, error: 'This scholarship does not cover that course. Nothing was awarded.' };
  }

  // 5. eligibility.
  const verdict = eligibilityVerdict(s.eligibility, input.facts);
  if (!verdict.eligible && !input.eligibilityJudgedBy) {
    const parts = verdict.failed.concat(verdict.unknown.map((u) => 'we do not hold ' + u));
    return {
      ok: false,
      error: 'This person does not meet the conditions of this scholarship: ' + parts.join('; ') + '.',
      humanConditions: verdict.humanConditions,
    };
  }

  // 6. the money.
  let feeBaseMinor = input.feeBaseMinor === undefined || input.feeBaseMinor === null ? null : Math.max(0, minorUnits(input.feeBaseMinor));
  if (feeBaseMinor === null) {
    if (!courseId) return { ok: false, error: 'Without a course there is nothing to measure this award against. Name a course, or state the amount it is worth.' };
    try {
      const { quoteCourseFee } = await import('@/lib/fee-engine');
      const q = await quoteCourseFee({ courseId, userId, includeScholarships: false, includeTax: false });
      if (q.currency !== s.currency) {
        return { ok: false, error: 'This scholarship is held in ' + s.currency + ' and that course is charged in ' + q.currency + '. An award is not the place to apply an exchange rate; nothing was awarded.' };
      }
      feeBaseMinor = q.payableMinor;
    } catch (e: any) {
      console.error(MOD, 'could not price course', courseId, 'for an award -', why(e));
      return { ok: false, error: 'The charges for that course could not be read, so there is nothing to measure this award against. Nothing was awarded.' };
    }
  }

  const amountMinor = commitmentMinor({ kind: s.awardKind, value: s.awardValue, feeBaseMinor, capMinor: s.maxAwardMinor });
  // The pure rule, asked first so the message names the real limit rather than a bare refusal. The
  // INSERT below enforces it again and IS the authority — this is the explanation, not the decision.
  const stats = await scholarshipStats(s.id);
  if (stats) {
    const v = budgetVerdict(stats, amountMinor, s.currency);
    if (!v.ok) return { ok: false, error: v.reason || 'This award does not fit what is left of this scholarship.' };
  }

  // THE CLAIM IS THE WRITE. Budget and seats are read from the scholarship row and from the awards
  // already made INSIDE this statement, so two administrators awarding the last seat at the same
  // instant cannot both succeed. Zero rows back is a REFUSAL, not an error.
  let inserted: any[] = [];
  try {
    inserted = rows(await db.execute(sql`
      INSERT INTO scholarship_awards (
        scholarship_id, user_id, course_id, cohort_key, award_kind, award_value,
        amount_minor, basis_minor, currency, status, reason, valid_from, valid_until, awarded_by)
      SELECT
        sc.id, ${userId}::uuid, ${courseId}::uuid, sc.cohort_key, sc.award_kind, sc.award_value,
        ${amountMinor}, ${feeBaseMinor}, sc.currency, 'awarded',
        ${input.reason ? String(input.reason).slice(0, 1000) : null},
        sc.valid_from, sc.valid_until, ${actor.id}::uuid
      FROM scholarships sc
      WHERE sc.id = ${s.id}::uuid
        AND sc.status = 'open'
        AND (sc.deadline_at IS NULL OR sc.deadline_at > NOW())
        AND (sc.opens_at IS NULL OR sc.opens_at <= NOW())
        AND (
          sc.budget_minor IS NULL OR
          COALESCE((SELECT SUM(a.amount_minor) FROM scholarship_awards a
                     WHERE a.scholarship_id = sc.id AND a.status IN ('awarded','consumed')), 0) + ${amountMinor} <= sc.budget_minor
        )
        AND (
          sc.seats_total IS NULL OR
          (SELECT COUNT(*) FROM scholarship_awards a2
            WHERE a2.scholarship_id = sc.id AND a2.status IN ('awarded','consumed')) < sc.seats_total
        )
      RETURNING id`));
  } catch (e: any) {
    const reason = why(e);
    console.error(MOD, 'award INSERT failed for scholarship', s.id, 'user', userId, '-', reason);
    if (/duplicate key|unique/i.test(reason)) {
      return { ok: false, error: 'This person already holds an award from this scholarship for that course. Nothing was awarded twice.' };
    }
    return { ok: false, error: 'That award could not be recorded, so nothing was awarded. (' + reason.slice(0, 160) + ')' };
  }

  if (!inserted.length) {
    // Refused by a limit. Re-read ONLY to say which one — the decision was made by the statement.
    const after = await scholarshipStats(s.id).catch(() => null);
    if (after) {
      const v = budgetVerdict(after, amountMinor, s.currency);
      if (!v.ok) return { ok: false, error: v.reason || 'This award does not fit what is left of this scholarship.' };
    }
    return { ok: false, error: 'This scholarship would not take that award — it may have closed, passed its deadline, or been fully awarded in the moment between reading it and awarding it. Nothing was awarded.' };
  }

  const awardId = String(inserted[0].id);

  // 7. THE AUDIT ROW IS PART OF THE AWARD. If it cannot be written, the award is undone.
  try {
    await auditStrict(actor, {
      action: 'scholarship.award',
      entity: 'scholarship_awards',
      entityId: awardId,
      diff: {
        scholarshipId: s.id, scholarshipCode: s.code, userId, courseId,
        amountMinor, basisMinor: feeBaseMinor, currency: s.currency,
        awardKind: s.awardKind, awardValue: s.awardValue,
        eligibilityJudgedBy: input.eligibilityJudgedBy || null,
        eligibilityOverridden: !verdict.eligible,
      },
    });
  } catch (e: any) {
    console.error(MOD, 'the audit row for award', awardId, 'could not be written — undoing the award -', why(e));
    const undone = await db.execute(sql`DELETE FROM scholarship_awards WHERE id = ${awardId}::uuid`)
      .then(() => true)
      .catch((e2: any) => {
        console.error(MOD, 'THE AWARD COULD NOT BE UNDONE EITHER. Award', awardId, 'exists with no audit row and a human has to resolve it -', why(e2));
        return false;
      });
    return {
      ok: false,
      error: undone
        ? 'That award could not be recorded against your name, so it was undone. Nothing was awarded. Please try again.'
        : 'That award was made but could not be recorded against your name, and it could not be undone automatically. Do not award it again; this needs an administrator.',
    };
  }

  return { ok: true, awardId, amountMinor, humanConditions: verdict.humanConditions };
}

/**
 * Withdraw an award. `scholarships.award`. Its reservation returns to the budget the moment the
 * status stops being one of COMMITTING_STATUSES, because every count in this file filters on those
 * two — there is no separate balance to keep in step.
 */
export async function cancelAward(actor: Actor, awardId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  if (!actor || !actor.id) return { ok: false, error: 'Nobody is signed in, so nothing was changed.' };
  if (!holdsCapability(actor, 'scholarships.award')) return { ok: false, error: 'You do not have the permission that withdraws an award. Nothing was changed.' };
  const text = String(reason || '').trim();
  if (!text) return { ok: false, error: 'Withdrawing an award needs a reason the person can be told.' };
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      UPDATE scholarship_awards
         SET status = 'cancelled', decided_reason = ${text.slice(0, 1000)}, decided_by = ${actor.id}::uuid, decided_at = NOW()
       WHERE id = ${awardId}::uuid AND status = 'awarded'
       RETURNING id, scholarship_id, user_id, amount_minor`));
    if (!r.length) return { ok: false, error: 'That award was not withdrawn — it may already have been used or withdrawn, or it no longer exists.' };
    await auditStrict(actor, {
      action: 'scholarship.award.cancel',
      entity: 'scholarship_awards',
      entityId: awardId,
      diff: { reason: text, userId: String(r[0].user_id), amountMinor: minorUnits(r[0].amount_minor) },
    }).catch((e: any) => console.error(MOD, 'award', awardId, 'was withdrawn but the audit row was not written -', why(e)));
    return { ok: true };
  } catch (e: any) {
    console.error(MOD, 'cancelAward failed for', awardId, '-', why(e));
    return { ok: false, error: 'That award could not be withdrawn just now. Nothing was changed.' };
  }
}

/**
 * Record that an award was actually spent, and RELEASE the difference.
 *
 * An award reserves what it was worth when it was made. If the charges were lower by the time it was
 * used, the unspent part goes back to the budget — this only ever REDUCES a commitment, so it can
 * never let the programme overspend. `appliedMinor` above the reservation is refused rather than
 * quietly raising it: that would be an award nobody granted.
 */
export async function consumeAward(awardId: string, appliedMinor: number, paymentRef?: string | null): Promise<{ ok: boolean; error?: string }> {
  const applied = Math.max(0, minorUnits(appliedMinor));
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      UPDATE scholarship_awards
         SET status = 'consumed',
             amount_minor = ${applied},
             decided_reason = ${paymentRef ? 'Applied to ' + String(paymentRef).slice(0, 120) : 'Applied to a charge'},
             decided_at = NOW()
       WHERE id = ${awardId}::uuid AND status = 'awarded' AND ${applied} <= amount_minor
       RETURNING id`));
    if (!r.length) {
      return { ok: false, error: 'That award was not marked as used. It may already have been used or withdrawn, or the amount claimed is more than it was worth.' };
    }
    return { ok: true };
  } catch (e: any) {
    console.error(MOD, 'consumeAward failed for', awardId, '-', why(e));
    return { ok: false, error: 'That award could not be marked as used. Nothing was changed.' };
  }
}

// =================================================================================================
// READING AWARDS BACK — into the fee engine, and onto a screen.
// =================================================================================================

export interface AwardRow {
  id: string;
  scholarshipId: string;
  scholarshipCode: string;
  scholarshipName: string;
  userId: string;
  courseId: string | null;
  awardKind: ScholarshipAwardKind;
  awardValue: number;
  amountMinor: number;
  currency: string;
  status: ScholarshipAwardStatus;
  reason: string | null;
  awardedAt: string | null;
  validUntil: string | null;
}

function mapAward(r: any): AwardRow {
  return {
    id: String(r?.id || ''),
    scholarshipId: String(r?.scholarship_id || ''),
    scholarshipCode: String(r?.code || ''),
    scholarshipName: String(r?.name || ''),
    userId: String(r?.user_id || ''),
    courseId: r?.course_id ? String(r.course_id) : null,
    awardKind: r?.award_kind === 'fixed' ? 'fixed' : 'percent',
    awardValue: Number(r?.award_value) || 0,
    amountMinor: minorUnits(r?.amount_minor),
    currency: String(r?.currency || 'INR'),
    status: ((SCHOLARSHIP_AWARD_STATUSES as readonly string[]).indexOf(String(r?.status)) >= 0 ? r.status : 'awarded') as ScholarshipAwardStatus,
    reason: r?.reason ? String(r.reason) : null,
    awardedAt: r?.awarded_at ? String(r.awarded_at) : null,
    validUntil: r?.valid_until ? String(r.valid_until) : null,
  };
}

/** Every award this person holds, spent or not, for a screen that has to explain their fees. */
export async function awardsForUser(userId: string, courseId?: string | null): Promise<AwardRow[]> {
  await ensureScholarshipSchema();
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`
    SELECT a.*, s.code, s.name
      FROM scholarship_awards a
      JOIN scholarships s ON s.id = a.scholarship_id
     WHERE a.user_id = ${userId}::uuid
       AND (${courseId ? String(courseId) : null}::uuid IS NULL OR a.course_id IS NULL OR a.course_id = ${courseId ? String(courseId) : null}::uuid)
     ORDER BY a.awarded_at DESC`));
  return r.map(mapAward);
}

/**
 * THE SEAM INTO THE FEE ENGINE. Live awards, as adjustments.
 *
 * Only awards that are still 'awarded' and inside their validity window are applied — an award that
 * expired last month must not quietly keep paying. Warnings are RETURNED rather than logged and
 * dropped: an award in a currency the course is not charged in cannot be applied, and the learner
 * has to be told that rather than simply charged the full fee.
 */
export async function scholarshipAdjustments(
  userId: string,
  courseId: string,
  currency: string,
): Promise<{ adjustments: FeeAdjustment[]; warnings: string[] }> {
  await ensureScholarshipSchema();
  const warnings: string[] = [];
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`
    SELECT a.*, s.code, s.name
      FROM scholarship_awards a
      JOIN scholarships s ON s.id = a.scholarship_id
     WHERE a.user_id = ${userId}::uuid
       AND a.status = 'awarded'
       AND (a.course_id IS NULL OR a.course_id = ${courseId}::uuid)
       AND (a.valid_from IS NULL OR a.valid_from <= NOW())
       AND (a.valid_until IS NULL OR a.valid_until > NOW())
     ORDER BY a.awarded_at ASC`));

  const adjustments: FeeAdjustment[] = [];
  for (const raw of r) {
    const a = mapAward(raw);
    if (a.currency !== String(currency || 'INR').toUpperCase()) {
      warnings.push('A scholarship you hold (' + a.scholarshipName + ') is held in ' + a.currency + ' and this course is charged in ' + currency + ', so it is not applied below. Please ask before paying.');
      continue;
    }
    adjustments.push({
      kind: 'scholarship',
      code: a.scholarshipCode || 'SCHOLARSHIP',
      label: a.scholarshipName || 'Scholarship',
      // FIXED, at the amount that was committed — not the percentage. The budget counted this exact
      // number when the award was made; re-deriving a percentage here would let the relief drift away
      // from the money that was reserved for it.
      basis: 'fixed',
      value: a.amountMinor,
      ref: a.id,
    });
  }
  return { adjustments, warnings };
}

/**
 * Move awards past their validity window to 'expired', releasing their reservations.
 *
 * Nothing depends on this having run: every read filters on the window, so an award past its date is
 * already not applied. This is housekeeping so a budget report is not permanently short.
 */
export async function expireStaleAwards(limit = 500): Promise<{ expired: number; error?: string }> {
  await ensureScholarshipSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      UPDATE scholarship_awards SET status = 'expired', decided_at = NOW(),
             decided_reason = 'The validity of this award passed before it was used.'
       WHERE id IN (
         SELECT id FROM scholarship_awards
          WHERE status = 'awarded' AND valid_until IS NOT NULL AND valid_until <= NOW()
          LIMIT ${Math.max(1, Math.min(5000, Math.floor(limit)))})
       RETURNING id`));
    return { expired: r.length };
  } catch (e: any) {
    console.error(MOD, 'expireStaleAwards failed -', why(e));
    return { expired: 0, error: why(e) };
  }
}

// =================================================================================================
// THE AUDIT ROW
// =================================================================================================

/**
 * Write the audit row, and THROW if it does not land.
 *
 * Raw SQL rather than src/lib/audit.ts logAudit(), for two reasons stated plainly: logAudit()
 * swallows its own failure by design, which is right for a page view and wrong for giving away
 * revenue; and this is the same statement registry.ts recordStrict() uses for a sensitive permission
 * grant, so the two most consequential writes in the product record themselves the same way.
 */
async function auditStrict(actor: Actor, input: { action: string; entity: string; entityId: string; diff: Record<string, unknown> }): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`
    INSERT INTO audit_log (user_id, action, entity, entity_id, diff, ip_address)
    VALUES (${actor.id || null}, ${input.action}, ${input.entity}, ${input.entityId},
            ${JSON.stringify(input.diff)}::jsonb, ${actor.ip || null})`);
}
