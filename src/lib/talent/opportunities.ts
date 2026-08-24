// src/lib/talent/opportunities.ts — THE OPPORTUNITY DESK.
// Persists to tal_opportunity and tal_opportunity_evaluator; resolves its pipeline through
// src/lib/talent/stages.ts and its identifier through src/lib/talent/ids.ts.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 5, 5A, 19, 21.1, 26.3 and 27.
//
// WHAT AN OPPORTUNITY IS. A hiring event against a position. It opens, it runs a pipeline, it
// closes, it archives — and the POSITION OUTLIVES IT (F1). That is why closing an opportunity is
// not the same act as deactivating the seat it was advertising, and why nothing here writes to
// org_positions.
//
// ---------------------------------------------------------------------------------------------
// THE TWO RULES THAT ARE ACTUALLY LOAD-BEARING, AND WHY THEY ARE PURE FUNCTIONS
// ---------------------------------------------------------------------------------------------
//
// 1. THE STATUS LATTICE — decideTransition() below. Every write path asks it, and no write path
//    carries its own opinion about which move is legal. Two opinions about whether a closed
//    opportunity may be re-opened is how one screen re-opens what another screen closed.
//
//    published_at and closed_at are STAMPED AND NEVER CLEARED. An archived opportunity must still
//    be able to say when it was published; a report that cannot answer "when did this open" for a
//    tidied-away opportunity has lost the fact, not hidden it. The guarantee is structural, not a
//    matter of remembering: the UPDATE statement writes both columns through
//    `CASE WHEN ... THEN COALESCE(col, NOW()) ELSE col END`, so there is no branch anywhere in this
//    file that can write NULL over a stamp that already exists.
//
// 2. VALIDATION — opportunityProblems(). It returns EVERY problem at once, because spec 5A's
//    failure state is explicit about it: iterative single-error publishing is how a deadline gets
//    missed. The internship rule in it comes from CLAUDE.md and not from the specification:
//    internships here are UNPAID unless a stipend is explicitly recorded, so an internship carrying
//    a compensation kind that implies payment with nothing written down is refused rather than
//    advertised as paying an amount nobody agreed.
//
// Both are exported, both are tested in opportunities.test.ts, and neither opens a connection.
//
// ---------------------------------------------------------------------------------------------
// ROW SCOPING IS IN THE QUERY — spec 21.3
// ---------------------------------------------------------------------------------------------
// Which opportunities a viewer may READ is decided per row and never by the capability key. A
// caller passes an OpportunityScope; `departmentIds: null` means unrestricted, and anything else
// narrows to those departments plus the viewer's own opportunities. The narrowing is a WHERE
// clause, because a list that loads every row and filters during render has already read what the
// principal was not entitled to, and no amount of correct rendering undoes that.
//
// ---------------------------------------------------------------------------------------------
// TWO THINGS THIS MODULE DOES NOT DO, WHICH ITS VOCABULARY WILL OTHERWISE IMPLY
// ---------------------------------------------------------------------------------------------
// 1. PUBLISHED IS AN INTERNAL STATE. `role_id` — the projection of an opportunity into the public
//    `roles` advertisement (spec 5A Outputs) — is written as NULL by every path in this file, and
//    nothing outside src/lib/talent and src/lib/horizon selects from tal_opportunity at all. So
//    moving a row to `published` puts nothing on the careers site. The state, the stamp and the
//    preconditions are all real; the projection is the missing half, and it is separate work.
// 2. tal_opportunity_evaluator GRANTS NOTHING. Spec 21.1 intends it as the per-row access control
//    for an evaluator's sight of a candidate, and no reader of it exists yet. See listEvaluators().
// Both are stated on screen. Neither is allowed to be described in the present tense anywhere in
// this module or on the desk that calls it: a provisioning that is only a proposal, described as
// though it had happened, is the failure this codebase writes down most often.
//
// ---------------------------------------------------------------------------------------------
// A FAILED READ IS NOT AN EMPTY LIST
// ---------------------------------------------------------------------------------------------
// listOpportunities(), opportunityCounts() and listEvaluators() RETHROW. "There are no
// opportunities" and "we could not read whether there are any" render as the same empty table and
// mean opposite things, and the swallowed read rendered as a confident empty state is the dominant
// defect in this repository. The write paths return TalentResult instead, because a refusal and a
// failure are both answers a form has to show.
import { uuidish } from '@/lib/page-safety';
import {
  rowsOf, reasonOf, okResult, failResult,
  IDENTITY_TYPES, IDENTITY_TYPE_LABELS, COMPENSATION_KINDS,
  type IdentityType, type CompensationKind, type Opportunity, type OpportunityStatus,
  type TalentResult,
} from '@/lib/talent/types';

// ---------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/**
 * The five states, as an ARRAY.
 *
 * types.ts owns `OpportunityStatus` as a union and publishes no runtime list for it, unlike every
 * other status vocabulary in that file. A screen needs tabs and a validator needs membership, so
 * the array is derived here and typed as the union — adding a state to types.ts fails to compile
 * until it is added here too, which is the only version of this that cannot drift silently.
 */
export const OPPORTUNITY_STATUSES: readonly OpportunityStatus[] =
  ['draft', 'published', 'unpublished', 'closed', 'archived'];

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  unpublished: 'Unpublished',
  closed: 'Closed',
  archived: 'Archived',
};

/**
 * EMPLOYMENT TYPE. `tal_opportunity.employment_type` is a free TEXT column and types.ts owns no
 * vocabulary for it, so this list is the one this module recognises.
 *
 * IT IS NOT INVENTED. It is exactly the set that identityTypeFromEmployment() in
 * src/lib/talent/onboarding.ts maps EXPLICITLY. That function resolves anything it does not
 * recognise to 'employee' — which asks a candidate for a PAN and bank details — so an opportunity
 * recorded with an employment type outside this list would silently hand a volunteer an employee's
 * onboarding form months later, with nothing in between saying why. Refusing it here, at the one
 * screen where a human is looking, is the cheap end of that failure.
 *
 * onboarding.ts is not imported for the check: it reaches the database through its own imports, and
 * the rules in this file are meant to be exercisable without a connection. opportunities.test.ts
 * asserts the two lists still agree.
 */
export const EMPLOYMENT_TYPES = [
  'full_time', 'part_time', 'contract',
  'internship', 'apprenticeship', 'fellowship', 'membership',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full time',
  part_time: 'Part time',
  contract: 'Contract',
  internship: 'Internship',
  apprenticeship: 'Apprenticeship',
  fellowship: 'Fellowship',
  membership: 'Membership',
};

/**
 * The engagements CLAUDE.md's unpaid-by-default rule governs. An apprenticeship is in the set with
 * an internship because both are training relationships where an unrecorded payment is the thing
 * that goes wrong, and src/lib/hr-classification.ts already treats them together.
 */
