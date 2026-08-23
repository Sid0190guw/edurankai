// src/lib/horizon/ids.ts — THE ELEVEN CANONICAL IDENTIFIERS OF THE HORIZON SYSTEM.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md section 2.
//
// =================================================================================================
// WHY A FILE FOR WHAT ARE, IN THE END, STRINGS
// =================================================================================================
//
// Because they are strings, and because in this repository that has already gone wrong in the two
// ways it always goes wrong.
//
//  1. THE SAME NAME FOR TWO THINGS. docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md records that
//     `roles` conflates a job ADVERTISEMENT with an org POSITION, and that the original brief used
//     one prefix (ERAI-INT) for both an internship opportunity and an intern identity. Two
//     namespaces, one segment, both pasted into the same search box.
//  2. THE WRONG ID IN THE RIGHT SLOT. `hr_employees.id`, `hr_employees.user_id` and
//     `applications.applicant_user_id` are all UUIDs. Nothing in the type system has ever stopped
//     one being passed where another was meant, and a query that silently returns zero rows is
//     indistinguishable from a person who has no record.
//
// So every identifier here is BRANDED. The brand is a phantom property that exists only at compile
// time — it costs nothing at runtime, a plain string still assigns INTO a branded type (so no patch
// has to litter its code with casts), but an EmployeeId will not compile into a slot that wants an
// ApplicantId. That is the whole trick and it is worth the file on its own.
//
// =================================================================================================
// OWNERSHIP IS THE OTHER HALF, AND IT IS THE HALF THAT PREVENTS DUPLICATE TABLES
// =================================================================================================
//
// Eleven identifiers; HORIZON ISSUES ONLY SIX OF THEM. The rest already exist, already have an
// owning module and an owning table, and HORIZON stores them as references. ID_OWNERSHIP below is
// the machine-readable statement of that, and it is what a later patch should read before it
// considers creating a table: if `horizonOwns` is false, the row you want already exists somewhere
// and you want a foreign reference, not a copy.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE, deliberately. src/lib/db/index.ts throws when
// DATABASE_URL is unset, and a transitive import of it has already put pure logic in this repository
// out of reach of tests that need no connection at all (see the note at the head of src/lib/audit.ts
// and src/lib/talent/types.ts). Everything here is pure and unit-testable.

// -------------------------------------------------------------------------------------------------
// THE BRAND
// -------------------------------------------------------------------------------------------------

declare const HORIZON_BRAND: unique symbol;

/**
 * A string identifier that knows what it identifies.
 *
 * The brand property is OPTIONAL on purpose. `const id: EmployeeId = row.id` compiles when `row.id`
 * is a plain `string`, so reading an id out of a query result needs no ceremony — but
 * `const a: ApplicantId = someEmployeeId` does not compile, which is the direction the mistakes
 * actually run.
 */
export type HorizonId<K extends string> = string & { readonly [HORIZON_BRAND]?: K };

export type EmployeeId = HorizonId<'employee'>;
export type ApplicantId = HorizonId<'applicant'>;
export type OrganisationId = HorizonId<'organisation'>;
export type ProfileId = HorizonId<'profile'>;
export type RoleId = HorizonId<'role'>;
export type FeedbackId = HorizonId<'feedback'>;
export type EvidenceId = HorizonId<'evidence'>;
export type SignalId = HorizonId<'signal'>;
export type AssessmentId = HorizonId<'assessment'>;
export type ReportId = HorizonId<'report'>;
export type ComputationId = HorizonId<'computation'>;

/** The id of one HORIZON event envelope. Not in the brief's list of eleven; required by the outbox. */
export type EventId = HorizonId<'event'>;
/** The id of one IntelligenceResult row. Not in the brief's eleven; every result needs one. */
export type ResultId = HorizonId<'result'>;

export const ID_KINDS = [
  'employee', 'applicant', 'organisation', 'profile', 'role', 'feedback',
  'evidence', 'signal', 'assessment', 'report', 'computation',
  'event', 'result',
] as const;

export type IdKind = (typeof ID_KINDS)[number];

// -------------------------------------------------------------------------------------------------
// OWNERSHIP — WHO ISSUES EACH IDENTIFIER, AND OUT OF WHICH TABLE
// -------------------------------------------------------------------------------------------------

export type IdFormat = 'uuid' | 'code' | 'opaque';

