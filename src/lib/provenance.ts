// src/lib/provenance.ts — HOW A VALUE CAME TO BE KNOWN. One vocabulary, for the whole system.
//
// =================================================================================================
// WHAT THIS IS, AND WHY IT IS NOT ANOTHER MODULE
// =================================================================================================
//
// Every other file in this codebase answers "what is the value". This one answers "what is this
// system entitled to say about that value", and it is the only file allowed to answer it. It stores
// no value of its own, it owns no screen, and it decides nothing about a person. It decides what a
// screen is ALLOWED TO ASSERT about a person, which turns out to be the load-bearing question.
//
// The seven ways a value comes to be known, and they are not interchangeable:
//
//   factual              the platform's own record of its own act. A row exists. A certificate was
//                        signed at this hash. Nobody's opinion is in it.
//   explicitly_provided  a human typed it. About themselves or about somebody else. It is a CLAIM,
//                        and a claim is not proof — a skill on a CV is claimed, not demonstrated.
//   inferred             the system reached it without being told it. Always advisory. Always
//                        carries what it rests on, what it assumed, and what it is unsure about.
//   calculated           deterministic arithmetic over inputs that have their own provenance. It is
//                        only ever as good as those inputs, and it changes when they do.
//   verified             a NAMED HUMAN checked a claim against something and said so, in writing,
//                        on a date. The only assertion type this module refuses to manufacture.
//   predicted            about something that has not happened. Never a record of a person.
//   recommended          advice to a human who decides. Never an outcome.
//
// =================================================================================================
// THE RULE THE CODE ENFORCES RATHER THAN DOCUMENTS
// =================================================================================================
//
// AN INFERENCE CANNOT BE PROMOTED TO A FACT BY ANY CODE PATH. There is no promote(), no
// setAssertion(), no upgrade(), and no exported function that takes an existing element and returns
// a stronger one — except verify(), which cannot be called without a human. The four ways that rule
// could be broken are each closed here:
//
//   1. BY MUTATION.      Every element is frozen (Object.freeze, including its nested arrays), and
//                        every field is readonly. `el.assertion = 'factual'` throws in strict mode
//                        and does nothing in sloppy mode. It never succeeds.
//   2. BY CONSTRUCTION.  recordFact() is a CONSTRUCTOR, not a converter: it takes a system of
//                        record and a value, never an existing element. Nothing in this file reads
//                        an element and returns one with a different assertion type, except
//                        verify() and withdrawVerification().
//   3. BY VERIFICATION.  verify() is the only producer of 'verified'. It REQUIRES an actor id, an
//                        actor name, a written reason and a named method, and the element it returns
//                        keeps `derivedFrom` set to what it was before. A verified inference stays
//                        an inference that a human checked; it never becomes a fact, and the
//                        sentence a screen must print says so in those words.
//   4. BY STORAGE.       The round trip is the hole every provenance design falls through: write
//                        'inferred', edit the row to 'verified', read it back as a fact. So the
//                        TABLE carries a CHECK constraint — assertion = 'verified' requires a
//                        verifier id, a reason and a timestamp — and the hydrator REFUSES a row that
//                        claims verified without naming who and when, rather than silently
//                        downgrading it. An unreadable provenance row renders as unreadable, on the
//                        precedent already set by /admin/tests/attempts printing EVIDENCE UNREADABLE
//                        rather than inventing a score.
//
// AND A VERIFICATION IS ABOUT ONE VALUE, NOT ABOUT A FIELD FOREVER. The row stores a fingerprint of
// the value at the moment it was recorded. When the underlying column changes, checkAgainstValue()
// says the verification is stale, and the render contract stops calling it verified. A verified fact
// that quietly changed underneath its verification is the most expensive lie a record can tell,
// because everybody trusts it.
//
// =================================================================================================
// WHAT IS NOT STORED HERE, ON PURPOSE
// =================================================================================================
//
// THE VALUE ITSELF. This table annotates existing columns; it does not copy them. Two copies of one
// truth is the failure this repository has already had with XP, with course progress and with
// chat_messages, and it is always discovered a year late by somebody asking which number is real.
// An element therefore describes a value and does not carry one — the caller holds the value it read
// from the real column and passes it here only to be fingerprinted.
//
// A PROTECTED OR SENSITIVE ATTRIBUTE AS A DERIVED VALUE. Race, religion, caste, politics, sexual
// orientation, disability, health, pregnancy and marital status can never be inferred, calculated,
// predicted or recommended here — the constructors refuse the field outright, so no seam exists for
// one to arrive through later. Where such a field is legitimately held (a person provided it for a
// statutory return, or to arrange an accommodation), it may only be annotated as explicitly
// provided, by its owner, at restricted access — and mayDecideOn() answers false for it always, in
// every assertion type, including verified.
//
// A SURVEILLANCE SIGNAL. Communication volume, keystrokes, screenshots, activity scores, monitoring
// of any kind, and the person-outcome predictions those signals exist to feed — attrition, flight
// risk, culture fit, personality, sentiment, loyalty, morale — are refused as FIELD NAMES by every
// constructor, for every assertion type. Not "not implemented": refused, so the first person to try
// gets a sentence rather than a working column.
//
// =================================================================================================
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// =================================================================================================
//
// IT RESOLVES NO AUTHORIZATION. Who may verify something about a person is a RELATIONSHIP, resolved
// per row from src/lib/org-graph.ts, or an org-wide capability checked by the caller. This module
// takes the answer as an argument (VerifyAuthority) exactly as src/lib/skills.ts takes `orgWide`
// rather than reading a permission itself. A second authorization engine is how two screens end up
// disagreeing about who somebody's manager is.
//
// IT APPROVES NOTHING. A human overriding a recommendation, a promotion, a termination: all of that
// is src/lib/workflow.ts. There is no pending/approved state in this file.
//
// IT OWNS NO AUDIT SYSTEM. Every write goes through logAudit() from src/lib/audit.ts.
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { ensureOnce } from '@/lib/ensure-once';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared ABOVE everything that reads them: `const` is not hoisted, and a const
// read before its declaration throws on the first line of the function that reads it. That has taken
// pages down on this project.
// -------------------------------------------------------------------------------------------------

const MOD = 'provenance';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

const nowIso = (): string => new Date().toISOString();

/**
 * THE CAPABILITY that means "record a verification about anybody, with no relationship".
 * Named once so the string is never typed twice. It exists in the Permission union in
 * src/lib/auth/permissions.ts AND in BUILTIN_PERMISSIONS in src/lib/auth/registry.ts — a key in
 * neither, or in only one, answers false for every role including super_admin.
 */
export const PROVENANCE_VERIFY = 'provenance.verify';

/** A verification reason shorter than this is not a reason. */
export const MIN_REASON_CHARS = 12;

const WRITE_FAILED = 'We could not record that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

export const ASSERTION_TYPES = [
  'factual',
  'explicitly_provided',
  'inferred',
  'calculated',
  'verified',
  'predicted',
  'recommended',
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];
export type UnverifiedAssertion = Exclude<AssertionType, 'verified'>;

/**
 * How heavily a screen may print it.
 *
 *   record    a statement of what is. Full weight. May stand alone next to a person's name.
 *   stated    somebody said it. Must name who said it, and must never read as confirmed.
 *   derived   arithmetic. Must be able to show its definition and its inputs.
 *   advisory  inferred, predicted or recommended. Visibly lighter, always labelled, never in the
 *             same typographic weight as a record. This is a rendering RULE, not a preference.
 */
export type RenderWeight = 'record' | 'stated' | 'derived' | 'advisory';

/** What a decision is allowed to rest on. */
export type DecisionUse = 'may_decide' | 'supporting_only' | 'advisory_only';

export interface AssertionDescriptor {
  key: AssertionType;
  /** Short, for a badge. */
  label: string;
  /** What it means, in the words a person reading their own record would need. */
  meaning: string;
  weight: RenderWeight;
  decisionUse: DecisionUse;
  /** A confidence figure is REQUIRED — a guess that will not say how sure it is, is not honest. */
  needsConfidence: boolean;
  /** A confidence figure is REFUSED — a fact does not carry a probability. */
  refusesConfidence: boolean;
}

/**
 * An ARRAY of descriptors rather than a Record map, on purpose: these are read inside .astro files,
 * and a `Record<string, string>` typed map in JSX breaks the Astro compiler on this project.
 */
export const ASSERTIONS: readonly AssertionDescriptor[] = Object.freeze([
  {
    key: 'factual' as const,
    label: 'Recorded fact',
    meaning: 'This platform recorded its own act. It is not a judgement anybody made.',
    weight: 'record' as const, decisionUse: 'may_decide' as const,
    needsConfidence: false, refusesConfidence: true,
  },
  {
    key: 'explicitly_provided' as const,
    label: 'Stated',
    meaning: 'A person entered this. It has not been checked against anything.',
    weight: 'stated' as const, decisionUse: 'supporting_only' as const,
    needsConfidence: false, refusesConfidence: true,
  },
  {
    key: 'inferred' as const,
    label: 'Inferred',
    meaning: 'The system worked this out. Nobody stated it and nobody has confirmed it.',
    weight: 'advisory' as const, decisionUse: 'advisory_only' as const,
    needsConfidence: true, refusesConfidence: false,
  },
  {
    key: 'calculated' as const,
    label: 'Calculated',
    meaning: 'Worked out from other recorded values, and it changes when they do.',
    weight: 'derived' as const, decisionUse: 'supporting_only' as const,
    needsConfidence: false, refusesConfidence: true,
  },
  {
    key: 'verified' as const,
    label: 'Verified',
    meaning: 'A named person checked this and wrote down what they checked it against.',
    weight: 'record' as const, decisionUse: 'may_decide' as const,
    needsConfidence: false, refusesConfidence: true,
  },
  {
    key: 'predicted' as const,
    label: 'Prediction',
    meaning: 'About something that has not happened. It is not a record of this person.',
    weight: 'advisory' as const, decisionUse: 'advisory_only' as const,
    needsConfidence: true, refusesConfidence: false,
  },
  {
    key: 'recommended' as const,
    label: 'Recommendation',
    meaning: 'A suggestion for a person to accept or refuse. It decides nothing by itself.',
    weight: 'advisory' as const, decisionUse: 'advisory_only' as const,
    needsConfidence: true, refusesConfidence: false,
  },
]);

export function assertionDescriptor(key: string): AssertionDescriptor | null {
  return ASSERTIONS.find((a) => a.key === key) || null;
}
export function assertionLabel(key: string): string {
  const d = assertionDescriptor(key);
  return d ? d.label : 'Unknown';
}
export function isAssertionType(key: unknown): key is AssertionType {
  return typeof key === 'string' && ASSERTIONS.some((a) => a.key === key);
}

