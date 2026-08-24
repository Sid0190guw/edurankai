// src/lib/talent/identity.ts — THE ORGANIZATIONAL IDENTITY REGISTRY.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 17, 25 and 26.6.
//
// One registry of every human this platform recognises organizationally, keyed by something that
// never changes. tal_person is the human; tal_candidate_profile is what they are as a candidate;
// tal_identity — this table — is what they are to the organisation, and there may be zero, one or
// several of them over a lifetime, the later ones linked back to the earlier by
// previous_identity_id.
//
// ---------------------------------------------------------------------------------------------
// THE THREE RULES THIS MODULE OWNS, AND WHAT EACH ONE PROTECTS
// ---------------------------------------------------------------------------------------------
//
// 1. THE CODE IS IMMUTABLE AND NEVER REUSED — spec 17.4 rule 3. identity_code is allocated once,
//    from allocateCode() in src/lib/talent/ids.ts, in the series that matches the identity type.
//    NOTHING IN THIS FILE RENUMBERS ONE. There is no deallocate, no reassign, no "fix the code"
//    path, and that absence is deliberate: a mistaken identity is VOIDED, not renumbered, so the
//    code stays attached to the void and a letter, a certificate or an access card bearing it still
//    resolves to the thing it was issued against. A renumbering is indistinguishable, six months
//    later, from a forgery.
//
// 2. THE STATUS LATTICE. IDENTITY_STATUSES and IDENTITY_STATUS_LABELS are owned by
//    src/lib/talent/types.ts; which MOVES between them are legal is owned here, by the pure
//    function canChangeStatus(). Every write in this file asks it, and so does the page — a hidden
//    button is not a lock. A terminated identity does not come back to life: reinstating somebody
//    is a NEW identity linked by previous_identity_id, never an UPDATE that quietly erases the
//    termination. Every status change carries a written status_reason.
//
//    NOT BUILT YET, AND SAID SO WHERE IT SHOWS: nothing in this module ISSUES that linked
//    replacement. createIdentityFromOnboarding() creates an unlinked identity from a fresh
//    admission and convertIdentity() refuses a same-type move, so an ex-employee returning as an
//    employee has no path that links the two. The refusal in statusChangeProblem() names the gap
//    rather than telling an operator to press a button nobody wrote. A reinstateIdentity() that
//    inserts with previous_identity_id set is what closes it.
//
// 3. CONVERSION IS A NEW ROW, NOT AN UPDATE — spec 17.6 rule 6. An intern who becomes an employee
//    gets a new identity, a new code from the employee series, and previous_identity_id pointing at
//    the internship, which is closed as `converted` in the same transaction. Overwriting
//    identity_type in place would erase the fact that the internship ever happened, and that chain
//    is the whole answer to "how long has this person been with us".
//
//    Its sibling, spec 17.6 rule 5: a move WITHIN one type — new department, new position,
//    promotion — is a TRANSFER and keeps the same identity_code. transferIdentity() does that, and
//    convertIdentity() refuses when the new type equals the old one rather than silently minting a
//    second code for the same standing.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODULE DELIBERATELY DOES NOT HOLD
// ---------------------------------------------------------------------------------------------
// Reporting manager and access groups are NOT columns on tal_identity and are not read or written
// here. The first is a relationship with a lifetime and lives in the org graph (spec 17.3, and the
// defect docs/org-graph.md records); the second is DERIVED from status, department, position and
// type, and its materialised copy in tal_identity_access is a cache with a recompute path
// (spec 23.2). A screen that edited either one from here would be writing to the wrong system.
//
// Identity documents, government identifiers and anything health-related are not read here either.
// This registry is organizational fact — code, type, department, position, status, dates.
// work_email and username are organizational and are shown; a passport number is a different desk
// behind a different key (spec 32.2, and tal_document_ref.is_sensitive).
//
// ---------------------------------------------------------------------------------------------
// READS RETHROW. WRITES RETURN A VALUE.
// ---------------------------------------------------------------------------------------------
// listIdentities(), identityCounts(), getIdentity() and identityLineage() let their exception out,
// because "there are no identities matching that" and "we could not read whether there are any"
// render as the same empty table and mean opposite things. The page catches and prints the reason.
// The writes answer with TalentResult, so a refusal is a value the caller can show and never an
// exception it has to guess the meaning of.
import { ensureTalentSchema } from './schema';
import { allocateCode } from './ids';
import { identityTypeFromEmployment } from './onboarding';
import { emitTalentEvent, TALENT_EVENTS, TALENT_SUBJECT_KINDS } from './events';
import { textIn, uuidIn } from '@/lib/pg-array';
import {
  rowsOf, reasonOf, okResult, failResult,
  ID_PREFIX, SERIES_FOR_TYPE,
  IDENTITY_TYPES, IDENTITY_TYPE_LABELS, IDENTITY_STATUSES, IDENTITY_STATUS_LABELS,
  type Identity, type IdentityStatus, type IdentityType, type IdKind, type TalentResult,
} from './types';

export { IDENTITY_TYPES, IDENTITY_TYPE_LABELS, IDENTITY_STATUSES, IDENTITY_STATUS_LABELS };
export type { Identity, IdentityStatus, IdentityType };

// Every const is declared above the functions that read it. `const` is not hoisted and a handler
// reaching a later declaration has taken pages down on this project.

/** How far back a lineage walk will follow previous_identity_id before it stops. */
const MAX_CHAIN_DEPTH = 12;

/** Hard cap on a registry page. Stated, so a caller asking for more is not silently truncated. */
const MAX_LIST = 200;

/** Postgres unique_violation. Mapped to a sentence rather than shown as a raw constraint name. */
const UNIQUE_VIOLATION = '23505';

async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ---------------------------------------------------------------------------------------------
// PURE RULES. Nothing below this heading until the queries reaches a connection, which is what
// makes it testable without one — src/lib/talent/identity.test.ts exercises all of it.
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PURE. Is this a row reference at all?
 *
 * Without it a typed or truncated `?id=` reaches Postgres as `'nonsense'::uuid` and comes back as
 * error 22P02, which a page then prints as "the registry could not be read" — the wording reserved
 * for a database that did not answer. A reference that is not a reference is a MISSING record, and
 * the two have to read differently or an operator learns to ignore both.
 */
export function isIdentityRef(v: unknown): boolean {
  return UUID_RE.test(String(v || '').trim());
}

export function isIdentityStatus(v: unknown): v is IdentityStatus {
  return typeof v === 'string' && (IDENTITY_STATUSES as readonly string[]).includes(v);
}

