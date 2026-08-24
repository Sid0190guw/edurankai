// src/lib/talent/candidates.ts — THE CANDIDATE REGISTER.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 24, 26.1, 26.4, 27, 32 and 43.
//
// ---------------------------------------------------------------------------------------------
// ONE HUMAN, MANY APPLICATIONS. THAT IS THE WHOLE POINT OF THIS MODULE.
// ---------------------------------------------------------------------------------------------
// Spec 27 states the cardinality rule first: "One person, many applications. Enforced by
// tal_person_identifier, not by string matching." tal_person is the spine and tal_application hangs
// off it, so every read in here returns A PERSON WITH THEIR APPLICATIONS NESTED. There is no
// exported function that answers with one row per application wearing a person's name, because that
// shape is how the same human turns into four "candidates" in a register, gets four emails, and
// gets asked the same screening question by four different people.
//
// The nesting is done in SQL — json_agg inside a single grouped statement — rather than by reading
// applications and grouping them in TypeScript, because grouping after a LIMIT gives a page of
// applications reshaped into a partial page of people, and the count under each name is then a lie
// about that page rather than about that person.
//
// ---------------------------------------------------------------------------------------------
// A CONFIRMED MERGE IS A POINTER, NOT A REWRITE
// ---------------------------------------------------------------------------------------------
// tal_person.merged_into_id is documented in spec 26.1 as "set when this row loses a merge; never
// deleted". So confirmMerge() sets that pointer and decides the proposal, and it does NOT repoint
// tal_application.person_id. Two reasons, both concrete:
//
//   * tal_app_person_opp_uq is UNIQUE (person_id, opportunity_id). If both records applied to the
//     same opportunity, repointing would violate it and the merge would fail half way through.
//   * Rewriting the person on a historical application destroys the record of which submission
//     arrived under which name, which is the evidence anyone reviewing the merge later would need.
//
// Every read here therefore folds on COALESCE(merged_into_id, id) — the EFFECTIVE person — so the
// surviving record shows both records' applications the moment the merge is confirmed, while the
// applications themselves still say which record they arrived on.
//
// ONE HOP, AND CHAINS ARE REFUSED RATHER THAN FOLLOWED. mergeDecisionProblem() refuses to merge into
// a record that has itself been merged away, so a chain is never created here and a single COALESCE
// is sufficient. A chain arriving from some other writer would leave the deepest record showing
// under its immediate parent instead of the root; that is visible on screen and is not silently
// resolved, because guessing at the root of a chain nobody built is worse than showing what is
// actually recorded.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODULE WILL NOT RETURN — spec 32.1 and 32.2
// ---------------------------------------------------------------------------------------------
// This is a RECRUITMENT register. It returns recruitment facts and nothing else:
//
//   * NO identity documents and no Drive links. tal_document_ref is not read here at all; a
//     sensitive document needs `document.view_sensitive`, which is a separate desk (spec 33.2).
//   * NO government identifiers, bank details, date of birth or address. None of those columns are
//     selected, in any query in this file.
//   * NO health-adjacent data of any kind, and nothing from the wellness system. That system is
//     gated server-side and women-only; it has no business being joined to a hiring screen.
//   * tal_person_identifier is read for its KIND ONLY — never value_norm. An identifier row can
//     hold an external reference or a government-issued number depending on who wrote it, so
//     identifierKindsFor() aggregates COUNT(*) per kind and returns no value at all. The one place
//     an identifier value is touched is the SEARCH predicate, restricted to kinds 'email' and
//     'phone', where the operator already holds the value they are typing.
//
// ---------------------------------------------------------------------------------------------
// EMPTY IS NOT UNREADABLE — spec 43 rule 2
// ---------------------------------------------------------------------------------------------
// listCandidates(), candidateCounts(), candidateDetail() and listMergeProposals() all RETHROW.
// "Nobody has applied" and "we could not read who applied" render as the same empty table and mean
// opposite things, and on this screen the second one wearing the first one's clothes is how a real
// candidate gets told there is no record of them. The page catches and prints the reason.
import { ensureTalentSchema } from './schema';
import { identifyCode } from './ids';
import { uuidish } from '@/lib/page-safety';
import {
  rowsOf, reasonOf, okResult, failResult, normEmail,
  CANDIDATE_STATUSES, candidateStatusLabel,
  IDENTIFIER_KINDS,
  type CandidateStatus, type MergeStatus, type TalentResult,
} from './types';

// ---------------------------------------------------------------------------------------------
// EVERY const IS DECLARED BEFORE ANYTHING USES IT. `const` is not hoisted, and a function reaching
// a later declaration threw on its first line every time while the caller reported success — that
// is a recorded outage on this project, not a style preference.
// ---------------------------------------------------------------------------------------------

/** A merge decision is a claim about two humans. Ten characters is a floor, not a quality bar. */
export const MIN_MERGE_REASON = 10;

/** Hard ceiling on one page of the register. People, not applications. */
export const MAX_REGISTER_PAGE = 200;

/**
 * The buckets the register counts and filters by. Spec 24 draws the status graph; these group it
 * into the five questions an operator actually asks a register.
 *
 * THE SQL AND statusBucket() READ THESE SAME ARRAYS. A second copy of "which statuses are still
 * live" written into a query is how a tile and its own drill-through come to disagree.
 */
export const IN_PROGRESS_STATUSES: readonly CandidateStatus[] = [
  'application_received', 'under_review', 'shortlisted',
  'assessment_pending', 'assessment_completed',
  'interview_pending', 'interview_completed',
  'final_review',
];
export const DECIDED_STATUSES: readonly CandidateStatus[] = ['selected', 'waitlisted'];
export const ONBOARDING_STATUSES_C: readonly CandidateStatus[] = [
  'onboarding_invited', 'onboarding_started', 'onboarding_pending', 'onboarding_approved',
];
export const JOINED_STATUSES: readonly CandidateStatus[] = ['active'];
export const CLOSED_STATUSES: readonly CandidateStatus[] = ['rejected', 'withdrawn'];

export type StatusBucket = 'in_progress' | 'decided' | 'onboarding' | 'joined' | 'closed';

const BUCKET_STATUSES: Record<StatusBucket, readonly CandidateStatus[]> = {
  in_progress: IN_PROGRESS_STATUSES,
  decided: DECIDED_STATUSES,
  onboarding: ONBOARDING_STATUSES_C,
  joined: JOINED_STATUSES,
  closed: CLOSED_STATUSES,
};

export const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
  in_progress: 'In progress',
  decided: 'Decision recorded',
  onboarding: 'In onboarding',
  joined: 'Joined',
  closed: 'Closed',
};

/**
 * Display words for the identifier kinds. THE KINDS THEMSELVES COME FROM types.ts — this map only
 * gives them English, and a kind that appears in the database without appearing here falls back to
 * its raw key rather than being hidden.
 */
export const IDENTIFIER_KIND_LABELS: Record<string, string> = {
  email: 'Email address',
  phone: 'Phone number',
  external: 'Reference from another system',
  user_account: 'Account on this platform',
  identity: 'Identity code',
};