/**
 * WHO THE DATA BELONGS TO. Not who may read it — whose it is. A person's own claims about themselves
 * stay theirs even while the organization is holding them.
 */
export type OwnerKind = 'person' | 'organization' | 'platform';

export interface ProvenanceOwner {
  kind: OwnerKind;
  /** 'user' | 'hr_employee' | 'application' | ... — the id space, named rather than assumed. */
  subjectKind: string | null;
  subjectId: string | null;
  /** How a screen names the owner. Never a guess. */
  label: string;
}

/**
 * ACCESS LEVEL — a DECLARATION carried with the element, never an authorization decision. Nothing in
 * this file grants or refuses a read. The Organization Graph and the permission registry do that.
 */
export const ACCESS_LEVELS = ['public', 'internal', 'restricted', 'self_only'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface ProvenanceSource {
  /** The module, table or partner that produced the value. Required, and never the word 'system'. */
  system: string;
  detail: string | null;
  /** The human who provided it, where a human did. Null for a machine-produced value. */
  actorUserId: string | null;
  actorName: string | null;
}

export interface EvidenceRef {
  /** 'course' | 'assessment' | 'certificate' | 'eims_evidence' | 'document' | 'external' | ... */
  kind: string;
  id: string | null;
  /** A sentence naming what it is. This is what a screen shows; an id is not readable. */
  label: string;
  /** A link, where there is one. Documents are links, never uploads. */
  url: string | null;
}

export const VERIFICATION_METHODS = [
  'checked_against_record',
  'document_seen',
  'issuer_confirmed',
  'witnessed_directly',
  'independently_reproduced',
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export interface Verification {
  readonly actorUserId: string;
  readonly actorName: string;
  readonly reason: string;
  readonly method: VerificationMethod;
  readonly at: string;
  readonly evidence: readonly EvidenceRef[];
}

/** A named human act. Every state change that strengthens or withdraws an assertion needs one. */
export interface HumanAct {
  actorUserId: string;
  actorName: string;
  reason: string;
  method?: VerificationMethod;
  evidence?: EvidenceRef[];
}

export interface ProvenanceEvent {
  readonly at: string;
  readonly kind: 'recorded' | 'verified' | 'verification_withdrawn' | 'superseded';
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly from: AssertionType | null;
  readonly to: AssertionType;
}

/**
 * ONE ELEMENT: everything known about how one field of one entity came to hold what it holds.
 *
 * IT CARRIES NO VALUE. See the header. `fingerprint` is a hash of the value at the moment it was
 * recorded, which is enough to answer "is this still the thing that was checked" and not enough to
 * become a second copy of the record.
 */
interface ElementCore {
  readonly entityType: string;
  readonly entityId: string;
  readonly field: string;
  readonly source: ProvenanceSource;
  readonly recordedAt: string;
  readonly owner: ProvenanceOwner;
  readonly access: AccessLevel;
  /** 0..1, and only where the descriptor allows one. Null everywhere else, never a default of 1. */
  readonly confidence: number | null;
  /** Why. One sentence a person can argue with. */
  readonly reasoning: string | null;
  /** What is not known. Never empty for an inference or a prediction. */
  readonly uncertainty: string | null;
  /** What had to be true for this to hold. */
  readonly assumptions: readonly string[];
  /** WHICH DATA INFLUENCED IT — named fields, tables or records, not a vague description. */
  readonly basis: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  /** sha256 of the canonical form of the value at record time. Null when no value was supplied. */
  readonly fingerprint: string | null;
  readonly history: readonly ProvenanceEvent[];
  /** Set by a reader that compared this with the live value and found it changed. */
  readonly stale: boolean;
}

export interface UnverifiedElement extends ElementCore {
  readonly assertion: UnverifiedAssertion;
  readonly verification: null;
  readonly derivedFrom: null;
}

export interface VerifiedElement extends ElementCore {
  readonly assertion: 'verified';
  /** Non-null by type AND re-checked at every storage boundary. */
  readonly verification: Verification;
  /** What it was before a human checked it. NEVER cleared — this is the anti-promotion record. */
  readonly derivedFrom: UnverifiedAssertion;
}

export type ProvenanceElement = UnverifiedElement | VerifiedElement;

export type ProvenanceResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

// -------------------------------------------------------------------------------------------------
// THE FIELDS THAT MAY NEVER BE DERIVED, AND THE FIELDS THAT MAY NEVER EXIST
//
// These two lists are the reason this file refuses things rather than merely warning about them. A
// warning is a comment somebody deletes; a refusal is a sentence somebody has to answer.
// -------------------------------------------------------------------------------------------------

/**
 * PROTECTED AND SENSITIVE ATTRIBUTES. A person may state one of these about themselves — a statutory
 * return, an accommodation they have asked for — and that statement may be recorded and, by a named
 * human, verified. NOTHING may ever infer, calculate, predict or recommend one, and nothing may ever
 * decide anything on one. mayDecideOn() answers false for these in every assertion type.
 *
 * The patterns are deliberately broad. A false refusal costs somebody an annotation they can record
 * a different way; a false acceptance creates the column this product promised never to have.
 */
const PROTECTED_FIELD_PATTERNS: readonly RegExp[] = [
  /race|ethnic|caste|tribe|indigen/i,
  /religio|faith|creed/i,
  /politic|union_?member/i,
  /sexual|orientation|gender|transgender|pronoun/i,
  /disab|handicap|impairment|accommodation_?need/i,
  /health|medical|diagnos|illness|clinical|therap|psychiatric|mental_?health/i,
  /pregnan|maternity|menstrual|wellness|cycle_(day|length|phase)/i,
  /marital|spouse|widow|divorc/i,
  /biometric|genetic/i,
];

/**
 * FIELDS THIS SYSTEM WILL NOT CARRY AT ALL, IN ANY ASSERTION TYPE.
 *
 * Two families, and both are refusals the founder's brief makes explicitly:
 *   - PERSON-OUTCOME PREDICTIONS with no labelled history and no validated instrument behind them.
 *     Attrition, flight risk, culture fit, personality, potential rating, engagement score,
 *     sentiment, loyalty, morale, trustworthiness.
 *   - SURVEILLANCE SIGNALS. Keystrokes, screenshots, activity scores, communication volume, screen
 *     or webcam monitoring. Performance is never inferred from any of them.
 *
 * Refused here rather than simply unimplemented, so that the seam does not exist: the first code
 * that tries to annotate one gets a sentence back naming the rule instead of a working row.
 */
const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  /attrition|flight_?risk|retention_?risk|churn_?risk|resign(ation)?_?(risk|likelihood|probability)/i,
  /culture_?fit|personality|psychometric|temperament/i,
  /potential_?(score|rating|index|band)|promotability_?score/i,
  /engagement_?(score|index)|sentiment_?(score|analysis)|morale_?score|loyalty_?score/i,
  /wellbeing_?score|burnout_?(score|risk)/i,
  /trustworth|honesty_?score|integrity_?score/i,
  /keystroke|screenshot|screen_?capture|screen_?time|idle_?time|mouse_?activity/i,
  /activity_?score|productivity_?score|communication_?volume|message_?count|monitoring/i,
];

export function isProtectedField(field: string): boolean {
  const f = String(field || '');
  return PROTECTED_FIELD_PATTERNS.some((re) => re.test(f));
}

export function isForbiddenField(field: string): boolean {
  const f = String(field || '');
  return FORBIDDEN_FIELD_PATTERNS.some((re) => re.test(f));
}

/** Identifier shape for entity types and fields: lowercase, no spaces, no casts, no surprises. */
const SLUG_RE = /^[a-z][a-z0-9_.]{1,80}$/;

/**
 * THE SIX DECISIONS A HUMAN KEEPS. Hiring, rejection, termination, promotion, compensation and
 * discipline. Nothing automated may make one, and no score may stand in for one.
 *
 * DECLARED HERE, ABOVE EVERY FUNCTION THAT READS IT. `const` is not hoisted, and this project has
 * taken pages down by reading one from a handler declared above it.
 */
const CONSEQUENTIAL_DECISION_PATTERNS: readonly RegExp[] = [
  /\b(hire|hiring)_?(decision|outcome)?\b|shortlist_?decision|selection_?decision/i,
  /reject|rejection|decline_?decision|disqualif/i,
  /terminat|dismiss|separation_?decision|offboard_?decision/i,
  /promot(e|ion)_?(decision|outcome)?\b|demot/i,
  /compensation|salary_?decision|pay_?(rise|raise|band)|increment_?decision|bonus_?decision/i,
  /disciplin|warning_?decision|sanction|penalis|penaliz/i,
];

const DECISION_SENTENCE =
  'Hiring, rejection, termination, promotion, compensation and discipline are decided by a named '
  + 'human, who can be asked why.';

export function isConsequentialDecision(field: string): boolean {
  const f = String(field || '');
  return CONSEQUENTIAL_DECISION_PATTERNS.some((re) => re.test(f));
}

// -------------------------------------------------------------------------------------------------
// THE FINGERPRINT
//
// It answers exactly one question — "is the value still the one that was recorded" — and it answers
// nothing else. It is not a copy of the value and it must never be reversed into one: a fingerprint
// of a short field is guessable, which is why it is never shown on a screen and never returned to a
// caller that did not already hold the value.
// -------------------------------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 's:' + value.trim();
  if (typeof value === 'number') return 'n:' + (Number.isFinite(value) ? String(value) : 'nan');
  if (typeof value === 'boolean') return 'b:' + (value ? '1' : '0');
  if (value instanceof Date) return 'd:' + value.toISOString();
  if (Array.isArray(value)) return 'a:[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return 'o:{' + keys.map((k) => k + '=' + canonical(obj[k])).join(',') + '}';
}

export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);
}

// -------------------------------------------------------------------------------------------------
// CONSTRUCTION
// -------------------------------------------------------------------------------------------------

/** Everything every constructor needs. `value` is fingerprinted and immediately forgotten. */
export interface ElementInput {
  entityType: string;
  entityId: string;
  field: string;
  /** The value as it stands in the real column, for fingerprinting only. Never stored. */
  value?: unknown;
  source: { system: string; detail?: string | null; actorUserId?: string | null; actorName?: string | null };
  owner: { kind: OwnerKind; subjectKind?: string | null; subjectId?: string | null; label: string };
  access?: AccessLevel;
  reasoning?: string | null;
  uncertainty?: string | null;
  assumptions?: string[];
  basis?: string[];
  evidence?: EvidenceRef[];
  confidence?: number | null;
  recordedAt?: string;
}