export interface IdOwnership {
  kind: IdKind;
  /** True when a `hzn_*` table issues this id. False when HORIZON only ever references it. */
  horizonOwns: boolean;
  /** The module that is allowed to create rows the id points at. */
  ownerModule: string;
  /** The table the id is a primary key of, as it exists today. */
  ownerTable: string;
  format: IdFormat;
  /** What a later patch needs to know before it writes anything against this id. */
  note: string;
}

/**
 * THE REGISTRY. Read this before creating a table.
 *
 * The `horizonOwns: false` entries are the ones that matter: those rows already exist, and a second
 * table holding the same concept is how this repository ended up with two definitions of one table
 * with different shapes (db/hr-schema.sql:300, where whichever CREATE ran second was a silent no-op
 * and half the columns simply never existed).
 */
export const ID_OWNERSHIP: Readonly<Record<IdKind, IdOwnership>> = Object.freeze({
  employee: {
    kind: 'employee', horizonOwns: false,
    ownerModule: 'src/lib/hr + db/hr-schema.sql', ownerTable: 'hr_employees', format: 'uuid',
    note: 'hr_employees.id, NOT hr_employees.user_id and NOT users.id. The mapping from a signed-in '
      + 'user to their employee row already exists as org-graph employeeIdForUser(); HORIZON calls '
      + 'it through the SubjectResolver interface rather than re-deriving it.',
  },
  applicant: {
    kind: 'applicant', horizonOwns: false,
    ownerModule: 'src/lib/talent (tal_person) with an applications.id fallback',
    ownerTable: 'tal_person | applications', format: 'uuid',
    note: 'AN APPLICANT IS A PERSON; AN APPLICATION IS AN EVENT. One human may hold many '
      + 'applications, so an applicant id is never an application id. Where the talent stack is '
      + 'present the person id is tal_person.id; where it is not, a subject may be anchored on '
      + 'applications.id, and SubjectRef.idScheme records which of the two it is rather than '
      + 'leaving a reader to guess.',
  },
  organisation: {
    kind: 'organisation', horizonOwns: false,
    ownerModule: 'not yet owned by any module', ownerTable: '(none)', format: 'opaque',
    note: 'THERE IS NO ORGANISATION TABLE IN THIS REPOSITORY AND HORIZON DOES NOT CREATE ONE. '
      + 'departments is a department, not an employing entity. Every hzn_* row carries '
      + 'organisation_id as TEXT so the column is ready the day an organisation registry lands, and '
      + 'until then it holds DEFAULT_ORGANISATION_ID. A patch that needs a real registry should '
      + 'implement OrganisationResolver, not add a table here.',
  },
  profile: {
    kind: 'profile', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_profile', format: 'uuid',
    note: 'The Master Employee Intelligence Record HEADER. It holds no intelligence of its own — '
      + 'see record.ts. One row per (organisation, subject).',
  },
  role: {
    kind: 'role', horizonOwns: false,
    ownerModule: 'src/lib/db/schema.ts (roles) / src/lib/org-graph-schema.ts (org_positions)',
    ownerTable: 'roles | org_positions', format: 'uuid',
    note: 'KNOWN CONFLATION, recorded in the talent spec: roles is simultaneously the public job '
      + 'advertisement and the internal position. HORIZON therefore carries roleId AND an optional '
      + 'positionId, and never assumes one implies the other.',
  },
  feedback: {
    kind: 'feedback', horizonOwns: false,
    ownerModule: 'src/lib/interview-feedback.ts | src/lib/performance.ts | later feedback patches',
    ownerTable: 'interview scorecards | hr_performance_reviews', format: 'uuid',
    note: 'HORIZON STORES NO FEEDBACK BODY. hzn_feedback_contribution is an AGGREGATION LEDGER that '
      + 'points at a feedback row owned elsewhere; the words a human wrote stay in the module that '
      + 'collected them, under that module access rules.',
  },
  evidence: {
    kind: 'evidence', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_evidence', format: 'uuid',
    note: 'NOT A FORK OF src/lib/evidence-graph.ts. capability_evidence answers "why does the system '
      + 'believe this person has this SKILL". hzn_evidence answers "what did this intelligence '
      + 'output rest on", and one of the things it may rest on is a capability_evidence row, cited '
      + 'by reference (sourceType: capability_evidence).',
  },
  signal: {
    kind: 'signal', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_signal', format: 'uuid',
    note: 'A signal is a STATEMENT THAT SOMETHING MAY DESERVE ATTENTION. It is never an outcome and '
      + 'never a status change.',
  },
  assessment: {
    kind: 'assessment', horizonOwns: false,
    ownerModule: 'src/lib/assessment.ts | src/lib/talent', ownerTable: 'assessment tables', format: 'uuid',
    note: 'Referenced from evidence and events only. HORIZON does not score assessments.',
  },
  report: {
    kind: 'report', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_report', format: 'uuid',
    note: 'The HEADER of a role-scoped rendering: who it was for, which computations it cites, when '
      + 'it was produced. The rendering itself belongs to the reporting patch.',
  },
  computation: {
    kind: 'computation', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_computation', format: 'uuid',
    note: 'One row per RUN of one engine. Every IntelligenceResult cites exactly one, which is what '
      + 'makes INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP reconstructable '
      + 'months later.',
  },
  event: {
    kind: 'event', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_event', format: 'uuid',
    note: 'The outbox row id, and the deduplication key a subscriber uses. Delivery is at-least-once.',
  },
  result: {
    kind: 'result', horizonOwns: true,
    ownerModule: 'src/lib/horizon', ownerTable: 'hzn_intelligence_result', format: 'uuid',
    note: 'One IntelligenceResult. Superseded rather than updated in place — see ResultStatus.',
  },
});

