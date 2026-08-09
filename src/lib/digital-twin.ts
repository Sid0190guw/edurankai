// src/lib/digital-twin.ts — THE PERSON, COMPOSED FROM THE RECORDS THAT ALREADY EXIST.
//
// =================================================================================================
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// =================================================================================================
//
// Section 70 of the master build prompt says PERSON is the root, and that candidate and employee are
// STATES of one person rather than two records.
//
// THIS CODEBASE IS IN THE TWO-RECORD CASE. There is no person table, no person_id column and no
// identity spine anywhere in src/. A human occupies four id spaces:
//
//     users.id             the login              (carries users.role, an ACCOUNT TYPE)
//     applications.id      the candidate record   (applicant_user_id is NULLABLE, ON DELETE SET NULL)
//     hr_employees.id      the employee record    (user_id and application_id are nullable, no FK)
//     the learner          users.id again, reached from hr_employees.user_id
//
// Merging them would be a migration against live data, so this module does NOT merge. It BRIDGES:
// resolvePerson() reads the pointers that already exist, composes one PersonRoot out of whatever it
// can prove, and REPORTS the linkage rather than assuming it. When the pointer is absent, the twin
// says so in a sentence instead of quietly returning a thinner person who looks complete.
//
// THE BRIDGE NEVER MATCHES ON EMAIL. src/lib/hire-transfer.ts resolves identity with
// lower(personal_email) = lower(email) at hire time; that is a WRITE, made once, by a named human,
// with a refusal path. A READ that silently joined two records because two strings matched would be
// converting an inference into a fact on every page load. Same-address accounts are reported as
// UNCONFIRMED CANDIDATE LINKS, marked 'inferred', and are never used to compose anything.
//
// =================================================================================================
// EVERY FIELD CARRIES ITS PROVENANCE, AND PROVENANCE IS NOT DECORATION
// =================================================================================================
//
// Seven assertion types, and they decide what a screen is ALLOWED TO ASSERT about a person:
//
//   factual      this platform recorded it as a side effect of something happening
//   provided     a named human typed it — the person themselves, or HR, or a manager
//   verified     confirmed against the module that owns the fact, or by a named human's verdict
//   calculated   derived here from stored values, by a rule that is written down
//   inferred     a guess this system made. Never load-bearing. Never a decision variable.
//   predicted    a statement about the future. NOTHING IN THIS FILE EMITS ONE.
//   recommended  a suggested action. NOTHING IN THIS FILE EMITS ONE.
//
// The vocabulary generalises hr_employee_skills.source (self | manager | course | assessment), which
// is the strongest existing precedent in this repository. It does not replace it: skillsFor() maps
// that column onto this vocabulary and the column keeps its four values.
//
// A KEYWORD IS NOT A CAPABILITY. roles.skills, applications.tech_skills, applicant_profiles.skills
// and hr_employee_profile.skills are strings a person or a job author typed. They are composed into
// `claimedCapabilities`, a SEPARATE aspect from `skills`, and they are marked 'provided'. Nothing in
// this file can promote a keyword into an evidenced capability, because the two never share a list.
//
// =================================================================================================
// AUTHORIZATION IS PART OF THE MODEL
// =================================================================================================
//
// The twin is ASSEMBLED PER VIEWER. An aspect the viewer may not see is ABSENT from the object —
// the query that would have read it is never issued, and the columns it would have selected are
// never named in any SQL. That is why the column lists below are per-aspect: the SELECT list is
// built from the GRANTED aspects, so an ungranted field cannot be fetched-then-hidden.
//
// Relationships come from src/lib/org-graph.ts, per row, and capabilities come through the holds()
// the caller passes in. This module resolves neither itself and must never become a second engine
// for either.
//
// =================================================================================================
// WHAT NEVER ENTERS THE OBJECT, FOR ANY VIEWER AT ALL
// =================================================================================================
//
// Compensation, bank details, tax identifiers, government identifiers, contact address, photograph,
// health and anything the wellness rules protect are NOT gated aspects here. They are absent from
// the model. A gate is a thing somebody can widen; an absence is not. src/lib/payroll.ts owns pay
// and src/lib/wellness.ts owns health, and both already refuse per-person disclosure on an oversight
// surface — this module does not build a second door into either.
//
// PROTECTED ATTRIBUTES ARE NOT MODELLED, NOT READ, AND NOT INFERRED. classifyFieldName() below is
// applied to every column name before it can reach a SELECT list, so the deny list is load-bearing
// rather than a comment. There is no free-form attribute bag anywhere in this file: a caller cannot
// smuggle a protected value in as data because there is no field shaped to hold one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  clean,
  isUuid,
  logFail,
  rowsOf,
  canSeePerformanceOf,
  type PerfViewer,
} from '@/lib/performance-scope';
import {
  getManager,
  getDirectReports,
  getMentorsFor,
  getReportingChain,
  isInitialized,
  type OrgPerson,
} from '@/lib/org-graph';
import { skillsForEmployee, SKILL_LEVEL_LABELS, type EmployeeSkill } from '@/lib/skills';
// NOT getProfile(). See PROFILE_COLUMNS_BY_ASPECT below: getProfile() selects date of birth,
// nationality, home address, photograph, bank account and tax identifiers, all of which
// NEVER_COMPOSED says are absent from this model for every viewer. ensureProfileSchema() is kept
// because the table may not exist yet on a database where nobody has opened a profile, and
// normaliseLink() is kept because the writer normalised through it and the reader must agree.
import { ensureProfileSchema, normaliseLink, type ProfileEntry } from '@/lib/profile';
import { getCertificatesForUser } from '@/lib/certificates';
import { learningPathFor, type LearningItem } from '@/lib/performance-learning';
import { reviewHistory, type PerformanceReview } from '@/lib/performance';
import { listGoals, type Goal } from '@/lib/goals';

const MOD = 'digital-twin';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every const is declared ABOVE the functions that read it. `const` is not
// hoisted, and a const read before its declaration throws on the first line of its caller. That
// pattern has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Capability keys, named once. An invented key answers false for EVERY role including super_admin. */
export const EMPLOYEE_MANAGE = 'employee.manage';
export const APPLICATIONS_VIEW = 'applications.view';
export const LEARNING_PROGRESS_VIEW = 'learning.progress.view';
export const SKILLS_MANAGE_KEY = 'skills.manage';

// =================================================================================================
// THE PROVENANCE VOCABULARY
// =================================================================================================