function normaliseEvidence(list: EvidenceRef[] | undefined): ProvenanceResult<EvidenceRef[]> {
  const out: EvidenceRef[] = [];
  for (const e of list || []) {
    const kind = clean(e?.kind, 40).toLowerCase();
    const label = clean(e?.label, 300);
    if (!kind) return fail('Every piece of evidence needs a kind naming what it is.');
    if (!label) return fail('Every piece of evidence needs a label a person can read.');
    const url = clean(e?.url, 600) || null;
    if (url && !/^https?:\/\//i.test(url)) {
      return fail('An evidence link must start with http:// or https://');
    }
    out.push(Object.freeze({ kind, id: clean(e?.id, 100) || null, label, url }));
  }
  return good(out);
}

function freezeElement<T extends ProvenanceElement>(el: T): T {
  Object.freeze(el.source);
  Object.freeze(el.owner);
  Object.freeze(el.assumptions);
  Object.freeze(el.basis);
  Object.freeze(el.evidence);
  Object.freeze(el.history);
  if (el.verification) {
    Object.freeze(el.verification.evidence);
    Object.freeze(el.verification);
  }
  return Object.freeze(el);
}

/**
 * THE ONE PLACE AN UNVERIFIED ELEMENT IS BUILT. Not exported: an assertion type is a decision, and
 * a caller choosing one from a string parameter is how 'inferred' becomes 'factual' in a refactor
 * six months from now. The exported constructors each fix their own type and demand what that type
 * owes the reader.
 */
function build(assertion: UnverifiedAssertion, input: ElementInput): ProvenanceResult<UnverifiedElement> {
  const entityType = clean(input?.entityType, 60).toLowerCase();
  const entityId = clean(input?.entityId, 100);
  const field = clean(input?.field, 120).toLowerCase();

  if (!SLUG_RE.test(entityType)) {
    return fail('An entity type must be a lowercase name such as hr_employee or application.');
  }
  if (!entityId) return fail('Provenance has to be about a particular record. Name the entity id.');
  if (!SLUG_RE.test(field)) {
    return fail('A field must be a lowercase column or property name, such as base_salary.');
  }

  // THE TWO REFUSALS. Neither is negotiable and neither has an override parameter.
  if (isForbiddenField(field)) {
    return fail(
      'This system does not hold a field called ' + field + '. Predictions about a person\'s future '
      + 'behaviour and signals collected by monitoring people are not recorded here in any form, so '
      + 'there is nothing to annotate. Record what a person did, and let a human read it.',
    );
  }
  if (isProtectedField(field) && assertion !== 'explicitly_provided') {
    return fail(
      'The field ' + field + ' is a protected or sensitive attribute. It may only be recorded as '
      + 'something the person themselves provided — never inferred, calculated, predicted or '
      + 'recommended — and it can never be a factor in a decision about them.',
    );
  }

  const descriptor = assertionDescriptor(assertion);
  if (!descriptor) return fail('Unknown assertion type.');

  const systemName = clean(input?.source?.system, 120);
  if (!systemName) return fail('Name the system, module or person that produced this value.');
  if (/^(system|unknown|n\/a|auto)$/i.test(systemName)) {
    return fail('"' + systemName + '" does not name anything. Say which module, table or partner produced it.');
  }

  const ownerLabel = clean(input?.owner?.label, 200);
  const ownerKind = input?.owner?.kind;
  if (ownerKind !== 'person' && ownerKind !== 'organization' && ownerKind !== 'platform') {
    return fail('Say whose data this is: the person, the organization, or the platform.');
  }
  if (!ownerLabel) return fail('Name the owner of this data in words a person would recognise.');

  const access: AccessLevel = (ACCESS_LEVELS as readonly string[]).indexOf(String(input?.access)) >= 0
    ? (input!.access as AccessLevel)
    : (ownerKind === 'person' ? 'restricted' : 'internal');

  // CONFIDENCE. Required where the descriptor says a guess must say how sure it is; refused where a
  // number would dress a record up as a probability. There is no default of 1: an element that
  // "forgot" its confidence would read as certainty.
  let confidence: number | null = null;
  const rawConfidence = input?.confidence;
  if (rawConfidence !== null && rawConfidence !== undefined) {
    const n = Number(rawConfidence);
    if (!isFinite(n) || n < 0 || n > 1) return fail('Confidence is a number between 0 and 1.');
    if (descriptor.refusesConfidence) {
      return fail(
        'A ' + descriptor.label.toLowerCase() + ' does not carry a confidence. If you are not sure of '
        + 'it, it is not one — record it as inferred and say what you are unsure about.',
      );
    }
    confidence = Math.round(n * 1000) / 1000;
  } else if (descriptor.needsConfidence) {
    return fail(
      'A ' + descriptor.label.toLowerCase() + ' must say how sure it is. Give a confidence between 0 '
      + 'and 1, or record this as something the system was told rather than something it worked out.',
    );
  }

  const reasoning = clean(input?.reasoning, 2000) || null;
  const uncertainty = clean(input?.uncertainty, 2000) || null;
  const assumptions = (input?.assumptions || []).map((a) => clean(a, 300)).filter(Boolean);
  const basis = (input?.basis || []).map((b) => clean(b, 200)).filter(Boolean);

  // WHAT EACH TYPE OWES THE READER. These are the seven questions, enforced at the moment of writing
  // rather than apologised for at the moment of reading.
  if (assertion === 'inferred' || assertion === 'predicted') {
    if (!reasoning) return fail('An ' + descriptor.label.toLowerCase() + ' has to say why it was reached.');
    if (!basis.length) return fail('Name the data this rests on. A conclusion with no named basis cannot be checked.');
    if (!uncertainty) return fail('Say what this does not know. "Nothing" is never the true answer.');
  }
  if (assertion === 'calculated') {
    if (!reasoning) return fail('A calculated value has to state the definition it was computed by.');
    if (!basis.length) return fail('Name the inputs. A calculation changes when they do, and a reader has to know which.');
  }
  if (assertion === 'recommended') {
    if (!reasoning) return fail('A recommendation has to say what it is based on.');
    if (!basis.length) return fail('Name the evidence this recommendation rests on.');
  }

  const evidenceResult = normaliseEvidence(input?.evidence);
  if (!evidenceResult.ok) return evidenceResult;

  const recordedAt = clean(input?.recordedAt, 40) || nowIso();
  const actorUserId = isUuid(input?.source?.actorUserId) ? String(input!.source!.actorUserId) : null;

  if (assertion === 'explicitly_provided' && !actorUserId && !clean(input?.source?.actorName, 200)) {
    return fail('Something a person provided has to name the person who provided it.');
  }

  const el: UnverifiedElement = {
    entityType,
    entityId,
    field,
    assertion,
    source: {
      system: systemName,
      detail: clean(input?.source?.detail, 1000) || null,
      actorUserId,
      actorName: clean(input?.source?.actorName, 200) || null,
    },
    recordedAt,
    owner: {
      kind: ownerKind,
      subjectKind: clean(input?.owner?.subjectKind, 40).toLowerCase() || null,
      subjectId: clean(input?.owner?.subjectId, 100) || null,
      label: ownerLabel,
    },
    access,
    confidence,
    reasoning,
    uncertainty,
    assumptions,
    basis,
    evidence: evidenceResult.value,
    fingerprint: input && 'value' in input ? fingerprintOf(input.value) : null,
    history: [Object.freeze({
      at: recordedAt,
      kind: 'recorded' as const,
      actorUserId,
      actorName: clean(input?.source?.actorName, 200) || null,
      reason: null,
      from: null,
      to: assertion,
    })],
    stale: false,
    verification: null,
    derivedFrom: null,
  };
  return good(freezeElement(el));
}

/**
 * A FACT THE PLATFORM RECORDED ABOUT ITS OWN ACT. A row exists. A certificate was signed. An offer
 * was countersigned at this timestamp.
 *
 * IT IS A CONSTRUCTOR AND NOT A CONVERTER. It takes a value and a system of record; it does not take
 * an element. There is no code path anywhere in this file from an existing element to this function,
 * which is what makes "an inference can never be promoted to a fact" true rather than aspirational.
 *
 * It refuses a claim about a PERSON'S CAPABILITY outright. "Holds Postgres at level 4" is never a
 * fact of the platform, however it arrived: it is what somebody stated, or what a completion
 * evidenced, or what a manager assessed. This refusal is the keyword rule with teeth.
 */
export function recordFact(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  const field = clean(input?.field, 120).toLowerCase();
  if (/skill|competenc|proficien|capabilit|expertise|mastery/.test(field)) {
    return fail(
      'A capability is never a fact of this platform. Record what was demonstrated — a completion, a '
      + 'passed assessment, a piece of work a named person reviewed — and let the level rest on that.',
    );
  }
  return build('factual', input);
}

/** A person typed it. About themselves, or about somebody else. A claim, and only a claim. */
export function recordProvided(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  return build('explicitly_provided', input);
}

/** The system worked it out. Advisory, always, and it has to say what it rests on and what it doubts. */
export function recordInference(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  return build('inferred', input);
}

/** Deterministic arithmetic over inputs that have their own provenance. */
export function recordCalculation(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  return build('calculated', input);
}

/**
 * About something that has not happened.
 *
 * The forbidden-field list has already refused the predictions this product will not make about a
 * person — attrition, flight risk, culture fit and the rest. What is left is honest: a due date, a
 * projected completion, a headcount plan. A prediction about a PERSON at all is refused here, one
 * layer beyond the field list, because the field name is not always the giveaway.
 */
export function recordPrediction(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  if (input?.owner?.kind === 'person') {
    return fail(
      'This system does not predict things about people. A prediction is about work, a schedule or a '
      + 'plan; a person is recorded by what they did and judged by a human who can be asked why.',
    );
  }
  return build('predicted', input);
}

/**
 * Advice to a human who decides.
 *
 * A recommendation about a person is allowed — "review this application", "consider this person for
 * this opening" — because a human still decides and can be shown exactly what it rested on. What it
 * may never carry is an outcome. isConsequentialDecision() below names the six decisions a
 * recommendation may never make, and this refuses to be filed under one of them.
 */
export function recordRecommendation(input: ElementInput): ProvenanceResult<UnverifiedElement> {
  const field = clean(input?.field, 120).toLowerCase();
  if (isConsequentialDecision(field)) {
    return fail(
      'A recommendation cannot be recorded as the decision itself. ' + DECISION_SENTENCE
      + ' Record the recommendation against what it advises on, and let the decision be a human act '
      + 'routed through the approval workflow.',
    );
  }
  return build('recommended', input);
}

// -------------------------------------------------------------------------------------------------
// VERIFICATION — THE ONLY WAY A 'verified' ELEMENT COMES INTO EXISTENCE
// -------------------------------------------------------------------------------------------------