/** The identifiers HORIZON issues. Everything else it references. */
export const HORIZON_OWNED_IDS: readonly IdKind[] =
  ID_KINDS.filter((k) => ID_OWNERSHIP[k].horizonOwns);

/** The identifiers that already belong to another patch. Never create a table for one of these. */
export const REFERENCED_IDS: readonly IdKind[] =
  ID_KINDS.filter((k) => !ID_OWNERSHIP[k].horizonOwns);

// -------------------------------------------------------------------------------------------------
// ORGANISATION SCOPE
// -------------------------------------------------------------------------------------------------

/**
 * The organisation every row belongs to until an organisation registry exists.
 *
 * A literal rather than a nullable column, because "no organisation" and "the only organisation"
 * read identically in a WHERE clause and only one of them is true. When a registry lands, a backfill
 * rewrites this value; nothing has to learn what NULL meant.
 */
export const DEFAULT_ORGANISATION_ID: OrganisationId = 'org_edurankai';

/**
 * Resolve an organisation for a request. Implemented by whichever patch eventually owns the
 * registry; until then `defaultOrganisationResolver` answers with the constant above.
 */
export interface OrganisationResolver {
  resolve(hint?: { userId?: string | null; employeeId?: EmployeeId | null }): Promise<OrganisationId>;
}

export const defaultOrganisationResolver: OrganisationResolver = {
  async resolve() { return DEFAULT_ORGANISATION_ID; },
};

// -------------------------------------------------------------------------------------------------
// SUBJECTS — THE ONE THING EVERY INTELLIGENCE OUTPUT POINTS AT
// -------------------------------------------------------------------------------------------------

export const SUBJECT_KINDS = ['employee', 'applicant'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Which table a subject is anchored on. Recorded, never inferred by a reader. */
export const SUBJECT_ID_SCHEMES = ['hr_employee', 'tal_person', 'application', 'user'] as const;
export type SubjectIdScheme = (typeof SUBJECT_ID_SCHEMES)[number];

/**
 * WHO an intelligence output is about.
 *
 * `idScheme` is not decoration. An applicant subject may be anchored on tal_person.id in an
 * environment that runs the talent stack and on applications.id in one that does not, and a reader
 * that guesses will join against the wrong table and get an empty result that looks like an
 * innocent person with no history.
 */
export interface SubjectRef {
  kind: SubjectKind;
  id: EmployeeId | ApplicantId;
  idScheme: SubjectIdScheme;
  organisationId: OrganisationId;
}

/** A stable string for a subject — map keys, dedup keys, cache keys. Never shown to a person. */
export function subjectKey(s: SubjectRef): string {
  return s.organisationId + '|' + s.kind + '|' + s.idScheme + '|' + s.id;
}

export function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
  return subjectKey(a) === subjectKey(b);
}