export function isIdentityType(v: unknown): v is IdentityType {
  return typeof v === 'string' && (IDENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * PURE. Which code series an identity type draws from, and therefore which prefix its code carries.
 *
 * SERIES_FOR_TYPE in types.ts is the owned mapping and this only widens its input, because the type
 * arriving here has usually come off a form or out of a database column as a plain string. An
 * unrecognised type resolves to the employee series, which is where contractor, consultant and
 * anything else without a series of its own already registers.
 */
export function codeSeriesFor(identityType: string): IdKind {
  const t = String(identityType || '').trim().toLowerCase();
  return isIdentityType(t) ? SERIES_FOR_TYPE[t] : SERIES_FOR_TYPE.employee;
}

/**
 * PURE. The short series label stored in tal_identity.code_series — EMP, INT, FEL, MEM.
 *
 * DERIVED FROM ID_PREFIX rather than written out again. A hand-kept second list is how a code says
 * ERAI-FEL while the column beside it says EMP, and nothing in the row would show which is wrong.
 */
export function codeSeriesLabel(kind: IdKind): string {
  const parts = String(ID_PREFIX[kind] || '').split('-');
  return parts.length > 1 ? parts[parts.length - 1] : String(kind).toUpperCase();
}

/**
 * PURE. An identity type from whatever arrived, falling back through the employment-type mapping.
 *
 * identityTypeFromEmployment() in onboarding.ts is the single mapping from "what the engagement IS"
 * to "what somebody BECOMES", and both this module and the onboarding review desk go through it, so
 * the two cannot drift into recording different types for one admission.
 */
export function resolveIdentityType(explicit: unknown, employmentType: string | null): IdentityType {
  const given = String(explicit || '').trim().toLowerCase();
  if (isIdentityType(given)) return given;
  const derived = identityTypeFromEmployment(employmentType);
  return isIdentityType(derived) ? derived : 'employee';
}

/**
 * The statuses in which an identity is finished. Nothing moves out of these by a status change; a
 * person returning to the organisation gets a NEW identity linked to the old one.
 */
export const IDENTITY_CLOSED: readonly IdentityStatus[] = ['exited', 'terminated', 'archived', 'converted'];

export function isClosedStatus(s: string): boolean {
  return (IDENTITY_CLOSED as readonly string[]).includes(String(s || ''));
}

/**
 * THE STATUS LATTICE — spec 25.
 *
 *   INVITED_FOR_ONBOARDING -> ONBOARDING_STARTED -> ONBOARDING_PENDING -> VERIFICATION -> ACTIVE
 *   ACTIVE <-> ON_LEAVE
 *   ACTIVE <-> SUSPENDED
 *   ACTIVE  -> NOTICE -> EXITED -> ARCHIVED
 *   Any     -> TERMINATED -> ARCHIVED
 *
 * Four readings of that diagram are written down here rather than left to each caller:
 *
 *  - THE PRE-ACTIVE CHAIN MAY BE SKIPPED FORWARD, NEVER BACKWARD. A registry that was imported, or
 *    an identity whose paperwork was handled outside this system, has no reason to be walked
 *    through three states it never occupied. Going back would rewrite what already happened.
 *  - ACTIVE IS ADMITTED TO ONLY FROM VERIFICATION. Skipping forward inside the paperwork is fine;
 *    skipping the last check that a human made before somebody is given access is not. This
 *    constrains the PRE-ACTIVE CHAIN and nothing else: on_leave and suspended also lead back to
 *    active, and they are RESTORATIONS of somebody already past that check, not admissions. Read as
 *    one rule over all twelve statuses it deletes the return-from-leave path, which strands every
 *    person who ever took leave with nowhere to go but terminated. identity.test.ts asserts the two
 *    separately for that reason.
 *  - `converted` IS NOT REACHABLE HERE AT ALL. It is what convertIdentity() writes on the old row
 *    in the same transaction as it inserts the new one. Setting it by hand would close an identity
 *    with no successor anywhere, which is exactly the broken chain rule 3 exists to prevent.
 *  - `archived` AND `converted` LEAD NOWHERE. They are historical. Terminating history rewrites it.
 *
 * A terminated identity does not come back to life, and that is the single most load-bearing entry
 * in this table: terminated leads only to archived.
 */
const LATTICE: Record<IdentityStatus, readonly IdentityStatus[]> = {
  invited_for_onboarding: ['onboarding_started', 'onboarding_pending', 'verification', 'terminated'],
  onboarding_started: ['onboarding_pending', 'verification', 'terminated'],
  onboarding_pending: ['verification', 'terminated'],
  verification: ['active', 'terminated'],
  active: ['on_leave', 'suspended', 'notice', 'terminated'],
  on_leave: ['active', 'suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  notice: ['exited', 'terminated'],
  exited: ['archived', 'terminated'],
  terminated: ['archived'],
  archived: [],
  converted: [],
};

/** PURE. Is this move legal? The single source of truth for the buttons AND for the refusal. */
export function canChangeStatus(from: string, to: string): boolean {
  if (!isIdentityStatus(from) || !isIdentityStatus(to)) return false;
  if (from === to) return false;
  return (LATTICE[from] as readonly string[]).includes(to);
}

/** PURE. Everything legal from here, in the order the lattice lists it. For a select element. */
export function legalNextStatuses(from: string): IdentityStatus[] {
  return isIdentityStatus(from) ? [...LATTICE[from]] : [];
}

/**
 * PURE. Why this status change cannot happen, as a sentence an operator can act on. Empty when the
 * change is allowed.
 *
 * The reason is checked HERE and not only at the form, because spec 25 and section 34 both make the
 * written reason part of the record rather than a nicety: a status with no reason is a change
 * nobody can explain later, and this registry drives access.
 */
export function statusChangeProblem(from: string, to: string, reason: string): string {
  const f = String(from || '');
  const t = String(to || '');
  const why = String(reason || '').trim();

  if (!isIdentityStatus(f)) return 'This identity is in a status the registry does not recognise, so nothing can be changed from it.';
  if (!isIdentityStatus(t)) return 'That is not an organizational status this registry knows.';
  if (!why) return 'A status change needs a written reason. It is recorded on the identity and it is what anybody reading this row later has to go on.';

  if (f === t) return 'This identity is already ' + IDENTITY_STATUS_LABELS[t].toLowerCase() + ', so there is nothing to change.';

  // THE LATTICE ANSWERS FIRST, AND EVERYTHING BELOW ONLY EXPLAINS A REFUSAL IT HAS ALREADY MADE.
  // Written this way round so the sentence can never disagree with the decision: an earlier draft
  // put the "a terminated identity does not come back to life" branch above this line, and it
  // refused exited -> terminated, which the lattice allows.
  if (canChangeStatus(f, t)) return '';

  if (t === 'converted') {
    return 'An identity is only ever marked converted by issuing the identity that replaces it. Use '
      + 'Convert, which allocates the new code and closes this one in the same act, so the chain '
      + 'between them survives.';
  }

  if (f === 'terminated' || f === 'exited') {
    // WORDED AGAINST WHAT EXISTS. It used to read "issue a NEW identity linked to this one", which
    // named an act no surface performs: there is no reinstate action anywhere in this module, and
    // convertIdentity() refuses a same-type move, so an ex-employee returning as an employee cannot
    // be given a linked identity from any screen. An instruction to press a button that is not
    // there costs the operator the same search every time; the honest sentence says which part is
    // missing.
    return 'A ' + IDENTITY_STATUS_LABELS[f].toLowerCase() + ' identity is not brought back to life, '
      + 'because a status change back would erase what happened. If this person is returning they '
      + 'need a NEW identity, and this registry has no reinstate action yet: they are admitted '
      + 'through onboarding again, and that path does not link the new identity to this one, so '
      + 'record the earlier service where it will be found.';
  }

  if (f === 'archived' || f === 'converted') {
    return 'This identity is historical. Nothing moves out of ' + IDENTITY_STATUS_LABELS[f].toLowerCase()
      + ', because the record of what happened is the only thing it is still for.';
  }

  if (t === 'active') {
    return 'An identity becomes active from verification, and this one is '
      + IDENTITY_STATUS_LABELS[f].toLowerCase() + '. Move it to verification first, so the last '
      + 'human check before somebody is given access is not skipped.';
  }

  const legal = legalNextStatuses(f).map((s) => IDENTITY_STATUS_LABELS[s]);
  return 'An identity that is ' + IDENTITY_STATUS_LABELS[f].toLowerCase() + ' cannot become '
    + IDENTITY_STATUS_LABELS[t].toLowerCase() + '. From here the registry allows: '
    + (legal.length ? legal.join(', ') : 'nothing at all') + '.';
}

/**
 * PURE. Why this transfer cannot happen. Empty when it can.
 *
 * A transfer keeps the identity_code — spec 17.6 rule 5. New department, new position, promotion:
 * same person, same standing, same code. That is why it is an UPDATE and conversion is not.
 */
export function transferProblem(
  status: string,
  departmentId: string | null,
  positionId: string | null,
  reason: string,
): string {
  const dept = String(departmentId || '').trim();
  const pos = String(positionId || '').trim();
  const why = String(reason || '').trim();

  if (!isIdentityStatus(status)) return 'This identity is in a status the registry does not recognise, so it cannot be moved.';
  if (isClosedStatus(status)) {
    return 'A ' + IDENTITY_STATUS_LABELS[status as IdentityStatus].toLowerCase() + ' identity is not '
      + 'transferred. Moving somebody who has left would rewrite where they were when they were here.';
  }
  if (!why) return 'A transfer needs a written reason.';
  if (!dept && !pos) return 'A transfer has to move something. Give a department, a position, or both.';
  if (pos && !isIdentityRef(pos)) return 'That position reference is not a position reference, so nothing has been moved.';
  return '';
}

/**
 * PURE. Why this conversion cannot happen. Empty when it can.
 *
 * THE SAME-TYPE REFUSAL IS THE POINT. Converting an employee to an employee would mint a second
 * code for one unbroken standing and close the first, so the person's own record would say they
 * left and rejoined on a day nothing happened. That move is a transfer and is sent there by name.
 */
export function conversionProblem(status: string, fromType: string, toType: string, reason: string): string {
  const to = String(toType || '').trim().toLowerCase();
  const from = String(fromType || '').trim().toLowerCase();
  const why = String(reason || '').trim();

  if (!isIdentityStatus(status)) return 'This identity is in a status the registry does not recognise, so it cannot be converted.';
  if (!isIdentityType(to)) return 'That is not an identity type this registry issues.';
  if (!why) return 'A conversion needs a written reason. It is recorded on both identities, and it is the only place the reason for the move will be.';
  if (to === from) {
    return 'That is the identity type this person already holds. A move within one type — a new '
      + 'department, a new position, a promotion — is a TRANSFER and keeps the same identity code. '
      + 'Converting would issue a second code for one unbroken standing.';
  }
  if (status !== 'active' && status !== 'on_leave') {
    return 'Only a live identity is converted, and this one is '
      + IDENTITY_STATUS_LABELS[status as IdentityStatus].toLowerCase() + '. A conversion closes the '
      + 'identity it converts, and closing something already closed loses which act ended it.';
  }
  return '';
}

/**
 * PURE. Which statuses a filter key stands for.
 *
 * The registry has twelve statuses and an operator thinks in about four groups, so the tabs are
 * groups and the mapping is written here once instead of being reassembled in the page's query
 * string. 'all' is the empty list, meaning no status predicate at all — NOT "match nothing".
 */
export const IDENTITY_STATUS_GROUPS: ReadonlyArray<readonly [string, readonly IdentityStatus[]]> = [
  ['live', ['active', 'on_leave', 'notice']],
  ['onboarding', ['invited_for_onboarding', 'onboarding_started', 'onboarding_pending', 'verification']],
  ['restricted', ['suspended']],
  ['closed', ['exited', 'terminated', 'archived']],
  ['converted', ['converted']],
];

export function statusesInFilter(key: string): IdentityStatus[] {
  const k = String(key || '').trim().toLowerCase();
  if (!k || k === 'all') return [];
  const group = IDENTITY_STATUS_GROUPS.find((g) => g[0] === k);
  if (group) return [...group[1]];
  return isIdentityStatus(k) ? [k] : [];
}

/**
 * PURE. Is this a filter key the registry actually knows?
 *
 * IT HAS TO BE ASKED SEPARATELY FROM statusesInFilter(), because that function answers the EMPTY
 * LIST for two opposite questions: 'all' (no status predicate — show everything) and 'wibble' (a
 * key that means nothing). Reading the empty list alone, listIdentities() dropped the predicate for
 * both, so a typed or stale `?status=` quietly widened a filtered registry read into the WHOLE
 * registry — terminated, archived and converted people included — while the operator believed they
 * were looking at one group. An unrecognised filter is a filter for a status nobody can hold, and
 * it must match NOTHING; the page's "No identity matches that filter" is then the true sentence.
 */
export function isKnownStatusFilter(key: string): boolean {
  const k = String(key || '').trim().toLowerCase();
  if (!k || k === 'all') return true;
  if (IDENTITY_STATUS_GROUPS.some((g) => g[0] === k)) return true;
  return isIdentityStatus(k);
}

// ---------------------------------------------------------------------------------------------
// SHAPES AND MAPPING
// ---------------------------------------------------------------------------------------------

const IDENTITY_COLUMNS = `id, identity_code, code_series, code_is_legacy, person_id, identity_type,
  employment_type, user_id, hr_employee_id, username, work_email, department_id, position_id,
  status, start_date, end_date, onboarding_application_id, selection_id, previous_identity_id,
  status_reason`;

const IDENTITY_COLUMNS_I = IDENTITY_COLUMNS.split(',').map((c) => 'i.' + c.trim()).join(', ');

/**
 * A DATE column as YYYY-MM-DD, or null.
 *
 * The Number.isNaN guard is not decoration: `new Date(x).toISOString()` THROWS on an unparseable
 * value, and this runs inside the map that builds every row on the registry page — so one
 * unreadable date would take the whole screen down with a RangeError that says nothing about
 * dates. A date that cannot be read is reported as no date, which the page already renders as
 * "No dates recorded".
 */
const dateOnly = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function toIdentity(x: any): Identity {
  return {
    id: String(x.id),
    identityCode: String(x.identity_code || ''),
    codeSeries: String(x.code_series || ''),
    codeIsLegacy: x.code_is_legacy === true,
    personId: String(x.person_id || ''),
    identityType: String(x.identity_type || 'employee') as IdentityType,
    employmentType: x.employment_type ? String(x.employment_type) : null,
    userId: x.user_id ? String(x.user_id) : null,
    hrEmployeeId: x.hr_employee_id ? String(x.hr_employee_id) : null,
    username: x.username ? String(x.username) : null,
    workEmail: x.work_email ? String(x.work_email) : null,
    departmentId: x.department_id ? String(x.department_id) : null,
    positionId: x.position_id ? String(x.position_id) : null,
    status: String(x.status || 'invited_for_onboarding') as IdentityStatus,
    startDate: dateOnly(x.start_date),
    endDate: dateOnly(x.end_date),
    onboardingApplicationId: x.onboarding_application_id ? String(x.onboarding_application_id) : null,
    selectionId: x.selection_id ? String(x.selection_id) : null,
    previousIdentityId: x.previous_identity_id ? String(x.previous_identity_id) : null,
    statusReason: x.status_reason ? String(x.status_reason) : null,
  };
}

/** An identity with the organizational names a screen has to show beside it. */
export interface IdentityRow extends Identity {
  personName: string;
  personCode: string;
  departmentName: string;
  positionTitle: string;
  /** The identity this one replaced, when there is one. The chain itself is identityLineage(). */
  previousIdentityCode: string;
  previousIdentityType: string;
  previousIdentityStatus: string;
}

/** One step back along previous_identity_id. depth 1 is the immediate predecessor. */
export interface LineageEntry {
  id: string;
  identityCode: string;
  identityType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  depth: number;
}

export interface IdentityCounts {
  total: number;
  active: number;
  onboarding: number;
  onLeave: number;
  suspended: number;
  notice: number;
  exited: number;
  terminated: number;
  archived: number;
  converted: number;
  /** Identities that replaced an earlier one. Every one of them is a chain somebody can follow. */
  withPrevious: number;
}

export interface IdentityFilter {
  status?: string;
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------------------------
// READS. ALL FOUR RETHROW.
// ---------------------------------------------------------------------------------------------

/**
 * The registry, filtered. RETHROWS — see the header. An empty array from this function means the
 * query ran and matched nothing, and that guarantee is the only thing that makes the empty state
 * on the page honest.
 */
export async function listIdentities(filter: IdentityFilter = {}): Promise<IdentityRow[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(MAX_LIST, Math.max(1, Number(filter.limit) || 100));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const statusKey = String(filter.status || 'all');
    const statuses = statusesInFilter(statusKey);
    const statusKnown = isKnownStatusFilter(statusKey);
    const typeKey = String(filter.type || '').trim().toLowerCase();
    const type = isIdentityType(typeKey) ? typeKey : null;
    // The same three outcomes as the status filter, and for the same reason: no type asked for
    // means every type; a type the registry issues means that one; a type it does NOT issue means
    // nothing, because answering it with the whole registry hands back rows the caller explicitly
    // filtered out.
    const typeUnknown = typeKey !== '' && type === null;
    const q = String(filter.q || '').trim();
    const term = q || null;
    // LIKE metacharacters escaped, so a term containing a per-cent sign does not silently become a
    // match-everything scan — which on a search box reads as "the filter is broken".
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';

    // The status predicate is a FRAGMENT, not a bound boolean. `${jsBoolean} OR ...` puts a
    // parameter where Postgres wants a predicate and leaves the membership subquery in the plan
    // even when there is nothing to match against; TRUE costs nothing and reads as what it is.
    //
    // THREE OUTCOMES, NOT TWO. 'all' (and an empty key) drop the predicate; a key the registry
    // knows becomes a membership test; a key it does NOT know matches nothing. That last branch is
    // the one worth having: statusesInFilter() answers the empty list for both 'all' and nonsense,
    // so treating the empty list alone as "no predicate" turned `?status=activ` into a read of the
    // ENTIRE registry — every terminated, archived and converted identity — displayed under a
    // filter the operator thought was narrowing it.
    const statusPredicate = statuses.length
      ? sql`i.status IN ${textIn(statuses)}`
      : (statusKnown ? sql`TRUE` : sql`FALSE`);
    const typePredicate = type
      ? sql`i.identity_type = ${type}`
      : (typeUnknown ? sql`FALSE` : sql`TRUE`);

    // department_id is TEXT on both sides. A ::uuid cast against a department id is a certain 500
    // on this project — src/lib/talent/schema.ts rule 1, spec F8.
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS_I)},
             COALESCE(p.display_name, '')  AS person_name,
             COALESCE(p.person_code, '')   AS person_code,
             COALESCE(d.name, '')          AS department_name,
             COALESCE(pos.title, '')       AS position_title,
             COALESCE(prev.identity_code, '') AS previous_identity_code,
             COALESCE(prev.identity_type, '') AS previous_identity_type,
             COALESCE(prev.status, '')        AS previous_identity_status
        FROM tal_identity i
        LEFT JOIN tal_person p     ON p.id = i.person_id
        LEFT JOIN departments d    ON d.id = i.department_id
        LEFT JOIN org_positions pos ON pos.id = i.position_id
        LEFT JOIN tal_identity prev ON prev.id = i.previous_identity_id
       WHERE ${statusPredicate}
         AND ${typePredicate}
         AND (${term}::text IS NULL
              OR i.identity_code ILIKE ${like}
              OR i.work_email ILIKE ${like}
              OR i.username ILIKE ${like}
              OR i.department_id ILIKE ${like}
              OR p.display_name ILIKE ${like}
              OR p.person_code ILIKE ${like})
       ORDER BY i.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`));

    return rows.map((x: any) => ({
      ...toIdentity(x),
      personName: String(x.person_name || ''),
      personCode: String(x.person_code || ''),
      departmentName: String(x.department_name || ''),
      positionTitle: String(x.position_title || ''),
      previousIdentityCode: String(x.previous_identity_code || ''),
      previousIdentityType: String(x.previous_identity_type || ''),
      previousIdentityStatus: String(x.previous_identity_status || ''),
    }));
  } catch (e: any) {
    console.error('[talent-identity] listIdentities: ' + reasonOf(e));
    throw e;
  }
}

/** One identity, with its names. null means NO SUCH ROW; a failure throws. RETHROWS. */
export async function getIdentity(id: string): Promise<IdentityRow | null> {
  const ref = String(id || '').trim();
  if (!isIdentityRef(ref)) return null;
  const rows = await listIdentitiesById([ref]);
  return rows.length ? rows[0] : null;
}

/** Shared by getIdentity() and the write paths, which all re-read the row they just touched. */
async function listIdentitiesById(ids: string[]): Promise<IdentityRow[]> {
  if (!ids.length) return [];
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS_I)},
             COALESCE(p.display_name, '')  AS person_name,
             COALESCE(p.person_code, '')   AS person_code,
             COALESCE(d.name, '')          AS department_name,
             COALESCE(pos.title, '')       AS position_title,
             COALESCE(prev.identity_code, '') AS previous_identity_code,
             COALESCE(prev.identity_type, '') AS previous_identity_type,
             COALESCE(prev.status, '')        AS previous_identity_status
        FROM tal_identity i
        LEFT JOIN tal_person p     ON p.id = i.person_id
        LEFT JOIN departments d    ON d.id = i.department_id
        LEFT JOIN org_positions pos ON pos.id = i.position_id
        LEFT JOIN tal_identity prev ON prev.id = i.previous_identity_id
       WHERE i.id IN ${uuidIn(ids)}
       LIMIT ${ids.length}`));
    return rows.map((x: any) => ({
      ...toIdentity(x),
      personName: String(x.person_name || ''),
      personCode: String(x.person_code || ''),
      departmentName: String(x.department_name || ''),
      positionTitle: String(x.position_title || ''),
      previousIdentityCode: String(x.previous_identity_code || ''),
      previousIdentityType: String(x.previous_identity_type || ''),
      previousIdentityStatus: String(x.previous_identity_status || ''),
    }));
  } catch (e: any) {
    console.error('[talent-identity] listIdentitiesById: ' + reasonOf(e));
    throw e;
  }
}