/**
 * WHO IS ALLOWED TO VERIFY, ANSWERED BY THE CALLER RATHER THAN HERE.
 *
 * `relationship` is an edge from src/lib/org-graph.ts — 'reporting_manager', 'mentor', 'reviewer',
 * 'department_head' — resolved PER ROW for this person. `orgWide` is the caller's answer to
 * can(user, 'provenance.verify'). One of the two must be present, and a capability never stands in
 * for a relationship on a person's own record: it is the org-wide version, named as such.
 *
 * This module reads neither the graph nor the permission registry, for the same reason
 * src/lib/skills.ts does not: a second authorization engine is a second answer.
 */
export interface VerifyAuthority {
  orgWide?: boolean;
  relationship?: string | null;
  /** True when the subject is verifying something on their own record. */
  self?: boolean;
}

/**
 * Promote a claim to a verified element.
 *
 * THIS IS THE ONLY FUNCTION IN THE CODEBASE THAT PRODUCES assertion = 'verified', and it cannot be
 * called without a named human: an actor id, an actor name, a written reason of at least
 * MIN_REASON_CHARS, and a method saying HOW it was checked. Those are parameters, not options —
 * there is no overload without them and no default actor.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS THE POINT:
 *
 *   A PREDICTION.      It is about something that has not happened. A human agreeing with a forecast
 *                      does not make the forecast true, and a verified prediction on a screen would
 *                      read exactly like a recorded fact.
 *   A RECOMMENDATION.  It is advice. Verifying advice would turn it into an outcome, which is the
 *                      one thing a recommendation may never become.
 *   A PLATFORM FACT.   Nothing is added by a human confirming this platform's own record of its own
 *                      act, and letting them do it invites a signature to stand in for the record.
 *   AN INFERENCE WITH NO EVIDENCE. A human ticking a box beside a guess produces a verified guess.
 *                      Verifying an inference requires naming what was checked, so that the chain
 *                      answers "on what evidence" rather than "because somebody said so".
 *   RE-VERIFICATION.   An element already verified is withdrawn first, by a named human with a
 *                      reason. Overwriting one verification with another loses the first.
 *   A STALE ELEMENT.   If the value has changed since it was recorded, there is nothing here to
 *                      verify: record the new value first.
 *
 * WHAT IT NEVER DOES: change the value, clear the uncertainty, or forget what the element was before.
 * `derivedFrom` keeps the original assertion type forever, and renderProvenance() prints it.
 */
export function verify(
  element: ProvenanceElement,
  act: HumanAct,
  authority: VerifyAuthority = {},
): ProvenanceResult<VerifiedElement> {
  if (!element || typeof element !== 'object') return fail('There is nothing here to verify.');

  if (element.assertion === 'verified') {
    const v = (element as VerifiedElement).verification;
    return fail(
      'This was already verified by ' + v.actorName + ' on ' + v.at.slice(0, 10) + '. Withdraw that '
      + 'verification, with a reason, before recording a new one.',
    );
  }
  if (element.stale) {
    return fail('The value has changed since this was recorded, so there is nothing here to verify yet. Record the value as it stands now, then verify that.');
  }
  if (element.assertion === 'predicted') {
    return fail('A prediction is about something that has not happened. It cannot be verified — only overtaken by what actually occurs.');
  }
  if (element.assertion === 'recommended') {
    return fail('A recommendation is advice for a human to accept or refuse. Verifying it would turn advice into an outcome.');
  }
  if (element.assertion === 'factual') {
    return fail('This is the platform\'s own record of its own act. There is nothing for a person to confirm, and a signature beside it would only obscure where it came from.');
  }
  if (isProtectedField(element.field)) {
    return fail('A protected or sensitive attribute is held because the person provided it. It is not checked, not confirmed, and never a factor in a decision.');
  }

  const actorUserId = isUuid(act?.actorUserId) ? String(act.actorUserId) : '';
  if (!actorUserId) return fail('A verification has to name the person making it. Nothing was recorded.');
  const actorName = clean(act?.actorName, 200);
  if (actorName.length < 2) return fail('A verification has to carry the name of the person making it, as it would be read on the record.');
  const reason = clean(act?.reason, 2000);
  if (reason.length < MIN_REASON_CHARS) {
    return fail('Write what you checked and how, in at least ' + MIN_REASON_CHARS + ' characters. A verification with no reason cannot be reviewed later.');
  }
  const method = act?.method;
  if (!method || (VERIFICATION_METHODS as readonly string[]).indexOf(method) < 0) {
    return fail('Say how this was checked: against a record, a document seen, confirmed by the issuer, witnessed directly, or independently reproduced.');
  }
  // WHO MAY VERIFY. Somebody confirming their own statement is not verification, it is the same
  // claim restated, and the refusal names that difference rather than pretending the act had no
  // effect. Everything else comes from the caller: a per-row relationship out of the Organization
  // Graph, or the organization-wide desk.
  const hasRelationship = clean(authority?.relationship, 60).length > 0;
  if (!authority?.orgWide && !hasRelationship) {
    if (authority?.self === true) {
      return fail('Confirming your own statement does not verify it. Somebody who answers for this record, or the verification desk, records that.');
    }
    return fail(
      'Nothing in the Organization Graph records you as answering for this record, and you do not '
      + 'hold the organization-wide verification desk, so this verification was not recorded.',
    );
  }

  const evidenceResult = normaliseEvidence(act?.evidence);
  if (!evidenceResult.ok) return evidenceResult;
  const evidence = evidenceResult.value;
  if (element.assertion === 'inferred' && evidence.length === 0) {
    return fail(
      'An inference is verified by naming what was checked, not by agreeing with it. Attach the '
      + 'record, the document or the piece of work that confirms it.',
    );
  }
  const at = nowIso();
  const verified: VerifiedElement = {
    ...element,
    assertion: 'verified',
    derivedFrom: element.assertion,
    verification: {
      actorUserId,
      actorName,
      reason,
      method: method as VerificationMethod,
      at,
      evidence,
    },
    // The evidence a human checked joins the element's own evidence; neither replaces the other.
    evidence: element.evidence.concat(evidence),
    history: element.history.concat([Object.freeze({
      at,
      kind: 'verified' as const,
      actorUserId,
      actorName,
      reason,
      from: element.assertion,
      to: 'verified' as const,
    })]),
  };
  return good(freezeElement(verified));
}

/**
 * Withdraw a verification — also a named human act, also with a reason.
 *
 * The element goes back to EXACTLY what it was before, never to something stronger, and the
 * withdrawal stays in the history. A verification that could be quietly removed would be worth
 * nothing; one that leaves a trace is worth what it says.
 */
export function withdrawVerification(
  element: ProvenanceElement,
  act: HumanAct,
): ProvenanceResult<UnverifiedElement> {
  if (element?.assertion !== 'verified') return fail('This is not verified, so there is nothing to withdraw.');
  const actorUserId = isUuid(act?.actorUserId) ? String(act.actorUserId) : '';
  const actorName = clean(act?.actorName, 200);
  const reason = clean(act?.reason, 2000);
  if (!actorUserId || actorName.length < 2) return fail('Withdrawing a verification has to name the person doing it.');
  if (reason.length < MIN_REASON_CHARS) {
    return fail('Say why the verification no longer stands, in at least ' + MIN_REASON_CHARS + ' characters.');
  }
  const at = nowIso();
  const back: UnverifiedElement = {
    ...element,
    assertion: (element as VerifiedElement).derivedFrom,
    derivedFrom: null,
    verification: null,
    history: element.history.concat([Object.freeze({
      at,
      kind: 'verification_withdrawn' as const,
      actorUserId,
      actorName,
      reason,
      from: 'verified' as const,
      to: (element as VerifiedElement).derivedFrom,
    })]),
  };
  return good(freezeElement(back));
}

/**
 * Has the value moved since this element was recorded?
 *
 * The reader calls this with the value it just read from the real column. A mismatch does not delete
 * anything — it marks the element stale, and the render contract stops presenting a stale
 * verification as verified. Nothing else in this file changes an element after it is built.
 */
export function checkAgainstValue(element: ProvenanceElement, currentValue: unknown): ProvenanceElement {
  if (!element?.fingerprint) return element;
  const matches = element.fingerprint === fingerprintOf(currentValue);
  if (matches === !element.stale) return element;
  return freezeElement({ ...element, stale: !matches } as ProvenanceElement);
}

// =================================================================================================
// THE RENDERING CONTRACT
//
// Provenance that never reaches a screen is decoration, and decoration is worse than nothing: it
// lets everybody believe the system is careful while every screen still prints a guess in the same
// type as a fact. So the contract is here, in the same file as the rule, and it is not optional:
//
//   1. EVERY element rendered next to a person carries its SENTENCE. Not a badge alone — a badge is
//      a colour, and a colour is not a sentence somebody can disagree with.
//   2. AN ADVISORY ELEMENT IS NEVER GIVEN THE WEIGHT OF A RECORD. Inferred, predicted and
//      recommended render at 'advisory': lighter type, an outline rather than a fill, and the word
//      Inferred or Prediction or Recommendation visible without hovering, tapping or expanding
//      anything. A prediction in the same visual weight as a recorded fact IS the failure this
//      layer exists to prevent, and there is no styling parameter that permits it.
//   3. A STALE VERIFICATION IS NOT A VERIFICATION. When the value has moved since it was checked,
//      renderProvenance() stops printing the word Verified. It says the verification is out of date
//      and drops to advisory weight — automatically, with nothing for a page author to remember.
//   4. NOTHING IS HIDDEN BEHIND AN INTERACTION. `sentence` is what the screen shows; `explanation`
//      is what a person can open. The first is never empty and never a truncation of the second.
//   5. NO EMOJI. The glyphs below are inline monochrome SVG paths on currentColor, which is also the
//      only kind of icon this product ships.
// =================================================================================================

export interface ProvenanceGlyph {
  viewBox: string;
  /** A single path on currentColor. Stroked, not filled — one shape, no emoji, no colour of its own. */
  path: string;
  strokeWidth: number;
}

const GLYPHS: ReadonlyArray<{ weight: RenderWeight; glyph: ProvenanceGlyph }> = Object.freeze([
  // A check inside nothing: the plainest mark for "this is on the record".
  { weight: 'record', glyph: { viewBox: '0 0 20 20', path: 'M3.5 10.5l4 4 9-9', strokeWidth: 1.75 } },
  // A speech mark: somebody said it.
  { weight: 'stated', glyph: { viewBox: '0 0 20 20', path: 'M4 4.5h12v9H9.5L5.5 17v-3.5H4z', strokeWidth: 1.5 } },
  // Two bars: worked out from things underneath it.
  { weight: 'derived', glyph: { viewBox: '0 0 20 20', path: 'M3.5 7.5h13M3.5 12.5h13M7 4v12', strokeWidth: 1.5 } },
  // An open triangle: read this, do not act on it alone.
  { weight: 'advisory', glyph: { viewBox: '0 0 20 20', path: 'M10 3.2l7 12.6H3zM10 8.6v3.4M10 14.2v.1', strokeWidth: 1.5 } },
]);