export const TRAINING_EMPLOYMENT_TYPES: readonly string[] = ['internship', 'apprenticeship'];

/** Compensation kinds that IMPLY money changes hands. 'unpaid' is the default and stays the default. */
export const PAID_COMPENSATION_KINDS: readonly CompensationKind[] = ['stipend', 'salary', 'grant'];

/** How somebody can be attached to an opportunity. tal_opportunity_evaluator.assign_role. */
export const ASSIGN_ROLES = ['evaluator', 'interviewer', 'panel'] as const;
export type AssignRole = (typeof ASSIGN_ROLES)[number];

export const ASSIGN_ROLE_LABELS: Record<AssignRole, string> = {
  evaluator: 'Evaluator',
  interviewer: 'Interviewer',
  panel: 'Panel member',
};

/** Which moves are legal, from each state. The single source of truth for the lattice. */
const LEGAL_TRANSITIONS: Record<OpportunityStatus, readonly OpportunityStatus[]> = {
  // A draft has never been public and has no applications, so it is either published or tidied away.
  draft: ['published', 'archived'],
  // A published opportunity is withdrawn from public view, or closed to new applications. It is
  // never archived straight from public: archiving a live advertisement loses the closing date.
  published: ['unpublished', 'closed'],
  // Re-publishing something withdrawn is ROUTINE and legal — a job pulled for a week comes back.
  unpublished: ['published', 'closed', 'archived'],
  // Closed is terminal for hiring. Spec 5A rule 3: publish a successor, do not re-open.
  closed: ['archived'],
  // Nothing leaves archived. Resurrecting one is how an opportunity's history stops being a history.
  archived: [],
};

const MAX_LIST_LIMIT = 200;
const MAX_Q_LEN = 120;

// ---------------------------------------------------------------------------------------------
// PURE RULES — no database, no imports that open one.
// ---------------------------------------------------------------------------------------------

export function isOpportunityStatus(v: unknown): v is OpportunityStatus {
  return typeof v === 'string' && (OPPORTUNITY_STATUSES as readonly string[]).includes(v);
}

export function isEmploymentType(v: unknown): v is EmploymentType {
  return typeof v === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(v);
}

export function isCompensationKind(v: unknown): v is CompensationKind {
  return typeof v === 'string' && (COMPENSATION_KINDS as readonly string[]).includes(v);
}

export function isAssignRole(v: unknown): v is AssignRole {
  return typeof v === 'string' && (ASSIGN_ROLES as readonly string[]).includes(v);
}

/** PURE. Is this engagement one the unpaid-by-default rule governs? */
export function isTrainingEngagement(employmentType: unknown): boolean {
  return TRAINING_EMPLOYMENT_TYPES.includes(String(employmentType || '').trim().toLowerCase());
}

export function opportunityStatusLabel(s: string): string {
  return (OPPORTUNITY_STATUS_LABELS as Record<string, string>)[s] || s;
}

export function employmentTypeLabel(s: string): string {
  return (EMPLOYMENT_TYPE_LABELS as Record<string, string>)[s] || s;
}

export function assignRoleLabel(s: string): string {
  return (ASSIGN_ROLE_LABELS as Record<string, string>)[s] || s;
}

/**
 * PURE. A ZONELESS DATETIME MEANS UTC HERE, AND IT IS MADE TO SAY SO BEFORE ANYTHING READS IT.
 *
 * THE BUG THIS EXISTS TO CLOSE. A `datetime-local` input posts a wall clock with no zone —
 * "2026-09-01T17:00". Two different things then interpreted it two different ways and neither was
 * written down:
 *   - `new Date('2026-09-01T17:00')` in the validator resolves it in the NODE process zone;
 *   - `'2026-09-01T17:00'::timestamptz` in Postgres resolves it in the DATABASE SESSION zone.
 * On the deployed estate both happen to be UTC, so the two agreed by luck and the drift was
 * invisible. On a developer machine in IST they disagree by five and a half hours, which is enough
 * for `deadline_at < NOW()` to call a live opportunity expired — and for the validator to refuse a
 * publish the database would have accepted.
 *
 * Appending Z makes the instant EXPLICIT, so the stored value no longer depends on which machine
 * ran the statement. The screen that collects it says UTC on the field, because a deadline the
 * operator cannot predict the meaning of is worse than one in an inconvenient zone.
 *
 * Anything already carrying a zone (`Z`, `+05:30`) is returned untouched, and so is anything that
 * is not a datetime at all — an unreadable deadline must stay unreadable so the validator can
 * refuse it rather than have it quietly repaired into a date nobody typed.
 */
export function normaliseDeadlineInput(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // YYYY-MM-DDTHH:MM, optionally with seconds and fractional seconds, and NO zone designator.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s;
}

/** PURE. Every move that is legal from here, in the order a screen should offer them. */
export function legalTransitionsFrom(from: unknown): readonly OpportunityStatus[] {
  return isOpportunityStatus(from) ? LEGAL_TRANSITIONS[from] : [];
}

/** PURE. The blunt question, for a caller that only wants a boolean. */
export function canTransition(from: unknown, to: unknown): boolean {
  return isOpportunityStatus(to) && legalTransitionsFrom(from).includes(to);
}

export interface TransitionDecision {
  ok: boolean;
  /** Always populated, in words an operator can act on — including when ok is true. */
  reason: string;
  /**
   * Set published_at, but only when it is not already recorded. There is NO flag that clears it:
   * the absence is the guarantee. Same for closedAt.
   */
  stampPublishedAt: boolean;
  stampClosedAt: boolean;
}

/**
 * PURE. THE STATUS LATTICE. Every write path in this module asks this and none of them argues.
 *
 * The stamp flags answer "does this move need a date written down", never "does it need one
 * cleared". Re-publishing something that was withdrawn keeps the ORIGINAL publication date: that
 * date is what a candidate was told the advertisement went up, and a week withdrawn does not change
 * when it opened.
 */