export function employeeSubject(
  id: EmployeeId,
  organisationId: OrganisationId = DEFAULT_ORGANISATION_ID,
): SubjectRef {
  return { kind: 'employee', id, idScheme: 'hr_employee', organisationId };
}

export function applicantSubject(
  id: ApplicantId,
  idScheme: Extract<SubjectIdScheme, 'tal_person' | 'application' | 'user'>,
  organisationId: OrganisationId = DEFAULT_ORGANISATION_ID,
): SubjectRef {
  return { kind: 'applicant', id, idScheme, organisationId };
}

/**
 * The scheme/kind pairs that are coherent. An employee subject anchored on `application` is a bug
 * that would otherwise reach the database and read nothing.
 */
const VALID_SCHEMES: Record<SubjectKind, readonly SubjectIdScheme[]> = {
  employee: ['hr_employee'],
  applicant: ['tal_person', 'application', 'user'],
};

export function isSubjectRef(v: unknown): v is SubjectRef {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<SubjectRef>;
  if (!s.kind || !(SUBJECT_KINDS as readonly string[]).includes(s.kind)) return false;
  if (!s.idScheme || !(SUBJECT_ID_SCHEMES as readonly string[]).includes(s.idScheme)) return false;
  if (!VALID_SCHEMES[s.kind].includes(s.idScheme)) return false;
  if (typeof s.id !== 'string' || !s.id.trim()) return false;
  if (typeof s.organisationId !== 'string' || !s.organisationId.trim()) return false;
  return true;
}

/**
 * Turn a signed-in user, an employee row or an application into a SubjectRef.
 *
 * DECLARED, NOT IMPLEMENTED HERE, and that is deliberate. Resolution requires the org graph and the
 * talent tables, both owned by other patches. Rule 8 of the brief: where a dependency is missing,
 * publish a typed boundary rather than building somebody else's module. The identity patch supplies
 * the implementation; every HORIZON caller takes it as a parameter.
 */
export interface SubjectResolver {
  fromUserId(userId: string, organisationId?: OrganisationId): Promise<SubjectRef | null>;
  fromEmployeeId(employeeId: EmployeeId, organisationId?: OrganisationId): Promise<SubjectRef | null>;
  fromApplicationId(applicationId: string, organisationId?: OrganisationId): Promise<SubjectRef | null>;
}

// -------------------------------------------------------------------------------------------------
// ACTORS — WHO DID SOMETHING
// -------------------------------------------------------------------------------------------------

export const ACTOR_KINDS = ['user', 'employee', 'system', 'engine', 'integration'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * The named party behind an act.
 *
 * `system` and `engine` are separate on purpose: "the scheduler ran" and "an inference engine
 * produced this" are different sentences to print next to a person's record, and only one of them
 * is a computation whose version anybody will want later.
 */
export interface ActorRef {
  kind: ActorKind;
  id: string;
  /** For a human actor, the name a screen prints. Never a placeholder: absent is better than wrong. */
  displayName?: string | null;
}

export const SYSTEM_ACTOR: ActorRef = Object.freeze({ kind: 'system', id: 'horizon', displayName: null });

export function isActorRef(v: unknown): v is ActorRef {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<ActorRef>;
  return !!a.kind && (ACTOR_KINDS as readonly string[]).includes(a.kind)
    && typeof a.id === 'string' && a.id.trim().length > 0;
}

// -------------------------------------------------------------------------------------------------
// GENERATION AND SHAPE CHECKS
// -------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Mint an id for a HORIZON-owned row.
 *
 * REFUSES a kind HORIZON does not own. Minting an `employee` id here would create a second employee
 * identity out of thin air, which is the failure mode this whole file exists to make impossible —
 * so the refusal is a thrown error, loudly, rather than a silently returned value nobody checks.
 */
export function newHorizonId<K extends IdKind>(kind: K): HorizonId<K> {
  if (!ID_OWNERSHIP[kind].horizonOwns) {
    throw new Error(
      'HORIZON does not issue ' + kind + ' identifiers; they belong to '
      + ID_OWNERSHIP[kind].ownerModule + '. Reference the existing row instead of minting a new id.',
    );
  }
  return globalThis.crypto.randomUUID() as HorizonId<K>;
}

/** Trim-and-check. Returns null rather than an empty string, so a caller cannot store '' as an id. */
export function idOrNull<K extends string>(v: unknown): HorizonId<K> | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? (t as HorizonId<K>) : null;
}