export function glyphFor(weight: RenderWeight): ProvenanceGlyph {
  const found = GLYPHS.find((g) => g.weight === weight);
  return (found ? found.glyph : GLYPHS[3].glyph);
}

/**
 * The markup a page inlines. Monochrome, currentColor, aria-hidden — the sentence beside it is what
 * a screen reader announces, because a shape is not a statement.
 */
export function provenanceGlyphSvg(weight: RenderWeight): string {
  const g = glyphFor(weight);
  return '<svg viewBox="' + g.viewBox + '" width="14" height="14" fill="none" stroke="currentColor"'
    + ' stroke-width="' + g.strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true" focusable="false"><path d="' + g.path + '"/></svg>';
}

const METHOD_PHRASES: ReadonlyArray<{ key: VerificationMethod; phrase: string }> = Object.freeze([
  { key: 'checked_against_record', phrase: 'checked against the record that holds it' },
  { key: 'document_seen', phrase: 'a document was seen' },
  { key: 'issuer_confirmed', phrase: 'confirmed with the body that issued it' },
  { key: 'witnessed_directly', phrase: 'witnessed directly' },
  { key: 'independently_reproduced', phrase: 'independently reproduced' },
]);

function methodPhrase(method: string): string {
  const m = METHOD_PHRASES.find((p) => p.key === method);
  return m ? m.phrase : 'checked';
}

/**
 * HOW A VERIFIED ELEMENT NAMES WHAT IT WAS BEFORE. A phrase rather than a label, because "a checked
 * inferred" is not a sentence and the reader is being told something that matters.
 */
const PRIOR_PHRASES: ReadonlyArray<{ key: UnverifiedAssertion; phrase: string }> = Object.freeze([
  { key: 'factual', phrase: 'a record this platform made of its own act' },
  { key: 'explicitly_provided', phrase: 'a statement somebody entered' },
  { key: 'inferred', phrase: 'an inference the system reached on its own' },
  { key: 'calculated', phrase: 'a value worked out from other records' },
  { key: 'predicted', phrase: 'a prediction' },
  { key: 'recommended', phrase: 'a recommendation' },
]);

function priorPhrase(key: UnverifiedAssertion): string {
  const p = PRIOR_PHRASES.find((x) => x.key === key);
  return p ? p.phrase : 'something else';
}

const dayOf = (iso: string): string => String(iso || '').slice(0, 10) || 'an unrecorded date';

const percentOf = (c: number | null): string =>
  c === null || c === undefined ? 'an unstated confidence' : String(Math.round(c * 100)) + '%';

function whoStated(el: ProvenanceElement): string {
  return el.source.actorName || (el.owner.kind === 'person' ? el.owner.label : el.source.system);
}

export interface ProvenanceRender {
  /** The assertion as it should be read now — 'verified' becomes stale when the value moved. */
  assertion: AssertionType;
  label: string;
  weight: RenderWeight;
  /** THE SENTENCE. Print it. It is never empty. */
  sentence: string;
  /** A short form for a dense table cell. Still a phrase, never a bare colour. */
  short: string;
  decisionUse: DecisionUse;
  /** What a screen must say beside a control that acts on this element. */
  decisionNote: string;
  /** Class token a page applies. The CSS is PROVENANCE_CSS below; nothing else styles these. */
  className: string;
  glyph: ProvenanceGlyph;
  /** Announced before the sentence, so the badge is not silent to a screen reader. */
  srPrefix: string;
  /** True when a UI must NOT print this value as a statement about the person. */
  advisoryOnly: boolean;
}

/**
 * GIVEN AN ELEMENT, THE SENTENCE A UI MUST SHOW.
 *
 * Everything a screen needs to render provenance honestly comes out of this one function, so that a
 * new page cannot get it wrong by forgetting a rule it never read.
 */
export function renderProvenance(el: ProvenanceElement): ProvenanceRender {
  const staleVerified = el.assertion === 'verified' && el.stale;
  const effective: AssertionType = staleVerified ? (el as VerifiedElement).derivedFrom : el.assertion;
  const descriptor = assertionDescriptor(effective) || ASSERTIONS[1];

  // A stale verification is never printed as a verification, and a stale anything is never allowed
  // to carry the weight of a record.
  const weight: RenderWeight = el.stale ? 'advisory' : descriptor.weight;
  const decisionUse: DecisionUse = el.stale ? 'advisory_only' : descriptor.decisionUse;
  const label = staleVerified ? 'Verification out of date' : (el.stale ? descriptor.label + ' (out of date)' : descriptor.label);

  const bits: string[] = [];
  if (el.stale) {
    bits.push(
      staleVerified
        ? 'The value has changed since ' + (el as VerifiedElement).verification.actorName
          + ' verified it on ' + dayOf((el as VerifiedElement).verification.at)
          + ', so it is no longer verified.'
        : 'The value has changed since this was recorded on ' + dayOf(el.recordedAt) + '.',
    );
  }

  if (el.assertion === 'verified' && !staleVerified) {
    const v = (el as VerifiedElement).verification;
    bits.push('Verified by ' + v.actorName + ' on ' + dayOf(v.at) + ' — ' + methodPhrase(v.method) + '.');
    bits.push('Reason given: ' + v.reason);
    // WHAT IT WAS BEFORE IS PART OF THE SENTENCE, ALWAYS. A checked inference is a checked
    // inference; the check is what a person did, and it does not rewrite where the value came from.
    bits.push('Before this it was ' + priorPhrase((el as VerifiedElement).derivedFrom)
      + ', and that is what was checked.');
  } else if (effective === 'factual') {
    bits.push('Recorded by ' + el.source.system + ' on ' + dayOf(el.recordedAt) + '. This is this platform\'s record of its own act, not anybody\'s judgement.');
  } else if (effective === 'explicitly_provided') {
    bits.push('Stated by ' + whoStated(el) + ' on ' + dayOf(el.recordedAt) + '. Nobody has checked it against anything.');
  } else if (effective === 'inferred') {
    bits.push('Inferred by ' + el.source.system + ' on ' + dayOf(el.recordedAt) + '. Nobody stated this and nobody has confirmed it.');
    if (el.reasoning) bits.push(el.reasoning);
    bits.push('About ' + percentOf(el.confidence) + ' sure.');
    if (el.uncertainty) bits.push('Not known: ' + el.uncertainty);
  } else if (effective === 'calculated') {
    bits.push('Calculated by ' + el.source.system + ' on ' + dayOf(el.recordedAt) + '.');
    if (el.reasoning) bits.push(el.reasoning);
    if (el.basis.length) bits.push('It is worked out from ' + el.basis.join(', ') + ', and it changes when they do.');
  } else if (effective === 'predicted') {
    bits.push('A prediction made by ' + el.source.system + ' on ' + dayOf(el.recordedAt) + ', about something that has not happened.');
    if (el.reasoning) bits.push(el.reasoning);
    bits.push('About ' + percentOf(el.confidence) + ' sure.');
    if (el.uncertainty) bits.push('Not known: ' + el.uncertainty);
  } else {
    bits.push('A recommendation from ' + el.source.system + ' on ' + dayOf(el.recordedAt) + '.');
    if (el.reasoning) bits.push(el.reasoning);
    bits.push('A person decides. This decides nothing by itself.');
  }

  const decisionNote =
    decisionUse === 'may_decide'
      ? 'This may be relied on, and where it is, the record shows who checked it.'
      : decisionUse === 'supporting_only'
        ? 'This supports a decision. It does not make one, and on its own it is not proof.'
        : 'Advisory only. A person decides, and they can be asked why. ' + DECISION_SENTENCE;

  const short = staleVerified
    ? 'Verification out of date'
    : effective === 'verified'
      ? 'Verified by ' + (el as VerifiedElement).verification.actorName
      : effective === 'explicitly_provided'
        ? 'Stated by ' + whoStated(el)
        : descriptor.label + (descriptor.needsConfidence ? ' — ' + percentOf(el.confidence) + ' sure' : '');

  return {
    assertion: staleVerified ? effective : el.assertion,
    label,
    weight,
    sentence: bits.join(' '),
    short,
    decisionUse,
    decisionNote,
    className: 'prov prov--' + weight,
    glyph: glyphFor(weight),
    srPrefix: label + ':',
    advisoryOnly: decisionUse === 'advisory_only',
  };
}

/** The sentence alone, for a caller that only needs the words. */
export function provenanceSentence(el: ProvenanceElement): string {
  return renderProvenance(el).sentence;
}

/**
 * WHEN THE PROVENANCE ROW ITSELF CANNOT BE READ.
 *
 * A stored row that claims 'verified' and names nobody is not downgraded to a claim and not silently
 * dropped: it is returned as unreadable and rendered as unreadable, on the precedent of
 * /admin/tests/attempts printing EVIDENCE UNREADABLE rather than inventing a score. A screen that
 * quietly showed the value with no provenance would be the most confident screen in the product.
 */
export function renderUnreadable(reason: string): ProvenanceRender {
  return {
    assertion: 'inferred',
    label: 'Provenance unreadable',
    weight: 'advisory',
    sentence: 'We cannot say how this value came to be known: ' + reason
      + ' Until that is put right, treat it as unconfirmed and do not decide anything on it.',
    short: 'Provenance unreadable',
    decisionUse: 'advisory_only',
    decisionNote: 'Advisory only. ' + DECISION_SENTENCE,
    className: 'prov prov--advisory prov--unreadable',
    glyph: glyphFor('advisory'),
    srPrefix: 'Provenance unreadable:',
    advisoryOnly: true,
  };
}

/**
 * THE STYLESHEET, SHIPPED WITH THE RULE IT ENFORCES.
 *
 * Inlined by whichever layout renders provenance. It is here rather than in a global sheet so that
 * "advisory is lighter than a record" travels with the code that decides which is which — a rule
 * kept in a design document is a rule that survives exactly one redesign.
 *
 * MOBILE FIRST. Badges wrap at 360px, the sentence is never truncated with an ellipsis (a truncated
 * provenance sentence is a misleading one), and where the badge is a control it is 44px tall.
 */