export function decideTransition(
  from: unknown,
  to: unknown,
  opts: { hasPublishedAt?: boolean; hasClosedAt?: boolean } = {},
): TransitionDecision {
  const no = (reason: string): TransitionDecision =>
    ({ ok: false, reason, stampPublishedAt: false, stampClosedAt: false });

  if (!isOpportunityStatus(from)) {
    return no('This opportunity is in a state this system does not recognise (' + String(from)
      + '), so no move can be judged legal. Report it rather than forcing it.');
  }
  if (!isOpportunityStatus(to)) {
    return no(String(to) + ' is not a state an opportunity can be in.');
  }
  if (from === to) {
    return no('This opportunity is already ' + OPPORTUNITY_STATUS_LABELS[to].toLowerCase() + '.');
  }
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    if (from === 'archived') {
      return no('An archived opportunity is not brought back. Create a successor opportunity '
        + 'instead, so that the record of what this one did stays a record.');
    }
    if (from === 'closed' && to === 'published') {
      return no('A closed opportunity is not re-opened. Publish a successor, so that everybody '
        + 'already in this one keeps the process they applied under.');
    }
    const open = LEGAL_TRANSITIONS[from].map((s) => OPPORTUNITY_STATUS_LABELS[s].toLowerCase());
    return no('A ' + OPPORTUNITY_STATUS_LABELS[from].toLowerCase() + ' opportunity cannot become '
      + OPPORTUNITY_STATUS_LABELS[to].toLowerCase() + '. From here it can only become: '
      + (open.length ? open.join(', ') : 'nothing') + '.');
  }

  return {
    ok: true,
    reason: OPPORTUNITY_STATUS_LABELS[from] + ' to ' + OPPORTUNITY_STATUS_LABELS[to].toLowerCase() + '.',
    stampPublishedAt: to === 'published' && opts.hasPublishedAt !== true,
    stampClosedAt: to === 'closed' && opts.hasClosedAt !== true,
  };
}

/** What a validator is handed. Deliberately loose: it is fed straight from a form. */
export interface OpportunityInput {
  title?: unknown;
  departmentId?: unknown;
  employmentType?: unknown;
  level?: unknown;
  headcount?: unknown;
  eligibleIdentityTypes?: unknown;
  internalVisibleToManager?: unknown;
  hiringManagerId?: unknown;
  compensationKind?: unknown;
  compensationNote?: unknown;
  onboardingPack?: unknown;
  deadlineAt?: unknown;
}

export interface ProblemOptions {
  /**
   * Apply the preconditions that only bite at publication. They are the conditions the advertisement
   * would have to meet to be world-readable; nothing in this repository projects a published
   * opportunity onto a public page yet, so "published" is still an internal state. The checks run
   * anyway, because the projection is the piece that is missing and not the standard.
   */
  forPublish?: boolean;
  /** Injected so the deadline rule is testable without waiting for a date to pass. */
  now?: Date;
  /**
   * The onboarding-pack keys this installation knows (engagementKeys() from
   * src/lib/onboarding-packs.ts). Passed IN rather than imported, because that module reaches the
   * database through its own import chain and these rules must run without a connection.
   */
  knownPacks?: readonly string[];
}

/**
 * PURE. EVERY problem with this opportunity, at once, in words an operator can act on.
 *
 * Spec 5A's failure state: "A publish that fails validation lists every failing precondition at
 * once, not the first one. Iterative single-error publishing is how a deadline gets missed."
 */