/**
 * THE CHAIN, for every identity named. RETHROWS.
 *
 * ONE STATEMENT, NOT ONE PER ROW. A recursive walk in application code would be a round trip per
 * generation per row, and this project has already measured what per-row round trips do to a page
 * on a database 130ms away. The depth is capped so a previous_identity_id cycle — which nothing
 * should be able to create, and which a hand-written UPDATE could — stops the walk instead of the
 * request.
 *
 * The map is keyed by the identity the chain belongs to, and each list is ordered oldest-last:
 * depth 1 is the immediate predecessor.
 */
export async function identityLineage(ids: string[]): Promise<Map<string, LineageEntry[]>> {
  const refs = (ids || []).map((x) => String(x || '').trim()).filter(isIdentityRef);
  const out = new Map<string, LineageEntry[]>();
  if (!refs.length) return out;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      WITH RECURSIVE chain (root_id, ancestor_id, depth) AS (
        SELECT i.id, i.previous_identity_id, 1
          FROM tal_identity i
         WHERE i.id IN ${uuidIn(refs)}
           AND i.previous_identity_id IS NOT NULL
        UNION ALL
        SELECT c.root_id, a.previous_identity_id, c.depth + 1
          FROM chain c
          JOIN tal_identity a ON a.id = c.ancestor_id
         WHERE a.previous_identity_id IS NOT NULL
           AND c.depth < ${MAX_CHAIN_DEPTH}
      )
      SELECT c.root_id, c.depth,
             a.id, a.identity_code, a.identity_type, a.status, a.start_date, a.end_date
        FROM chain c
        JOIN tal_identity a ON a.id = c.ancestor_id
       ORDER BY c.root_id, c.depth ASC`));
    for (const x of rows as any[]) {
      const key = String(x.root_id);
      const list = out.get(key) || [];
      list.push({
        id: String(x.id),
        identityCode: String(x.identity_code || ''),
        identityType: String(x.identity_type || ''),
        status: String(x.status || ''),
        startDate: dateOnly(x.start_date),
        endDate: dateOnly(x.end_date),
        depth: Number(x.depth || 0),
      });
      out.set(key, list);
    }
    return out;
  } catch (e: any) {
    console.error('[talent-identity] identityLineage: ' + reasonOf(e));
    throw e;
  }
}

/** What a transfer may move somebody TO. Departments and open positions, by name. */
export interface TransferTargets {
  departments: Array<{ id: string; name: string }>;
  positions: Array<{ id: string; title: string; departmentId: string | null }>;
}

/**
 * The pickers a transfer form is built from. RETHROWS.
 *
 * It rethrows for the same reason the registry does: a transfer form offering an EMPTY department
 * list, because the read failed, looks exactly like an organisation with no departments, and an
 * operator would conclude the wrong thing about the system rather than about the request. The page
 * says the list could not be read and does not draw a form nobody could complete correctly.
 *
 * departments.id is varchar(50) and tal_identity.department_id is TEXT. Both sides stay text; a
 * ::uuid cast anywhere near a department id is a certain 500 here — spec F8.
 */
export async function transferTargets(): Promise<TransferTargets> {
  try {
    const { db, sql } = await ctx();
    const deptRows = rowsOf(await db.execute(sql`
      SELECT id, name FROM departments ORDER BY sort_order ASC, name ASC LIMIT 500`));
    const posRows = rowsOf(await db.execute(sql`
      SELECT id, title, department_id
        FROM org_positions
       WHERE is_active = TRUE
       ORDER BY title ASC
       LIMIT 400`));
    return {
      departments: (deptRows as any[]).map((x) => ({ id: String(x.id), name: String(x.name || x.id) })),
      positions: (posRows as any[]).map((x) => ({
        id: String(x.id),
        title: String(x.title || ''),
        departmentId: x.department_id ? String(x.department_id) : null,
      })),
    };
  } catch (e: any) {
    console.error('[talent-identity] transferTargets: ' + reasonOf(e));
    throw e;
  }
}

/** Counts for the registry header. RETHROWS, for the same reason listIdentities() does. */
export async function identityCounts(): Promise<IdentityCounts> {
  try {
    const { db, sql } = await ctx();
    // ONE round trip, eleven numbers. Eleven COUNT queries against one table is the shape that made
    // page latency on this project a function of how many tiles a header happened to have.
    const rows = rowsOf(await db.execute(sql`
      SELECT COUNT(*)                                                  AS total,
             COUNT(*) FILTER (WHERE status = 'active')                 AS active,
             COUNT(*) FILTER (WHERE status IN ('invited_for_onboarding','onboarding_started','onboarding_pending','verification')) AS onboarding,
             COUNT(*) FILTER (WHERE status = 'on_leave')               AS on_leave,
             COUNT(*) FILTER (WHERE status = 'suspended')              AS suspended,
             COUNT(*) FILTER (WHERE status = 'notice')                 AS notice,
             COUNT(*) FILTER (WHERE status = 'exited')                 AS exited,
             COUNT(*) FILTER (WHERE status = 'terminated')             AS terminated,
             COUNT(*) FILTER (WHERE status = 'archived')               AS archived,
             COUNT(*) FILTER (WHERE status = 'converted')              AS converted,
             COUNT(*) FILTER (WHERE previous_identity_id IS NOT NULL)  AS with_previous
        FROM tal_identity`));
    const r = (rows[0] || {}) as any;
    return {
      total: Number(r.total || 0),
      active: Number(r.active || 0),
      onboarding: Number(r.onboarding || 0),
      onLeave: Number(r.on_leave || 0),
      suspended: Number(r.suspended || 0),
      notice: Number(r.notice || 0),
      exited: Number(r.exited || 0),
      terminated: Number(r.terminated || 0),
      archived: Number(r.archived || 0),
      converted: Number(r.converted || 0),
      withPrevious: Number(r.with_previous || 0),
    };
  } catch (e: any) {
    console.error('[talent-identity] identityCounts: ' + reasonOf(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// WRITES. EVERY ONE RETURNS TalentResult — A REFUSAL IS A VALUE, NEVER AN EXCEPTION.
// ---------------------------------------------------------------------------------------------

/**
 * CREATE AN IDENTITY FROM AN APPROVED ONBOARDING.
 *
 * THE PRECONDITION, STATED EXPLICITLY. tal_onboarding_application.status must be **'submitted'**.
 *
 * That is not the status of an approved form, and it is deliberate. src/lib/talent/onboarding-review.ts
 * creates the identity FIRST and marks the application approved SECOND, precisely so that a failure
 * here leaves nothing half-done: the row is untouched, it is still in the review queue, and the
 * reviewer is told the approval did not go through. If this function demanded 'approved' it would
 * force the desk into the opposite order, where the screen says "Approved" over somebody who was
 * never given an identity. So 'submitted' is the state the review desk holds the row in while it
 * calls, and anything else is refused.
 *
 * Everything else this function refuses, it refuses as a VALUE:
 *  - a reference that is not a reference, so 22P02 never reaches an operator as "could not read";
 *  - an application that does not exist, or whose selection does not;
 *  - a selection that was withdrawn, or that is not a 'selected' decision;
 *  - a person who already holds a live identity — the second one would be a duplicate standing, and
 *    where a login account is attached it would also hit tal_identity_user_active_uq, which is the
 *    partial unique index this check exists to answer BEFORE the database has to.
 *
 * IT IS IDEMPOTENT. An identity already recorded against this application is RETURNED, not
 * duplicated. That is what makes the review desk's retry safe rather than a machine for minting
 * second identities.
 *
 * THE SIGNATURE IS PINNED. onboarding-review.ts resolves this function by name through
 * import.meta.glob and calls it with exactly these fields. Do not rename or reshape it.
 */
export async function createIdentityFromOnboarding(args: {
  onboardingApplicationId: string;
  actorUserId: string;
  identityType?: string;
  startDate?: string | null;
}): Promise<TalentResult<Identity>> {
  const appId = String(args?.onboardingApplicationId || '').trim();
  const actor = String(args?.actorUserId || '').trim();

  if (!appId) return failResult<Identity>('No onboarding was named, so no identity was created.');
  if (!isIdentityRef(appId)) {
    return failResult<Identity>('That is not an onboarding reference, so no identity was created.');
  }
  if (!actor || !isIdentityRef(actor)) {
    return failResult<Identity>('An identity has to carry the name of the person creating it, and no valid one was given.');
  }

  let db: any;
  let sql: any;
  let app: any;
  try {
    const c = await ctx();
    db = c.db; sql = c.sql;
    const found = rowsOf(await db.execute(sql`
      SELECT ob.id, ob.status, ob.selection_id, ob.person_id, ob.onboarding_code_ref,
             s.decision, s.withdrawn_at, s.employment_type, s.department_id, s.position_id,
             s.proposed_joining_date
        FROM tal_onboarding_application ob
        LEFT JOIN tal_selection_decision s ON s.id = ob.selection_id
       WHERE ob.id = ${appId}::uuid
       LIMIT 1`));
    if (!found.length) {
      return failResult<Identity>('That onboarding record could not be found, so no identity was created.');
    }
    app = found[0];
  } catch (e: any) {
    return failResult<Identity>('The onboarding could not be read, so no identity was created: ' + reasonOf(e));
  }

  // Already done? Return it rather than minting a second. See "IT IS IDEMPOTENT" above.
  try {
    const existing = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS)}
        FROM tal_identity
       WHERE onboarding_application_id = ${appId}::uuid
       ORDER BY created_at ASC
       LIMIT 1`));
    if (existing.length) return okResult<Identity>(toIdentity(existing[0]));
  } catch (e: any) {
    return failResult<Identity>(
      'Could not check whether an identity already exists for this onboarding, and creating a second '
      + 'one is not a risk worth taking. Nothing has been changed: ' + reasonOf(e));
  }

  if (String(app.status) !== 'submitted') {
    return failResult<Identity>(
      'An identity is created from an onboarding that has been submitted and is being decided, and '
      + 'this one is ' + String(app.status).replace(/_/g, ' ') + '. Nothing has been changed.');
  }
  if (!app.selection_id || !app.decision) {
    return failResult<Identity>(
      'The selection behind this onboarding could not be read, so there is nothing to say what '
      + 'somebody was admitted as. No identity was created.');
  }
  if (String(app.decision) !== 'selected') {
    return failResult<Identity>(
      'The decision behind this onboarding is not a selection, so nobody can be admitted on it.');
  }
  if (app.withdrawn_at) {
    return failResult<Identity>(
      'The selection behind this onboarding has been withdrawn, so nobody can be admitted on it. '
      + 'Reinstate the selection first if the withdrawal was wrong.');
  }

  const personId = String(app.person_id || '');
  if (!isIdentityRef(personId)) {
    return failResult<Identity>('This onboarding has no person attached to it, so there is nobody to give an identity to.');
  }

  // A LOGIN ACCOUNT, WHERE THE PERSON SPINE RECORDS ONE. tal_person_identifier is the only link
  // this platform has between a human and a users row; nothing here matches on an email address,
  // because spec 17.2 is explicit that no part of this system keys on one.
  let userId: string | null = null;
  try {
    const acct = rowsOf(await db.execute(sql`
      SELECT value_norm
        FROM tal_person_identifier
       WHERE person_id = ${personId}::uuid AND kind = 'user_account'
       ORDER BY is_verified DESC, created_at ASC
       LIMIT 1`));
    const v = acct.length ? String((acct[0] as any).value_norm || '') : '';
    if (isIdentityRef(v)) userId = v;
  } catch (e: any) {
    // Not fatal: an identity without a login account is a normal state, and the live-identity check
    // below still runs on the person. Logged so the gap is visible rather than assumed away.
    console.error('[talent-identity] user account lookup: ' + reasonOf(e));
  }

  // ONE LIVE IDENTITY PER PERSON. Asked here, in a sentence, rather than left to
  // tal_identity_user_active_uq to answer as a constraint name in an error banner — and it is a
  // wider question than the index can ask, because the index only sees identities with a login
  // account attached.
  try {
    const live = rowsOf(await db.execute(sql`
      SELECT identity_code, status
        FROM tal_identity
       WHERE (person_id = ${personId}::uuid
              OR (${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid))
         AND status IN ('active','on_leave','notice')
       ORDER BY created_at DESC
       LIMIT 1`));
    if (live.length) {
      const held = String((live[0] as any).identity_code || '');
      return failResult<Identity>(
        'This person already holds a live identity (' + held + '), so a second one would be two '
        + 'organizational standings for one human at the same time. If they are moving department '
        + 'or position, that is a Transfer and keeps their code; if they are changing what they are '
        + 'to the organisation, that is a Convert, which issues the new code and closes this one.');
    }
  } catch (e: any) {
    return failResult<Identity>(
      'Could not check whether this person already holds an identity, and issuing a second one is '
      + 'not a risk worth taking. Nothing has been changed: ' + reasonOf(e));
  }

  const identityType = resolveIdentityType(args?.identityType, app.employment_type ? String(app.employment_type) : null);
  const series = codeSeriesFor(identityType);
  const seriesLabel = codeSeriesLabel(series);
  const startDate = args?.startDate
    ? String(args.startDate).slice(0, 10)
    : (app.proposed_joining_date ? String(app.proposed_joining_date).slice(0, 10) : null);
  const departmentId = app.department_id ? String(app.department_id) : null;
  const positionId = app.position_id && isIdentityRef(String(app.position_id)) ? String(app.position_id) : null;
  const employmentType = app.employment_type ? String(app.employment_type) : null;
  const codeRef = String(app.onboarding_code_ref || '');
  const statusReason = 'Created on approval of onboarding ' + (codeRef || appId) + '.';

  // ALLOCATED, NEVER REUSED, NEVER RENUMBERED. allocateCode() reserves the number in one atomic
  // statement and fails loudly rather than handing back a duplicate — src/lib/talent/ids.ts.
  let identityCode = '';
  try {
    identityCode = await allocateCode(series);
  } catch (e: any) {
    return failResult<Identity>('No identity was created because a code could not be allocated: ' + reasonOf(e));
  }

  try {
    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO tal_identity (
        identity_code, code_series, code_is_legacy, person_id, identity_type, employment_type,
        user_id, department_id, position_id, status, start_date,
        onboarding_application_id, selection_id, status_reason, created_by
      ) VALUES (
        ${identityCode}, ${seriesLabel}, FALSE, ${personId}::uuid, ${identityType}, ${employmentType},
        ${userId}::uuid, ${departmentId}::text, ${positionId}::uuid, 'active', ${startDate}::date,
        ${appId}::uuid, ${String(app.selection_id)}::uuid, ${statusReason}, ${actor}::uuid
      )
      RETURNING ${sql.raw(IDENTITY_COLUMNS)}`));
    if (!inserted.length) {
      return failResult<Identity>('The identity was not written and the registry gave no reason. Nothing has been changed.');
    }
    const identity = toIdentity(inserted[0]);
    await emitTalentEvent(
      TALENT_EVENTS.IDENTITY_CREATED, TALENT_SUBJECT_KINDS.IDENTITY, identity.id,
      { identityCode: identity.identityCode, identityType: identity.identityType, source: 'onboarding' },
      actor);
    return okResult<Identity>(identity);
  } catch (e: any) {
    if (String(e?.cause?.code || e?.code || '') === UNIQUE_VIOLATION) {
      return failResult<Identity>(
        'The registry refused a duplicate. Either this person was given an identity by somebody else '
        + 'a moment ago, or the code series has drifted. Nothing has been changed — reload the '
        + 'registry and look for ' + identityCode + ' before trying again.');
    }
    return failResult<Identity>('The identity could not be written, so nothing has been changed: ' + reasonOf(e));
  }
}

/**
 * CHANGE THE STATUS OF AN IDENTITY. The lattice decides; this function only carries it out.
 *
 * The reason is stored on the row, not merely audited, because the row is what the next person to
 * open this registry reads. Closing statuses stamp end_date if the row has not got one, so "when
 * did this end" is answerable from the record rather than from an audit search.
 */
export async function changeIdentityStatus(
  id: string,
  status: string,
  reason: string,
  actorUserId: string,
): Promise<TalentResult<Identity>> {
  const ref = String(id || '').trim();
  const to = String(status || '').trim();
  const why = String(reason || '').trim().slice(0, 2000);
  const actor = String(actorUserId || '').trim();

  if (!isIdentityRef(ref)) return failResult<Identity>('That is not an identity reference, so nothing has been changed.');
  if (!actor || !isIdentityRef(actor)) {
    return failResult<Identity>('A status change has to carry the name of the person making it, and no valid one was given.');
  }

  let db: any;
  let sql: any;
  let current: any;
  try {
    const c = await ctx();
    db = c.db; sql = c.sql;
    const found = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS)} FROM tal_identity WHERE id = ${ref}::uuid LIMIT 1`));
    if (!found.length) return failResult<Identity>('That identity could not be found, so nothing has been changed.');
    current = found[0];
  } catch (e: any) {
    return failResult<Identity>('The identity could not be read, so nothing has been changed: ' + reasonOf(e));
  }

  const from = String(current.status || '');
  // Asked AGAIN here, on the server, after the page has already asked it to decide which buttons to
  // draw. A hidden button is not a lock.
  const problem = statusChangeProblem(from, to, why);
  if (problem) return failResult<Identity>(problem);

  // A closing status stamps the end date if the row has not got one already, so "when did this
  // end" is answerable from the record. Written as a FRAGMENT rather than a bound boolean in a
  // CASE, for the same reason the status filter above is one.
  const endDate = isClosedStatus(to) ? sql`COALESCE(end_date, CURRENT_DATE)` : sql`end_date`;
  try {
    // Guarded on the status this decision was made against, so two operators acting at the same
    // moment cannot both apply a move; the loser is told the state changed under them.
    const moved = rowsOf(await db.execute(sql`
      UPDATE tal_identity
         SET status = ${to},
             status_reason = ${why},
             end_date = ${endDate},
             updated_at = NOW()
       WHERE id = ${ref}::uuid AND status = ${from}
      RETURNING ${sql.raw(IDENTITY_COLUMNS)}`));
    if (!moved.length) {
      return failResult<Identity>(
        'This identity is no longer ' + (IDENTITY_STATUS_LABELS[from as IdentityStatus] || from).toLowerCase()
        + ', so the change was not applied. Somebody else moved it while this page was open — reload '
        + 'and look at where it is now.');
    }
    const identity = toIdentity(moved[0]);
    // The catalogue has a name for three of these; the rest are carried by the audit entry the page
    // writes. An invented event name would be a name nothing subscribes to.
    const eventName = to === 'suspended' ? TALENT_EVENTS.ACCOUNT_SUSPENDED
      : to === 'terminated' ? TALENT_EVENTS.ACCOUNT_TERMINATED
      : to === 'active' ? TALENT_EVENTS.ACCOUNT_ACTIVATED
      : null;
    if (eventName) {
      await emitTalentEvent(
        eventName, TALENT_SUBJECT_KINDS.IDENTITY, identity.id,
        { identityCode: identity.identityCode, from, to }, actor);
    }
    return okResult<Identity>(identity);
  } catch (e: any) {
    if (String(e?.cause?.code || e?.code || '') === UNIQUE_VIOLATION) {
      // tal_identity_user_active_uq: exactly one ACTIVE identity per login account. Reachable by
      // activating a second identity attached to an account that already has one, which is a real
      // mistake with a plain explanation and should not be shown as a constraint name.
      return failResult<Identity>(
        'The login account attached to this identity already has an active identity, and one account '
        + 'holds one at a time. Nothing has been changed. Close the other one first, or convert it if '
        + 'this is a change of what this person is to the organisation.');
    }
    return failResult<Identity>('The status could not be changed, so nothing has been changed: ' + reasonOf(e));
  }
}