/** Lazy, exactly as codes.ts and selection.ts do it: the pure rules below stay testable. */
async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const iso = (v: unknown): string | null => {
  if (!v) return null;
  try {
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
};

/**
 * LIKE metacharacters escaped, so a term containing a per-cent sign does not become a
 * match-everything scan — which on a search box reads as "the filter is broken".
 */
export const likeTerm = (q: string): string => '%' + String(q || '').replace(/[\\%_]/g, (m) => '\\' + m) + '%';

/**
 * A JSONB column that arrives as text must not blank the row it belongs to — and a payload that
 * will not parse must not be reported as an EMPTY one either.
 *
 * Returns null, distinctly, on failure. `{}` is what the column's own default holds and honestly
 * means "nothing was recorded"; null here means "something was recorded and could not be read", and
 * the caller says which. Collapsing the two was the same swallow this module exists to refuse.
 */
const safeJson = (v: string): any => { try { return JSON.parse(v); } catch { return null; } };

// ---------------------------------------------------------------------------------------------
// PURE RULES. Nothing below this line to the persistence heading opens a connection, which is what
// makes candidates.test.ts able to exercise them.
// ---------------------------------------------------------------------------------------------

/**
 * PURE. Which bucket a candidate status falls in.
 *
 * Reads the same five arrays the counting query does. `unknown` is returned rather than guessed:
 * a status this build has never heard of belongs in no tile, and quietly filing it under "closed"
 * would make a live candidate disappear from the register.
 */
export function statusBucket(status: string): StatusBucket | 'unknown' {
  const s = String(status || '');
  const keys = Object.keys(BUCKET_STATUSES) as StatusBucket[];
  for (const k of keys) {
    if ((BUCKET_STATUSES[k] as readonly string[]).includes(s)) return k;
  }
  return 'unknown';
}

/** PURE. The statuses a bucket covers, or an empty list for anything else. */
export function statusesInBucket(bucket: string): readonly CandidateStatus[] {
  const b = String(bucket || '') as StatusBucket;
  return BUCKET_STATUSES[b] || [];
}

/**
 * PURE. Turn the `status` filter into the exact list of statuses to match, or null for no filter.
 *
 * Accepts a bucket key, a single CandidateStatus, 'all', or nothing. ANYTHING ELSE IS NO FILTER
 * RATHER THAN NO ROWS: a filter value this build does not recognise must not silently produce an
 * empty register that reads as "there are no candidates".
 */
export function resolveStatusFilter(status: unknown): readonly CandidateStatus[] | null {
  const s = String(status || '').trim();
  if (!s || s === 'all') return null;
  const bucket = statusesInBucket(s);
  if (bucket.length) return bucket;
  if ((CANDIDATE_STATUSES as readonly string[]).includes(s)) return [s as CandidateStatus];
  return null;
}

// ---------------------------------------------------------------------------------------------
// SEARCH CLASSIFICATION — the rule this module exists to get right.
//
// An operator's search box takes whatever is on the clipboard, and this platform mints EIGHT
// identifier namespaces that all begin ERAI- (types.ts ID_PREFIX). A register that answers "no such
// candidate" to a pasted opportunity code has given a confident wrong answer to a question it never
// understood. So the term is CLASSIFIED first, the search still runs exactly as typed, and the page
// says what was actually pasted when it belongs to a different register.
//
// ERAI-ONBCODE AND ERAI-ONB SHARE A STEM, which is the collision spec F11 splits apart: the
// identifier of an onboarding code is not the identifier of an onboarding application. identifyCode()
// sorts by prefix length so the longer one is tested first; this function inherits that and
// candidates.test.ts pins it, because a match on the shorter prefix would file every onboarding code
// under the wrong register.
//
// ERAI-INT IS AN INTERN IDENTITY, NOT AN INTERNSHIP OPPORTUNITY — finding F10. Opportunities take
// ERAI-OPP. Both get pasted into this box and they must not classify the same.
// ---------------------------------------------------------------------------------------------

export type SearchKind =
  | 'empty'
  | 'text'
  | 'email'
  | 'person_code'
  | 'candidate_code'
  | 'application_code'
  | 'opportunity_code'
  | 'selection_code'
  | 'onboarding_code_ref'
  | 'onboarding_ref'
  | 'identity_code';

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  empty: 'Nothing typed',
  text: 'Free text',
  email: 'Email address',
  person_code: 'Person reference',
  candidate_code: 'Candidate reference',
  application_code: 'Application reference',
  opportunity_code: 'Opportunity reference',
  selection_code: 'Selection reference',
  onboarding_code_ref: 'Onboarding code reference',
  onboarding_ref: 'Onboarding application reference',
  identity_code: 'Identity code',
};

/**
 * Where a code that this register cannot answer actually belongs. Only kinds with `searchable`
 * false appear here, and the words are the sidebar's own so an operator can follow them.
 */
export const SEARCH_ELSEWHERE: Record<string, string> = {
  opportunity_code: 'the Opportunities register, or the opportunity filter on this page',
  selection_code: 'Selected candidates',
  onboarding_code_ref: 'Onboarding codes',
  onboarding_ref: 'Onboarding review',
  identity_code: 'the Identity registry',
};

export interface SearchClassification {
  kind: SearchKind;
  /** What to search with. Codes are upper-cased, an email lower-cased, free text merely trimmed. */
  term: string;
  /** True when this register can answer the term at all. */
  searchable: boolean;
  /** Where to look instead, when searchable is false. Null otherwise. */
  belongsTo: string | null;
}

/**
 * PURE. What kind of thing did the operator type?
 *
 * The kind is decided by NAMESPACE, not by whether the digits are well formed: "ERAI-PER-oops" is
 * still somebody reaching for a person, and telling them so is more useful than calling it free
 * text. looksLikeCode() in ids.ts is the strict test, and this is deliberately not it.
 */
export function classifySearch(raw: unknown): SearchClassification {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { kind: 'empty', term: '', searchable: true, belongsTo: null };

  const codeKind = identifyCode(trimmed);
  if (codeKind) {
    const upper = trimmed.toUpperCase();
    if (codeKind === 'person') return { kind: 'person_code', term: upper, searchable: true, belongsTo: null };
    if (codeKind === 'candidate') return { kind: 'candidate_code', term: upper, searchable: true, belongsTo: null };
    if (codeKind === 'application') return { kind: 'application_code', term: upper, searchable: true, belongsTo: null };

    let kind: SearchKind = 'identity_code';
    if (codeKind === 'opportunity') kind = 'opportunity_code';
    else if (codeKind === 'selection') kind = 'selection_code';
    // ORDER MATTERS NOWHERE HERE, because identifyCode() already resolved the ONBCODE/ONB stem.
    else if (codeKind === 'onboardingCode') kind = 'onboarding_code_ref';
    else if (codeKind === 'onboarding') kind = 'onboarding_ref';
    return { kind, term: upper, searchable: false, belongsTo: SEARCH_ELSEWHERE[kind] || null };
  }

  // An address is normalised the one way this platform normalises addresses — types.ts normEmail —
  // so the search term and the stored identifier are the same string or neither is.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { kind: 'email', term: normEmail(trimmed), searchable: true, belongsTo: null };
  }

  return { kind: 'text', term: trimmed, searchable: true, belongsTo: null };
}

// ---------------------------------------------------------------------------------------------
// MERGE RULES — spec 26.1 and finding F2.
// ---------------------------------------------------------------------------------------------

export type ConfidenceBand = 'strong' | 'possible' | 'weak' | 'unstated';

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  strong: 'Strong match',
  possible: 'Possible match',
  weak: 'Weak match',
  unstated: 'No confidence recorded',
};