export const PROVENANCE_CSS = [
  '.prov{display:inline-flex;align-items:center;gap:.375rem;max-width:100%;',
  'font-size:.75rem;line-height:1.25;padding:.1875rem .4375rem;border-radius:.25rem;',
  'border:1px solid currentColor;white-space:normal;overflow-wrap:anywhere}',
  '.prov svg{flex:0 0 auto}',
  '.prov--record{font-weight:600;opacity:1;border-style:solid}',
  '.prov--stated{font-weight:400;opacity:.9;border-style:solid;border-color:currentColor}',
  '.prov--derived{font-weight:400;opacity:.9;border-style:solid}',
  // Advisory is deliberately the quietest thing on the row: lighter, dashed, italic. It must never
  // be restyled to match a record, and there is no modifier here that would let it.
  '.prov--advisory{font-weight:400;opacity:.75;border-style:dashed;font-style:italic}',
  '.prov--unreadable{text-decoration:underline dotted}',
  '.prov-sentence{display:block;font-size:.8125rem;line-height:1.45;margin-top:.25rem;opacity:.9}',
  '.prov-sentence--advisory{font-style:italic}',
  'button.prov,a.prov{min-height:44px;padding-block:.625rem}',
  '@media (max-width:360px){.prov{font-size:.6875rem}}',
].join('');

/** The class a page puts on the sentence element, so it matches the weight of its badge. */
export function sentenceClass(r: ProvenanceRender): string {
  return r.weight === 'advisory' ? 'prov-sentence prov-sentence--advisory' : 'prov-sentence';
}

// =================================================================================================
// THE SEVEN QUESTIONS
//
// No opaque score on a high-impact decision. Seven questions must be answerable about anything that
// influences one: what was concluded, why, on what evidence, under what assumptions, what is
// uncertain, what data influenced it, and can a human override it. explainElement() answers all
// seven or names the ones it cannot, and mayDecideOn() refuses a high-impact use while any answer
// is missing.
// =================================================================================================

export interface ProvenanceExplanation {
  /** What was concluded. */
  concluded: string;
  /** Why. */
  why: string;
  /** On what evidence. */
  evidence: string[];
  /** Under what assumptions. */
  assumptions: string[];
  /** What is uncertain. */
  uncertain: string;
  /** What data influenced it. */
  influencedBy: string[];
  /** Can a human override it. Always yes, and this says how. */
  override: string;
  /** The questions this element cannot answer. Empty is the only good answer for a high-impact use. */
  unanswered: string[];
}

export function explainElement(el: ProvenanceElement): ProvenanceExplanation {
  const r = renderProvenance(el);
  const unanswered: string[] = [];

  const concluded = el.field.replace(/_/g, ' ') + ' on ' + el.entityType.replace(/_/g, ' ')
    + ' ' + el.entityId + ' — ' + r.label.toLowerCase() + '.';

  let why = el.reasoning || '';
  if (!why && el.assertion === 'verified') why = (el as VerifiedElement).verification.reason;
  if (!why && el.assertion === 'explicitly_provided') why = whoStated(el) + ' entered it.';
  if (!why && el.assertion === 'factual') why = el.source.system + ' recorded it when it happened.';
  if (!why) unanswered.push('why it was concluded');

  const evidence = el.evidence.map((e) => e.label + (e.url ? ' (' + e.url + ')' : ''));
  if (!evidence.length && (el.assertion === 'verified' || el.assertion === 'inferred' || el.assertion === 'recommended')) {
    unanswered.push('what evidence it rests on');
  }

  // WHAT DATA INFLUENCED IT, asked of what the element ACTUALLY IS. A verified element is a checked
  // claim, a checked inference or a checked calculation, and each of those answers this question
  // differently — a claim is influenced by what the person entered and by nothing else, and saying
  // so is a complete answer rather than a missing one.
  const effectiveKind: AssertionType = el.assertion === 'verified'
    ? (el as VerifiedElement).derivedFrom
    : el.assertion;
  const assumptions = el.assumptions.slice();
  const influencedBy = el.basis.slice();
  if (!influencedBy.length) {
    if (effectiveKind === 'explicitly_provided') {
      influencedBy.push('what ' + whoStated(el) + ' entered, and nothing else');
    } else if (effectiveKind === 'factual') {
      influencedBy.push(el.source.system + ', which recorded the act as it happened');
    }
  }
  if (!influencedBy.length) unanswered.push('which data influenced it');

  const descriptor = assertionDescriptor(el.assertion);
  let uncertain = el.uncertainty || '';
  if (!uncertain) {
    uncertain = el.assertion === 'verified'
      ? 'What was checked is on the record; anything not named in the reason was not checked.'
      : el.assertion === 'explicitly_provided'
        ? 'Nobody has checked this against anything.'
        : el.assertion === 'factual'
          ? 'Nothing beyond the act itself is claimed.'
          : '';
  }
  if (!uncertain) unanswered.push('what is uncertain');
  if (descriptor && descriptor.needsConfidence && el.confidence === null) unanswered.push('how sure it is');
  if (el.stale) unanswered.push('whether it still describes the value on the record');

  const override = el.assertion === 'verified'
    ? 'Yes. A named person can withdraw this verification with a written reason, and the withdrawal stays on the record.'
    : 'Yes. Nothing here decides anything. ' + DECISION_SENTENCE;

  return { concluded, why, evidence, assumptions, uncertain, influencedBy, override, unanswered };
}

export interface DecisionCheck {
  allowed: boolean;
  /** The sentence to show wherever the answer is no. It always says what would change it. */
  reason: string;
}

/**
 * MAY A DECISION REST ON THIS?
 *
 * `high` means one of the six a human keeps: hiring, rejection, termination, promotion, compensation
 * and discipline. The answer for an advisory element is always no, and the answer for a protected
 * attribute is always no — including when a human verified it, because verifying somebody's religion
 * does not make it a permissible reason to do anything to them.
 */
export function mayDecideOn(el: ProvenanceElement, impact: 'high' | 'ordinary' = 'high'): DecisionCheck {
  if (isProtectedField(el.field)) {
    return {
      allowed: false,
      reason: 'This is a protected or sensitive attribute. It is never a factor in a decision about a person, in any assertion type, however it was established.',
    };
  }
  const r = renderProvenance(el);
  if (el.stale) {
    return { allowed: false, reason: 'The value has changed since this was recorded, so nothing here describes what is on the record now.' };
  }
  if (r.decisionUse === 'advisory_only') {
    return {
      allowed: false,
      reason: r.label + ' is advisory. It can be shown to the person deciding, with everything it rests on, but it cannot stand as the reason. ' + DECISION_SENTENCE,
    };
  }
  const missing = explainElement(el).unanswered;
  if (impact === 'high' && missing.length) {
    return {
      allowed: false,
      reason: 'A decision of this weight needs seven questions answered, and this cannot answer ' + missing.join(', ') + '.',
    };
  }
  if (impact === 'high' && r.decisionUse === 'supporting_only') {
    return {
      allowed: false,
      reason: r.label + ' supports a decision of this weight but cannot carry it on its own. Something checked by a named person has to be on the record too.',
    };
  }
  return { allowed: true, reason: r.decisionNote };
}

// =================================================================================================
// STORAGE — ADDITIVE, AND IT REWRITES NOTHING
//
// ONE TABLE, keyed by (entity_type, entity_id, field). Existing tables are not migrated and existing
// columns are not moved: applications.education stays exactly where it is and gains a row here
// saying it is something the applicant stated. Annotate, never relocate.
//
// entity_id IS TEXT AND EVERY COMPARISON IS ::text. departments.id is varchar(50) (a slug) in
// src/lib/db/schema.ts and UUID in db/hr-schema.sql, and half this product's department ids are
// slugs. A ::uuid cast throws on the first one that arrives, so there is not one anywhere in here.
//
// THE VALUE IS NOT STORED. Only a fingerprint of it. See the header.
//
// THE CHECK CONSTRAINT IS THE POINT. `assertion = 'verified'` requires a verifier id, a written
// reason and a timestamp, enforced by Postgres. A row that claims verification and names nobody
// cannot be inserted by this module, by a script, by a console session or by a future refactor.
// =================================================================================================

const TABLE = 'provenance_records';

/** Every column this module reads. provenanceSchemaStatus() checks for exactly these. */
const REQUIRED_COLUMNS: readonly string[] = [
  'id', 'entity_type', 'entity_id', 'field', 'assertion', 'derived_from', 'value_fingerprint',
  'source_system', 'source_detail', 'source_actor_user_id', 'source_actor_name',
  'owner_kind', 'owner_subject_kind', 'owner_subject_id', 'owner_label', 'access_level',
  'confidence', 'reasoning', 'uncertainty', 'assumptions', 'basis', 'evidence', 'history',
  'verified_by_user_id', 'verified_by_name', 'verification_reason', 'verification_method',
  'verified_at', 'recorded_at', 'recorded_by_user_id', 'updated_at',
];

/**
 * Create the table.
 *
 * THE RETURN VALUE OF THIS FUNCTION PROVES NOTHING. src/lib/ensure-once.ts ends in
 * `p.catch(() => {})`, so a DDL failure inside it RESOLVES SILENTLY and the caller reports success.
 * Ten module tables were reported created on this project and none of them existed. So the catch
 * lives inside the callback — the real Postgres reason is logged off `e.cause` and re-thrown, which
 * is what makes ensureOnce drop its memo and retry — and ANY CALLER THAT NEEDS TO KNOW asks
 * provenanceSchemaStatus(), which reads information_schema and reports what is actually present.
 *
 * Fresh key, because ensureOnce's memo is in-memory per process and keys are never persisted.
 */
export function ensureProvenanceSchema(): Promise<void> {
  return ensureOnce('provenance:records:v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS provenance_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(60) NOT NULL,
        entity_id TEXT NOT NULL,
        field VARCHAR(120) NOT NULL,
        assertion VARCHAR(24) NOT NULL,
        derived_from VARCHAR(24),
        value_fingerprint TEXT,
        source_system VARCHAR(120) NOT NULL DEFAULT 'unrecorded',
        source_detail TEXT,
        source_actor_user_id UUID,
        source_actor_name VARCHAR(200),
        owner_kind VARCHAR(20) NOT NULL DEFAULT 'organization',
        owner_subject_kind VARCHAR(40),
        owner_subject_id TEXT,
        owner_label VARCHAR(200),
        access_level VARCHAR(20) NOT NULL DEFAULT 'internal',
        confidence NUMERIC(4,3),
        reasoning TEXT,
        uncertainty TEXT,
        assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
        basis JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
        history JSONB NOT NULL DEFAULT '[]'::jsonb,
        verified_by_user_id UUID,
        verified_by_name VARCHAR(200),
        verification_reason TEXT,
        verification_method VARCHAR(40),
        verified_at TIMESTAMPTZ,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        recorded_by_user_id UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // Additive assertions, so a table created by an earlier version of this file completes rather
      // than being dropped and rebuilt. Every one is a no-op where the column is already there.
      await db.execute(sql`ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS derived_from VARCHAR(24)`);
      await db.execute(sql`ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS value_fingerprint TEXT`);
      await db.execute(sql`ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await db.execute(sql`ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS verification_method VARCHAR(40)`);

      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS provenance_records_key
        ON provenance_records (entity_type, entity_id, field)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS provenance_records_entity_idx
        ON provenance_records (entity_type, entity_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS provenance_records_field_idx
        ON provenance_records (entity_type, field)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS provenance_records_assertion_idx
        ON provenance_records (assertion)`);

      // THE RULE, IN THE DATABASE. Not a convention, not a code path — a constraint. Added inside a
      // DO block because ADD CONSTRAINT has no IF NOT EXISTS, and nothing is ever dropped.
      await db.execute(sql`DO $do$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provenance_verified_needs_actor') THEN
            ALTER TABLE provenance_records
              ADD CONSTRAINT provenance_verified_needs_actor
              CHECK (assertion <> 'verified' OR (
                verified_by_user_id IS NOT NULL
                AND verification_reason IS NOT NULL
                AND verified_at IS NOT NULL
                AND derived_from IS NOT NULL
              ));
          END IF;
        END
      $do$;`);
    } catch (e: any) {
      logFail('ensureProvenanceSchema', e);
      throw e; // ensureOnce drops the memo on a rejection, so the next call retries.
    }
  });
}