export function opportunityProblems(input: OpportunityInput, opts: ProblemOptions = {}): string[] {
  const problems: string[] = [];
  const title = String(input.title ?? '').trim();
  const departmentId = String(input.departmentId ?? '').trim();
  const employmentType = String(input.employmentType ?? '').trim();
  const compensationKind = String(input.compensationKind ?? '').trim();
  const compensationNote = String(input.compensationNote ?? '').trim();
  const onboardingPack = String(input.onboardingPack ?? '').trim();

  if (!title) {
    problems.push('A title is required. It is what a candidate reads first, so write the seat, not the project.');
  }
  if (!departmentId) {
    problems.push('A department is required. Every opportunity is owned by one, and access to its candidates is decided from it.');
  }
  if (!employmentType) {
    problems.push('An employment type is required.');
  } else if (!isEmploymentType(employmentType)) {
    problems.push('"' + employmentType + '" is not an employment type this system recognises, and an '
      + 'unrecognised one silently becomes an employee engagement at onboarding. Use one of: '
      + EMPLOYMENT_TYPES.join(', ') + '.');
  }

  if (!compensationKind) {
    problems.push('A compensation kind is required. Unpaid is the default and is a valid answer.');
  } else if (!isCompensationKind(compensationKind)) {
    problems.push('"' + compensationKind + '" is not a compensation kind this system recognises. Use one of: '
      + COMPENSATION_KINDS.join(', ') + '.');
  }

  // Headcount is optional. Where it is set it must be a whole number of seats, and zero seats is a
  // closed opportunity rather than an open one with nothing in it.
  const rawHeadcount = input.headcount;
  const headcountGiven = rawHeadcount !== null && rawHeadcount !== undefined && String(rawHeadcount).trim() !== '';
  if (headcountGiven) {
    const n = Number(rawHeadcount);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      problems.push('Headcount must be a whole number of seats, or left empty.');
    } else if (n < 1) {
      problems.push('Headcount, where it is set, must be at least one. Leave it empty if the number of seats is not decided.');
    }
  }

  // eligible_identity_types is JSONB holding IdentityType values. An EMPTY list is legal and means
  // external-only (spec 26.3), so emptiness is not a problem — an unknown value is.
  const rawTypes = input.eligibleIdentityTypes;
  if (rawTypes !== null && rawTypes !== undefined) {
    if (!Array.isArray(rawTypes)) {
      problems.push('Eligible identity types must be a list.');
    } else {
      const unknown = rawTypes
        .map((t) => String(t).trim())
        .filter((t) => t && !(IDENTITY_TYPES as readonly string[]).includes(t));
      if (unknown.length) {
        problems.push('These are not identity types this system knows: ' + unknown.join(', ')
          + '. Known types are: ' + IDENTITY_TYPES.join(', ') + '.');
      }
    }
  }

  if (onboardingPack && opts.knownPacks && !opts.knownPacks.includes(onboardingPack)) {
    problems.push('"' + onboardingPack + '" is not an onboarding package this system has. Leave it empty '
      + 'if the package has not been decided.');
  }

  // THE PRODUCT RULE, from CLAUDE.md. Internships here are UNPAID unless the stipend is explicitly
  // recorded. A training engagement flagged as paying, with nothing written down about what it
  // pays, would advertise money nobody has agreed — so it is refused at every stage, not only at
  // publish, because a draft is what the next person edits from.
  if (isTrainingEngagement(employmentType)
      && PAID_COMPENSATION_KINDS.includes(compensationKind as CompensationKind)
      && !compensationNote) {
    problems.push('This is a training engagement recorded as paying, and nothing says what it pays. '
      + 'Internships and apprenticeships here are unpaid unless the stipend is written down: either '
      + 'record the stipend in the compensation note, or set compensation to unpaid.');
  }

  if (opts.forPublish) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    // Normalised FIRST, so this comparison and the timestamptz cast that follows it later resolve
    // the same wall clock to the same instant. Before that, a zoneless deadline could be refused
    // here and accepted by the database, or the reverse.
    const rawDeadline = normaliseDeadlineInput(input.deadlineAt);
    const deadline = rawDeadline ? new Date(rawDeadline) : null;
    if (deadline && Number.isNaN(deadline.getTime())) {
      problems.push('The deadline is not a date this system can read, so it was not accepted. '
        + 'Give a date and time, or clear it.');
    } else if (deadline && deadline.getTime() <= now.getTime()) {
      problems.push('The deadline has already passed, so publishing would advertise a window that '
        + 'has already shut. Move the deadline or clear it. Deadlines on this desk are UTC.');
    }
    if (!uuidish(String(input.hiringManagerId ?? ''))) {
      problems.push('Publishing needs a named hiring manager: somebody has to own the decisions this '
        + 'opportunity will produce, and evaluator assignment is scoped from that ownership.');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_opportunity, tal_opportunity_evaluator
// ---------------------------------------------------------------------------------------------

/**
 * Resolved lazily, exactly as src/lib/talent/stages.ts does it: importing this module must not
 * require DATABASE_URL, or the pure rules above stop being testable without a connection.
 */
async function ctx() {
  const { ensureTalentSchema } = await import('./schema');
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const OPP_COLUMNS = `o.id, o.opportunity_code, o.position_id, o.department_id, o.role_id, o.title,
  o.employment_type, o.level, o.headcount, o.eligible_identity_types, o.internal_visible_to_manager,
  o.pipeline_id, o.pipeline_version, o.hiring_manager_id, o.compensation_kind, o.compensation_note,
  o.onboarding_pack, o.status, o.deadline_at, o.published_at, o.closed_at, o.created_by,
  o.created_at, o.updated_at`;

/**
 * The same list, unqualified, for RETURNING clauses. Written out rather than derived from
 * OPP_COLUMNS by a regular expression: a column list is the last place to be clever, and a stray
 * substitution here would return the wrong column into toOpportunity() with nothing failing loudly.
 *
 * IT IS USED. The three RETURNING clauses below originally ran OPP_COLUMNS through
 * `.replace(/\bo\./g, '')` — the exact substitution this constant exists to avoid — leaving this
 * one unreferenced and the comment above it describing something no statement did.
 */
const OPP_RETURNING = `id, opportunity_code, position_id, department_id, role_id, title,
  employment_type, level, headcount, eligible_identity_types, internal_visible_to_manager,
  pipeline_id, pipeline_version, hiring_manager_id, compensation_kind, compensation_note,
  onboarding_pack, status, deadline_at, published_at, closed_at, created_by,
  created_at, updated_at`;

function toOpportunity(x: any): Opportunity {
  const rawTypes = x.eligible_identity_types;
  const types: IdentityType[] = Array.isArray(rawTypes)
    ? rawTypes.map((t: any) => String(t)).filter((t: string) => (IDENTITY_TYPES as readonly string[]).includes(t)) as IdentityType[]
    : [];
  return {
    id: String(x.id),
    opportunityCode: String(x.opportunity_code || ''),
    positionId: x.position_id ? String(x.position_id) : null,
    departmentId: String(x.department_id || ''),
    roleId: x.role_id ? String(x.role_id) : null,
    title: String(x.title || ''),
    employmentType: String(x.employment_type || ''),
    level: x.level ? String(x.level) : null,
    headcount: x.headcount === null || x.headcount === undefined ? null : Number(x.headcount),
    eligibleIdentityTypes: types,
    internalVisibleToManager: x.internal_visible_to_manager === true,
    pipelineId: String(x.pipeline_id || ''),
    pipelineVersion: Number(x.pipeline_version || 1),
    hiringManagerId: x.hiring_manager_id ? String(x.hiring_manager_id) : null,
    compensationKind: String(x.compensation_kind || 'unpaid') as CompensationKind,
    compensationNote: x.compensation_note ? String(x.compensation_note) : null,
    onboardingPack: x.onboarding_pack ? String(x.onboarding_pack) : null,
    status: String(x.status || 'draft') as OpportunityStatus,
    deadlineAt: x.deadline_at ? new Date(x.deadline_at).toISOString() : null,
    publishedAt: x.published_at ? new Date(x.published_at).toISOString() : null,
    closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null,
  };
}

/** One list row: the opportunity, plus the few joined facts the desk reads at a glance. */
export interface OpportunityRow extends Opportunity {
  departmentName: string;
  hiringManagerName: string;
  hiringManagerEmail: string;
  createdAt: string;
  updatedAt: string;
  applicationCount: number;
  evaluatorCount: number;
}

/**
 * WHICH ROWS THIS VIEWER MAY READ — spec 21.1 "Department" and "Assignment".
 *
 * `departmentIds: null` is unrestricted and is what a talent.manage holder gets. Anything else
 * narrows to those departments OR the viewer's own opportunities, applied in the WHERE clause.
 * An EMPTY array is not the same as null: it means "no department, only your own opportunities",
 * which is the correct answer for a viewer who heads nothing.
 */
export interface OpportunityScope {
  departmentIds: string[] | null;
  hiringManagerUserId: string | null;
}

export interface OpportunityFilter {
  status?: string | null;
  q?: string | null;
  scope?: OpportunityScope | null;
  limit?: number;
  offset?: number;
}

/**
 * The scope clause, as a FRESH fragment on every call.
 *
 * Called once per statement and never held in a variable shared between two of them: one sql``
 * fragment reused across two queries under prepare:false binds the wrong parameter list, and the
 * fallback that follows then returns unfiltered rows AS IF filtered — which on this function would
 * mean showing a department head another department's hiring.
 */
function scopeClause(sql: any, scope: OpportunityScope | null | undefined): any {
  if (!scope || scope.departmentIds === null) return sql`TRUE`;
  const deptJson = JSON.stringify(scope.departmentIds.map((d) => String(d)));
  const hm = uuidish(scope.hiringManagerUserId);
  // The uuid cast is on the PARAMETER, never on the column: casting hiring_manager_id::text is what
  // defeats tal_opp_hm_idx, and department_id is TEXT so it is compared as TEXT with no cast at all.
  return sql`(o.department_id IN (SELECT value FROM jsonb_array_elements_text(${deptJson}::jsonb) AS t(value))
              OR o.hiring_manager_id = ${hm}::uuid)`;
}

/** LIKE metacharacters escaped, so a search containing a per-cent sign is not a match-everything scan. */
function likeTerm(q: string): string {
  return '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

/**
 * The desk's list. RETHROWS — see the header. An empty array from this function means the query ran
 * and matched nothing, and the page is entitled to say so.
 */
export async function listOpportunities(filter: OpportunityFilter = {}): Promise<OpportunityRow[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(filter.limit) || 100));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const status = filter.status && filter.status !== 'all' && isOpportunityStatus(filter.status)
      ? String(filter.status) : null;
    const q = String(filter.q || '').trim().slice(0, MAX_Q_LEN);
    const term = q || null;
    const like = likeTerm(q);
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(OPP_COLUMNS)},
             COALESCE(d.name, '')  AS department_name,
             COALESCE(hm.name, '') AS hiring_manager_name,
             COALESCE(hm.email,'') AS hiring_manager_email,
             (SELECT COUNT(*) FROM tal_application a WHERE a.opportunity_id = o.id)::int AS application_count,
             (SELECT COUNT(*) FROM tal_opportunity_evaluator e WHERE e.opportunity_id = o.id)::int AS evaluator_count
        FROM tal_opportunity o
        LEFT JOIN departments d ON d.id::text = o.department_id
        LEFT JOIN users hm      ON hm.id = o.hiring_manager_id
       WHERE (${status}::text IS NULL OR o.status = ${status})
         AND (${term}::text IS NULL
              OR o.title ILIKE ${like}
              OR o.opportunity_code ILIKE ${like})
         AND ${scopeClause(sql, filter.scope)}
       ORDER BY o.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`));
    return rows.map((x: any) => ({
      ...toOpportunity(x),
      departmentName: String(x.department_name || ''),
      hiringManagerName: String(x.hiring_manager_name || ''),
      hiringManagerEmail: String(x.hiring_manager_email || ''),
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
      updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : '',
      applicationCount: Number(x.application_count || 0),
      evaluatorCount: Number(x.evaluator_count || 0),
    }));
  } catch (e: any) {
    console.error('[talent-opportunities] listOpportunities: ' + reasonOf(e));
    throw e;
  }
}

export interface OpportunityCounts {
  total: number;
  draft: number;
  published: number;
  unpublished: number;
  closed: number;
  archived: number;
  /** Marked published, and the deadline has already gone by. Nothing stops an application arriving. */
  deadlinePassed: number;
}

/**
 * The header tiles. ONE round trip, seven numbers — seven COUNT queries against one table is the
 * shape that made page latency here a function of how many tiles a header happened to have.
 *
 * RETHROWS, for the same reason listOpportunities() does.
 */
export async function opportunityCounts(scope?: OpportunityScope | null): Promise<OpportunityCounts> {
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             (COUNT(*) FILTER (WHERE o.status = 'draft'))::int       AS draft,
             (COUNT(*) FILTER (WHERE o.status = 'published'))::int   AS published,
             (COUNT(*) FILTER (WHERE o.status = 'unpublished'))::int AS unpublished,
             (COUNT(*) FILTER (WHERE o.status = 'closed'))::int      AS closed,
             (COUNT(*) FILTER (WHERE o.status = 'archived'))::int    AS archived,
             (COUNT(*) FILTER (WHERE o.status = 'published'
                                 AND o.deadline_at IS NOT NULL
                                 AND o.deadline_at < NOW()))::int    AS deadline_passed
        FROM tal_opportunity o
       WHERE ${scopeClause(sql, scope)}`));
    const x = rows[0] || {};
    return {
      total: Number(x.total || 0),
      draft: Number(x.draft || 0),
      published: Number(x.published || 0),
      unpublished: Number(x.unpublished || 0),
      closed: Number(x.closed || 0),
      archived: Number(x.archived || 0),
      deadlinePassed: Number(x.deadline_passed || 0),
    };
  } catch (e: any) {
    console.error('[talent-opportunities] opportunityCounts: ' + reasonOf(e));
    throw e;
  }
}