/**
 * PURE. A readable band for a proposal's confidence.
 *
 * ADVISORY ONLY, and the screen says so in words. Nothing in this module lets a band decide a merge:
 * a "strong match" on an email is exactly finding F2's failure — two students who shared a college
 * address — and the band exists to order a queue a human works through, never to shorten it.
 *
 * A value outside 0..1 is not a confidence and is reported as unstated rather than clamped upward,
 * because a writer that stored 5 in a NUMERIC(4,3) meant something this scale cannot express.
 */
export function confidenceBand(confidence: unknown): ConfidenceBand {
  if (confidence === null || confidence === undefined || confidence === '') return 'unstated';
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 'unstated';
  if (n < 0 || n > 1) return 'unstated';
  if (n >= 0.9) return 'strong';
  if (n >= 0.6) return 'possible';
  return 'weak';
}

/**
 * PURE. What a proposal says it matched on, WITHOUT ever returning what it matched.
 *
 * `evidence` is free-shaped JSONB written by whatever proposed the merge, so its values can be an
 * email address, a phone number or an external reference. The signal an operator needs is which
 * axis matched, and that is the KEY. Values never leave this function — candidates.test.ts asserts
 * that directly, because a helper that leaked one would put identifier values on a list screen.
 */
export function evidenceSignals(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const keys = Object.keys(evidence as Record<string, unknown>);
  const words = keys.slice(0, 8).map((k) => {
    const spaced = String(k)
      .replace(/[_\-.]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim()
      .toLowerCase();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : '';
  });
  return words.filter(Boolean);
}

export interface MergeDecisionInput {
  /** The proposal's current status. Only 'proposed' may be decided. */
  status: string;
  keepPersonId: string;
  mergePersonId: string;
  reason: string;
  /** Set when the record to KEEP has itself already been folded into another. */
  keepAlreadyMergedInto?: string | null;
  /** Set when the record to FOLD has already been folded into something. */
  mergeAlreadyMergedInto?: string | null;
}

/**
 * PURE. Why this merge decision may not proceed, in the words the operator is shown. Null when it
 * may.
 *
 * `confirm` and `reject` share the identity and reason rules and differ on the chain rules: a
 * rejection is a statement that two records are two people, and that is safe to record whatever
 * either record has since become.
 */
export function mergeDecisionProblem(
  input: MergeDecisionInput,
  decision: 'confirm' | 'reject',
): string | null {
  const keep = String(input.keepPersonId || '').trim();
  const fold = String(input.mergePersonId || '').trim();
  const reason = String(input.reason || '').trim();

  if (String(input.status || '') !== 'proposed') {
    return 'That proposal has already been decided. A decided merge is not re-opened from this screen.';
  }
  if (!keep || !fold) {
    return 'The proposal does not name both records, so there is nothing to decide.';
  }
  if (keep === fold) {
    return 'The proposal names the same record twice. That is a defect in the proposal, not a merge.';
  }
  if (reason.length < MIN_MERGE_REASON) {
    return decision === 'confirm'
      ? 'A confirmed merge needs a written reason of at least ' + MIN_MERGE_REASON
        + ' characters. It is permanent, and the reason is what anybody reading this record later has to go on.'
      : 'A rejection needs a written reason of at least ' + MIN_MERGE_REASON
        + ' characters, so the next person to see this pair knows it was looked at.';
  }
  if (decision === 'confirm') {
    if (input.keepAlreadyMergedInto) {
      return 'The record to keep has itself been folded into another record. Merge into the surviving record instead; this screen does not build chains.';
    }
    if (input.mergeAlreadyMergedInto && input.mergeAlreadyMergedInto !== keep) {
      return 'The record to fold has already been folded into a different record. Nothing has been changed.';
    }
  }
  return null;
}

export interface MergeSideSummary {
  personCode: string;
  displayName: string;
  applicationCount: number;
}

/**
 * PURE. The sentence shown BEFORE a merge is confirmed, spelling out exactly what will happen.
 *
 * A confirmed merge is not reversible from this screen, so the screen has to say what it does in
 * full before the button is pressed rather than afterwards in a toast.
 */
export function describeMergeEffect(keep: MergeSideSummary, fold: MergeSideSummary): string[] {
  const keepName = keep.displayName || keep.personCode || 'the record to keep';
  const foldName = fold.displayName || fold.personCode || 'the record to fold';
  return [
    'Confirming records that ' + foldName + ' (' + fold.personCode + ') and ' + keepName
      + ' (' + keep.personCode + ') are one human.',
    fold.personCode + ' is marked as folded into ' + keep.personCode + '. It is not deleted, and its '
      + applicationsPhrase(fold.applicationCount) + ' stay attached to it.',
    'From then on the register shows one entry, ' + keep.personCode + ', carrying '
      + applicationsPhrase(keep.applicationCount + fold.applicationCount) + '.',
    'This screen cannot undo it. Reversing a confirmed merge is a database correction with a written record.',
  ];
}

/** PURE. "No applications", "1 application", "4 applications". Used in copy and in the register. */
export function applicationsPhrase(n: number): string {
  const c = Math.max(0, Math.floor(Number(n) || 0));
  if (c === 0) return 'no applications';
  if (c === 1) return '1 application';
  return c + ' applications';
}

/**
 * PURE. Opportunities BOTH records applied to.
 *
 * Shown on the merge panel because it is the fact an operator most needs and least expects: if the
 * same human applied twice to one opportunity under two records, that is a duplicate application to
 * resolve, and confirming the merge does not resolve it — tal_application rows are not repointed,
 * so both submissions remain and both remain live in whatever stage they reached.
 */
export function overlappingOpportunities(
  a: { opportunityId: string; opportunityTitle: string }[],
  b: { opportunityId: string; opportunityTitle: string }[],
): string[] {
  const seen = new Map<string, string>();
  for (const x of a || []) if (x && x.opportunityId) seen.set(x.opportunityId, x.opportunityTitle || x.opportunityId);
  const out: string[] = [];
  for (const y of b || []) {
    if (y && y.opportunityId && seen.has(y.opportunityId)) {
      const title = seen.get(y.opportunityId) as string;
      if (!out.includes(title)) out.push(title);
    }
  }
  return out;
}

/**
 * PURE. A whitelisted SQL literal list.
 *
 * EVERY MEMBER IS CHECKED AGAINST CANDIDATE_STATUSES BEFORE IT IS EMITTED, so nothing that reaches
 * sql.raw() can have come from a request. It exists because the status filter is a LIST and the
 * lists are module constants — binding N parameters for a constant would not make it safer, and
 * building the literal without this check would.
 */
export function statusLiteralList(statuses: readonly string[]): string {
  const safe = (statuses || []).filter((s) => (CANDIDATE_STATUSES as readonly string[]).includes(String(s)));
  if (!safe.length) return "''";
  return safe.map((s) => "'" + String(s).replace(/'/g, "''") + "'").join(', ');
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_person, tal_person_identifier, tal_candidate_profile, tal_application,
// tal_person_merge. Column names are exactly those in src/lib/talent/schema.ts.
//
// NO DDL IN THIS FILE. ensureTalentSchema() owns every tal_* table; ctx() calls it and this module
// creates nothing, alters nothing and adds no column of its own.
//
// department_id IS TEXT, EVERYWHERE. There is no ::uuid anywhere near it in this file — that cast
// is a guaranteed production 500 on this project (spec F8, schema.ts rule 1).
// ---------------------------------------------------------------------------------------------

export interface CandidateApplicationRow {
  applicationId: string;
  applicationCode: string;
  opportunityId: string;
  opportunityCode: string;
  opportunityTitle: string;
  /** TEXT. Never cast to uuid. */
  departmentId: string;
  departmentName: string;
  employmentType: string;
  status: string;
  statusLabel: string;
  bucket: StatusBucket | 'unknown';
  currentStageKey: string;
  /** The stage's configured label, when the pipeline still carries that key. */
  currentStageLabel: string;
  isInternal: boolean;
  submittedAt: string | null;
  closedAt: string | null;
  /** The person row this application actually arrived on — differs after a merge. */
  onPersonId: string;
  onPersonCode: string;
  /** True when this application is one the active filter selected. Set by listCandidates(). */
  matchesFilter: boolean;
}

export interface CandidateRow {
  personId: string;
  personCode: string;
  displayName: string;
  preferredName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  country: string | null;
  candidateCode: string;
  headline: string;
  talentPool: boolean;
  /** Every application this human has, newest first. Never one row per application at top level. */
  applications: CandidateApplicationRow[];
  applicationCount: number;
  /**
   * TRUE when the nested applications arrived in a shape this code could not read, so the empty
   * list above means "could not be read" and NOT "this person has none". The screen must say which;
   * they are opposite facts and they render as the same blank space.
   */
  applicationsUnreadable: boolean;
  /** How many other person rows have been folded into this one by a confirmed merge. */
  foldedInCount: number;
  lastActivityAt: string | null;
}

export interface CandidateFilter {
  q?: string;
  /** A StatusBucket, a single CandidateStatus, or 'all'. Anything unrecognised means no filter. */
  status?: string;
  opportunityId?: string;
  limit?: number;
  offset?: number;
}

function toApplication(x: any): CandidateApplicationRow {
  const status = String(x?.status || '');
  return {
    applicationId: String(x?.application_id || ''),
    applicationCode: String(x?.application_code || ''),
    opportunityId: String(x?.opportunity_id || ''),
    opportunityCode: String(x?.opportunity_code || ''),
    opportunityTitle: String(x?.opportunity_title || ''),
    departmentId: String(x?.department_id || ''),
    departmentName: String(x?.department_name || ''),
    employmentType: String(x?.employment_type || ''),
    status,
    statusLabel: candidateStatusLabel(status),
    bucket: statusBucket(status),
    currentStageKey: String(x?.current_stage_key || ''),
    currentStageLabel: String(x?.current_stage_label || ''),
    isInternal: x?.is_internal === true,
    submittedAt: iso(x?.submitted_at),
    closedAt: iso(x?.closed_at),
    onPersonId: String(x?.on_person_id || ''),
    onPersonCode: String(x?.on_person_code || ''),
    matchesFilter: true,
  };
}

/**
 * Shape one database row into a person with their applications nested.
 *
 * EXPORTED FOR ONE REASON: the unreadable-versus-empty rule below is the dominant defect class on
 * this project and it needs an assertion of its own. It opens no connection, so the test does not
 * either.
 */
export function toCandidate(x: any): CandidateRow {
  const raw = x?.applications;
  let list: any[] = [];
  // AN UNREADABLE PAYLOAD IS NOT AN EMPTY ONE. json_agg with its COALESCE always yields an array, so
  // reaching a failure branch here means the value arrived in a shape this code does not understand.
  // Rendering that as "no application recorded against this person" is exactly the empty-state lie
  // this module is built to refuse — on this screen it tells a real candidate there is no record of
  // them. The flag travels to the page, which says which of the two it is.
  let unreadable = false;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') {
    // A driver that hands JSON back as text must not blank a candidate's whole history.
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
      else unreadable = true;
    } catch { unreadable = true; }
  } else if (raw !== null && raw !== undefined) {
    unreadable = true;
  }
  const applications = list.map(toApplication);
  return {
    personId: String(x?.id || ''),
    personCode: String(x?.person_code || ''),
    displayName: String(x?.display_name || ''),
    preferredName: x?.preferred_name ? String(x.preferred_name) : null,
    primaryEmail: x?.primary_email ? String(x.primary_email) : null,
    primaryPhone: x?.primary_phone ? String(x.primary_phone) : null,
    country: x?.country ? String(x.country) : null,
    candidateCode: String(x?.candidate_code || ''),
    headline: String(x?.headline || ''),
    talentPool: x?.talent_pool === true,
    applications,
    applicationCount: applications.length,
    applicationsUnreadable: unreadable,
    foldedInCount: Number(x?.folded_in_count || 0),
    lastActivityAt: iso(x?.last_activity_at),
  };
}

/**
 * THE REGISTER. One row per HUMAN, with their applications nested. RETHROWS.
 *
 * WHAT THE FILTERS DO, PRECISELY, because the two readings differ and the wrong one hides records.
 * The filters choose WHICH PEOPLE APPEAR; they do not trim what is shown underneath a person who
 * appears. Someone who matches "selected" on one application is listed with ALL of their
 * applications, and the ones outside the filter are marked as such by `matchesFilter`. Trimming them
 * would reproduce the exact defect this screen exists to prevent — a human shown as though they had
 * one application when they have four.
 */
export async function listCandidates(filter: CandidateFilter = {}): Promise<CandidateRow[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(MAX_REGISTER_PAGE, Math.max(1, Number(filter.limit) || 50));
    const offset = Math.max(0, Number(filter.offset) || 0);

    const statuses = resolveStatusFilter(filter.status);
    const statusOn = statuses !== null;
    const statusSql = statusOn
      ? sql.raw('a.status IN (' + statusLiteralList(statuses as readonly string[]) + ')')
      : sql.raw('TRUE');
    // A LITERAL, not a bound boolean. `$1 = FALSE` against an untyped parameter is a needless way
    // for a query to fail on type inference, and this value never comes from a request.
    const noStatusSql = sql.raw(statusOn ? 'FALSE' : 'TRUE');

    // uuidish() FIRST. A non-uuid reaching `${x}::uuid` is a certain 500, and an opportunity id
    // arrives here from a query string.
    const oppId = uuidish(String(filter.opportunityId || '')) || null;

    const search = classifySearch(filter.q);
    // The term is used AS TYPED even when it belongs to another register. The search then honestly
    // returns nothing and the page explains what was pasted; silently dropping the filter would
    // show the whole register as though it had matched.
    const q = search.kind === 'empty' ? '' : search.term;
    const term = q || null;
    const like = likeTerm(q);

    const rows = rowsOf(await db.execute(sql`
      WITH eff AS (
        SELECT p.id, COALESCE(p.merged_into_id, p.id) AS eff_id FROM tal_person p
      ),
      app AS (
        SELECT a.id, a.application_code, a.person_id, a.opportunity_id, a.status,
               a.current_stage_key, a.pipeline_id, a.is_internal, a.submitted_at, a.closed_at,
               e.eff_id
          FROM tal_application a
          JOIN eff e ON e.id = a.person_id
      ),
      hit AS (
        SELECT DISTINCT a.eff_id
          FROM app a
          LEFT JOIN tal_person ap            ON ap.id = a.person_id
          LEFT JOIN tal_candidate_profile ac ON ac.person_id = a.person_id
         WHERE ${statusSql}
           AND (${oppId}::uuid IS NULL OR a.opportunity_id = ${oppId}::uuid)
           AND (${term}::text IS NULL
                OR a.application_code ILIKE ${like}
                OR ap.person_code     ILIKE ${like}
                OR ap.display_name    ILIKE ${like}
                OR ap.primary_email   ILIKE ${like}
                OR ac.candidate_code  ILIKE ${like}
                OR EXISTS (SELECT 1 FROM tal_person_identifier pi
                            WHERE pi.person_id = a.person_id
                              AND pi.kind IN ('email', 'phone')
                              AND pi.value_norm ILIKE ${like}))
        UNION
        SELECT e2.eff_id
          FROM tal_person p2
          JOIN eff e2 ON e2.id = p2.id
          LEFT JOIN tal_candidate_profile cp2 ON cp2.person_id = p2.id
         WHERE ${noStatusSql}
           AND ${oppId}::uuid IS NULL
           AND (
                 (${term}::text IS NULL AND cp2.id IS NOT NULL)
              OR (${term}::text IS NOT NULL
                  AND (p2.person_code    ILIKE ${like}
                    OR p2.display_name   ILIKE ${like}
                    OR p2.primary_email  ILIKE ${like}
                    OR cp2.candidate_code ILIKE ${like}
                    OR EXISTS (SELECT 1 FROM tal_person_identifier pi2
                                WHERE pi2.person_id = p2.id
                                  AND pi2.kind IN ('email', 'phone')
                                  AND pi2.value_norm ILIKE ${like})))
               )
      )
      SELECT p.id, p.person_code, p.display_name, p.preferred_name,
             p.primary_email, p.primary_phone, p.country,
             COALESCE(cp.candidate_code, '') AS candidate_code,
             COALESCE(cp.headline, '')       AS headline,
             COALESCE(cp.talent_pool, FALSE) AS talent_pool,
             (SELECT COUNT(*) FROM tal_person m WHERE m.merged_into_id = p.id) AS folded_in_count,
             MAX(a.submitted_at) AS last_activity_at,
             COALESCE(json_agg(
               json_build_object(
                 'application_id',      a.id,
                 'application_code',    a.application_code,
                 'opportunity_id',      a.opportunity_id,
                 'opportunity_code',    COALESCE(o.opportunity_code, ''),
                 'opportunity_title',   COALESCE(o.title, ''),
                 'department_id',       COALESCE(o.department_id, ''),
                 'department_name',     COALESCE(d.name, ''),
                 'employment_type',     COALESCE(o.employment_type, ''),
                 'status',              a.status,
                 'current_stage_key',   COALESCE(a.current_stage_key, ''),
                 'current_stage_label', COALESCE(ps.label, ''),
                 'is_internal',         a.is_internal,
                 'submitted_at',        a.submitted_at,
                 'closed_at',           a.closed_at,
                 'on_person_id',        a.person_id,
                 'on_person_code',      COALESCE(ap.person_code, '')
               ) ORDER BY a.submitted_at DESC
             ) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS applications
        FROM tal_person p
        JOIN hit h                          ON h.eff_id = p.id
        LEFT JOIN tal_candidate_profile cp  ON cp.person_id = p.id
        LEFT JOIN app a                     ON a.eff_id = p.id
        LEFT JOIN tal_person ap             ON ap.id = a.person_id
        LEFT JOIN tal_opportunity o         ON o.id = a.opportunity_id
        -- departments.id AND tal_opportunity.department_id ARE NOT THE SAME TYPE. db/hr-schema.sql
        -- creates departments.id as UUID and src/lib/db/schema.ts declares it varchar(50), while
        -- department_id here is TEXT by rule 1 of schema.ts. An uncast d.id = o.department_id is
        -- therefore a guaranteed "operator does not exist: uuid = text" on the live database, and the
        -- whole register 500s on first load. The cast goes on departments.id and NEVER on
        -- department_id; this is the same form opportunities.ts:533 and every other departments join
        -- in src/lib already uses.
        LEFT JOIN departments d             ON d.id::text = o.department_id
        LEFT JOIN tal_pipeline_stage ps     ON ps.pipeline_id = a.pipeline_id
                                           AND ps.key = a.current_stage_key
       GROUP BY p.id, p.person_code, p.display_name, p.preferred_name,
                p.primary_email, p.primary_phone, p.country,
                cp.candidate_code, cp.headline, cp.talent_pool
       -- p.id LAST, AND IT IS NOT DECORATION. This is the only paged read on the register, and an
       -- ORDER BY whose keys can tie has no defined order between the tied rows — so a person can
       -- sit on page one for one request and page two for the next, appearing twice or not at all.
       -- Two people with no application at all tie on BOTH keys the moment they share a name. The
       -- primary key breaks every remaining tie and makes the paging total.
       ORDER BY MAX(a.submitted_at) DESC NULLS LAST, p.display_name ASC, p.id ASC
       LIMIT ${limit} OFFSET ${offset}`));

    const wanted = statuses ? new Set<string>(statuses as readonly string[]) : null;
    return rows.map((x: any) => {
      const c = toCandidate(x);
      // Which of a person's applications the filter actually selected. Computed here rather than in
      // SQL so the nested list stays complete and the marking stays a presentation fact.
      for (const a of c.applications) {
        const statusOk = !wanted || wanted.has(a.status);
        const oppOk = !oppId || a.opportunityId === oppId;
        a.matchesFilter = statusOk && oppOk;
      }
      return c;
    });
  } catch (e: any) {
    console.error('[talent-candidates] listCandidates: ' + reasonOf(e));
    throw e;
  }
}

export interface CandidateCounts {
  /** Distinct humans, folded on merges. Never a count of application rows. */
  people: number;
  applications: number;
  inProgress: number;
  decided: number;
  onboarding: number;
  joined: number;
  closed: number;
  /** Humans holding more than one application — the reason this register is person-first. */
  multiApplicants: number;
  openMerges: number;
}

/**
 * Counts for the register header. RETHROWS, for the same reason listCandidates() does.
 *
 * ONE ROUND TRIP, NINE NUMBERS. Nine COUNT queries against one table is the shape that made page
 * latency on this project a function of how many tiles a header happened to have.
 *
 * Every bucket list is emitted through statusLiteralList(), which only lets a member of
 * CANDIDATE_STATUSES through — so the tiles and statusBucket() cannot drift apart, and nothing that
 * reaches sql.raw() came from a request.
 */
export async function candidateCounts(): Promise<CandidateCounts> {
  try {
    const { db, sql } = await ctx();
    const inProg = sql.raw(statusLiteralList(IN_PROGRESS_STATUSES));
    const decided = sql.raw(statusLiteralList(DECIDED_STATUSES));
    const onb = sql.raw(statusLiteralList(ONBOARDING_STATUSES_C));
    const joined = sql.raw(statusLiteralList(JOINED_STATUSES));
    const closed = sql.raw(statusLiteralList(CLOSED_STATUSES));

    const rows = rowsOf(await db.execute(sql`
      WITH app AS (
        SELECT a.status, COALESCE(p.merged_into_id, p.id) AS eff_id
          FROM tal_application a
          JOIN tal_person p ON p.id = a.person_id
      )
      SELECT (SELECT COUNT(DISTINCT eff_id) FROM app)                        AS people,
             (SELECT COUNT(*) FROM app)                                      AS applications,
             (SELECT COUNT(*) FROM app WHERE status IN (${inProg}))          AS in_progress,
             (SELECT COUNT(*) FROM app WHERE status IN (${decided}))         AS decided,
             (SELECT COUNT(*) FROM app WHERE status IN (${onb}))             AS onboarding,
             (SELECT COUNT(*) FROM app WHERE status IN (${joined}))          AS joined,
             (SELECT COUNT(*) FROM app WHERE status IN (${closed}))          AS closed,
             (SELECT COUNT(*) FROM (SELECT eff_id FROM app GROUP BY eff_id
                                     HAVING COUNT(*) > 1) m)                 AS multi_applicants,
             (SELECT COUNT(*) FROM tal_person_merge WHERE status = 'proposed') AS open_merges`));
    const r = (rows[0] || {}) as any;
    return {
      people: Number(r.people || 0),
      applications: Number(r.applications || 0),
      inProgress: Number(r.in_progress || 0),
      decided: Number(r.decided || 0),
      onboarding: Number(r.onboarding || 0),
      joined: Number(r.joined || 0),
      closed: Number(r.closed || 0),
      multiApplicants: Number(r.multi_applicants || 0),
      openMerges: Number(r.open_merges || 0),
    };
  } catch (e: any) {
    console.error('[talent-candidates] candidateCounts: ' + reasonOf(e));
    throw e;
  }
}

export interface IdentifierKindRow {
  kind: string;
  label: string;
  count: number;
  anyVerified: boolean;
}

export interface FoldedRecord {
  personId: string;
  personCode: string;
  displayName: string;
}

export interface CandidateDetail {
  person: CandidateRow;
  /**
   * Set when the id asked for had itself been folded into another record: the detail shown is the
   * SURVIVING record, and this names the one that was asked for. Silently showing the survivor
   * without saying so would look like the register had lost a person.
   */
  followedFromPersonCode: string | null;
  /** KINDS AND COUNTS ONLY. No identifier value is read into this shape — spec 32.1. */
  identifierKinds: IdentifierKindRow[];
  /** Records folded into this one by a confirmed merge. */
  foldedIn: FoldedRecord[];
}

/**
 * One person, with everything this screen is allowed to show about them. RETHROWS.
 *
 * Returns null only when no such person exists — which is a real answer, distinguishable from the
 * throw that means the read failed.
 */
export async function candidateDetail(personId: string): Promise<CandidateDetail | null> {
  const wanted = uuidish(String(personId || ''));
  if (!wanted) return null;
  try {
    const { db, sql } = await ctx();

    // Resolve to the EFFECTIVE record first, one hop, and remember whether a hop happened.
    const head = rowsOf(await db.execute(sql`
      SELECT p.id, p.person_code, p.merged_into_id
        FROM tal_person p
       WHERE p.id = ${wanted}::uuid`));
    if (!head.length) return null;
    const askedCode = String(head[0]?.person_code || '');
    const mergedInto = head[0]?.merged_into_id ? String(head[0].merged_into_id) : '';
    const effId = mergedInto || wanted;

    // Addressed directly rather than by scanning a page of listCandidates() for the id: the
    // register's LIMIT is a page of PEOPLE, so the record asked for may simply not be on it.
    const rows = rowsOf(await db.execute(sql`
      WITH eff AS (
        SELECT p.id, COALESCE(p.merged_into_id, p.id) AS eff_id FROM tal_person p
      ),
      app AS (
        SELECT a.id, a.application_code, a.person_id, a.opportunity_id, a.status,
               a.current_stage_key, a.pipeline_id, a.is_internal, a.submitted_at, a.closed_at,
               e.eff_id
          FROM tal_application a
          JOIN eff e ON e.id = a.person_id
      )
      SELECT p.id, p.person_code, p.display_name, p.preferred_name,
             p.primary_email, p.primary_phone, p.country,
             COALESCE(cp.candidate_code, '') AS candidate_code,
             COALESCE(cp.headline, '')       AS headline,
             COALESCE(cp.talent_pool, FALSE) AS talent_pool,
             (SELECT COUNT(*) FROM tal_person m WHERE m.merged_into_id = p.id) AS folded_in_count,
             MAX(a.submitted_at) AS last_activity_at,
             COALESCE(json_agg(
               json_build_object(
                 'application_id',      a.id,
                 'application_code',    a.application_code,
                 'opportunity_id',      a.opportunity_id,
                 'opportunity_code',    COALESCE(o.opportunity_code, ''),
                 'opportunity_title',   COALESCE(o.title, ''),
                 'department_id',       COALESCE(o.department_id, ''),
                 'department_name',     COALESCE(d.name, ''),
                 'employment_type',     COALESCE(o.employment_type, ''),
                 'status',              a.status,
                 'current_stage_key',   COALESCE(a.current_stage_key, ''),
                 'current_stage_label', COALESCE(ps.label, ''),
                 'is_internal',         a.is_internal,
                 'submitted_at',        a.submitted_at,
                 'closed_at',           a.closed_at,
                 'on_person_id',        a.person_id,
                 'on_person_code',      COALESCE(ap.person_code, '')
               ) ORDER BY a.submitted_at DESC
             ) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS applications
        FROM tal_person p
        LEFT JOIN tal_candidate_profile cp  ON cp.person_id = p.id
        LEFT JOIN app a                     ON a.eff_id = p.id
        LEFT JOIN tal_person ap             ON ap.id = a.person_id
        LEFT JOIN tal_opportunity o         ON o.id = a.opportunity_id
        -- departments.id AND tal_opportunity.department_id ARE NOT THE SAME TYPE. db/hr-schema.sql
        -- creates departments.id as UUID and src/lib/db/schema.ts declares it varchar(50), while
        -- department_id here is TEXT by rule 1 of schema.ts. An uncast d.id = o.department_id is
        -- therefore a guaranteed "operator does not exist: uuid = text" on the live database, and the
        -- whole register 500s on first load. The cast goes on departments.id and NEVER on
        -- department_id; this is the same form opportunities.ts:533 and every other departments join
        -- in src/lib already uses.
        LEFT JOIN departments d             ON d.id::text = o.department_id
        LEFT JOIN tal_pipeline_stage ps     ON ps.pipeline_id = a.pipeline_id
                                           AND ps.key = a.current_stage_key
       WHERE p.id = ${effId}::uuid
       GROUP BY p.id, p.person_code, p.display_name, p.preferred_name,
                p.primary_email, p.primary_phone, p.country,
                cp.candidate_code, cp.headline, cp.talent_pool`));
    if (!rows.length) return null;
    const person = toCandidate(rows[0]);

    // KIND AND COUNT ONLY. value_norm is not selected, here or anywhere on this screen's path.
    const idRows = rowsOf(await db.execute(sql`
      SELECT i.kind, COUNT(*) AS n, bool_or(i.is_verified) AS any_verified
        FROM tal_person_identifier i
        JOIN tal_person p ON p.id = i.person_id
       WHERE COALESCE(p.merged_into_id, p.id) = ${effId}::uuid
       GROUP BY i.kind
       ORDER BY i.kind ASC`));
    const identifierKinds: IdentifierKindRow[] = idRows.map((x: any) => {
      const kind = String(x.kind || '');
      return {
        kind,
        label: IDENTIFIER_KIND_LABELS[kind] || kind,
        count: Number(x.n || 0),
        anyVerified: x.any_verified === true,
      };
    });

    const foldRows = rowsOf(await db.execute(sql`
      SELECT m.id, m.person_code, m.display_name
        FROM tal_person m
       WHERE m.merged_into_id = ${effId}::uuid
       ORDER BY m.person_code ASC`));
    const foldedIn: FoldedRecord[] = foldRows.map((x: any) => ({
      personId: String(x.id || ''),
      personCode: String(x.person_code || ''),
      displayName: String(x.display_name || ''),
    }));

    return {
      person,
      followedFromPersonCode: mergedInto ? askedCode : null,
      identifierKinds,
      foldedIn,
    };
  } catch (e: any) {
    console.error('[talent-candidates] candidateDetail: ' + reasonOf(e));
    throw e;
  }
}

export interface MergeSide {
  personId: string;
  personCode: string;
  displayName: string;
  primaryEmail: string;
  applicationCount: number;
  mergedIntoId: string | null;
  mergedIntoCode: string;
}

export interface MergeProposalRow {
  id: string;
  status: MergeStatus;
  confidence: number | null;
  band: ConfidenceBand;
  /** KEYS ONLY, through evidenceSignals(). No evidence value reaches this shape. */
  signals: string[];
  /**
   * TRUE when `evidence` was recorded but could not be read back, so an empty `signals` means
   * "unreadable" rather than "nothing was matched on". A merge is decided partly on what the
   * proposal says it matched; reporting a failed read as "no evidence recorded" understates the
   * proposal and is the same swallow in a place where the consequence is two humans merged.
   */
  evidenceUnreadable: boolean;
  reason: string | null;
  decidedByName: string;
  decidedAt: string | null;
  createdAt: string | null;
  keep: MergeSide;
  fold: MergeSide;
}

function toSide(x: any, p: string): MergeSide {
  return {
    personId: String(x[p + '_id'] || ''),
    personCode: String(x[p + '_code'] || ''),
    displayName: String(x[p + '_name'] || ''),
    primaryEmail: String(x[p + '_email'] || ''),
    applicationCount: Number(x[p + '_apps'] || 0),
    mergedIntoId: x[p + '_merged_into'] ? String(x[p + '_merged_into']) : null,
    mergedIntoCode: String(x[p + '_merged_code'] || ''),
  };
}

/**
 * The merge queue. RETHROWS.
 *
 * NOTHING HERE APPLIES A PROPOSAL. Finding F2: matching on an email alone merges two people who
 * shared a college address and splits one person who changed jobs, so a proposal is a piece of work
 * for a human and never an instruction. There is no auto-confirm path in this module — not on
 * confidence, not on an exact identifier hit, not on a batch.
 */
export async function listMergeProposals(
  status: string = 'proposed',
  limit: number = 100,
): Promise<MergeProposalRow[]> {
  try {
    const { db, sql } = await ctx();
    const cap = Math.min(MAX_REGISTER_PAGE, Math.max(1, Number(limit) || 100));
    const wanted = ['proposed', 'confirmed', 'rejected'].includes(String(status)) ? String(status) : null;

    const rows = rowsOf(await db.execute(sql`
      SELECT m.id, m.status, m.confidence, m.evidence, m.reason, m.decided_at, m.created_at,
             COALESCE(u.name, '') AS decided_by_name,
             k.id  AS keep_id,  COALESCE(k.person_code, '')   AS keep_code,
             COALESCE(k.display_name, '')  AS keep_name,
             COALESCE(k.primary_email, '') AS keep_email,
             k.merged_into_id AS keep_merged_into,
             COALESCE(kk.person_code, '')  AS keep_merged_code,
             (SELECT COUNT(*) FROM tal_application a WHERE a.person_id = k.id) AS keep_apps,
             f.id  AS fold_id,  COALESCE(f.person_code, '')   AS fold_code,
             COALESCE(f.display_name, '')  AS fold_name,
             COALESCE(f.primary_email, '') AS fold_email,
             f.merged_into_id AS fold_merged_into,
             COALESCE(ff.person_code, '')  AS fold_merged_code,
             (SELECT COUNT(*) FROM tal_application a WHERE a.person_id = f.id) AS fold_apps
        FROM tal_person_merge m
        LEFT JOIN tal_person k  ON k.id = m.keep_person_id
        LEFT JOIN tal_person f  ON f.id = m.merge_person_id
        LEFT JOIN tal_person kk ON kk.id = k.merged_into_id
        LEFT JOIN tal_person ff ON ff.id = f.merged_into_id
        LEFT JOIN users u       ON u.id = m.decided_by
       WHERE (${wanted}::text IS NULL OR m.status = ${wanted})
       ORDER BY m.created_at DESC
       LIMIT ${cap}`));

    return rows.map((x: any) => {
      // A JSONB column can arrive parsed or as text depending on the driver. Parsed is used as-is;
      // text that will not parse is UNREADABLE, and is reported as that rather than as no evidence.
      const rawEvidence = x.evidence;
      const evidence = typeof rawEvidence === 'string' ? safeJson(rawEvidence) : rawEvidence;
      const evidenceUnreadable = typeof rawEvidence === 'string'
        && evidence === null
        && rawEvidence.trim() !== 'null';
      return {
      id: String(x.id || ''),
      status: String(x.status || 'proposed') as MergeStatus,
      confidence: x.confidence === null || x.confidence === undefined ? null : Number(x.confidence),
      band: confidenceBand(x.confidence),
      signals: evidenceSignals(evidence),
      evidenceUnreadable,
      reason: x.reason ? String(x.reason) : null,
      decidedByName: String(x.decided_by_name || ''),
      decidedAt: iso(x.decided_at),
      createdAt: iso(x.created_at),
      keep: toSide(x, 'keep'),
      fold: toSide(x, 'fold'),
      };
    });
  } catch (e: any) {
    console.error('[talent-candidates] listMergeProposals: ' + reasonOf(e));
    throw e;
  }
}

export interface MergeDecisionData {
  keepPersonId: string;
  mergePersonId: string;
}

/**
 * CONFIRM: these two records are one human.
 *
 * IRREVERSIBLE FROM ANY SCREEN IN THIS PRODUCT, so every refusal happens before anything is written
 * and the reason is not optional. The write itself is ONE STATEMENT with data-modifying CTEs, not
 * two updates in sequence: `target` re-checks every precondition inside the same snapshot, and both
 * updates key off it, so there is no window where the proposal reads "confirmed" while the records
 * are still separate — which is the ordering failure that would make this screen lie.
 *
 * IT DOES NOT REPOINT APPLICATIONS. See the header of this file: tal_app_person_opp_uq would reject
 * the repoint whenever both records applied to the same opportunity, and the historical record of
 * which submission arrived under which name is evidence, not clutter.
 */
export async function confirmMerge(
  id: string,
  actorUserId: string,
  reason: string,
): Promise<TalentResult<MergeDecisionData>> {
  const rowId = uuidish(String(id || ''));
  if (!rowId) return failResult('That is not a merge proposal reference.');
  const actor = uuidish(String(actorUserId || ''));
  // decided_by is a UUID column. A non-uuid actor would throw INSIDE the statement, after the
  // preconditions had passed, which is the worst place for it to fail.
  if (!actor) return failResult('A merge must be decided by a signed-in administrator.');
  const why = String(reason || '').trim();

  try {
    const { db, sql } = await ctx();

    const pre = rowsOf(await db.execute(sql`
      SELECT m.id, m.status, m.keep_person_id, m.merge_person_id,
             k.merged_into_id AS keep_merged_into,
             f.merged_into_id AS fold_merged_into
        FROM tal_person_merge m
        LEFT JOIN tal_person k ON k.id = m.keep_person_id
        LEFT JOIN tal_person f ON f.id = m.merge_person_id
       WHERE m.id = ${rowId}::uuid`));
    if (!pre.length) return failResult('No such merge proposal.');
    const p = pre[0] as any;

    const problem = mergeDecisionProblem({
      status: String(p.status || ''),
      keepPersonId: String(p.keep_person_id || ''),
      mergePersonId: String(p.merge_person_id || ''),
      reason: why,
      keepAlreadyMergedInto: p.keep_merged_into ? String(p.keep_merged_into) : null,
      mergeAlreadyMergedInto: p.fold_merged_into ? String(p.fold_merged_into) : null,
    }, 'confirm');
    if (problem) return failResult(problem);

    // EVERY PRECONDITION IS REPEATED ON THE UPDATE ROWS THEMSELVES, not left to the target CTE.
    //
    // target is evaluated against this statement's snapshot. When a second administrator confirms
    // the same proposal at the same moment, the second UPDATE blocks on the row lock and then
    // re-checks ONLY ITS OWN WHERE clause against the newly committed row — the CTE is not re-run.
    // Without the two extra conditions below, that second confirm overwrote the reason and the
    // decided_by of an already-confirmed, irreversible record: it silently reassigned authorship of
    // a decision about two humans to whoever clicked last, and reported success for doing it. With
    // them the second writer changes nothing and is told exactly that.
    //
    // NO BACKTICKS IN THE SQL BELOW. This is a template literal; a backtick in a -- comment inside
    // it closes the string and the file stops compiling.
    const out = rowsOf(await db.execute(sql`
      WITH target AS (
        SELECT m.id, m.keep_person_id, m.merge_person_id
          FROM tal_person_merge m
          JOIN tal_person kp ON kp.id = m.keep_person_id
          JOIN tal_person mp ON mp.id = m.merge_person_id
         WHERE m.id = ${rowId}::uuid
           AND m.status = 'proposed'
           AND m.keep_person_id <> m.merge_person_id
           AND kp.merged_into_id IS NULL
           AND (mp.merged_into_id IS NULL OR mp.merged_into_id = m.keep_person_id)
      ),
      fold AS (
        UPDATE tal_person p
           SET merged_into_id = t.keep_person_id, updated_at = NOW()
          FROM target t
         WHERE p.id = t.merge_person_id
           AND (p.merged_into_id IS NULL OR p.merged_into_id = t.keep_person_id)
         RETURNING p.id
      ),
      claim AS (
        UPDATE tal_person_merge m
           SET status = 'confirmed', decided_by = ${actor}::uuid, decided_at = NOW(), reason = ${why}
          FROM target t
         WHERE m.id = t.id
           AND m.status = 'proposed'
         RETURNING m.id
      )
      SELECT t.keep_person_id, t.merge_person_id,
             (SELECT COUNT(*) FROM fold)  AS folded,
             (SELECT COUNT(*) FROM claim) AS claimed
        FROM target t`));

    if (!out.length) {
      // The preconditions changed between the read above and the write. Nothing was written.
      return failResult('The proposal changed while you were looking at it, so nothing was merged. Reload and check it again.');
    }
    const r = out[0] as any;
    const folded = Number(r.folded || 0);
    const claimed = Number(r.claimed || 0);
    if (claimed !== 1 && folded === 1) {
      // The row-level rechecks above caught a second administrator deciding the same proposal.
      // The records are in the state THAT decision left them; nothing here was applied, and — the
      // point of the guard — nothing of theirs was overwritten. Saying "did not apply cleanly"
      // would send this operator looking for a defect in a record that is perfectly correct.
      return failResult('Somebody else confirmed this merge a moment ago. Their decision and their written reason stand, and nothing of yours was recorded. Reload to see it.');
    }
    if (folded !== 1 || claimed !== 1) {
      return failResult('The merge did not apply cleanly and has been left alone. Reload and check the two records.');
    }
    return okResult<MergeDecisionData>({
      keepPersonId: String(r.keep_person_id || ''),
      mergePersonId: String(r.merge_person_id || ''),
    });
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/**
 * REJECT: these are two different humans.
 *
 * Also needs a written reason. A rejected pair stays rejected and the partial unique index frees the
 * pair for a future proposal, so the reason is the only thing telling the next person who looks that
 * this was considered rather than missed.
 */
export async function rejectMerge(
  id: string,
  actorUserId: string,
  reason: string,
): Promise<TalentResult<MergeDecisionData>> {
  const rowId = uuidish(String(id || ''));
  if (!rowId) return failResult('That is not a merge proposal reference.');
  const actor = uuidish(String(actorUserId || ''));
  if (!actor) return failResult('A merge must be decided by a signed-in administrator.');
  const why = String(reason || '').trim();

  try {
    const { db, sql } = await ctx();
    const pre = rowsOf(await db.execute(sql`
      SELECT id, status, keep_person_id, merge_person_id
        FROM tal_person_merge WHERE id = ${rowId}::uuid`));
    if (!pre.length) return failResult('No such merge proposal.');
    const p = pre[0] as any;

    const problem = mergeDecisionProblem({
      status: String(p.status || ''),
      keepPersonId: String(p.keep_person_id || ''),
      mergePersonId: String(p.merge_person_id || ''),
      reason: why,
    }, 'reject');
    if (problem) return failResult(problem);

    const out = rowsOf(await db.execute(sql`
      UPDATE tal_person_merge
         SET status = 'rejected', decided_by = ${actor}::uuid, decided_at = NOW(), reason = ${why}
       WHERE id = ${rowId}::uuid AND status = 'proposed'
       RETURNING keep_person_id, merge_person_id`));
    if (!out.length) {
      return failResult('That proposal was decided by somebody else a moment ago. Nothing has been changed.');
    }
    const r = out[0] as any;
    return okResult<MergeDecisionData>({
      keepPersonId: String(r.keep_person_id || ''),
      mergePersonId: String(r.merge_person_id || ''),
    });
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

export interface OpportunityOption {
  id: string;
  code: string;
  title: string;
  applicationCount: number;
}

/**
 * The opportunity filter's options: only opportunities that have actually received an application,
 * because an option that can only ever return nothing is a filter that reads as broken. RETHROWS,
 * so the page can say the dropdown is unavailable rather than showing an empty one that looks like
 * "no opportunities exist".
 */
export async function candidateOpportunityOptions(limit: number = 200): Promise<OpportunityOption[]> {
  try {
    const { db, sql } = await ctx();
    const cap = Math.min(500, Math.max(1, Number(limit) || 200));
    const rows = rowsOf(await db.execute(sql`
      SELECT o.id, COALESCE(o.opportunity_code, '') AS code, COALESCE(o.title, '') AS title,
             COUNT(a.id) AS n
        FROM tal_opportunity o
        JOIN tal_application a ON a.opportunity_id = o.id
       GROUP BY o.id, o.opportunity_code, o.title
       ORDER BY o.title ASC
       LIMIT ${cap}`));
    return rows.map((x: any) => ({
      id: String(x.id || ''),
      code: String(x.code || ''),
      title: String(x.title || ''),
      applicationCount: Number(x.n || 0),
    }));
  } catch (e: any) {
    console.error('[talent-candidates] candidateOpportunityOptions: ' + reasonOf(e));
    throw e;
  }
}

/** Re-exported so a consumer has one import for the register's vocabulary. DEFINED in types.ts. */
export { IDENTIFIER_KINDS };