export interface ProvenanceSchemaStatus {
  ok: boolean;
  tablePresent: boolean;
  columnsPresent: string[];
  columnsMissing: string[];
  uniqueIndexPresent: boolean;
  verifiedCheckPresent: boolean;
  /** A sentence an ops screen prints verbatim. It never says "created" — only what is there. */
  report: string;
}

/**
 * WHAT IS ACTUALLY IN THE DATABASE, asked of information_schema rather than assumed from a return
 * value. This is the function to call from a bootstrap page or a health check; ensureProvenanceSchema()
 * resolving is not evidence of anything.
 */
export async function provenanceSchemaStatus(): Promise<ProvenanceSchemaStatus> {
  const base: ProvenanceSchemaStatus = {
    ok: false,
    tablePresent: false,
    columnsPresent: [],
    columnsMissing: REQUIRED_COLUMNS.slice(),
    uniqueIndexPresent: false,
    verifiedCheckPresent: false,
    report: 'The database could not be asked what is present, so nothing is claimed about it.',
  };
  try {
    await ensureProvenanceSchema();
  } catch {
    // Deliberately not fatal: the point of this function is to report the state that follows,
    // whatever the ensure did or failed to do.
  }
  try {
    const cols = rowsOf(await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'provenance_records'`))
      .map((r: any) => String(r.column_name));
    const idx = rowsOf(await db.execute(sql`
      SELECT 1 AS present FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'provenance_records'
         AND indexname = 'provenance_records_key'`));
    const chk = rowsOf(await db.execute(sql`
      SELECT 1 AS present FROM pg_constraint WHERE conname = 'provenance_verified_needs_actor'`));

    const present = REQUIRED_COLUMNS.filter((c) => cols.indexOf(c) >= 0);
    const missing = REQUIRED_COLUMNS.filter((c) => cols.indexOf(c) < 0);
    const tablePresent = cols.length > 0;
    const uniqueIndexPresent = idx.length > 0;
    const verifiedCheckPresent = chk.length > 0;
    const ok = tablePresent && missing.length === 0 && uniqueIndexPresent && verifiedCheckPresent;

    const parts: string[] = [];
    parts.push(tablePresent
      ? 'Table ' + TABLE + ' is present with ' + present.length + ' of ' + REQUIRED_COLUMNS.length + ' expected columns.'
      : 'Table ' + TABLE + ' does not exist.');
    if (missing.length) parts.push('Missing: ' + missing.join(', ') + '.');
    parts.push(uniqueIndexPresent
      ? 'The one-row-per-field index is present.'
      : 'The unique index provenance_records_key is MISSING, so one field could hold two contradictory provenance rows.');
    parts.push(verifiedCheckPresent
      ? 'The constraint that stops a verified row naming nobody is present.'
      : 'The constraint provenance_verified_needs_actor is MISSING, so the database would accept a verification with no verifier. Nothing should be recorded as verified until it is there.');

    return {
      ok, tablePresent, columnsPresent: present, columnsMissing: missing,
      uniqueIndexPresent, verifiedCheckPresent, report: parts.join(' '),
    };
  } catch (e: any) {
    logFail('provenanceSchemaStatus', e);
    return { ...base, report: base.report + ' (' + (e?.cause?.message || e?.message || 'unknown error') + ')' };
  }
}

// -------------------------------------------------------------------------------------------------
// HYDRATION — the storage boundary where a fact could be manufactured, closed
// -------------------------------------------------------------------------------------------------

function parseJsonArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Turn a stored row back into an element, or REFUSE.
 *
 * A row claiming 'verified' with no verifier, no reason, no timestamp or no derived_from is not
 * quietly downgraded to a claim and not silently skipped — it comes back as a refusal, and the
 * caller renders renderUnreadable(). Silently downgrading would hide a tampered row; silently
 * skipping would hide it better.
 */
export function elementFromRow(row: any): ProvenanceResult<ProvenanceElement> {
  const assertion = String(row?.assertion || '');
  if (!isAssertionType(assertion)) {
    return fail('the stored row records an assertion type this system does not have (' + assertion + ').');
  }
  const evidence = parseJsonArray(row?.evidence).map((e: any) => Object.freeze({
    kind: String(e?.kind || 'external'),
    id: e?.id ? String(e.id) : null,
    label: String(e?.label || 'Unnamed evidence'),
    url: e?.url ? String(e.url) : null,
  })) as EvidenceRef[];

  const core = {
    entityType: String(row?.entity_type || ''),
    entityId: String(row?.entity_id || ''),
    field: String(row?.field || ''),
    source: {
      system: String(row?.source_system || 'unrecorded'),
      detail: row?.source_detail ? String(row.source_detail) : null,
      actorUserId: row?.source_actor_user_id ? String(row.source_actor_user_id) : null,
      actorName: row?.source_actor_name ? String(row.source_actor_name) : null,
    },
    recordedAt: row?.recorded_at ? new Date(row.recorded_at).toISOString() : nowIso(),
    owner: {
      kind: (['person', 'organization', 'platform'].indexOf(String(row?.owner_kind)) >= 0
        ? String(row.owner_kind) : 'organization') as OwnerKind,
      subjectKind: row?.owner_subject_kind ? String(row.owner_subject_kind) : null,
      subjectId: row?.owner_subject_id ? String(row.owner_subject_id) : null,
      label: String(row?.owner_label || 'Not recorded'),
    },
    access: ((ACCESS_LEVELS as readonly string[]).indexOf(String(row?.access_level)) >= 0
      ? String(row.access_level) : 'internal') as AccessLevel,
    confidence: row?.confidence === null || row?.confidence === undefined ? null : Number(row.confidence),
    reasoning: row?.reasoning ? String(row.reasoning) : null,
    uncertainty: row?.uncertainty ? String(row.uncertainty) : null,
    assumptions: parseJsonArray(row?.assumptions).map((a: any) => String(a)),
    basis: parseJsonArray(row?.basis).map((b: any) => String(b)),
    evidence,
    fingerprint: row?.value_fingerprint ? String(row.value_fingerprint) : null,
    history: parseJsonArray(row?.history) as ProvenanceEvent[],
    stale: false,
  };

  if (assertion !== 'verified') {
    return good(freezeElement({ ...core, assertion, verification: null, derivedFrom: null } as UnverifiedElement));
  }

  const actorUserId = row?.verified_by_user_id ? String(row.verified_by_user_id) : '';
  const actorName = row?.verified_by_name ? String(row.verified_by_name) : '';
  const reason = row?.verification_reason ? String(row.verification_reason) : '';
  const at = row?.verified_at ? new Date(row.verified_at).toISOString() : '';
  const derivedFrom = String(row?.derived_from || '');
  if (!actorUserId || !reason || !at) {
    return fail('the stored row says this was verified but does not name who verified it, why, or when.');
  }
  if (!isAssertionType(derivedFrom) || derivedFrom === 'verified') {
    return fail('the stored row says this was verified but does not record what it was before, so it cannot be read as a checked claim rather than a fact.');
  }
  const method = String(row?.verification_method || 'checked_against_record');
  return good(freezeElement({
    ...core,
    assertion: 'verified' as const,
    derivedFrom: derivedFrom as UnverifiedAssertion,
    verification: {
      actorUserId,
      actorName: actorName || 'Not recorded',
      reason,
      method: ((VERIFICATION_METHODS as readonly string[]).indexOf(method) >= 0
        ? method : 'checked_against_record') as VerificationMethod,
      at,
      evidence,
    },
  } as VerifiedElement));
}

// -------------------------------------------------------------------------------------------------
// WRITING
// -------------------------------------------------------------------------------------------------

/**
 * Store an element.
 *
 * IT TAKES AN ELEMENT, NEVER A SHAPE. The only way to get one is through a constructor above, so a
 * caller cannot write 'verified' by passing a string — and if it somehow held one, the runtime check
 * below and the CHECK constraint in the table both refuse it.
 *
 * REPLACING A VERIFIED ROW IS A NAMED HUMAN ACT. A calculation, an import or a re-inference silently
 * overwriting somebody's verification is how a checked record becomes a guess without anybody
 * noticing. So the write refuses, names the verifier and the date, and says what would let it
 * through: `supersede`, with an actor and a written reason, which is recorded in the history.
 *
 * THE REFUSAL IS ALSO IN THE SQL. The ON CONFLICT ... WHERE clause repeats the rule, so two requests
 * racing cannot slip an unverified row past a check that ran a moment earlier.
 */
export async function saveProvenance(
  element: ProvenanceElement,
  opts: { supersede?: HumanAct; recordedByUserId?: string | null } = {},
): Promise<ProvenanceResult<{ id: string }>> {
  if (!element || !isAssertionType(element.assertion)) return fail('There is nothing here to record.');
  if (element.assertion === 'verified') {
    const v = (element as VerifiedElement).verification;
    if (!v || !isUuid(v.actorUserId) || clean(v.reason, 10).length < MIN_REASON_CHARS || !(element as VerifiedElement).derivedFrom) {
      return fail('A verified element must name who verified it, why, and what it was before. Nothing was recorded.');
    }
  }

  const supersede = opts?.supersede;
  let allowSupersede = false;
  let history = element.history.slice();

  try {
    await ensureProvenanceSchema();

    const existingRows = rowsOf(await db.execute(sql`
      SELECT assertion, verified_by_name, verified_at FROM provenance_records
       WHERE entity_type = ${element.entityType}
         AND entity_id::text = ${element.entityId}
         AND field = ${element.field}
       LIMIT 1`));
    const existing = existingRows.length ? existingRows[0] : null;

    if (existing && String(existing.assertion) === 'verified' && element.assertion !== 'verified') {
      const who = existing.verified_by_name ? String(existing.verified_by_name) : 'somebody';
      const when = existing.verified_at ? new Date(existing.verified_at).toISOString().slice(0, 10) : 'an unrecorded date';
      if (!supersede || !isUuid(supersede.actorUserId) || clean(supersede.reason, 2000).length < MIN_REASON_CHARS) {
        return fail(
          'This field is recorded as verified by ' + who + ' on ' + when + '. A ' + assertionLabel(element.assertion).toLowerCase()
          + ' cannot quietly replace it. Withdraw the verification with a written reason, or record this against a different field.',
        );
      }
      allowSupersede = true;
      history = history.concat([Object.freeze({
        at: nowIso(),
        kind: 'superseded' as const,
        actorUserId: String(supersede.actorUserId),
        actorName: clean(supersede.actorName, 200) || 'Not recorded',
        reason: clean(supersede.reason, 2000),
        from: 'verified' as const,
        to: element.assertion,
      })]);
    }

    const v = element.assertion === 'verified' ? (element as VerifiedElement).verification : null;
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO provenance_records (
        entity_type, entity_id, field, assertion, derived_from, value_fingerprint,
        source_system, source_detail, source_actor_user_id, source_actor_name,
        owner_kind, owner_subject_kind, owner_subject_id, owner_label, access_level,
        confidence, reasoning, uncertainty, assumptions, basis, evidence, history,
        verified_by_user_id, verified_by_name, verification_reason, verification_method, verified_at,
        recorded_at, recorded_by_user_id, updated_at
      ) VALUES (
        ${element.entityType}, ${element.entityId}, ${element.field}, ${element.assertion},
        ${element.derivedFrom}::varchar, ${element.fingerprint}::text,
        ${element.source.system}, ${element.source.detail}::text,
        ${element.source.actorUserId}::uuid, ${element.source.actorName}::varchar,
        ${element.owner.kind}, ${element.owner.subjectKind}::varchar, ${element.owner.subjectId}::text,
        ${element.owner.label}::varchar, ${element.access},
        ${element.confidence}::numeric, ${element.reasoning}::text, ${element.uncertainty}::text,
        ${JSON.stringify(element.assumptions)}::jsonb, ${JSON.stringify(element.basis)}::jsonb,
        ${JSON.stringify(element.evidence)}::jsonb, ${JSON.stringify(history)}::jsonb,
        ${v ? v.actorUserId : null}::uuid, ${v ? v.actorName : null}::varchar,
        ${v ? v.reason : null}::text, ${v ? v.method : null}::varchar, ${v ? v.at : null}::timestamptz,
        ${element.recordedAt}::timestamptz, ${isUuid(opts?.recordedByUserId) ? String(opts.recordedByUserId) : null}::uuid,
        NOW()
      )
      ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET
        assertion = EXCLUDED.assertion,
        derived_from = EXCLUDED.derived_from,
        value_fingerprint = EXCLUDED.value_fingerprint,
        source_system = EXCLUDED.source_system,
        source_detail = EXCLUDED.source_detail,
        source_actor_user_id = EXCLUDED.source_actor_user_id,
        source_actor_name = EXCLUDED.source_actor_name,
        owner_kind = EXCLUDED.owner_kind,
        owner_subject_kind = EXCLUDED.owner_subject_kind,
        owner_subject_id = EXCLUDED.owner_subject_id,
        owner_label = EXCLUDED.owner_label,
        access_level = EXCLUDED.access_level,
        confidence = EXCLUDED.confidence,
        reasoning = EXCLUDED.reasoning,
        uncertainty = EXCLUDED.uncertainty,
        assumptions = EXCLUDED.assumptions,
        basis = EXCLUDED.basis,
        evidence = EXCLUDED.evidence,
        history = EXCLUDED.history,
        verified_by_user_id = EXCLUDED.verified_by_user_id,
        verified_by_name = EXCLUDED.verified_by_name,
        verification_reason = EXCLUDED.verification_reason,
        verification_method = EXCLUDED.verification_method,
        verified_at = EXCLUDED.verified_at,
        recorded_at = EXCLUDED.recorded_at,
        recorded_by_user_id = EXCLUDED.recorded_by_user_id,
        updated_at = NOW()
      WHERE provenance_records.assertion <> 'verified'
         OR EXCLUDED.assertion = 'verified'
         OR ${allowSupersede}::boolean
      RETURNING id`));

    if (!rows.length) {
      return fail(
        'This field is recorded as verified and the replacement was refused, so nothing was changed. '
        + 'Withdraw the verification with a written reason first.',
      );
    }

    await logAudit({
      userId: v ? v.actorUserId : (isUuid(opts?.recordedByUserId) ? String(opts.recordedByUserId) : element.source.actorUserId),
      action: element.assertion === 'verified' ? 'provenance.verify' : 'provenance.record',
      entity: TABLE,
      entityId: String(rows[0].id),
      diff: {
        entityType: element.entityType,
        entityId: element.entityId,
        field: element.field,
        assertion: element.assertion,
        derivedFrom: element.derivedFrom,
        superseded: allowSupersede,
      },
    });
    return good({ id: String(rows[0].id) });
  } catch (e: any) {
    // NEVER SWALLOWED. A write path that hides its own failure is how ten tables were reported
    // created and none existed.
    logFail('saveProvenance', e);
    return fail(e?.cause?.message || e?.message || WRITE_FAILED);
  }
}