/** One opportunity, or null when no row has that id. RETHROWS on a failed read. */
export async function getOpportunity(id: string): Promise<Opportunity | null> {
  const oid = uuidish(id);
  if (!oid) return null;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(OPP_COLUMNS)} FROM tal_opportunity o WHERE o.id = ${oid}::uuid LIMIT 1`));
    return rows.length ? toOpportunity(rows[0]) : null;
  } catch (e: any) {
    console.error('[talent-opportunities] getOpportunity: ' + reasonOf(e));
    throw e;
  }
}

/**
 * Resolve somebody named by email OR by user id to an admin-capable account.
 *
 * ADMIN_CAPABLE_ROLES is derived from the permission matrix, so a role that loses admin.access
 * stops being assignable here without anybody editing this file. Imported lazily because
 * src/lib/auth/admin-access.ts reaches the database.
 */
async function resolveUserRef(ref: unknown): Promise<TalentResult<{ id: string; name: string; email: string }>> {
  const raw = String(ref ?? '').trim();
  if (!raw) return failResult('Nobody was named.');
  try {
    const { db, sql } = await ctx();
    const { ADMIN_CAPABLE_ROLES } = await import('@/lib/auth/admin-access');
    const rolesJson = JSON.stringify(Array.from(ADMIN_CAPABLE_ROLES));
    const asId = uuidish(raw);
    const email = raw.toLowerCase();
    const rows = rowsOf(await db.execute(sql`
      SELECT u.id::text AS id, u.name, u.email
        FROM users u
       WHERE (u.id = ${asId}::uuid OR LOWER(u.email) = ${email})
         AND u.is_active
         AND u.role::text IN (SELECT value FROM jsonb_array_elements_text(${rolesJson}::jsonb) AS t(value))
       LIMIT 1`));
    if (!rows.length) {
      return failResult('No active administrative account matches "' + raw + '". Somebody has to be able '
        + 'to open the admin console before they are worth recording against an opportunity here.');
    }
    return okResult({
      id: String(rows[0].id),
      name: String(rows[0].name || ''),
      email: String(rows[0].email || ''),
    });
  } catch (e: any) {
    // "There is no such account" and "we could not check whether there is" are different answers,
    // and the caller folds this string into a validation problem list where they would otherwise be
    // indistinguishable — an operator would retype a perfectly good address at a database outage.
    console.error('[talent-opportunities] resolveUserRef: ' + reasonOf(e));
    return failResult('The account for "' + raw + '" could not be checked just now, so it was not '
      + 'accepted. This is a failed lookup and not a statement that no such account exists: '
      + reasonOf(e));
  }
}

export interface CreateOpportunityArgs extends OpportunityInput {
  createdByUserId: string;
  /** Email address or user id. Optional at draft; required to publish. */
  hiringManagerRef?: unknown;
  knownPacks?: readonly string[];
}

/**
 * Create a DRAFT opportunity. Nothing is ever created published: publication is a separate act with
 * its own preconditions, and spec 5A separates them for exactly that reason.
 *
 * pipeline_id is NOT NULL, and it is resolved through ensureDefaultPipeline() rather than invented.
 * pipeline_version is recorded ALONGSIDE it, because the pinned version is the load-bearing half:
 * editing a pipeline must not change the rules under an application already halfway through it.
 */
export async function createOpportunity(args: CreateOpportunityArgs): Promise<TalentResult<Opportunity>> {
  try {
    // The hiring manager is resolved FIRST, so that a mistyped address is reported alongside every
    // other problem instead of after them.
    let hiringManagerId: string | null = uuidish(String(args.hiringManagerId ?? ''));
    const managerRef = String(args.hiringManagerRef ?? '').trim();
    let managerProblem = '';
    if (!hiringManagerId && managerRef) {
      const who = await resolveUserRef(managerRef);
      if (who.ok && who.data) hiringManagerId = who.data.id;
      else managerProblem = who.error || 'That hiring manager could not be resolved.';
    }

    const problems = opportunityProblems({ ...args, hiringManagerId }, { knownPacks: args.knownPacks });
    if (managerProblem) problems.push(managerProblem);
    if (problems.length) return failResult(problems.join(' '));

    const { ensureDefaultPipeline } = await import('@/lib/talent/stages');
    const pipeline = await ensureDefaultPipeline(args.createdByUserId);
    if (!pipeline.ok || !pipeline.data) {
      return failResult('No pipeline could be resolved for this opportunity, so it was not created: '
        + (pipeline.error || 'unknown reason'));
    }

    const { allocateCode } = await import('@/lib/talent/ids');
    const code = await allocateCode('opportunity');

    const { db, sql } = await ctx();
    const rawTypes = Array.isArray(args.eligibleIdentityTypes) ? args.eligibleIdentityTypes : [];
    const types = rawTypes
      .map((t: any) => String(t).trim())
      .filter((t: string) => (IDENTITY_TYPES as readonly string[]).includes(t));
    const headcountRaw = args.headcount;
    const headcount = headcountRaw === null || headcountRaw === undefined || String(headcountRaw).trim() === ''
      ? null : Number(headcountRaw);
    // Zoneless in, explicit UTC out — so the stored instant does not depend on the database
    // session's TimeZone setting. See normaliseDeadlineInput().
    const deadline = normaliseDeadlineInput(args.deadlineAt);
    const createdBy = uuidish(args.createdByUserId);

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO tal_opportunity (
        opportunity_code, position_id, department_id, role_id, title, employment_type, level,
        headcount, eligible_identity_types, internal_visible_to_manager, pipeline_id,
        pipeline_version, hiring_manager_id, compensation_kind, compensation_note, onboarding_pack,
        status, deadline_at, created_by, created_at, updated_at)
      VALUES (
        ${code}, NULL, ${String(args.departmentId).trim()}, NULL, ${String(args.title).trim()},
        ${String(args.employmentType).trim()},
        ${args.level ? String(args.level).trim() : null},
        ${headcount},
        ${JSON.stringify(types)}::jsonb,
        ${args.internalVisibleToManager === true},
        ${String(pipeline.data.id)}::uuid,
        ${Number(pipeline.data.version || 1)},
        ${hiringManagerId}::uuid,
        ${String(args.compensationKind).trim()},
        ${args.compensationNote ? String(args.compensationNote).trim() : null},
        ${args.onboardingPack ? String(args.onboardingPack).trim() : null},
        'draft',
        ${deadline}::timestamptz,
        ${createdBy}::uuid, NOW(), NOW())
      RETURNING ${sql.raw(OPP_RETURNING)}`));
    if (!rows.length) {
      return failResult('The opportunity was not written, and no reason was returned. Nothing has been created.');
    }
    return okResult(toOpportunity(rows[0]));
  } catch (e: any) {
    console.error('[talent-opportunities] createOpportunity: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

export interface UpdateOpportunityArgs extends OpportunityInput {
  hiringManagerRef?: unknown;
  knownPacks?: readonly string[];
}

/**
 * Edit an opportunity's descriptive fields.
 *
 * NOT EDITABLE HERE: pipeline_id and pipeline_version. Spec 5A rule 3 refuses a pipeline change on a
 * published opportunity with live applications, and the only safe way to honour that from a desk
 * screen is not to offer the change at all — silently altering the process people are already in is
 * precisely what /policy/recruitment promises not to do.
 *
 * A PUBLISHED opportunity is re-validated against the publish preconditions, because an edit that
 * would have blocked publication must not be allowed in through the side door.
 */
export async function updateOpportunity(
  id: string,
  patch: UpdateOpportunityArgs,
): Promise<TalentResult<Opportunity>> {
  try {
    const oid = uuidish(id);
    if (!oid) return failResult('That opportunity reference is not a valid id, so nothing was changed.');

    const current = await getOpportunity(oid);
    if (!current) return failResult('No opportunity has that id, so nothing was changed.');
    if (current.status === 'archived') {
      return failResult('An archived opportunity is a record and is not edited.');
    }

    let hiringManagerId: string | null = current.hiringManagerId;
    let managerProblem = '';
    const managerRef = String(patch.hiringManagerRef ?? '').trim();
    if (managerRef) {
      const who = await resolveUserRef(managerRef);
      if (who.ok && who.data) hiringManagerId = who.data.id;
      else managerProblem = who.error || 'That hiring manager could not be resolved.';
    } else if (patch.hiringManagerRef !== undefined) {
      hiringManagerId = null;
    }

    const merged: OpportunityInput = {
      title: patch.title === undefined ? current.title : patch.title,
      departmentId: patch.departmentId === undefined ? current.departmentId : patch.departmentId,
      employmentType: patch.employmentType === undefined ? current.employmentType : patch.employmentType,
      level: patch.level === undefined ? current.level : patch.level,
      headcount: patch.headcount === undefined ? current.headcount : patch.headcount,
      eligibleIdentityTypes: patch.eligibleIdentityTypes === undefined
        ? current.eligibleIdentityTypes : patch.eligibleIdentityTypes,
      internalVisibleToManager: patch.internalVisibleToManager === undefined
        ? current.internalVisibleToManager : patch.internalVisibleToManager,
      hiringManagerId,
      compensationKind: patch.compensationKind === undefined ? current.compensationKind : patch.compensationKind,
      compensationNote: patch.compensationNote === undefined ? current.compensationNote : patch.compensationNote,
      onboardingPack: patch.onboardingPack === undefined ? current.onboardingPack : patch.onboardingPack,
      deadlineAt: patch.deadlineAt === undefined ? current.deadlineAt : patch.deadlineAt,
    };

    const problems = opportunityProblems(merged, {
      forPublish: current.status === 'published',
      knownPacks: patch.knownPacks,
    });
    if (managerProblem) problems.push(managerProblem);
    if (problems.length) {
      // A PUBLISHED opportunity keeps meeting the conditions it was published under, so an edit is
      // held to them too. The prefix matters: without it the refusal talks about publishing, in the
      // middle of an edit, and reads as the wrong screen answering.
      const prefix = current.status === 'published'
        ? 'This opportunity is published, so it has to keep meeting the conditions it was published under. '
        : '';
      return failResult(prefix + problems.join(' '));
    }

    const { db, sql } = await ctx();
    const types = (Array.isArray(merged.eligibleIdentityTypes) ? merged.eligibleIdentityTypes : [])
      .map((t: any) => String(t).trim())
      .filter((t: string) => (IDENTITY_TYPES as readonly string[]).includes(t));
    const headcountRaw = merged.headcount;
    const headcount = headcountRaw === null || headcountRaw === undefined || String(headcountRaw).trim() === ''
      ? null : Number(headcountRaw);

    const rows = rowsOf(await db.execute(sql`
      UPDATE tal_opportunity o
         SET title                       = ${String(merged.title).trim()},
             department_id               = ${String(merged.departmentId).trim()},
             employment_type             = ${String(merged.employmentType).trim()},
             level                       = ${merged.level ? String(merged.level).trim() : null},
             headcount                   = ${headcount},
             eligible_identity_types     = ${JSON.stringify(types)}::jsonb,
             internal_visible_to_manager = ${merged.internalVisibleToManager === true},
             hiring_manager_id           = ${hiringManagerId}::uuid,
             compensation_kind           = ${String(merged.compensationKind).trim()},
             compensation_note           = ${merged.compensationNote ? String(merged.compensationNote).trim() : null},
             onboarding_pack             = ${merged.onboardingPack ? String(merged.onboardingPack).trim() : null},
             deadline_at                 = ${normaliseDeadlineInput(merged.deadlineAt)}::timestamptz,
             updated_at                  = NOW()
       WHERE o.id = ${oid}::uuid
      RETURNING ${sql.raw(OPP_RETURNING)}`));
    if (!rows.length) {
      return failResult('The opportunity was not updated. Reload and check whether somebody else changed it.');
    }
    return okResult(toOpportunity(rows[0]));
  } catch (e: any) {
    console.error('[talent-opportunities] updateOpportunity: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

/**
 * Move an opportunity between states. THE ONLY write path for `status` in this module.
 *
 * Three guarantees, in order:
 *   1. decideTransition() decides legality AND whether each date is stamped. This function has no
 *      opinion of its own — it does not re-derive "is this a publication" from the target state.
 *
 *      THAT WAS THE SECOND OPINION THIS MODULE'S OWN HEADER WARNS ABOUT. The statement used to test
 *      `to = 'published'` in SQL while decideTransition() computed `stampPublishedAt` in TypeScript,
 *      tested it thoroughly, and was ignored by every write path. Two places deciding when a date
 *      gets written is how they eventually disagree, and the tested one was the one with no effect.
 *      The flags are now what the statement reads, so the tests are testing the write.
 *   2. Publishing re-runs the full validator, so the preconditions are checked against what is in
 *      the database now, not against what a form said when the draft was written.
 *   3. The UPDATE is conditional on the status it read (`AND o.status = <from>`), so two operators
 *      pressing two buttons at the same moment produce one move and one honest refusal, not two
 *      moves. And both timestamps are still written through COALESCE, which is belt as well as
 *      braces: even a flag computed from a stale read cannot clear a stamp that already exists.
 */
export async function transitionOpportunity(
  id: string,
  to: string,
  opts: { knownPacks?: readonly string[]; now?: Date } = {},
): Promise<TalentResult<Opportunity>> {
  try {
    const oid = uuidish(id);
    if (!oid) return failResult('That opportunity reference is not a valid id, so nothing was changed.');

    const current = await getOpportunity(oid);
    if (!current) return failResult('No opportunity has that id, so nothing was changed.');

    const decision = decideTransition(current.status, to, {
      hasPublishedAt: !!current.publishedAt,
      hasClosedAt: !!current.closedAt,
    });
    if (!decision.ok) return failResult(decision.reason);

    if (to === 'published') {
      const problems = opportunityProblems(current, {
        forPublish: true, now: opts.now, knownPacks: opts.knownPacks,
      });
      if (problems.length) {
        return failResult('This opportunity is not ready to be published. ' + problems.join(' '));
      }
    }

    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      UPDATE tal_opportunity o
         SET status       = ${String(to)},
             published_at = CASE WHEN ${decision.stampPublishedAt}::boolean THEN COALESCE(o.published_at, NOW())
                                 ELSE o.published_at END,
             closed_at    = CASE WHEN ${decision.stampClosedAt}::boolean THEN COALESCE(o.closed_at, NOW())
                                 ELSE o.closed_at END,
             updated_at   = NOW()
       WHERE o.id = ${oid}::uuid
         AND o.status = ${String(current.status)}
      RETURNING ${sql.raw(OPP_RETURNING)}`));
    if (!rows.length) {
      return failResult('This opportunity changed while you were looking at it, so the move was not applied. '
        + 'Reload and check where it stands now.');
    }
    return okResult(toOpportunity(rows[0]));
  } catch (e: any) {
    console.error('[talent-opportunities] transitionOpportunity: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

export interface EvaluatorAssignment {
  id: string;
  opportunityId: string;
  userId: string;
  assignRole: AssignRole;
  assignRoleLabel: string;
  userName: string;
  userEmail: string;
  createdAt: string;
}

/**
 * Who is recorded against these opportunities.
 *
 * SPEC 21.1 INTENDS THIS TABLE TO BE AN ACCESS CONTROL. IT IS NOT ONE YET, AND NO COPY BUILT ON
 * THIS FUNCTION MAY SAY IT IS. Nothing else in this repository selects from
 * tal_opportunity_evaluator: `grep -rn tal_opportunity_evaluator src/` returns this module, the
 * schema that creates the table, two comments, and the audit calls on the desk page. So a row here
 * grants nobody sight of a candidate and removing one takes no sight away — the applicant surfaces
 * apply whatever gates they apply today, and none of them consults this. Writing the rows is still
 * worth doing: the per-opportunity shape is what an access rule would later be built from, and
 * recording who was asked is a fact worth keeping. Telling an operator that pressing the button
 * granted access would not be.
 *
 * RETHROWS: an evaluator panel that renders empty because the read failed says "nobody is recorded
 * here", which is the opposite of what has happened.
 */
export async function listEvaluators(opportunityIds: string[]): Promise<EvaluatorAssignment[]> {
  const ids = (opportunityIds || []).map((x) => uuidish(x)).filter((x): x is string => !!x);
  if (!ids.length) return [];
  try {
    const { db, sql } = await ctx();
    const idsJson = JSON.stringify(ids);
    const rows = rowsOf(await db.execute(sql`
      SELECT e.id::text AS id, e.opportunity_id::text AS opportunity_id, e.user_id::text AS user_id,
             e.assign_role, e.created_at,
             COALESCE(u.name, '')  AS user_name,
             COALESCE(u.email, '') AS user_email
        FROM tal_opportunity_evaluator e
        LEFT JOIN users u ON u.id = e.user_id
       WHERE e.opportunity_id IN (
               SELECT value::uuid FROM jsonb_array_elements_text(${idsJson}::jsonb) AS t(value))
       ORDER BY e.created_at ASC`));
    return rows.map((x: any) => {
      const role = String(x.assign_role || 'evaluator');
      return {
        id: String(x.id),
        opportunityId: String(x.opportunity_id),
        userId: String(x.user_id),
        assignRole: (isAssignRole(role) ? role : 'evaluator') as AssignRole,
        assignRoleLabel: assignRoleLabel(role),
        userName: String(x.user_name || ''),
        userEmail: String(x.user_email || ''),
        createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
      };
    });
  } catch (e: any) {
    console.error('[talent-opportunities] listEvaluators: ' + reasonOf(e));
    throw e;
  }
}

export interface AssignEvaluatorArgs {
  opportunityId: string;
  /** Email address or user id. Resolved against active, admin-capable accounts. */
  userRef: unknown;
  assignRole: string;
}

/**
 * Record somebody against one opportunity. See listEvaluators() above for what this does NOT do:
 * no surface reads these rows, so this is a record of who was asked and not a grant of access.
 *
 * The unique index is (opportunity_id, user_id, assign_role), so recording the same person twice in
 * the same capacity is a no-op rather than an error — `changed: false` says which happened, because
 * "already recorded" and "just recorded" are different things to tell an operator.
 */
export async function assignEvaluator(
  args: AssignEvaluatorArgs,
): Promise<TalentResult<{ id: string; changed: boolean; userId: string; userName: string; userEmail: string }>> {
  try {
    const oid = uuidish(args.opportunityId);
    if (!oid) return failResult('That opportunity reference is not a valid id, so nobody was assigned.');
    const role = String(args.assignRole || 'evaluator').trim();
    if (!isAssignRole(role)) {
      return failResult('"' + role + '" is not a way somebody can be attached to an opportunity. Use one of: '
        + ASSIGN_ROLES.join(', ') + '.');
    }

    const opp = await getOpportunity(oid);
    if (!opp) return failResult('No opportunity has that id, so nobody was assigned.');
    if (opp.status === 'archived') {
      return failResult('An archived opportunity is a record. Nobody new is recorded against it.');
    }

    const who = await resolveUserRef(args.userRef);
    if (!who.ok || !who.data) return failResult(who.error || 'That person could not be resolved.');

    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO tal_opportunity_evaluator (opportunity_id, user_id, assign_role)
      VALUES (${oid}::uuid, ${who.data.id}::uuid, ${role})
      ON CONFLICT (opportunity_id, user_id, assign_role) DO NOTHING
      RETURNING id::text AS id`));
    if (!rows.length) {
      return okResult({
        id: '', changed: false,
        userId: who.data.id, userName: who.data.name, userEmail: who.data.email,
      });
    }
    return okResult({
      id: String(rows[0].id), changed: true,
      userId: who.data.id, userName: who.data.name, userEmail: who.data.email,
    });
  } catch (e: any) {
    console.error('[talent-opportunities] assignEvaluator: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

/**
 * Delete that record. Returns what was removed so the caller can write an audit entry naming the
 * person, which a bare id cannot do — and the row is gone afterwards, so the audit entry is the
 * only place the fact survives.
 */
export async function removeEvaluator(
  assignmentId: string,
): Promise<TalentResult<{ opportunityId: string; userId: string; assignRole: string }>> {
  try {
    const aid = uuidish(assignmentId);
    if (!aid) return failResult('That assignment reference is not a valid id, so nothing was removed.');
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM tal_opportunity_evaluator e
       WHERE e.id = ${aid}::uuid
      RETURNING e.opportunity_id::text AS opportunity_id, e.user_id::text AS user_id, e.assign_role`));
    if (!rows.length) {
      return failResult('That assignment no longer exists. Somebody may have removed it already.');
    }
    return okResult({
      opportunityId: String(rows[0].opportunity_id),
      userId: String(rows[0].user_id),
      assignRole: String(rows[0].assign_role || ''),
    });
  } catch (e: any) {
    console.error('[talent-opportunities] removeEvaluator: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

export interface DepartmentOption { id: string; name: string; }

/**
 * The departments an opportunity can be owned by.
 *
 * `departments.id` is a varchar slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql, so it
 * is read as ::text and compared as TEXT everywhere. A ::uuid cast against a department id is a
 * guaranteed production 500 on this estate — spec F8.
 *
 * RETHROWS: a create form whose department list quietly came back empty would offer a select with
 * nothing in it, which reads as "this company has no departments".
 */
export async function listDepartmentOptions(): Promise<DepartmentOption[]> {
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT d.id::text AS id, d.name FROM departments d ORDER BY d.name ASC LIMIT 300`));
    return rows.map((x: any) => ({ id: String(x.id), name: String(x.name || x.id) }));
  } catch (e: any) {
    console.error('[talent-opportunities] listDepartmentOptions: ' + reasonOf(e));
    throw e;
  }
}

export interface AssignableUser { id: string; name: string; email: string; role: string; }

/**
 * Everybody who could hold an assignment: active accounts that can open the admin console at all.
 * Derived from ADMIN_CAPABLE_ROLES, which is itself derived from the permission matrix.
 *
 * RETHROWS, for the same reason as the departments list.
 */
export async function listAssignableUsers(limit = 300): Promise<AssignableUser[]> {
  try {
    const { db, sql } = await ctx();
    const { ADMIN_CAPABLE_ROLES } = await import('@/lib/auth/admin-access');
    const rolesJson = JSON.stringify(Array.from(ADMIN_CAPABLE_ROLES));
    const cap = Math.min(1000, Math.max(1, Number(limit) || 300));
    const rows = rowsOf(await db.execute(sql`
      SELECT u.id::text AS id, u.name, u.email, u.role::text AS role
        FROM users u
       WHERE u.is_active
         AND u.role::text IN (SELECT value FROM jsonb_array_elements_text(${rolesJson}::jsonb) AS t(value))
       ORDER BY u.name ASC
       LIMIT ${cap}`));
    return rows.map((x: any) => ({
      id: String(x.id),
      name: String(x.name || ''),
      email: String(x.email || ''),
      role: String(x.role || ''),
    }));
  } catch (e: any) {
    console.error('[talent-opportunities] listAssignableUsers: ' + reasonOf(e));
    throw e;
  }
}

/** Re-exported so a consumer has one import for the whole opportunity story. Defined in types.ts. */
export { IDENTITY_TYPES, IDENTITY_TYPE_LABELS, COMPENSATION_KINDS };