export const ASSERTION_TYPES = [
  'factual',
  'provided',
  'verified',
  'calculated',
  'inferred',
  'predicted',
  'recommended',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

export const ASSERTION_LABELS: Record<AssertionType, string> = {
  factual: 'Recorded fact',
  provided: 'Stated by a person',
  verified: 'Checked against the record that owns it',
  calculated: 'Worked out from stored values',
  inferred: 'A guess this system made',
  predicted: 'A statement about the future',
  recommended: 'A suggested action',
};

/** The sentence a screen prints under a value. One wording, so two screens cannot differ. */
export const ASSERTION_SENTENCES: Record<AssertionType, string> = {
  factual: 'This platform recorded this as a side effect of something that happened here.',
  provided: 'Somebody stated this. It has not been checked against anything.',
  verified: 'This was confirmed against the record that owns the fact, or by a named person.',
  calculated: 'This was worked out from stored values by a rule that is written down.',
  inferred: 'This system guessed this. It decides nothing and may be wrong.',
  predicted: 'This is a statement about the future, not a record of anything.',
  recommended: 'This is a suggestion. A person decides.',
};

export interface Provenance {
  assertion: AssertionType;
  /** Module and table the value came out of. Never a guess, never a display name. */
  source: string;
  /** What makes this the value it is, in a sentence a person can act on. */
  basis: string;
  recordedAt: string | null;
  /** users.id of whoever put it on the record, where the record names one. */
  assertedByUserId: string | null;
  /** A link that lets somebody check it. Always a link, never an upload. */
  evidenceUrl: string | null;
}

/** Every field on a twin is one of these. There is no bare value anywhere in the object. */
export interface Asserted<T> {
  value: T;
  provenance: Provenance;
}

export function asserted<T>(
  value: T,
  assertion: AssertionType,
  source: string,
  basis: string,
  extra?: Partial<Pick<Provenance, 'recordedAt' | 'assertedByUserId' | 'evidenceUrl'>>,
): Asserted<T> {
  return {
    value,
    provenance: {
      assertion,
      source,
      basis,
      recordedAt: extra?.recordedAt ?? null,
      assertedByUserId: extra?.assertedByUserId ?? null,
      evidenceUrl: extra?.evidenceUrl ?? null,
    },
  };
}

// =================================================================================================
// PROTECTED AND SENSITIVE ATTRIBUTES — THE STRUCTURAL PART
// =================================================================================================
//
// Matching is done on SEGMENTS, not substrings. 'age' as a substring appears in manager, percentage
// and language; as a segment it appears only in a field that is actually about age. Field names are
// split on non-alphanumerics AND on camelCase boundaries, then compared exactly.

/** Never a decision variable, never inferred, never modelled. This list only ever grows. */
export const PROTECTED_ATTRIBUTE_SEGMENTS: readonly string[] = Object.freeze([
  'gender', 'sex', 'race', 'racial', 'ethnicity', 'ethnic', 'caste', 'tribe', 'colour', 'color',
  'religion', 'religious', 'creed', 'faith',
  'politics', 'political', 'party', 'union',
  'orientation', 'sexuality', 'sexual',
  'marital', 'marriage', 'spouse', 'dependents', 'pregnancy', 'pregnant', 'maternity', 'paternity',
  'disability', 'disabled', 'impairment', 'accommodation',
  'health', 'medical', 'illness', 'diagnosis', 'condition', 'wellness', 'cycle', 'menstrual',
  'symptom', 'symptoms', 'blood',
  'age', 'dob', 'birth', 'birthday', 'birthdate',
  'nationality', 'citizenship', 'immigration', 'visa', 'veteran', 'refugee', 'origin',
  'criminal', 'arrest', 'conviction', 'offence', 'offense',
]);

/** Not fairness-protected, but not this object's business either. Absent for every viewer. */
export const SENSITIVE_NOT_COMPOSED_SEGMENTS: readonly string[] = Object.freeze([
  'salary', 'compensation', 'ctc', 'wage', 'wages', 'stipend', 'payslip', 'payroll', 'remuneration',
  'bank', 'ifsc', 'iban', 'account', 'aadhaar', 'aadhar', 'pan', 'uan', 'esic', 'pf', 'tax', 'gst',
  'passport', 'licence', 'license',
  'address', 'street', 'postcode', 'pincode', 'zip',
  'photo', 'avatar', 'selfie', 'face', 'biometric', 'fingerprint',
  'password', 'secret', 'token', 'otp',
]);

const PROTECTED_SET = new Set(PROTECTED_ATTRIBUTE_SEGMENTS);
const SENSITIVE_SET = new Set(SENSITIVE_NOT_COMPOSED_SEGMENTS);

/** snake_case, camelCase and dotted names all reduce to the same segment list. */
export function fieldSegments(name: string): string[] {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export type FieldClass = 'protected' | 'sensitive' | 'ok';

export function classifyFieldName(name: string): FieldClass {
  const segs = fieldSegments(name);
  for (const s of segs) if (PROTECTED_SET.has(s)) return 'protected';
  for (const s of segs) if (SENSITIVE_SET.has(s)) return 'sensitive';
  return 'ok';
}

export function isProtectedFieldName(name: string): boolean {
  return classifyFieldName(name) === 'protected';
}

/** A column name may reach SQL only if it is a plain identifier AND classifies 'ok'. */
const IDENT_RE = /^[a-z][a-z0-9_]*$/;

export interface ColumnScreen {
  allowed: string[];
  refused: { column: string; reason: FieldClass | 'malformed' }[];
}

/**
 * THE GATE EVERY COLUMN NAME PASSES THROUGH BEFORE IT CAN BE SELECTED.
 *
 * This is the reason the deny list is structural rather than a promise. Adding `gender` to a column
 * list below does not produce a twin with a gender on it; it produces a refusal, a log line, and a
 * query that never names the column.
 */
export function screenColumns(cols: readonly string[]): ColumnScreen {
  const allowed: string[] = [];
  const refused: { column: string; reason: FieldClass | 'malformed' }[] = [];
  for (const raw of cols) {
    const c = String(raw || '').trim().toLowerCase();
    if (!IDENT_RE.test(c)) { refused.push({ column: c, reason: 'malformed' }); continue; }
    const k = classifyFieldName(c);
    if (k !== 'ok') { refused.push({ column: c, reason: k }); continue; }
    allowed.push(c);
  }
  if (refused.length) {
    console.error('[' + MOD + '] refused columns: ' + refused.map((r) => r.column + '(' + r.reason + ')').join(', '));
  }
  return { allowed, refused };
}

/** What this module will not compose for anybody, and the module that owns each instead. */
export const NEVER_COMPOSED: readonly { what: string; because: string }[] = Object.freeze([
  { what: 'Compensation, salary band, payslips', because: 'src/lib/payroll.ts owns pay. A twin that carried it would be a second door into it.' },
  { what: 'Bank, tax and government identifiers', because: 'They identify a person to a state or a bank and decide nothing about capability.' },
  { what: 'Health, wellness, cycle and symptom data', because: 'src/lib/wellness.ts is women-only, gated server-side and aggregate-only. No per-person row exists on any oversight surface and none is created here.' },
  { what: 'Date of birth, age, gender, nationality, religion, caste, marital status, disability', because: 'Protected attributes are never decision variables and are never inferred. The field is not modelled, so there is no seam to fill.' },
  { what: 'Photograph and biometric records', because: 'A face is a proxy for several protected attributes and evidences no capability.' },
  { what: 'Home address, personal phone', because: 'Contact detail is not capability. The people desk holds it where it belongs.' },
  { what: 'Background-verification identity, criminal, credit and sanctions checks', because: 'Only the education and employment checks are read here, and only because they VERIFY a claim the person made. The others are about a person, not about a claim.' },
  { what: 'Communication volume, activity metrics, monitoring signals', because: 'No performance inference is drawn from surveillance. There is no field for one, so nothing can start collecting it.' },
]);

// =================================================================================================
// THE PERSON ROOT
// =================================================================================================

export type PersonStateKind = 'account' | 'candidate' | 'employee' | 'learner';

export interface PersonState {
  kind: PersonStateKind;
  /** The id in the space this state lives in. */
  id: string;
  label: string;
  /** Whether this state is currently the live one — an employee who left is still a state. */
  current: boolean;
  provenance: Provenance;
}

export type LinkStatus = 'recorded' | 'absent' | 'not-applicable' | 'unreadable';

export interface LinkEdge {
  from: string;
  to: string;
  status: LinkStatus;
  /** The column that carries the pointer, so somebody can go and look at it. */
  via: string;
  sentence: string;
}

export interface UnconfirmedLink {
  kind: 'same-address-account' | 'same-address-application';
  id: string;
  provenance: Provenance;
  /** Always false. Recorded so a human can confirm it; never used to compose anything. */
  usedInTwin: false;
  sentence: string;
}

export interface PersonRoot {
  /**
   * A COMPOSED KEY, NOT A STORED ONE. There is no person_id column in this database. This string
   * exists so a screen can talk about "this person" without implying a row that does not exist.
   */
  key: string;
  userId: string | null;
  employeeId: string | null;
  applicationIds: string[];
  displayName: string | null;
  states: PersonState[];
  edges: LinkEdge[];
  unconfirmed: UnconfirmedLink[];
  /** True only when every state this person has could be reached from every other. */
  fullyLinked: boolean;
  /** The sentence a screen prints. It never says "no employee record" when it means "could not read". */
  sentence: string;
  /** A read failed. The twin is INCOMPLETE, and that is not the same as EMPTY. */
  readFailed: boolean;
  /**
   * Has anything DESCRIPTIVE been read about this person — their name, their employee code, the
   * state of their application?
   *
   * resolvePerson() answers false. It reads the id graph and nothing else, because the id graph is
   * what the authorization question is asked ABOUT and there is no way to ask "may this viewer see
   * this person" without first knowing which rows are this person. describePerson() answers true,
   * and it is called only after `identity` has been granted.
   *
   * A screen reading `described: false` must not print a name, because there is no name on the
   * object — not because it was blanked, but because the SELECT that would have carried it was
   * never issued.
   */
  described: boolean;
}

const NO_PERSON: PersonRoot = {
  key: '',
  userId: null,
  employeeId: null,
  applicationIds: [],
  displayName: null,
  states: [],
  edges: [],
  unconfirmed: [],
  fullyLinked: false,
  sentence: 'No person could be resolved from what was asked for.',
  readFailed: false,
  described: false,
};

/**
 * RESOLVE ONE PERSON FROM ANY ONE OF THEIR IDS — THE ID GRAPH, AND STRICTLY NOTHING ELSE.
 *
 * Reads only the pointers that are already on the record: hr_employees.user_id,
 * hr_employees.application_id, applications.applicant_user_id. Nothing is joined on a name or an
 * address, and nothing is created.
 *
 * =================================================================================================
 * WHY THERE IS NO NAME, NO EMPLOYEE CODE AND NO APPLICATION STATUS IN ANY SELECT BELOW
 * =================================================================================================
 *
 * This function RUNS BEFORE twinAccess(), because the authorization question — is this me, does the
 * Organization Graph make me responsible for them, does my capability reach them — cannot be asked
 * until we know which rows are this person. So everything read here is read by a viewer whose
 * grants are not yet known, and the only defensible thing to read in that position is the id graph
 * the question is asked about.
 *
 * IT USED TO READ MORE. full_name, employee_code, employment_status, applications.status,
 * applications.first_name, applications.last_name and users.name were all selected here and written
 * onto PersonRoot, which buildDigitalTwin() returns to EVERY caller whatever their grants — so a
 * viewer granted nothing at all still received the person's name, their employee code inside a
 * state label, and the fact that one of their applications had been rejected. The withheld list
 * said the identity aspect was withheld while the name sat on the object beside it. That is
 * fetch-then-hide, and this module's own header refuses it in as many words.
 *
 * The descriptive values now live in describePerson(), which runs AFTER the grant and only under
 * it. An ungranted viewer does not get a blanked name; the SELECT that would have carried one is
 * never issued.
 */
export async function resolvePerson(input: {
  userId?: string | null;
  employeeId?: string | null;
  applicationId?: string | null;
}): Promise<PersonRoot> {
  const wantUser = isUuid(input?.userId) ? String(input.userId) : null;
  const wantEmployee = isUuid(input?.employeeId) ? String(input.employeeId) : null;
  const wantApplication = isUuid(input?.applicationId) ? String(input.applicationId) : null;
  if (!wantUser && !wantEmployee && !wantApplication) return { ...NO_PERSON };

  let readFailed = false;
  let employee: any = null;
  let applications: any[] = [];

  // ---- THE EMPLOYEE RECORD -----------------------------------------------------------------------
  // is_active is a pointer question, not a disclosure: it decides WHICH employee row is this person
  // when somebody has been engaged twice. It is not put on the object here.
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT id, user_id, application_id, is_active
        FROM hr_employees
       WHERE (${wantEmployee}::uuid IS NOT NULL AND id = ${wantEmployee}::uuid)
          OR (${wantUser}::uuid IS NOT NULL AND user_id = ${wantUser}::uuid)
          OR (${wantApplication}::uuid IS NOT NULL AND application_id = ${wantApplication}::uuid)
       ORDER BY is_active DESC, created_at DESC
       LIMIT 1`));
    employee = r.length ? r[0] : null;
  } catch (e: any) {
    logFail(MOD, 'resolvePerson:employee', e);
    readFailed = true;
  }

  const userId = wantUser || (employee?.user_id ? String(employee.user_id) : null);

  // ---- THE CANDIDATE RECORDS ---------------------------------------------------------------------
  try {
    const appId = wantApplication || (employee?.application_id ? String(employee.application_id) : null);
    const rows = rowsOf(await db.execute(sql`
      SELECT id, applicant_user_id
        FROM applications
       WHERE (${appId}::uuid IS NOT NULL AND id = ${appId}::uuid)
          OR (${userId}::uuid IS NOT NULL AND applicant_user_id = ${userId}::uuid)
       ORDER BY created_at DESC
       LIMIT 25`));
    applications = rows;
  } catch (e: any) {
    logFail(MOD, 'resolvePerson:applications', e);
    readFailed = true;
  }

  // ---- THE LOGIN, DELIBERATELY NOT READ ----------------------------------------------------------
  // There was a `SELECT id, name, is_active FROM users` here. Nothing in the id graph needs it:
  // userId is already known from the input or from hr_employees.user_id. It existed to put a NAME on
  // the object, and a name is a description, so it moved into describePerson() behind the grant.

  const employeeId = employee?.id ? String(employee.id) : null;
  const applicationIds = applications.map((a: any) => String(a.id)).filter(isUuid);

  // STATES ARE DESCRIPTIONS. "On the employee register as ERA-0142", "Applied for a role (rejected)"
  // — each of those is a sentence about a person, and each was being handed to viewers who had been
  // granted nothing. describePerson() builds them.
  const states: PersonState[] = [];

  const edges: LinkEdge[] = [];
  if (employeeId) {
    edges.push({
      from: 'employee', to: 'account', via: 'hr_employees.user_id',
      status: employee?.user_id ? 'recorded' : (readFailed ? 'unreadable' : 'absent'),
      sentence: employee?.user_id
        ? 'The employee record names the sign-in it belongs to.'
        : 'The employee record does not name a sign-in, so nothing on the learning side of this platform can be attached to this person.',
    });
    edges.push({
      from: 'employee', to: 'candidate', via: 'hr_employees.application_id',
      status: employee?.application_id ? 'recorded' : (readFailed ? 'unreadable' : 'absent'),
      sentence: employee?.application_id
        ? 'The employee record names the application it came from.'
        : 'The employee record does not name an application, so the work this person did as a candidate cannot be read from here.',
    });
  }
  for (const a of applications) {
    edges.push({
      from: 'candidate:' + String(a.id), to: 'account', via: 'applications.applicant_user_id',
      status: a.applicant_user_id ? 'recorded' : 'absent',
      sentence: a.applicant_user_id
        ? 'The application names the sign-in that made it.'
        : 'This application was made without an account, so it can never be deduplicated against another application by the same person.',
    });
  }

  // The same-address comparison that used to run here is in describePerson(). It is an inference
  // ABOUT WHO SOMEBODY IS, which makes it identity, which makes it something to read after the grant
  // rather than before it.
  const unconfirmed: UnconfirmedLink[] = [];

  const key = employeeId ? 'employee:' + employeeId
    : userId ? 'user:' + userId
      : applicationIds.length ? 'application:' + applicationIds[0]
        : '';

  const missing = edges.filter((e) => e.status === 'absent');
  const recordCount = (employeeId ? 1 : 0) + (userId ? 1 : 0) + applicationIds.length;

  const sentence = readFailed
    ? 'One of the records that make up this person could not be read just now, so this is incomplete. That is not a statement that the record does not exist.'
    : missing.length === 0 && recordCount > 0
      ? 'Every record this person has is linked to every other, so this twin is composed from all of them.'
      : missing.length
        ? 'This person is on ' + recordCount + ' records and ' + missing.length + ' of the links between them is not on file. '
          + 'What is missing is named above; nothing was guessed to fill it.'
        : 'This person is on one record only.';

  return {
    key,
    userId,
    employeeId,
    applicationIds,
    displayName: null,
    states,
    edges,
    unconfirmed,
    fullyLinked: !readFailed && missing.length === 0,
    sentence,
    readFailed,
    described: false,
  };
}

/**
 * THE NAMES, THE CODES AND THE STATUSES — READ ONLY ONCE `identity` HAS BEEN GRANTED.
 *
 * Everything in here is a description of a human: what they are called, what their employee code
 * is, whether an application of theirs was rejected, whether an account somewhere shares one of
 * their addresses. None of it is needed to decide whether the viewer may look, so none of it is
 * read until that has been decided.
 *
 * `emp` is the employee row buildDigitalTwin() has already read under the same grant, using the
 * screened per-aspect column list. It is passed in rather than re-queried so that the identity
 * columns are named in exactly one SELECT in this module.
 *
 * A failure here marks the root readFailed and leaves the descriptions off. It never invents one,
 * and it never returns a person who looks complete.
 */
async function describePerson(person: PersonRoot, emp: any): Promise<PersonRoot> {
  const states: PersonState[] = [];
  const unconfirmed: UnconfirmedLink[] = [];
  let readFailed = person.readFailed;

  // ---- THE LOGIN ---------------------------------------------------------------------------------
  let account: any = null;
  if (person.userId) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT id, name, is_active FROM users WHERE id = ${person.userId}::uuid LIMIT 1`));
      account = r.length ? r[0] : null;
    } catch (e: any) {
      logFail(MOD, 'describePerson:user', e);
      readFailed = true;
    }
  }

  // ---- THE APPLICATIONS --------------------------------------------------------------------------
  let apps: any[] = [];
  if (person.applicationIds.length) {
    try {
      apps = rowsOf(await db.execute(sql`
        SELECT id, applicant_user_id, first_name, last_name, status, created_at
          FROM applications
         WHERE id IN (${sql.join(person.applicationIds.map((id) => sql`${id}::uuid`), sql`, `)})
         ORDER BY created_at DESC`));
    } catch (e: any) {
      logFail(MOD, 'describePerson:applications', e);
      readFailed = true;
    }
  }

  if (account) {
    states.push({
      kind: 'account',
      id: String(account.id),
      label: 'Has a sign-in on this platform',
      current: account.is_active !== false,
      provenance: {
        assertion: 'factual', source: 'users', recordedAt: null, assertedByUserId: null, evidenceUrl: null,
        basis: 'A row exists in users for this id.',
      },
    });
    states.push({
      kind: 'learner',
      id: String(account.id),
      label: 'Learner record, keyed on the same sign-in',
      current: true,
      provenance: {
        assertion: 'factual', source: 'users (the learning engine is keyed on users.id)', recordedAt: null,
        assertedByUserId: null, evidenceUrl: null,
        basis: 'Enrolments, completions and certificates on this platform are keyed on users.id.',
      },
    });
  }
  for (const a of apps) {
    states.push({
      kind: 'candidate',
      id: String(a.id),
      label: 'Applied for a role' + (a.status ? ' (' + String(a.status) + ')' : ''),
      current: String(a.status || '') !== 'rejected',
      provenance: {
        assertion: 'factual', source: 'applications',
        recordedAt: a.created_at ? new Date(a.created_at).toISOString() : null,
        assertedByUserId: a.applicant_user_id ? String(a.applicant_user_id) : null, evidenceUrl: null,
        basis: 'An application row exists.',
      },
    });
  }
  if (person.employeeId) {
    states.push({
      kind: 'employee',
      id: person.employeeId,
      label: 'On the employee register' + (emp?.employee_code ? ' as ' + String(emp.employee_code) : ''),
      current: emp ? emp.is_active !== false : true,
      provenance: {
        assertion: 'factual', source: 'hr_employees', recordedAt: null, assertedByUserId: null, evidenceUrl: null,
        basis: 'An employee row exists.',
      },
    });
  }

  // ---- WHAT WE DID NOT USE ----------------------------------------------------------------------
  // Address matching is how hire-transfer.ts resolves identity at WRITE time, once, with a human
  // present and a refusal path. Doing it on a read would convert an inference into a fact on every
  // page load, so a possible link is recorded and left for a person to confirm.
  const employeeHasNoAccount = !!person.employeeId && !person.userId;
  if (employeeHasNoAccount) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT u.id
          FROM hr_employees e
          JOIN users u ON lower(u.email) IN (lower(COALESCE(e.email, '')), lower(COALESCE(e.personal_email, '')), lower(COALESCE(e.work_email, '')))
         WHERE e.id = ${person.employeeId}::uuid
         LIMIT 3`));
      for (const row of r) {
        unconfirmed.push({
          kind: 'same-address-account',
          id: String(row.id),
          usedInTwin: false,
          sentence: 'An account exists at an address this employee record also carries. That is a resemblance, not a link. Somebody has to confirm it before it means anything.',
          provenance: {
            assertion: 'inferred', source: 'digital-twin (address comparison)', recordedAt: null,
            assertedByUserId: null, evidenceUrl: null,
            basis: 'Two records carry the same address. Nothing on either record says they are the same person.',
          },
        });
      }
    } catch (e: any) {
      logFail(MOD, 'describePerson:unconfirmed', e);
    }
  }

  const displayName = emp?.full_name ? String(emp.full_name)
    : account?.name ? String(account.name)
      : apps.length ? ([apps[0].first_name, apps[0].last_name].filter(Boolean).join(' ') || null)
        : null;

  return {
    ...person,
    displayName,
    states,
    unconfirmed,
    readFailed,
    described: true,
    sentence: readFailed
      ? 'One of the records that make up this person could not be read just now, so this is incomplete. That is not a statement that the record does not exist.'
      : person.sentence,
  };
}

/**
 * The person root for a viewer who was NOT granted `identity`.
 *
 * The ids stay, because the caller passed one in and pretending otherwise would be theatre. Every
 * DESCRIPTION is absent — and absent is the right word: no query carrying a name, a code or an
 * application status was issued for this viewer.
 */
function undescribedPerson(person: PersonRoot): PersonRoot {
  return {
    ...person,
    displayName: null,
    states: [],
    edges: [],
    unconfirmed: [],
    described: false,
    sentence: 'Who this person is — their name, which records are them, and how those records were '
      + 'connected — was not read for you. It is not hidden on this page; the query that would have '
      + 'carried it was never issued.',
  };
}

// =================================================================================================
// ASPECTS AND WHO MAY SEE THEM
// =================================================================================================

export const TWIN_ASPECTS = [
  'identity',
  'employment',
  'relationships',
  'education',
  'experience',
  'claimed_capabilities',
  'skills',
  'competencies',
  'projects',
  'achievements',
  'performance',
  'goals',
  'learning',
  'certifications',
  'trajectory',
] as const;

export type TwinAspect = (typeof TWIN_ASPECTS)[number];

export const ASPECT_LABELS: Record<TwinAspect, string> = {
  identity: 'Who this is',
  employment: 'Employment on the record',
  relationships: 'Organizational relationships',
  education: 'Education',
  experience: 'Experience',
  claimed_capabilities: 'Capabilities claimed in words',
  skills: 'Skills with their evidence',
  competencies: 'Competencies',
  projects: 'Work submitted',
  achievements: 'Achievements',
  performance: 'Performance record',
  goals: 'Goals and objectives',
  learning: 'Learning',
  certifications: 'Certificates issued on this platform',
  trajectory: 'What has happened, in order',
};

export interface AspectDecision {
  aspect: TwinAspect;
  granted: boolean;
  /** Why, in the vocabulary of the three layers: a relationship, a capability, or being yourself. */
  because: string;
}

export interface TwinAccess {
  decisions: AspectDecision[];
  granted: TwinAspect[];
  withheld: { aspect: TwinAspect; because: string }[];
  sentence: string;
}

/**
 * Resolve, BEFORE any data is read, exactly which aspects this viewer may see of this person.
 *
 * Three ways in, and no fourth:
 *   1. it is you;
 *   2. a RELATIONSHIP the Organization Graph records, per row;
 *   3. a CAPABILITY, which means the whole organization with no relationship.
 *
 * `holds` is the caller's wildcard-aware capability test. This module imports no authorization
 * engine and must never become one.
 */
export async function twinAccess(
  viewer: PerfViewer,
  person: PersonRoot,
  holds: (key: string) => boolean,
): Promise<TwinAccess> {
  const ask = (key: string): boolean => {
    try { return holds(key) === true; } catch { return false; }
  };

  const isSelf = (!!person.employeeId && person.employeeId === viewer.employeeId)
    || (!!person.userId && person.userId === viewer.userId);

  const hrDesk = ask(EMPLOYEE_MANAGE);
  const recruiter = ask(APPLICATIONS_VIEW);
  const learningDesk = ask(LEARNING_PROGRESS_VIEW);
  const skillsDesk = ask(SKILLS_MANAGE_KEY);

  // The relationship question, asked ONCE, per row, of the module that owns it.
  let responsible = false;
  if (!isSelf && person.employeeId) {
    responsible = await canSeePerformanceOf(viewer, person.employeeId);
  }

  const hasCandidateState = person.applicationIds.length > 0;

  const decisions: AspectDecision[] = [];
  const decide = (aspect: TwinAspect, granted: boolean, because: string) =>
    decisions.push({ aspect, granted, because });

  const selfWord = 'This is your own record.';
  const relWord = 'The Organization Graph records you as answering for this person\'s work.';
  const hrWord = 'You hold ' + EMPLOYEE_MANAGE + ', which reaches every employee record without a relationship.';
  const recWord = 'You hold ' + APPLICATIONS_VIEW + ', which reaches the candidate side of this person.';
  const noneWord = (what: string) =>
    'Withheld. ' + what + ' needs one of: being this person, a relationship the Organization Graph records, or a capability that reaches the whole organization. '
    + (viewer.initialized ? '' : 'The Organization Graph has not been set up yet, so no relationship can be confirmed for anybody — that is not the same as you having none.');

  const grantOrNot = (aspect: TwinAspect, arms: { ok: boolean; word: string }[]) => {
    const hit = arms.find((a) => a.ok);
    decide(aspect, !!hit, hit ? hit.word : noneWord(ASPECT_LABELS[aspect]));
  };

  const selfArm = { ok: isSelf, word: selfWord };
  const relArm = { ok: responsible, word: relWord };
  const hrArm = { ok: hrDesk, word: hrWord };
  const recArm = { ok: recruiter && hasCandidateState, word: recWord };

  grantOrNot('identity', [selfArm, relArm, hrArm, recArm]);
  grantOrNot('employment', [selfArm, relArm, hrArm]);
  grantOrNot('relationships', [selfArm, relArm, hrArm]);
  grantOrNot('education', [selfArm, hrArm, recArm]);
  grantOrNot('experience', [selfArm, hrArm, recArm]);
  grantOrNot('claimed_capabilities', [selfArm, hrArm, recArm]);
  grantOrNot('skills', [selfArm, relArm, { ok: skillsDesk, word: 'You hold ' + SKILLS_MANAGE_KEY + '.' }, hrArm]);
  grantOrNot('competencies', [selfArm, relArm, { ok: learningDesk, word: 'You hold ' + LEARNING_PROGRESS_VIEW + '.' }, hrArm]);
  grantOrNot('projects', [selfArm, relArm, hrArm, recArm]);
  grantOrNot('achievements', [selfArm, relArm, hrArm]);
  grantOrNot('performance', [selfArm, relArm, hrArm]);
  grantOrNot('goals', [selfArm, relArm, hrArm]);
  grantOrNot('learning', [selfArm, relArm, { ok: learningDesk, word: 'You hold ' + LEARNING_PROGRESS_VIEW + '.' }, hrArm]);
  grantOrNot('certifications', [selfArm, relArm, { ok: learningDesk, word: 'You hold ' + LEARNING_PROGRESS_VIEW + '.' }, hrArm]);
  grantOrNot('trajectory', [selfArm, relArm, hrArm]);

  const granted = decisions.filter((d) => d.granted).map((d) => d.aspect);
  const withheld = decisions.filter((d) => !d.granted).map((d) => ({ aspect: d.aspect, because: d.because }));

  return {
    decisions,
    granted,
    withheld,
    sentence: granted.length === 0
      ? 'You may not see any part of this person\'s record. Nothing was read.'
      : 'You may see ' + granted.length + ' of ' + TWIN_ASPECTS.length + ' aspects of this person. '
        + (withheld.length ? 'The rest are named as withheld and were never read.' : 'Nothing is withheld.'),
  };
}

// =================================================================================================
// THE TWIN
// =================================================================================================

export interface SkillHolding {
  skillId: string;
  skillName: string;
  category: string;
  level: number;
  levelLabel: string;
  /** self | manager | course | assessment, as stored. Kept so nothing is lost in translation. */
  storedSource: string;
  provenance: Provenance;
}

export interface ClaimedCapability {
  /** The word somebody typed. It is a word. */
  keyword: string;
  /** Where the word came from: an application blob, a profile list, a public profile. */
  from: string;
  /**
   * Resolved to hr_skills only when the catalogue already contains that exact name,
   * case-insensitively. A resolution is a NAME MATCH, not evidence, and is marked as such.
   */
  resolvedSkillId: string | null;
  provenance: Provenance;
}

export interface EducationEntry {
  label: string;
  detail: string | null;
  period: string | null;
  url: string | null;
  /** Set only when a background-verification EDUCATION check confirmed a claim on this application. */
  verification: Asserted<{ status: string; evidenceUrl: string | null }> | null;
  provenance: Provenance;
}

export interface TrajectoryStep {
  at: string | null;
  what: string;
  provenance: Provenance;
}

export interface DigitalTwin {
  person: PersonRoot;
  viewer: {
    userId: string;
    employeeId: string | null;
    scope: string;
  };
  access: TwinAccess;
  /** Exactly the aspects that are present as keys below. */
  aspects: TwinAspect[];
  /** Named, so a screen can say what it is not showing without showing it. */
  withheld: { aspect: TwinAspect; because: string }[];
  /** What this model refuses to hold for anybody. */
  neverComposed: readonly { what: string; because: string }[];
  /** An aspect that was granted and could not be READ. Distinct from an aspect that is empty. */
  unreadable: { aspect: TwinAspect; because: string }[];

  identity?: {
    name: Asserted<string> | null;
    employeeCode: Asserted<string> | null;
    workEmail: Asserted<string> | null;
    states: PersonState[];
  };
  employment?: {
    designation: Asserted<string> | null;
    departmentId: Asserted<string> | null;
    departmentName: Asserted<string> | null;
    employmentType: Asserted<string> | null;
    workMode: Asserted<string> | null;
    employmentStatus: Asserted<string> | null;
    joiningDate: Asserted<string> | null;
    confirmationDate: Asserted<string> | null;
    tenureDays: Asserted<number> | null;
  };
  relationships?: {
    graphReady: boolean;
    manager: Asserted<OrgPerson> | null;
    chain: Asserted<OrgPerson[]> | null;
    directReports: Asserted<OrgPerson[]> | null;
    mentors: Asserted<OrgPerson[]> | null;
    sentence: string;
  };
  education?: EducationEntry[];
  experience?: { label: string; detail: string | null; period: string | null; url: string | null; provenance: Provenance }[];
  claimedCapabilities?: ClaimedCapability[];
  skills?: SkillHolding[];
  competencies?: { name: string; code: string; dimension: string; status: string; verifiedByUserId: string | null; provenance: Provenance }[];
  projects?: { title: string; kind: string; url: string | null; status: string; reviewedAt: string | null; provenance: Provenance }[];
  achievements?: { label: string; detail: string | null; url: string | null; provenance: Provenance }[];
  performance?: { cycleTitle: string | null; rating: number | null; outcome: string | null; stage: string | null; provenance: Provenance }[];
  goals?: { title: string; kind: string; status: string; progressPct: number; provenance: Provenance }[];
  learning?: { courseTitle: string; assignedAt: string | null; dueAt: string | null; complete: boolean; provenance: Provenance }[];
  certifications?: { certNumber: string; courseTitle: string | null; issuedAt: string | null; provenance: Provenance }[];
  trajectory?: {
    steps: TrajectoryStep[];
    /** ALWAYS null. This model does not predict a career and does not create the field to hold one. */
    prediction: null;
    sentence: string;
  };
}

/** Provenance shorthands used all over the composer below. */
const P = {
  employeeRow: (basis: string): Provenance => ({
    assertion: 'provided', source: 'hr_employees', basis, recordedAt: null, assertedByUserId: null, evidenceUrl: null,
  }),
  platformFact: (source: string, basis: string, at?: string | null, url?: string | null): Provenance => ({
    assertion: 'factual', source, basis, recordedAt: at ?? null, assertedByUserId: null, evidenceUrl: url ?? null,
  }),
};

const dayOf = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * The per-aspect column lists for hr_employees.
 *
 * These are the ONLY names that can reach a SELECT, and each one goes through screenColumns() first.
 * A protected or sensitive name written here does not produce a twin field; it produces a refusal.
 */
const EMPLOYEE_COLUMNS_BY_ASPECT: Record<string, readonly string[]> = {
  base: ['id', 'user_id', 'application_id'],
  // is_active is here as well as under employment because describePerson() needs it to say whether
  // the employee state is the CURRENT one, and describePerson() runs under `identity`.
  identity: ['full_name', 'employee_code', 'work_email', 'is_active'],
  employment: [
    'designation', 'department_id', 'employment_type', 'work_mode', 'employment_status',
    'onboarding_status', 'joining_date', 'confirmation_date', 'probation_end_date', 'exit_date', 'is_active',
  ],
  trajectory: ['joining_date', 'confirmation_date', 'exit_date', 'exit_type'],
};

/**
 * The per-aspect column lists for `applications`.
 *
 * ONE SELECT USED TO CARRY ALL OF THEM. It was issued whenever any one of education, experience,
 * claimed_capabilities, projects or trajectory was granted, so a recruiter granted only `projects`
 * pulled the applicant's education, their institution and their self-described experience into
 * memory and the composer then dropped them on the floor. Fetched-then-hidden is the shape this
 * module's header refuses; the list is now built from the grants, exactly as the employee one is.
 *
 * `trajectory` is absent on purpose: it reads application_stage_events and takes no column from
 * this table at all.
 */
const APPLICATION_COLUMNS_BY_ASPECT: Record<string, readonly string[]> = {
  base: ['id', 'created_at'],
  education: ['education', 'field_of_study', 'institution'],
  experience: ['experience_band', 'experience_description'],
  claimed_capabilities: ['tech_skills'],
  projects: ['ps_selected', 'ps_solution_link'],
};

/**
 * The per-aspect column lists for `hr_employee_profile`.
 *
 * THIS USED TO BE getProfile(), AND THAT WAS THE WORST FETCH-THEN-HIDE IN THE FILE. getProfile()
 * selects date_of_birth, nationality, address, city, photo_url, bank_name, bank_holder,
 * bank_account_number, bank_ifsc, pan_number, uan_number, pf_number and esic_number off
 * hr_employees, and this module's comment cheerfully said the bank and tax blocks "are dropped
 * here". Dropped after being read. A viewer granted nothing but `education` caused a protected
 * attribute and a bank account number to be selected out of the database — the NEVER_COMPOSED list
 * two hundred lines above says those are absent for every viewer, and they were not.
 *
 * The four list columns this module actually composes live on hr_employee_profile and nowhere near
 * hr_employees, so they are read directly and hr_employees is not touched for them at all.
 */
const PROFILE_COLUMNS_BY_ASPECT: Record<string, readonly string[]> = {
  base: ['updated_at'],
  education: ['education'],
  experience: ['experience'],
  claimed_capabilities: ['skills'],
  achievements: ['achievements'],
};

/** The profile aspects, named once so the read condition and the column build cannot disagree. */
const PROFILE_ASPECTS: readonly TwinAspect[] = ['education', 'experience', 'claimed_capabilities', 'achievements'];

const MAX_PROFILE_ENTRIES = 40;
const MAX_ENTRY_TEXT = 2000;

/**
 * One JSON list column off hr_employee_profile, parsed into entries.
 *
 * The same shape profile.ts stores, read without profile.ts's SELECT. `label` is required — a row
 * with no label is not a half-filled entry, it is noise — and the link goes through the same
 * normaliser the writer used, so nothing here can render a javascript: URL somebody stored.
 */
function profileEntries(v: any): ProfileEntry[] {
  let list: any = v;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out: ProfileEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = clean((item as any).label, 200);
    if (!label) continue;
    out.push({
      label,
      detail: clean((item as any).detail, MAX_ENTRY_TEXT) || null,
      period: clean((item as any).period, 80) || null,
      url: normaliseLink((item as any).url),
    });
    if (out.length >= MAX_PROFILE_ENTRIES) break;
  }
  return out;
}

/**
 * BUILD THE TWIN, PER VIEWER.
 *
 * Only granted aspects are read. An ungranted aspect is not a key on the returned object, and the
 * columns behind it are never named in any query issued by this call.
 */
export async function buildDigitalTwin(
  input: { userId?: string | null; employeeId?: string | null; applicationId?: string | null },
  viewer: PerfViewer,
  holds: (key: string) => boolean,
): Promise<DigitalTwin> {
  const person = await resolvePerson(input);
  const access = await twinAccess(viewer, person, holds);
  const has = (a: TwinAspect) => access.granted.indexOf(a) >= 0;
  const unreadable: { aspect: TwinAspect; because: string }[] = [];
  const note = (aspect: TwinAspect, e: any) => {
    logFail(MOD, 'aspect:' + aspect, e);
    unreadable.push({
      aspect,
      because: 'This could not be read just now, so it is missing rather than empty. Nothing here says the record does not exist.',
    });
  };

  // ---- ONE EMPLOYEE READ, WITH THE COLUMNS THE GRANTS ALLOW --------------------------------------
  // This runs BEFORE the twin object is built, because describePerson() reads it and describePerson()
  // decides what `twin.person` is allowed to say.
  let emp: any = null;
  if (person.employeeId && (has('identity') || has('employment') || has('trajectory'))) {
    const wanted = new Set<string>(EMPLOYEE_COLUMNS_BY_ASPECT.base);
    if (has('identity')) for (const c of EMPLOYEE_COLUMNS_BY_ASPECT.identity) wanted.add(c);
    if (has('employment')) for (const c of EMPLOYEE_COLUMNS_BY_ASPECT.employment) wanted.add(c);
    if (has('trajectory')) for (const c of EMPLOYEE_COLUMNS_BY_ASPECT.trajectory) wanted.add(c);
    const screened = screenColumns(Array.from(wanted));
    try {
      const cols = sql.raw(screened.allowed.map((c) => 'e.' + c).join(', '));
      const r = rowsOf(await db.execute(sql`
        SELECT ${cols}
          FROM hr_employees e
         WHERE e.id = ${person.employeeId}::uuid
         LIMIT 1`));
      emp = r.length ? r[0] : null;
    } catch (e: any) {
      note('employment', e);
    }
  }

  // ---- WHO THIS IS, READ ONLY NOW, AND ONLY IF THE GRANT SAYS SO ---------------------------------
  const described = has('identity') ? await describePerson(person, emp) : undescribedPerson(person);

  const twin: DigitalTwin = {
    person: described,
    viewer: { userId: viewer.userId, employeeId: viewer.employeeId, scope: viewer.kind },
    access,
    aspects: [],
    withheld: access.withheld,
    neverComposed: NEVER_COMPOSED,
    unreadable,
  };

  // ---- IDENTITY ----------------------------------------------------------------------------------
  if (has('identity')) {
    twin.aspects.push('identity');
    twin.identity = {
      name: described.displayName
        ? asserted(described.displayName, 'provided', emp ? 'hr_employees.full_name' : 'applications / users',
          'A name somebody entered on the record. Nothing verifies it.')
        : null,
      employeeCode: emp?.employee_code
        ? asserted(String(emp.employee_code), 'factual', 'hr_employees.employee_code',
          'Issued by this platform when the employee record was created.')
        : null,
      workEmail: emp?.work_email
        ? asserted(String(emp.work_email), 'factual', 'hr_employees.work_email',
          'The address this organization issued.')
        : null,
      states: person.states,
    };
  }

  // ---- EMPLOYMENT --------------------------------------------------------------------------------
  if (has('employment')) {
    twin.aspects.push('employment');
    let departmentName: string | null = null;
    if (emp?.department_id) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT name FROM departments WHERE id::text = ${String(emp.department_id)}::text LIMIT 1`));
        departmentName = r.length && r[0]?.name ? String(r[0].name) : null;
      } catch (e: any) {
        logFail(MOD, 'departmentName', e);
      }
    }
    const joining = dayOf(emp?.joining_date);
    const tenure = joining ? Math.floor((Date.now() - new Date(joining).getTime()) / 86400000) : null;
    twin.employment = {
      designation: emp?.designation
        ? asserted(String(emp.designation), 'provided', 'hr_employees.designation',
          'What the people desk recorded as this person\'s title. A promotion changes it only through the approval chain in src/lib/workflow.ts.')
        : null,
      departmentId: emp?.department_id
        ? asserted(String(emp.department_id), 'provided', 'hr_employees.department_id', 'Set on the employee record.')
        : null,
      departmentName: departmentName
        ? asserted(departmentName, 'factual', 'departments.name', 'The department this id names.')
        : null,
      employmentType: emp?.employment_type
        ? asserted(String(emp.employment_type), 'provided', 'hr_employees.employment_type', 'Recorded by the people desk.')
        : null,
      workMode: emp?.work_mode
        ? asserted(String(emp.work_mode), 'provided', 'hr_employees.work_mode', 'Recorded by the people desk.')
        : null,
      employmentStatus: emp?.employment_status
        ? asserted(String(emp.employment_status), 'factual', 'hr_employees.employment_status', 'The register\'s own state for this person.')
        : null,
      joiningDate: joining
        ? asserted(joining, 'factual', 'hr_employees.joining_date', 'The date this platform recorded the engagement as starting.')
        : null,
      confirmationDate: dayOf(emp?.confirmation_date)
        ? asserted(String(dayOf(emp?.confirmation_date)), 'factual', 'hr_employees.confirmation_date', 'Recorded when probation was closed.')
        : null,
      tenureDays: tenure === null
        ? null
        : asserted(tenure, 'calculated', 'digital-twin',
          'Days between the recorded joining date and today. If the joining date is wrong, this is wrong in exactly the same way.'),
    };
  }

  // ---- RELATIONSHIPS -----------------------------------------------------------------------------
  if (has('relationships') && person.employeeId) {
    twin.aspects.push('relationships');
    try {
      const graphReady = await isInitialized();
      const [manager, chain, reports, mentors] = await Promise.all([
        getManager(person.employeeId),
        getReportingChain(person.employeeId),
        getDirectReports(person.employeeId),
        // getMentorsFor() is the BATCH reader: it takes a list of employee ids and answers a Map
        // keyed by mentee. One person is a list of one, and the answer for them is read back out of
        // the map below. Passing the bare id would iterate the string character by character.
        getMentorsFor([person.employeeId]),
      ]);
      const src = 'org-graph (org_relationships)';
      const basis = 'An effective-dated edge in the Organization Graph, resolved per row. Never a role name and never a column somebody typed.';
      // The map holds at most one entry, for this person. An absent key is "no mentor edge is in
      // force", which is a real answer and is rendered as an empty list, never as a failure.
      const own = mentors.get(person.employeeId);
      const mentorList: OrgPerson[] = own ? [own] : [];
      twin.relationships = {
        graphReady,
        manager: manager ? asserted(manager, 'factual', src, basis) : null,
        chain: chain.length ? asserted(chain as OrgPerson[], 'factual', src, basis) : null,
        directReports: reports.length ? asserted(reports, 'factual', src, basis) : null,
        mentors: mentorList.length ? asserted(mentorList, 'factual', src, basis) : null,
        sentence: graphReady
          ? 'Relationships come from the Organization Graph. An empty list here means no edge is in force, not that nobody exists.'
          : 'The Organization Graph has not been set up yet, so no reporting line can be resolved for anybody. That is not the same as this person having no manager.',
      };
    } catch (e: any) {
      note('relationships', e);
    }
  }

  // ---- THE PROFILE-BACKED ASPECTS ----------------------------------------------------------------
  // getProfile() returns bank and tax blocks. They are dropped here and never referenced again: the
  // twin has no field shaped to hold them.
  let profile: Awaited<ReturnType<typeof getProfile>> = null;
  if (person.employeeId && (has('education') || has('experience') || has('claimed_capabilities') || has('achievements'))) {
    try {
      profile = await getProfile(person.employeeId);
    } catch (e: any) {
      note('education', e);
    }
  }

  // ---- THE APPLICATION-BACKED ASPECTS ------------------------------------------------------------
  let app: any = null;
  if (person.applicationIds.length && (has('education') || has('experience') || has('claimed_capabilities') || has('projects') || has('trajectory'))) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT id, education, field_of_study, institution, experience_band, experience_description,
               tech_skills, ps_selected, ps_solution_link, status, created_at
          FROM applications
         WHERE id = ${person.applicationIds[0]}::uuid
         LIMIT 1`));
      app = r.length ? r[0] : null;
    } catch (e: any) {
      note('education', e);
    }
  }

  // ---- EDUCATION, AND THE ONE PLACE A CLAIM MEETS A CHECK ----------------------------------------
  if (has('education')) {
    twin.aspects.push('education');
    const out: EducationEntry[] = [];

    // The background-verification EDUCATION check, read ONLY for the application it belongs to, and
    // only that check. hr_bgv_records also carries identity, criminal, credit and sanctions results;
    // none of those verify a capability claim and none of them are read here.
    let bgvEducation: { status: string; evidenceUrl: string | null } | null = null;
    if (person.applicationIds.length) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT check_education, education_evidence_url
            FROM hr_bgv_records
           WHERE application_id = ${person.applicationIds[0]}::uuid
           ORDER BY created_at DESC
           LIMIT 1`));
        if (r.length && r[0]?.check_education) {
          bgvEducation = {
            status: String(r[0].check_education),
            evidenceUrl: r[0].education_evidence_url ? String(r[0].education_evidence_url) : null,
          };
        }
      } catch (e: any) {
        // Absent table on a database where BGV never ran is not an error worth failing an aspect for.
        logFail(MOD, 'bgvEducation', e);
      }
    }

    const verification: EducationEntry['verification'] = bgvEducation && bgvEducation.status === 'clear'
      ? asserted(bgvEducation, 'verified', 'hr-bgv (hr_bgv_records.check_education)',
        'A background-verification education check was recorded as clear, against written consent. This verifies the claim on the application it belongs to and nothing else.',
        { evidenceUrl: bgvEducation.evidenceUrl })
      : null;

    if (app?.education || app?.institution || app?.field_of_study) {
      out.push({
        label: [app.education, app.field_of_study].filter(Boolean).map(String).join(' — ') || 'Education',
        detail: app.institution ? String(app.institution) : null,
        period: null,
        url: null,
        verification,
        provenance: {
          assertion: 'provided', source: 'applications.education / institution / field_of_study',
          basis: 'The applicant typed this into their application. Nothing on the application checks it.',
          recordedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
          assertedByUserId: null, evidenceUrl: null,
        },
      });
    }
    for (const e of (profile?.education || []) as ProfileEntry[]) {
      out.push({
        label: e.label, detail: e.detail ?? null, period: e.period ?? null, url: e.url ?? null,
        verification: null,
        provenance: {
          assertion: 'provided', source: 'hr_employee_profile.education',
          basis: 'The employee entered this on their own profile. Nothing checks it.',
          recordedAt: profile?.updatedAt ?? null, assertedByUserId: null, evidenceUrl: e.url ?? null,
        },
      });
    }
    twin.education = out;
  }

  // ---- EXPERIENCE --------------------------------------------------------------------------------
  if (has('experience')) {
    twin.aspects.push('experience');
    const out: DigitalTwin['experience'] = [];
    if (app?.experience_band || app?.experience_description) {
      out.push({
        label: app.experience_band ? String(app.experience_band) : 'Experience as described',
        detail: app.experience_description ? String(app.experience_description) : null,
        period: null,
        url: null,
        provenance: {
          assertion: 'provided', source: 'applications.experience_band / experience_description',
          basis: 'The applicant described their own experience. Nothing checks it.',
          recordedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
          assertedByUserId: null, evidenceUrl: null,
        },
      });
    }
    for (const e of (profile?.experience || []) as ProfileEntry[]) {
      out.push({
        label: e.label, detail: e.detail ?? null, period: e.period ?? null, url: e.url ?? null,
        provenance: {
          assertion: 'provided', source: 'hr_employee_profile.experience',
          basis: 'The employee entered this on their own profile. Nothing checks it.',
          recordedAt: profile?.updatedAt ?? null, assertedByUserId: null, evidenceUrl: e.url ?? null,
        },
      });
    }
    if (emp?.joining_date) {
      out.push({
        label: 'Engaged by this organization',
        detail: emp.designation ? String(emp.designation) : null,
        period: dayOf(emp.joining_date) + (dayOf(emp.exit_date) ? ' to ' + dayOf(emp.exit_date) : ' to date'),
        url: null,
        provenance: P.platformFact('hr_employees', 'This platform recorded the engagement itself.', dayOf(emp.joining_date)),
      });
    }
    twin.experience = out;
  }

  // ---- CLAIMED CAPABILITIES — WORDS, KEPT APART FROM EVIDENCE ------------------------------------
  if (has('claimed_capabilities')) {
    twin.aspects.push('claimed_capabilities');
    const claims: { keyword: string; from: string; recordedAt: string | null }[] = [];
    const pushWords = (v: unknown, from: string, at: string | null) => {
      if (Array.isArray(v)) {
        for (const x of v) {
          const w = clean(typeof x === 'string' ? x : (x && typeof x === 'object' ? (x as any).label : ''), 120);
          if (w) claims.push({ keyword: w, from, recordedAt: at });
        }
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(val)) pushWords(val, from + '.' + k, at);
          else {
            const w = clean(typeof val === 'string' ? val : '', 120);
            if (w) claims.push({ keyword: w, from: from + '.' + k, recordedAt: at });
          }
        }
      }
    };
    if (app) pushWords(app.tech_skills, 'applications.tech_skills', app.created_at ? new Date(app.created_at).toISOString() : null);
    if (profile) pushWords(profile.skills, 'hr_employee_profile.skills', profile.updatedAt);
    if (person.userId) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT skills, updated_at FROM applicant_profiles WHERE user_id = ${person.userId}::uuid LIMIT 1`));
        if (r.length) pushWords(r[0].skills, 'applicant_profiles.skills', r[0].updated_at ? new Date(r[0].updated_at).toISOString() : null);
      } catch (e: any) {
        logFail(MOD, 'applicantProfileSkills', e);
      }
    }

    // Resolve to the catalogue by EXACT NAME ONLY, case-insensitively, and say that is all it is.
    // There is no fuzzy match here on purpose: a near-miss resolution would make a word look like a
    // capability, which is the exact failure this whole model exists to prevent.
    const names = Array.from(new Set(claims.map((c) => c.keyword.toLowerCase()))).slice(0, 200);
    const byName = new Map<string, string>();
    if (names.length) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT id, lower(name) AS lname FROM hr_skills WHERE lower(name) IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`));
        for (const row of r) byName.set(String(row.lname), String(row.id));
      } catch (e: any) {
        logFail(MOD, 'resolveClaimNames', e);
      }
    }

    twin.claimedCapabilities = claims.slice(0, 400).map((c) => ({
      keyword: c.keyword,
      from: c.from,
      resolvedSkillId: byName.get(c.keyword.toLowerCase()) || null,
      provenance: {
        assertion: 'provided', source: c.from,
        basis: 'Somebody typed this word. A word on a form is a claim, not a demonstration, and nothing here treats it as one.',
        recordedAt: c.recordedAt, assertedByUserId: null, evidenceUrl: null,
      },
    }));
  }

  // ---- SKILLS, WITH THEIR EVIDENCE ---------------------------------------------------------------
  if (has('skills') && person.employeeId) {
    twin.aspects.push('skills');
    try {
      const rows: EmployeeSkill[] = await skillsForEmployee(person.employeeId);
      twin.skills = rows.map((s) => ({
        skillId: s.skillId,
        skillName: s.skillName,
        category: s.category,
        level: s.level,
        levelLabel: s.levelLabel || SKILL_LEVEL_LABELS[s.level] || String(s.level),
        storedSource: s.source,
        provenance: {
          assertion: skillAssertionOf(s.source),
          source: 'skills (hr_employee_skills.source = ' + s.source + ')',
          basis: skillBasisOf(s.source, s.evidence),
          recordedAt: s.assessedAt,
          assertedByUserId: null,
          evidenceUrl: s.evidenceUrl,
        },
      }));
    } catch (e: any) {
      note('skills', e);
    }
  }

  // ---- COMPETENCIES ------------------------------------------------------------------------------
  if (has('competencies') && person.userId) {
    twin.aspects.push('competencies');
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT c.name, c.code, c.dimension, p.status, p.verified_by, p.updated_at
          FROM aquin_competency_progress p
          JOIN aquin_competencies c ON c.id = p.competency_id
         WHERE p.user_id = ${person.userId}::uuid
         ORDER BY p.updated_at DESC
         LIMIT 200`));
      twin.competencies = r.map((x: any) => {
        const status = String(x.status || 'not_started');
        const verified = status === 'verified' && x.verified_by;
        return {
          name: String(x.name || ''),
          code: String(x.code || ''),
          dimension: String(x.dimension || ''),
          status,
          verifiedByUserId: x.verified_by ? String(x.verified_by) : null,
          provenance: {
            assertion: (verified ? 'verified' : status === 'demonstrated' ? 'factual' : 'provided') as AssertionType,
            source: 'aquin-competencies (aquin_competency_progress.status)',
            basis: verified
              ? 'A named person recorded this competency as verified.'
              : status === 'demonstrated'
                ? 'This platform recorded the competency as demonstrated. What was demonstrated is not stored, so this says that it happened and not what it was.'
                : 'A progress state on the learner record. Nobody has verified it.',
            recordedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null,
            assertedByUserId: x.verified_by ? String(x.verified_by) : null,
            evidenceUrl: null,
          },
        };
      });
    } catch (e: any) {
      note('competencies', e);
    }
  }

  // ---- PROJECTS AND WORK SUBMITTED ---------------------------------------------------------------
  if (has('projects')) {
    twin.aspects.push('projects');
    const out: DigitalTwin['projects'] = [];
    if (person.userId) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT title, kind, drive_url, external_url, status, reviewed_at, submitted_at, reviewer_user_id
            FROM portal_submissions
           WHERE submitter_user_id = ${person.userId}::uuid
           ORDER BY submitted_at DESC
           LIMIT 100`));
        for (const x of r) {
          const status = String(x.status || 'submitted');
          const reviewed = status === 'approved' || status === 'rejected';
          out.push({
            title: String(x.title || 'Untitled'),
            kind: String(x.kind || 'other'),
            url: x.drive_url ? String(x.drive_url) : (x.external_url ? String(x.external_url) : null),
            status,
            reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
            provenance: {
              assertion: reviewed ? 'verified' : 'provided',
              source: 'submissions (portal_submissions)',
              basis: reviewed
                ? 'A named reviewer recorded a verdict on this piece of work.'
                : 'Submitted work that nobody has reviewed yet. It is a thing that exists, not a thing anybody has judged.',
              recordedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
              assertedByUserId: x.reviewer_user_id ? String(x.reviewer_user_id) : null,
              evidenceUrl: x.drive_url ? String(x.drive_url) : (x.external_url ? String(x.external_url) : null),
            },
          });
        }
      } catch (e: any) {
        note('projects', e);
      }
    }
    if (app?.ps_solution_link) {
      out.push({
        title: 'Problem statement solution' + (app.ps_selected ? ' (' + String(app.ps_selected) + ')' : ''),
        kind: 'problem_statement',
        url: String(app.ps_solution_link),
        status: 'submitted',
        reviewedAt: null,
        provenance: {
          assertion: 'provided', source: 'applications.ps_solution_link',
          basis: 'A link the applicant supplied with their application. Nothing here says anybody opened it.',
          recordedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
          assertedByUserId: null, evidenceUrl: String(app.ps_solution_link),
        },
      });
    }
    twin.projects = out;
  }

  // ---- ACHIEVEMENTS ------------------------------------------------------------------------------
  if (has('achievements')) {
    twin.aspects.push('achievements');
    twin.achievements = ((profile?.achievements || []) as ProfileEntry[]).map((e) => ({
      label: e.label,
      detail: e.detail ?? null,
      url: e.url ?? null,
      provenance: {
        assertion: 'provided', source: 'hr_employee_profile.achievements',
        basis: 'The employee entered this themselves. Nothing checks it.',
        recordedAt: profile?.updatedAt ?? null, assertedByUserId: null, evidenceUrl: e.url ?? null,
      },
    }));
  }

  // ---- PERFORMANCE -------------------------------------------------------------------------------
  if (has('performance') && person.employeeId) {
    twin.aspects.push('performance');
    try {
      const reviews: PerformanceReview[] = await reviewHistory(person.employeeId, 12);
      twin.performance = reviews.map((r: any) => ({
        cycleTitle: r.cycleTitle ?? null,
        rating: r.finalRating ?? r.managerRating ?? null,
        outcome: r.outcome ?? null,
        stage: r.stage ?? null,
        provenance: {
          assertion: 'provided',
          source: 'performance (hr_performance_reviews)',
          basis: 'A rating a named human recorded in an appraisal cycle. It is a judgement, not a measurement, and no part of it comes from monitoring anybody.',
          recordedAt: r.updatedAt ?? r.createdAt ?? null,
          assertedByUserId: r.managerUserId ?? null,
          evidenceUrl: null,
        },
      }));
    } catch (e: any) {
      note('performance', e);
    }
  }

  // ---- GOALS -------------------------------------------------------------------------------------
  if (has('goals') && person.employeeId) {
    twin.aspects.push('goals');
    try {
      const isSelf = person.employeeId === viewer.employeeId;
      const goals: Goal[] = await listGoals(person.employeeId, { includePrivate: isSelf });
      twin.goals = goals.map((g) => ({
        title: g.title,
        kind: g.kind,
        status: g.status,
        progressPct: g.progressPct,
        provenance: {
          assertion: g.progressDerived ? 'calculated' : 'provided',
          source: 'goals (hr_employee_goals' + (g.progressDerived ? ' + hr_goal_key_results' : '') + ')',
          basis: g.progressDerived
            ? 'Worked out from the key results attached to this objective, not from a number somebody typed.'
            : 'A progress figure somebody entered by hand.',
          recordedAt: g.lastProgressAt,
          assertedByUserId: g.setByUserId,
          evidenceUrl: null,
        },
      }));
    } catch (e: any) {
      note('goals', e);
    }
  }

  // ---- LEARNING ----------------------------------------------------------------------------------
  if (has('learning') && person.employeeId) {
    twin.aspects.push('learning');
    try {
      const items: LearningItem[] = await learningPathFor(person.employeeId);
      twin.learning = items.map((i: any) => ({
        courseTitle: String(i.courseTitle || i.title || 'A course'),
        assignedAt: i.assignedAt ?? null,
        dueAt: i.dueAt ?? null,
        complete: i.complete === true,
        provenance: {
          // 'factual' EITHER WAY. A completion is this platform recording something that happened
          // here — nobody checked it against anything, and 'verified' in this vocabulary is the
          // word for a check. The two rows differ in their BASIS, which is where the difference
          // actually lives, not in a stronger word for the same machine act.
          assertion: 'factual',
          source: 'performance-learning + learning-progress (the single definition of completion)',
          basis: i.complete === true
            ? 'Completion as learning-progress.ts defines it: lessons recorded against the learner account that owns them.'
            : 'An assignment on the record. It says what was asked for, not what was done.',
          recordedAt: i.completedAt ?? i.assignedAt ?? null,
          assertedByUserId: i.assignedByUserId ?? null,
          evidenceUrl: null,
        },
      }));
    } catch (e: any) {
      note('learning', e);
    }
  }

  // ---- CERTIFICATIONS — THE ONE CRYPTOGRAPHIC FACT -----------------------------------------------
  if (has('certifications') && person.userId) {
    twin.aspects.push('certifications');
    try {
      const certs = await getCertificatesForUser(person.userId);
      twin.certifications = (certs || []).map((c: any) => ({
        certNumber: String(c.cert_number || ''),
        courseTitle: c.course_title ? String(c.course_title) : null,
        issuedAt: c.issued_at ? new Date(c.issued_at).toISOString() : null,
        provenance: {
          // A certificate THIS PLATFORM ISSUED is our own record of our own act, however strongly
          // it is signed. A signature proves the row was not altered; it does not mean anybody
          // outside checked what it says. src/lib/evidence-graph.ts makes the same call in the same
          // words: a platform certificate supports 'demonstrated', never 'externally_verified'.
          assertion: 'factual',
          source: 'certificates (course_certificates, hash-chained and signed)',
          basis: 'A signed entry in the certificate ledger, checkable by anybody at the verification link. '
            + 'It records what was completed on this platform. EduRankAI is the technology platform; accredited partners award credentials.',
          recordedAt: c.issued_at ? new Date(c.issued_at).toISOString() : null,
          assertedByUserId: null,
          evidenceUrl: c.cert_number ? '/verify/' + String(c.cert_number) : null,
        },
      }));
    } catch (e: any) {
      note('certifications', e);
    }
  }

  // ---- TRAJECTORY — WHAT HAPPENED, IN ORDER, AND NOTHING ABOUT WHAT COMES NEXT -------------------
  if (has('trajectory')) {
    twin.aspects.push('trajectory');
    const steps: TrajectoryStep[] = [];
    if (person.applicationIds.length) {
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT from_stage, to_stage, actor_name, note, created_at
            FROM application_stage_events
           WHERE application_id = ${person.applicationIds[0]}::uuid
           ORDER BY created_at ASC
           LIMIT 60`));
        for (const x of r) {
          steps.push({
            at: x.created_at ? new Date(x.created_at).toISOString() : null,
            what: 'Application moved to ' + String(x.to_stage || 'a new stage')
              + (x.actor_name ? ', by ' + String(x.actor_name) : ''),
            provenance: P.platformFact('application-stages (application_stage_events)',
              'A stage change a named person made. The history is append-only.',
              x.created_at ? new Date(x.created_at).toISOString() : null),
          });
        }
      } catch (e: any) {
        logFail(MOD, 'trajectory:stages', e);
      }
    }
    if (emp?.joining_date) {
      steps.push({
        at: dayOf(emp.joining_date),
        what: 'Joined the organization',
        provenance: P.platformFact('hr_employees.joining_date', 'This platform recorded the start of the engagement.', dayOf(emp.joining_date)),
      });
    }
    if (emp?.confirmation_date) {
      steps.push({
        at: dayOf(emp.confirmation_date),
        what: 'Probation closed',
        provenance: P.platformFact('hr_employees.confirmation_date', 'Recorded when probation ended.', dayOf(emp.confirmation_date)),
      });
    }
    if (emp?.exit_date) {
      steps.push({
        at: dayOf(emp.exit_date),
        what: 'Engagement ended' + (emp.exit_type ? ' (' + String(emp.exit_type) + ')' : ''),
        provenance: P.platformFact('hr_employees.exit_date', 'Recorded at separation.', dayOf(emp.exit_date)),
      });
    }
    steps.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    twin.trajectory = {
      steps,
      prediction: null,
      sentence: 'This is the sequence of things that were recorded. It is not a forecast: this model does not predict '
        + 'where somebody is going, and there is no field on it that could hold such a prediction.',
    };
  }

  return twin;
}

// -------------------------------------------------------------------------------------------------
// THE ONE PLACE hr_employee_skills.source BECOMES AN ASSERTION TYPE
//
// The column keeps its four values. This maps them; it does not replace them, and no second source
// vocabulary is created anywhere in this file.
// -------------------------------------------------------------------------------------------------

/**
 * 'factual', NOT 'verified'. A course-sourced or assessment-sourced row was confirmed by this
 * platform reading its own table at write time. No named human checked anything, gave a reason or
 * can be asked why in six months, and 'verified' is the word this system reserves for exactly that
 * act — see src/lib/provenance.ts, which will not produce one without an actor, a reason and a
 * method. src/lib/person-assertions.ts maps the same column the same way.
 */
export function skillAssertionOf(storedSource: string): AssertionType {
  const s = String(storedSource || 'self');
  if (s === 'course' || s === 'assessment') return 'factual';
  return 'provided';
}

export function skillBasisOf(storedSource: string, evidence: string | null): string {
  const s = String(storedSource || 'self');
  if (s === 'course') {
    return 'Attached to a course completion, confirmed against the learner record that owns it. '
      + (evidence ? evidence + '. ' : '')
      + 'The LEVEL is still a person\'s judgement — the completion evidences that the work was done, not how good somebody is at it.';
  }
  if (s === 'assessment') {
    return 'Attached to a passed assessment, confirmed against the attempt on the learner record. '
      + (evidence ? evidence + '. ' : '')
      + 'The LEVEL is still a person\'s judgement, not a figure derived from the mark.';
  }
  if (s === 'manager') {
    return 'Somebody the Organization Graph records as answering for this person\'s work assessed this level. '
      + (evidence ? evidence + '. ' : '')
      + 'It is one named human\'s assessment.';
  }
  return 'The employee recorded this level about themselves. '
    + (evidence ? evidence + '. ' : '')
    + 'Nothing checks it, and a screen that shows it beside an assessed level as the same number overstates what it knows.';
}