/**
 * Record a provenance element for a field in one call: build it, store it, get the element back.
 * The constructors stay exported for callers that want to inspect or render before writing.
 */
export async function annotate(
  assertionBuilder: (input: ElementInput) => ProvenanceResult<UnverifiedElement>,
  input: ElementInput,
  opts: { supersede?: HumanAct; recordedByUserId?: string | null } = {},
): Promise<ProvenanceResult<UnverifiedElement>> {
  const built = assertionBuilder(input);
  if (!built.ok) return built;
  const saved = await saveProvenance(built.value, opts);
  if (!saved.ok) return fail(saved.error);
  return built;
}

// -------------------------------------------------------------------------------------------------
// READING
// -------------------------------------------------------------------------------------------------

export type ProvenanceEntry =
  | { ok: true; field: string; element: ProvenanceElement }
  | { ok: false; field: string; error: string };

/**
 * One field's provenance.
 *
 * PASS THE CURRENT VALUE where you have it. That is what lets the reader notice that the column has
 * moved since it was recorded and mark the element stale, which is what stops a screen printing
 * "Verified by ..." beside a value nobody ever verified.
 *
 * `{ ok: false }` means the row could not be read AS PROVENANCE, which is not the same as no row:
 * `null` value with ok true is the "nothing recorded" answer.
 */
export async function readProvenance(
  entityType: string,
  entityId: string,
  field: string,
  currentValue?: unknown,
): Promise<ProvenanceResult<ProvenanceElement | null>> {
  try {
    await ensureProvenanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM provenance_records
       WHERE entity_type = ${clean(entityType, 60).toLowerCase()}
         AND entity_id::text = ${clean(entityId, 100)}
         AND field = ${clean(field, 120).toLowerCase()}
       LIMIT 1`));
    if (!rows.length) return good(null);
    const built = elementFromRow(rows[0]);
    if (!built.ok) return built;
    const el = currentValue === undefined ? built.value : checkAgainstValue(built.value, currentValue);
    return good(el);
  } catch (e: any) {
    logFail('readProvenance', e);
    return fail('We could not read how this value came to be known just now.');
  }
}

/** Everything recorded about one record, field by field. Unreadable rows come back as refusals. */
export async function readProvenanceFor(
  entityType: string,
  entityId: string,
  values: ReadonlyArray<{ field: string; value: unknown }> = [],
): Promise<ProvenanceEntry[]> {
  try {
    await ensureProvenanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM provenance_records
       WHERE entity_type = ${clean(entityType, 60).toLowerCase()}
         AND entity_id::text = ${clean(entityId, 100)}
       ORDER BY field ASC
       LIMIT 500`));
    return rows.map((row: any): ProvenanceEntry => {
      const field = String(row?.field || '');
      const built = elementFromRow(row);
      if (!built.ok) return { ok: false, field, error: built.error };
      const match = values.find((v) => String(v.field).toLowerCase() === field);
      const el = match ? checkAgainstValue(built.value, match.value) : built.value;
      return { ok: true, field, element: el };
    });
  } catch (e: any) {
    logFail('readProvenanceFor', e);
    return [];
  }
}

/**
 * THE NAMED HUMAN ACT, END TO END: read the stored element, verify it, store the result.
 *
 * There is no path to a stored 'verified' row that does not pass through here or through
 * saveProvenance() with an element verify() built, and neither can run without an actor, a name, a
 * written reason and a method. That is the whole rule, in one place.
 */
export async function verifyStored(
  target: { entityType: string; entityId: string; field: string; currentValue?: unknown },
  act: HumanAct,
  authority: VerifyAuthority,
): Promise<ProvenanceResult<VerifiedElement>> {
  const read = 'currentValue' in target
    ? await readProvenance(target.entityType, target.entityId, target.field, target.currentValue)
    : await readProvenance(target.entityType, target.entityId, target.field);
  if (!read.ok) return fail(read.error);
  if (!read.value) {
    return fail('There is nothing recorded about how this value came to be known, so there is nothing to verify. Record it first, saying where it came from.');
  }
  const verified = verify(read.value, act, authority);
  if (!verified.ok) return verified;
  const saved = await saveProvenance(verified.value, { recordedByUserId: act.actorUserId });
  if (!saved.ok) return fail(saved.error);
  return verified;
}

/** Withdraw a stored verification. Also a named human act, also kept in the history. */
export async function withdrawStoredVerification(
  target: { entityType: string; entityId: string; field: string },
  act: HumanAct,
): Promise<ProvenanceResult<UnverifiedElement>> {
  const read = await readProvenance(target.entityType, target.entityId, target.field);
  if (!read.ok) return fail(read.error);
  if (!read.value) return fail('There is nothing recorded here.');
  const back = withdrawVerification(read.value, act);
  if (!back.ok) return back;
  const saved = await saveProvenance(back.value, {
    supersede: act,
    recordedByUserId: act.actorUserId,
  });
  if (!saved.ok) return fail(saved.error);
  await logAudit({
    userId: act.actorUserId,
    action: 'provenance.verification.withdraw',
    entity: TABLE,
    entityId: target.entityType + ':' + target.entityId + ':' + target.field,
    diff: { reason: clean(act.reason, 2000) },
  });
  return back;
}