/**
 * TRANSFER — new department, new position, SAME identity code. Spec 17.6 rule 5.
 *
 * A promotion and a departmental move are the same act here, and neither issues a code. The reason
 * is recorded in the audit entry and the event; it is NOT written to status_reason, because that
 * column explains the STATUS and overwriting it with a transfer note would leave the next reader
 * with no explanation for why somebody is suspended.
 *
 * An omitted field is left alone rather than cleared. Clearing a department or a position outright
 * is not offered from here: an identity with neither is a standing nothing can derive access from,
 * and that is a decision for the access desk, not a side effect of a move.
 */
export async function transferIdentity(
  id: string,
  to: { departmentId?: string | null; positionId?: string | null },
  reason: string,
  actorUserId: string,
): Promise<TalentResult<Identity>> {
  const ref = String(id || '').trim();
  const dept = String(to?.departmentId || '').trim();
  const pos = String(to?.positionId || '').trim();
  const why = String(reason || '').trim().slice(0, 2000);
  const actor = String(actorUserId || '').trim();

  if (!isIdentityRef(ref)) return failResult<Identity>('That is not an identity reference, so nothing has been moved.');
  if (!actor || !isIdentityRef(actor)) {
    return failResult<Identity>('A transfer has to carry the name of the person making it, and no valid one was given.');
  }

  let db: any;
  let sql: any;
  let current: any;
  try {
    const c = await ctx();
    db = c.db; sql = c.sql;
    const found = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS)} FROM tal_identity WHERE id = ${ref}::uuid LIMIT 1`));
    if (!found.length) return failResult<Identity>('That identity could not be found, so nothing has been moved.');
    current = found[0];
  } catch (e: any) {
    return failResult<Identity>('The identity could not be read, so nothing has been moved: ' + reasonOf(e));
  }

  const problem = transferProblem(String(current.status || ''), dept, pos, why);
  if (problem) return failResult<Identity>(problem);

  const fromDept = current.department_id ? String(current.department_id) : null;
  const fromPos = current.position_id ? String(current.position_id) : null;

  try {
    // department_id is TEXT on BOTH sides. departments.id is varchar(50); a ::uuid cast here is a
    // guaranteed 500 on this project — schema.ts rule 1, spec F8.
    const moved = rowsOf(await db.execute(sql`
      UPDATE tal_identity
         SET department_id = COALESCE(${dept || null}::text, department_id),
             position_id   = COALESCE(${pos || null}::uuid, position_id),
             updated_at    = NOW()
       WHERE id = ${ref}::uuid
      RETURNING ${sql.raw(IDENTITY_COLUMNS)}`));
    if (!moved.length) return failResult<Identity>('The transfer was not applied and the registry gave no reason. Nothing has been changed.');
    const identity = toIdentity(moved[0]);
    await emitTalentEvent(
      TALENT_EVENTS.IDENTITY_TRANSFERRED, TALENT_SUBJECT_KINDS.IDENTITY, identity.id,
      {
        identityCode: identity.identityCode,
        fromDepartmentId: fromDept, toDepartmentId: identity.departmentId,
        fromPositionId: fromPos, toPositionId: identity.positionId,
      },
      actor);
    return okResult<Identity>(identity);
  } catch (e: any) {
    return failResult<Identity>('The transfer could not be written, so nothing has been changed: ' + reasonOf(e));
  }
}

/**
 * CONVERT — a NEW identity, a NEW code, the old one closed and linked. Spec 17.6 rule 6.
 *
 * WHY A NEW ROW. An intern who becomes an employee has not stopped having been an intern. Writing
 * 'employee' over identity_type would leave a single row saying they have always been staff, the
 * internship would exist nowhere, and the ERAI-INT code on their internship certificate would
 * resolve to an employee record that contradicts it. So: the employee identity is inserted with
 * previous_identity_id pointing at the internship, and the internship is closed as `converted` in
 * the same transaction. Both codes stay resolvable forever, and the chain answers "how long has
 * this person been with us" — which is exactly what a renumbering would have destroyed.
 *
 * ONE TRANSACTION, AND WHY IT HAS TO BE. tal_identity_user_active_uq permits exactly one ACTIVE
 * identity per login account. The close and the insert therefore cannot be two statements: doing
 * the insert first hits the index, and doing the close first leaves — if the insert then fails — a
 * person closed out of the organisation with no successor and no access. Both, or neither.
 *
 * THE CODE IS ALLOCATED BEFORE THE TRANSACTION OPENS, and that is an honest cost rather than an
 * oversight: allocateCode() runs its own statement on the pool and takes no transaction handle, so
 * a conversion that rolls back leaves a gap in that series' numbering. A gap is survivable and
 * explicable. Allocating inside a transaction that might retry is how a series develops a
 * DUPLICATE, which is not.
 */
export async function convertIdentity(
  id: string,
  newType: string,
  reason: string,
  actorUserId: string,
): Promise<TalentResult<Identity>> {
  const ref = String(id || '').trim();
  const toType = String(newType || '').trim().toLowerCase();
  const why = String(reason || '').trim().slice(0, 2000);
  const actor = String(actorUserId || '').trim();

  if (!isIdentityRef(ref)) return failResult<Identity>('That is not an identity reference, so nothing has been converted.');
  if (!actor || !isIdentityRef(actor)) {
    return failResult<Identity>('A conversion has to carry the name of the person making it, and no valid one was given.');
  }

  let db: any;
  let sql: any;
  let current: any;
  try {
    const c = await ctx();
    db = c.db; sql = c.sql;
    const found = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(IDENTITY_COLUMNS)} FROM tal_identity WHERE id = ${ref}::uuid LIMIT 1`));
    if (!found.length) return failResult<Identity>('That identity could not be found, so nothing has been converted.');
    current = found[0];
  } catch (e: any) {
    return failResult<Identity>('The identity could not be read, so nothing has been converted: ' + reasonOf(e));
  }

  const fromStatus = String(current.status || '');
  const fromType = String(current.identity_type || '');
  const problem = conversionProblem(fromStatus, fromType, toType, why);
  if (problem) return failResult<Identity>(problem);

  const series = codeSeriesFor(toType);
  const seriesLabel = codeSeriesLabel(series);
  let newCode = '';
  try {
    newCode = await allocateCode(series);
  } catch (e: any) {
    return failResult<Identity>('Nothing has been converted because a code could not be allocated: ' + reasonOf(e));
  }

  const oldCode = String(current.identity_code || '');
  const closeReason = 'Converted to ' + toType.replace(/_/g, ' ') + ' as ' + newCode + '. ' + why;
  const openReason = 'Converted from ' + fromType.replace(/_/g, ' ') + ' identity ' + oldCode + '. ' + why;

  try {
    let created: any = null;
    await db.transaction(async (tx: any) => {
      // CLOSE FIRST, INSIDE THE TRANSACTION. Guarded on the status this decision was made against,
      // so a simultaneous suspension or termination makes this conversion fail rather than silently
      // overwrite somebody else's decision.
      const closed = rowsOf(await tx.execute(sql`
        UPDATE tal_identity
           SET status = 'converted',
               status_reason = ${closeReason},
               end_date = COALESCE(end_date, CURRENT_DATE),
               updated_at = NOW()
         WHERE id = ${ref}::uuid AND status = ${fromStatus}
        RETURNING id`));
      if (!closed.length) {
        throw new Error('IDENTITY_MOVED');
      }
      const inserted = rowsOf(await tx.execute(sql`
        INSERT INTO tal_identity (
          identity_code, code_series, code_is_legacy, person_id, identity_type,
          user_id, hr_employee_id, username, work_email, department_id, position_id,
          status, start_date, previous_identity_id, status_reason, created_by
        )
        SELECT ${newCode}::text, ${seriesLabel}::text, FALSE, o.person_id, ${toType}::text,
               o.user_id, o.hr_employee_id, o.username, o.work_email, o.department_id, o.position_id,
               'active', CURRENT_DATE, o.id, ${openReason}::text, ${actor}::uuid
          FROM tal_identity o
         WHERE o.id = ${ref}::uuid
        RETURNING ${sql.raw(IDENTITY_COLUMNS)}`));
      if (!inserted.length) throw new Error('IDENTITY_NOT_INSERTED');
      created = inserted[0];
    });

    if (!created) {
      return failResult<Identity>('The conversion did not complete and nothing has been changed.');
    }
    const identity = toIdentity(created);
    await emitTalentEvent(
      TALENT_EVENTS.IDENTITY_CONVERTED, TALENT_SUBJECT_KINDS.IDENTITY, identity.id,
      {
        fromIdentityId: ref, fromIdentityCode: oldCode, fromType,
        toIdentityCode: identity.identityCode, toType,
      },
      actor);
    return okResult<Identity>(identity);
  } catch (e: any) {
    const marker = String(e?.message || '');
    if (marker === 'IDENTITY_MOVED') {
      return failResult<Identity>(
        'This identity is no longer ' + (IDENTITY_STATUS_LABELS[fromStatus as IdentityStatus] || fromStatus).toLowerCase()
        + ', so it was not converted and NOTHING has been changed. Somebody else moved it while this '
        + 'page was open. The code ' + newCode + ' was allocated and is now unused, which is a gap in '
        + 'the series and not a problem — codes are never reused.');
    }
    if (String(e?.cause?.code || e?.code || '') === UNIQUE_VIOLATION) {
      return failResult<Identity>(
        'The registry refused a duplicate, so NOTHING has been changed: this person still holds an '
        + 'active identity attached to the same login account. Close that one first.');
    }
    // The whole transaction rolled back, so the old identity is untouched and no new one exists.
    return failResult<Identity>(
      'The conversion failed and was rolled back, so NOTHING has been changed — the existing '
      + 'identity is exactly as it was: ' + reasonOf(e));
  }
}
