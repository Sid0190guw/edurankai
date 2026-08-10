// src/lib/assistant/scope.ts — WHO IS ASKING, AND THEREFORE WHAT MAY BE RETRIEVED.
//
// =================================================================================================
// THIS FILE IS THE SECURITY BOUNDARY OF THE ASSISTANT
// =================================================================================================
//
// One question, answered once per request, on the server: given this asker, what corpus may be
// searched and what may be said about a person? Everything else in the feature — the retriever, the
// answer builder, the endpoint — reads the object this module returns and does as it says.
//
// It is deliberately SMALL, TOTAL, and DB-FREE in its deciding half:
//
//   buildAssistantScope()     pure and synchronous. No database, no network, no throwing.
//   decideFact()              pure and synchronous. Decides from facts handed to it, reads nothing.
//   resolveAssistantScope()   async, org-graph only, and it FAILS CLOSED to the visitor scope.
//   resolveRowRelationship()  async, org-graph only, per ROW, and false on any failure.
//
// The split is not tidiness. It means every exclusion in this file can be asserted in a unit test
// with no database, including the exclusions that must hold for the founder — see scope.test.ts.
//
// =================================================================================================
// SCOPE FILTERS THE CORPUS BEFORE RETRIEVAL. NEVER AFTER.
// =================================================================================================
//
// restrictionsFor(scope) returns the query restrictions the retriever pastes into its WHERE clause.
// There is no "fetch everything and hide the rest" path here and there must never be one: a document
// that reaches the ranker has already leaked its existence through the hit count, through the
// ordering of its neighbours, and through how long the request took. The four audiences are four
// different retrievals, not one retrieval with four presentations.
//
// The corpus list is an ALLOW-LIST built from nothing. mayRetrieve() answers false for every name
// that is not in it, so a source nobody added is a source nobody can reach — including a source that
// does not exist yet. That is what makes the hard exclusions below IMPOSSIBLE rather than filtered:
// there is no branch anywhere in this module that can put a wellness table into a scope's corpora,
// for any audience, at any capability, and assertRetrievableSource() throws if a retriever ever
// names one anyway.
//
// =================================================================================================
// THE HARD EXCLUSIONS
// =================================================================================================
//
//   individual wellness and health data   CLAUDE.md is explicit: no admin and not the founder may
//                                         see one person's cycle, symptoms or consult messages. The
//                                         assistant has NO path to it, not even a filtered one.
//   legal-hold records                    require an open numbered matter and a written reason, with
//                                         logAccess() succeeding before anything renders. An
//                                         assistant can satisfy none of those three, so it is out.
//   another person's compensation         HR capability AND the org graph, both, per row.
//   anything a capability key does not grant.
//
// =================================================================================================
// THE REFUSAL IS UNIFORM, AND THAT IS A SECURITY PROPERTY
// =================================================================================================
//
// "There is no wellness record for Priya" tells you there might have been. So does a refusal that
// reads differently for a record that exists and one that does not, or differently for wellness than
// for leave. Every refusal about another person's private records is the SAME SENTENCE, decided
// WITHOUT looking anything up — decideFact() performs no read, so there is nothing for the wording
// to disagree with. The `auditReason` on the decision is for the server log and is never rendered.
//
// =================================================================================================
// IT ANSWERS, IT DOES NOT ACT
// =================================================================================================
//
// Section 67 of the HCM spec. No approving, no submitting, no changing. ACTION_SURFACES below is the
// only thing this module says about doing: the URL of the screen where a human does it themselves.
import type { OrgSource } from '@/lib/org-graph';
import { BUILTIN_PERMISSION_KEYS } from '@/lib/auth/registry';

/**
 * THE ORG GRAPH IS LOADED LAZILY, AND THAT IS PART OF THE DESIGN.
 *
 * The deciding half of this module — buildAssistantScope(), decideFact(), the corpus allow-list, the
 * hard exclusions — must be loadable and assertable with no database and no dependency on the graph
 * module at all. A static import would pull org-graph, and through it src/lib/db, into every test
 * that only wants to prove that the founder cannot reach a wellness record.
 *
 * The type import above is erased at build time, so it costs nothing. The value import happens on the
 * first call of an async function that actually needs the graph, and the promise is memoised so the
 * module is resolved once per process. This is a MODULE handle, never a connection: src/lib/db still
 * connects on first use behind its own Proxy, and nothing here opens one.
 */
let orgGraphPromise: Promise<typeof import('@/lib/org-graph')> | null = null;
const orgGraph = () => {
  if (!orgGraphPromise) orgGraphPromise = import('@/lib/org-graph');
  return orgGraphPromise;
};

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the first function that reads it. `const` is not
// hoisted, and a const declared below its use throws on the first line of whatever reads it. That
// exact shape has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[assistant/scope] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard every id before it is compared or handed to a caller that will cast it. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A capability key may only ever contain these characters. Anything else is not a key. */
const CAPABILITY_RE = /^[a-z0-9_.*-]+$/;

/** The keys the registry actually defines. A key outside this set is held by nobody, by design. */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(BUILTIN_PERMISSION_KEYS);

/** The registry's super_admin grant. Carried as a BOOLEAN, never tested by set membership. */
const WILDCARD = '*';

/**
 * THE ONE REFUSAL. Used for every question about another person's private records, whatever the
 * record is and whether or not it exists. Four different refusals would be four different oracles.
 */
export const UNIFORM_PERSON_REFUSAL =
  'This assistant does not answer questions about another person’s private records. ' +
  'If you need this for your work, the people who can help are linked below.';

/** Rule 1, said out loud: retrieval found nothing, so nothing is composed. */
export const NO_GROUNDS_REFUSAL =
  'I could not find anything in the sources I am allowed to read that answers this, ' +
  'so I am not going to guess. Here is the person who can answer it.';

/** Rule 4, as a value a caller can assert against. There is no code path that sets it true. */
export const ASSISTANT_MAY_ACT = false as const;

// -------------------------------------------------------------------------------------------------
// THE AUDIENCES
// -------------------------------------------------------------------------------------------------

/**
 * Four audiences, resolved on the server from the session and the org graph. NEVER from a request
 * body, a query string, a header, or anything else the client can write. There is no parameter on
 * any function in this file through which a caller can declare its own audience.
 */
export const ASSISTANT_AUDIENCES = ['visitor', 'employee', 'manager', 'hr'] as const;
export type AssistantAudience = (typeof ASSISTANT_AUDIENCES)[number];

/** Each audience contains the one before it. For readability only — never for authorization. */
const AUDIENCE_RANK: Record<AssistantAudience, number> = {
  visitor: 0,
  employee: 1,
  manager: 2,
  hr: 3,
};

export function atLeast(audience: AssistantAudience, floor: AssistantAudience): boolean {
  return AUDIENCE_RANK[audience] >= AUDIENCE_RANK[floor];
}

// -------------------------------------------------------------------------------------------------
// THE CORPUS ALLOW-LIST
// -------------------------------------------------------------------------------------------------

/**
 * Every corpus the assistant may ever read, named once. A scope's `corpora` is a subset of this and
 * is built by ADDING to an empty list, so the default for any audience is nothing.
 */
export const ASSISTANT_CORPORA = [
  /** content_pages WHERE is_published — public policy and long-form pages, served at /p/<slug>. */
  'public_pages',
  /** training_courses WHERE is_published AND access_type IN ('public','both'). */
  'public_courses',
  /** aquin_programs — the programme catalogue behind /aquintutor/programs. */
  'public_programs',
  /** edu_search_index rows labelled 'public' only. 'exam-secure' is never discoverable, ever. */
  'public_catalogue',
  /** kb_articles, through knowledge-base.ts's own visibility clause. Staff only. */
  'kb_articles',
  /** search-global.ts: where a thing lives at work (departments, documents, tasks). Staff only. */
  'workplace_directory',
] as const;
export type AssistantCorpus = (typeof ASSISTANT_CORPORA)[number];

const CORPUS_SET: ReadonlySet<string> = new Set(ASSISTANT_CORPORA);

/** The table (or module) each corpus reads, so a retriever never invents a source name of its own. */
export const CORPUS_SOURCE: Record<AssistantCorpus, string> = {
  public_pages: 'content_pages',
  public_courses: 'training_courses',
  public_programs: 'aquin_programs',
  public_catalogue: 'edu_search_index',
  kb_articles: 'kb_articles',
  workplace_directory: 'search-global',
};

/**
 * SOURCES THAT ARE NOT A CORPUS AND NEVER WILL BE, with the reason each one is out.
 *
 * This list is the belt over the braces. The braces are that none of these appear in
 * ASSISTANT_CORPORA, so no scope can contain one. The belt is assertRetrievableSource(), which a
 * retriever calls with the table it is about to read; a future edit that adds a query over one of
 * these fails loudly at the first request instead of quietly succeeding.
 */
export const FORBIDDEN_SOURCE_PREFIXES: readonly string[] = ['wellness_'];

export const FORBIDDEN_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  wellness_cycles: 'individual health data; women-only, gated server-side, readable by no admin and not the founder',
  wellness_symptoms: 'individual health data',
  wellness_consult_requests: 'individual health data, and a private message to a clinician',
  wellness_consultants: 'the consult roster is part of the wellness boundary',
  wellness_settings: 'a person’s own wellness configuration',
  legal_matters: 'legal hold; requires an open numbered matter and a written reason',
  legal_access_log: 'legal hold; the access log is itself the record of who looked',
  hr_payslips: 'another person’s compensation; the payslip reader is per-employee and gated elsewhere',
  ai_training_example: 'verbatim past conversations belonging to other people',
  helpdesk_tickets: 'a ticket body is one person’s problem, described in their own words',
  request_messages: 'a ticket conversation is another person’s data by a different door',
});

/** Why a source is out of bounds, or null when it is not forbidden. For LOGS and tests only. */
export function forbiddenSourceReason(name: unknown): string | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  for (const prefix of FORBIDDEN_SOURCE_PREFIXES) {
    if (key.startsWith(prefix)) {
      return (
        FORBIDDEN_SOURCES[key] ||
        'individual health and wellness data is out of bounds to every audience'
      );
    }
  }
  return FORBIDDEN_SOURCES[key] || null;
}

/**
 * The guard a retriever calls before it reads anything. THROWS — it does not return false — because
 * a retriever that has reached this line with a forbidden table name is already wrong, and a false
 * would let it fall through to the next branch and try again.
 */
export function assertRetrievableSource(name: unknown): void {
  const reason = forbiddenSourceReason(name);
  if (reason) {
    throw new Error(
      'assistant/scope: refusing to retrieve from "' + String(name) + '" — ' + reason,
    );
  }
}

// -------------------------------------------------------------------------------------------------
// PERSONAL FACTS
// -------------------------------------------------------------------------------------------------

/**
 * The kinds of fact the assistant can be asked about a PERSON. Two of them are here only so that
 * decideFact() can refuse them BY NAME rather than by falling through a default; there is no reader
 * for either anywhere in this feature.
 */
export const PERSONAL_FACT_KINDS = [
  'leave',
  'payslip',
  'compensation',
  'benefits',
  'training',
  'expenses',
  'tasks',
  'profile',
  'policy_ack',
  /** NEVER ANSWERABLE, to anybody, about anybody, including yourself. */
  'wellness',
  /** NEVER ANSWERABLE. */
  'legal_hold',
] as const;
export type PersonalFactKind = (typeof PERSONAL_FACT_KINDS)[number];

/**
 * NO AUDIENCE, NO CAPABILITY, NO RELATIONSHIP, NO SELF. Not the founder, not a wildcard grant.
 * decideFact() checks this set FIRST, before audience, before capability, before the graph and
 * before the self comparison, so no combination of inputs can reach past it.
 */
export const FORBIDDEN_FACT_KINDS: ReadonlySet<PersonalFactKind> = new Set<PersonalFactKind>([
  'wellness',
  'legal_hold',
]);

/**
 * Facts that need BOTH an HR capability AND an org-graph relationship before a word is said about
 * somebody else. Compensation is the one the rules name; a payslip is the same data with a different
 * noun on it, so it is held to the same test.
 */
export const BOTH_REQUIRED_FACT_KINDS: ReadonlySet<PersonalFactKind> = new Set<PersonalFactKind>([
  'compensation',
  'payslip',
]);

/**
 * The capability that lets somebody ask about ANOTHER PERSON, per fact kind. A kind whose key is not
 * held is refused for a non-report whatever the audience label says.
 *
 * Every key here already exists in BOTH src/lib/auth/permissions.ts and registry.ts. Nothing new is
 * invented: a key that is not in both answers false for every role including super_admin, which is a
 * permanent 403 rather than a permissive default.
 */
export const FACT_CAPABILITY: Record<PersonalFactKind, readonly string[]> = {
  leave: ['leave.approve', 'employee.manage'],
  payslip: ['payroll.manage'],
  compensation: ['payroll.manage'],
  benefits: ['employee.manage'],
  training: ['learning.progress.view', 'learning.assign', 'employee.manage'],
  expenses: ['expenses.review'],
  tasks: ['employee.manage', 'projects.manage'],
  profile: ['employee.manage'],
  policy_ack: ['knowledge.manage'],
  wellness: [],
  legal_hold: [],
};

/**
 * WHERE A HUMAN DOES IT. Rule 4 in one map: the assistant explains, then links here. These are the
 * screens that exist today; a link that 404s is worse than no link, so they are written down rather
 * than composed from a fact kind at runtime.
 */
export const ACTION_SURFACES: Record<PersonalFactKind, string | null> = {
  leave: '/portal/employee/leave',
  payslip: '/portal/employee/payslips',
  compensation: '/portal/employee/payslips',
  benefits: '/portal/employee/benefits',
  training: '/portal/employee/learning',
  expenses: '/portal/employee/expenses',
  tasks: '/portal/employee/projects',
  profile: '/portal/employee/profile',
  policy_ack: '/portal/employee/knowledge',
  wellness: null,
  legal_hold: null,
};

// -------------------------------------------------------------------------------------------------
// THE SCOPE OBJECT
// -------------------------------------------------------------------------------------------------

export interface AssistantScope {
  audience: AssistantAudience;
  /** users.id, or null for a visitor. */
  userId: string | null;
  /** hr_employees.id, or null. An admin or the founder may legitimately have no employee record. */
  employeeId: string | null;
  /** hr_employees.department_id, read as text. Never cast to uuid. */
  departmentId: string | null;
  /** Capability keys held, filtered to keys the registry actually defines. Safe to inline in SQL. */
  capabilities: readonly string[];
  /** The registry wildcard, carried separately: a set test against '*' answers false for a key. */
  wildcard: boolean;
  /** Is there anything in the organization graph at all? Distinct from "this person has nobody". */
  graphInitialized: boolean;
  /** The corpora this asker's retrieval may touch. Built by adding to an empty list. */
  corpora: readonly AssistantCorpus[];
  /** May the assistant answer facts about the asker themselves? False with no employee record. */
  ownFacts: boolean;
  /** Named sources that failed to resolve, so a surface can say "I could not check" honestly. */
  contextGaps: readonly string[];
  /** A sentence the endpoint may print verbatim about what was searched. Never a refusal reason. */
  explanation: string;
}

/**
 * What buildAssistantScope() is handed. EVERY FIELD IS SERVER-RESOLVED. `permissions` comes from
 * resolvePermissions(user.id) or the built-in matrix; `employeeId` from readEmployeeIdForUser() or
 * composeWorkspace().context. None of it may originate in a request body.
 */
export interface ScopeInput {
  user?: { id?: string | null; isActive?: boolean | null } | null;
  permissions?: Iterable<string> | null;
  employeeId?: string | null;
  departmentId?: string | null;
  /** Does this account have a workspace at all, per composeWorkspace()? */
  hasWorkspace?: boolean;
  /** From org-graph isInitialized(). False means "the graph is empty", not "you manage nobody". */
  graphInitialized?: boolean;
  /** From org-graph getDirectReports(). Having any report is what makes an asker a manager. */
  hasDirectReports?: boolean;
  contextGaps?: readonly string[] | null;
}

/** The public corpora. A visitor gets exactly these; staff get these plus the internal ones. */
const PUBLIC_CORPORA: readonly AssistantCorpus[] = [
  'public_pages',
  'public_courses',
  'public_programs',
  'public_catalogue',
];

/** The capabilities that make somebody HR-shaped for this assistant. */
const HR_CAPABILITIES: readonly string[] = [
  'employee.manage',
  'payroll.manage',
  'leave.approve',
  'expenses.review',
  'performance.manage',
];

/**
 * BUILD THE SCOPE. Pure, synchronous, total: it never reads, never throws and never awaits.
 *
 * Fails closed at every step. No user, an inactive user, or a user whose id is not a uuid is a
 * VISITOR — which is a real and useful scope, not an error.
 */
export function buildAssistantScope(input: ScopeInput = {}): AssistantScope {
  const gaps: string[] = [...(input.contextGaps || [])].map((g) => String(g)).slice(0, 12);

  const rawId = String(input.user?.id || '').trim();
  const active = input.user?.isActive !== false;
  const userId = isUuid(rawId) && active ? rawId : null;

  const held = new Set<string>();
  try {
    for (const k of input.permissions || []) {
      if (typeof k === 'string' && CAPABILITY_RE.test(k)) held.add(k);
    }
  } catch {
    // A permissions iterable that throws mid-iteration is a broken resolution, not a grant. The set
    // keeps whatever it read, the gap is named, and every test below is a membership test that a
    // partial set can only ever answer NARROWER.
    gaps.push('capabilities');
  }
  const wildcard = userId !== null && held.has(WILDCARD);
  const capabilities =
    userId === null ? [] : [...held].filter((k) => k !== WILDCARD && KNOWN_CAPABILITIES.has(k));

  const employeeId = userId !== null && isUuid(input.employeeId) ? String(input.employeeId) : null;
  const departmentId = userId !== null && input.departmentId ? String(input.departmentId) : null;

  // A workspace, an employee record, or an admin-capable account. The second and third arms are not
  // a convenience: an HR account or the founder frequently has no hr_employees row of their own, and
  // gating internal policy on the record alone hides the company's own handbook from the people who
  // write it. It grants no PERSONAL facts — ownFacts below still needs a real employee row.
  const staff =
    userId !== null &&
    (input.hasWorkspace === true || !!employeeId || wildcard || held.has('admin.access'));

  const holdsAny = (keys: readonly string[]) => wildcard || keys.some((k) => held.has(k));

  const hrShaped = staff && holdsAny(HR_CAPABILITIES);
  const managerShaped = staff && input.hasDirectReports === true;

  const audience: AssistantAudience = !staff
    ? 'visitor'
    : hrShaped
      ? 'hr'
      : managerShaped
        ? 'manager'
        : 'employee';

  // THE ALLOW-LIST, BUILT FROM NOTHING. Note what is absent: there is no branch below that can add a
  // source outside ASSISTANT_CORPORA, and no capability anywhere that unlocks one.
  const corpora: AssistantCorpus[] = [...PUBLIC_CORPORA];
  if (staff) {
    corpora.push('kb_articles');
    corpora.push('workplace_directory');
  }

  const explanation = !staff
    ? 'Answers here come from published pages and the programme and course catalogue, and nothing else.'
    : 'You are searching published pages, the catalogue, and the internal knowledge base your access allows.';

  return {
    audience,
    userId,
    employeeId,
    departmentId,
    capabilities,
    wildcard,
    graphInitialized: input.graphInitialized === true,
    corpora,
    ownFacts: employeeId !== null,
    contextGaps: gaps,
    explanation,
  };
}

/** Is this corpus in scope? Answers false for every name that is not in the allow-list. */
export function mayRetrieve(scope: AssistantScope, corpus: unknown): boolean {
  const key = String(corpus || '');
  if (!CORPUS_SET.has(key)) return false;
  if (forbiddenSourceReason(CORPUS_SOURCE[key as AssistantCorpus])) return false;
  return scope.corpora.includes(key as AssistantCorpus);
}

// -------------------------------------------------------------------------------------------------
// THE QUERY RESTRICTIONS — what the retriever pastes into its WHERE clause
// -------------------------------------------------------------------------------------------------

/**
 * One corpus, and the narrowing that must be applied to it BEFORE ranking.
 *
 * `capabilityKeys` has already been checked against CAPABILITY_RE and the registry's own key list,
 * so it is safe to inline as quoted literals — which is what knowledge-base.ts does, because this
 * driver rejects `= ANY($jsArray)` with "op ANY/ALL (array) requires array on right side".
 */
export interface CorpusRestriction {
  corpus: AssistantCorpus;
  /** The table (or module) the retriever reads. Pass it through assertRetrievableSource() first. */
  source: string;
  /** Only rows whose publication flag is set. True for every corpus here, internal ones included. */
  publishedOnly: boolean;
  /** How the audience column narrows: public rows, workspace rows, or workspace plus capabilities. */
  audienceClause: 'public' | 'workspace' | 'workspace+capabilities';
  capabilityKeys: readonly string[];
  wildcard: boolean;
  /** A sentence a surface prints under the group heading. */
  note: string;
}

/**
 * THE RESTRICTIONS, IN THE ORDER A RETRIEVER APPLIES THEM. A corpus absent from this list was never
 * in scope; there is no second list of "in scope but hidden".
 */
export function restrictionsFor(scope: AssistantScope): CorpusRestriction[] {
  const out: CorpusRestriction[] = [];
  for (const corpus of scope.corpora) {
    const source = CORPUS_SOURCE[corpus];
    // Unreachable by construction — no forbidden source is in ASSISTANT_CORPORA. Kept as the belt.
    if (forbiddenSourceReason(source)) continue;

    if (corpus === 'kb_articles') {
      out.push({
        corpus,
        source,
        publishedOnly: true,
        audienceClause: 'workspace+capabilities',
        capabilityKeys: scope.capabilities,
        wildcard: scope.wildcard,
        note: 'Internal articles and policies you are cleared to read.',
      });
      continue;
    }
    if (corpus === 'workplace_directory') {
      out.push({
        corpus,
        source,
        publishedOnly: true,
        audienceClause: 'workspace',
        capabilityKeys: scope.capabilities,
        wildcard: scope.wildcard,
        note: 'Where a thing lives at work, narrowed by search-global.ts to what you may open.',
      });
      continue;
    }
    out.push({
      corpus,
      source,
      publishedOnly: true,
      audienceClause: 'public',
      capabilityKeys: [],
      wildcard: false,
      note: 'Published public content.',
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// PER-ROW: MAY ANYTHING BE SAID ABOUT THIS PERSON?
// -------------------------------------------------------------------------------------------------

/**
 * What the ORG GRAPH says about one asker and one subject, resolved per ROW. Never users.role.
 *
 * `source` is carried through from org-graph so a caller can tell "the graph says no" apart from
 * "the graph did not answer". Neither is a grant; the difference is only what a human is told next.
 */
export interface RowRelationship {
  targetEmployeeId: string | null;
  /** Is the subject the asker themselves? */
  self: boolean;
  /** Does the asker answer for this person's work, per org-graph isResponsibleFor()? */
  responsible: boolean;
  graphInitialized: boolean;
  source: OrgSource;
}

/** The relationship you get when nothing could be resolved. Every flag false. */
export const NO_RELATIONSHIP: RowRelationship = Object.freeze({
  targetEmployeeId: null,
  self: false,
  responsible: false,
  graphInitialized: false,
  source: 'none' as OrgSource,
});

export interface FactDecision {
  allowed: boolean;
  /** The sentence a person sees. On a refusal it is ALWAYS UNIFORM_PERSON_REFUSAL. */
  message: string;
  /** SERVER LOG ONLY. Never render this: the point of the uniform refusal is that this one varies. */
  auditReason: string;
  /** Where the human does it themselves, when there is such a screen. Rule 4. */
  actionHref: string | null;
}

const allow = (kind: PersonalFactKind, why: string): FactDecision => ({
  allowed: true,
  message: '',
  auditReason: why,
  actionHref: ACTION_SURFACES[kind],
});

const refuse = (why: string): FactDecision => ({
  allowed: false,
  message: UNIFORM_PERSON_REFUSAL,
  auditReason: why,
  actionHref: null,
});

/**
 * DECIDE. Pure, synchronous, and it reads NOTHING — which is what makes the refusal uniform: there
 * is no lookup whose success, failure or latency could shade the wording.
 *
 * The ORDER of the checks is the whole design:
 *
 *   1. FORBIDDEN KIND       wellness, legal hold. Before audience, before capability, before the
 *                           graph, and before self. No input reaches past it.
 *   2. UNKNOWN KIND         refuse. An unrecognised noun is not a permissive default.
 *   3. NO WORKSPACE         a visitor has no personal facts of any kind, including their own.
 *   4. NO EMPLOYEE RECORD   nothing personal is addressable; said honestly, not as an error.
 *   5. SELF                 the ids must actually match. rel.self is never believed on its own.
 *   6. SOMEBODY ELSE        compensation and payslip need BOTH the capability AND the graph. Every
 *                           other kind needs the graph OR that kind's HR capability.
 */
export function decideFact(
  scope: AssistantScope,
  kind: unknown,
  targetEmployeeId: unknown,
  rel: RowRelationship = NO_RELATIONSHIP,
): FactDecision {
  // 1. THE HARD EXCLUSIONS. Not the founder, not a wildcard, not about yourself.
  if (FORBIDDEN_FACT_KINDS.has(kind as PersonalFactKind)) {
    return refuse(
      'forbidden fact kind "' + String(kind) + '"; no audience, capability or relationship reaches it',
    );
  }

  // 2. An unrecognised kind is a refusal, not a fall-through.
  if (!PERSONAL_FACT_KINDS.includes(kind as PersonalFactKind)) {
    return refuse('unknown fact kind "' + String(kind) + '"');
  }
  const factKind = kind as PersonalFactKind;

  // 3.
  if (scope.audience === 'visitor' || !scope.userId) {
    return refuse('visitor scope has no personal facts');
  }

  // 4.
  if (!scope.employeeId) {
    return refuse('asker has no hr_employees row, so no personal fact is addressable');
  }

  const target = isUuid(targetEmployeeId) ? String(targetEmployeeId) : null;
  if (!target) return refuse('target employee id is not a uuid');

  // 5. SELF.
  if (target === scope.employeeId) {
    return allow(factKind, 'self');
  }

  // 6. SOMEBODY ELSE.
  const keys = FACT_CAPABILITY[factKind] || [];
  const hasCapability = scope.wildcard || keys.some((k) => scope.capabilities.includes(k));

  // rel.responsible is believed only when the answer actually came FROM the graph and is about the
  // row being asked about. `source: 'none'` means the graph did not answer, and org-graph's own
  // header is explicit that this must be read as a refusal rather than as permission.
  const graphSaysYes =
    rel.responsible === true && rel.source === 'graph' && rel.targetEmployeeId === target;

  if (BOTH_REQUIRED_FACT_KINDS.has(factKind)) {
    if (hasCapability && graphSaysYes) {
      return allow(factKind, 'compensation-shaped fact: capability AND org graph both allow');
    }
    return refuse(
      'compensation-shaped fact about another person; capability=' +
        String(hasCapability) +
        ' graph=' +
        String(graphSaysYes),
    );
  }

  if (graphSaysYes) return allow(factKind, 'org graph records the asker as responsible for this row');
  if (hasCapability) return allow(factKind, 'held capability for "' + factKind + '"');
  return refuse('no relationship on the org graph and no capability for "' + factKind + '"');
}

// -------------------------------------------------------------------------------------------------
// THE ASYNC HALF — org graph only, fails closed
// -------------------------------------------------------------------------------------------------

/**
 * Resolve the asker-to-subject relationship for ONE row. Reads only the org graph, and returns
 * NO_RELATIONSHIP on any failure, so a pooler timeout narrows the answer instead of widening it.
 */
export async function resolveRowRelationship(
  scope: AssistantScope,
  targetEmployeeId: unknown,
): Promise<RowRelationship> {
  const target = isUuid(targetEmployeeId) ? String(targetEmployeeId) : null;
  if (!target || !scope.employeeId) return { ...NO_RELATIONSHIP, targetEmployeeId: target };
  if (target === scope.employeeId) {
    return {
      targetEmployeeId: target,
      self: true,
      responsible: false,
      graphInitialized: scope.graphInitialized,
      source: 'graph',
    };
  }
  try {
    const { isResponsibleFor } = await orgGraph();
    const responsible = await isResponsibleFor(scope.employeeId, target);
    return {
      targetEmployeeId: target,
      self: false,
      responsible,
      graphInitialized: scope.graphInitialized,
      source: 'graph',
    };
  } catch (e: any) {
    logFail('resolveRowRelationship', e);
    return { ...NO_RELATIONSHIP, targetEmployeeId: target };
  }
}

/** resolveRowRelationship() followed by decideFact(). The convenience an endpoint actually calls. */
export async function mayAnswerFactAbout(
  scope: AssistantScope,
  kind: PersonalFactKind,
  targetEmployeeId: unknown,
): Promise<FactDecision> {
  // The hard exclusions are decided BEFORE any read, so asking about a forbidden kind does not even
  // produce a database round trip that a stopwatch could measure.
  if (FORBIDDEN_FACT_KINDS.has(kind)) {
    return decideFact(scope, kind, targetEmployeeId, NO_RELATIONSHIP);
  }
  const rel = await resolveRowRelationship(scope, targetEmployeeId);
  return decideFact(scope, kind, targetEmployeeId, rel);
}

/**
 * RESOLVE THE SCOPE for a request. The caller passes the session user and the already-composed
 * workspace context (composeWorkspace().context); this function adds only the org-graph facts.
 *
 * FAILS CLOSED. Every read is wrapped, every failure is NAMED in contextGaps rather than swallowed,
 * and a total failure yields the visitor scope — which is a correct scope, not an error page.
 */
export async function resolveAssistantScope(args: {
  user?: { id?: string | null; isActive?: boolean | null } | null;
  permissions?: Iterable<string> | null;
  employeeId?: string | null;
  departmentId?: string | null;
  hasWorkspace?: boolean;
}): Promise<AssistantScope> {
  const gaps: string[] = [];
  const rawId = String(args?.user?.id || '').trim();

  let employeeId = isUuid(args?.employeeId) ? String(args.employeeId) : null;
  if (!employeeId && isUuid(rawId)) {
    try {
      const { readEmployeeIdForUser } = await orgGraph();
      const read = await readEmployeeIdForUser(rawId);
      // ok:false means only that the read failed. It is never a grant — employeeId stays null either
      // way — but the gap has to be sayable, or "you have no employee record" gets printed at a
      // person on the strength of a pooler timeout.
      if (!read.ok) gaps.push('employee-record');
      employeeId = read.employeeId;
    } catch (e: any) {
      logFail('readEmployeeIdForUser', e);
      gaps.push('employee-record');
    }
  }

  let graphInitialized = false;
  try {
    const { isInitialized } = await orgGraph();
    graphInitialized = await isInitialized();
  } catch (e: any) {
    logFail('isInitialized', e);
    gaps.push('organization-graph');
  }

  // MANAGER IS A RELATIONSHIP, and it is asked of the graph. Never users.role, never a title, never
  // a column somebody typed. A failure here narrows the audience to 'employee', which shows a
  // manager less than they may see — the safe direction.
  let hasDirectReports = false;
  if (employeeId && graphInitialized) {
    try {
      const { getDirectReports } = await orgGraph();
      const reports = await getDirectReports(employeeId);
      hasDirectReports = Array.isArray(reports) && reports.length > 0;
    } catch (e: any) {
      logFail('getDirectReports', e);
      gaps.push('reporting-line');
    }
  }

  return buildAssistantScope({
    user: args?.user ?? null,
    permissions: args?.permissions ?? null,
    employeeId,
    departmentId: args?.departmentId ?? null,
    hasWorkspace: args?.hasWorkspace,
    graphInitialized,
    hasDirectReports,
    contextGaps: gaps,
  });
}

// -------------------------------------------------------------------------------------------------
// ESCALATION — rule 5. Present on EVERY answer, including a good one.
// -------------------------------------------------------------------------------------------------

export interface Escalation {
  label: string;
  href: string;
  /** The sentence that goes under a good answer as readily as under a refusal. */
  sentence: string;
}

/**
 * The route to a person. Nobody should be trapped in a conversation with software about their own
 * pay, and nobody should have to ask for the exit.
 *
 * NOTE WHAT IS NOT HERE: /founder is a PAID direct line with its own booking and payment flow. It is
 * never offered as a general contact route, because that routes somebody at a paywall when they are
 * trying to ask a question about their leave.
 */
export function escalationFor(scope: AssistantScope): Escalation {
  if (scope.audience === 'visitor') {
    return {
      label: 'Talk to a person',
      href: '/contact',
      sentence:
        'If this did not answer your question, a person will: use the contact form, or the live chat on any page.',
    };
  }
  return {
    label: 'Raise it with the right desk',
    href: '/portal/employee/support',
    sentence:
      'If this is not right, or it is about your own record, raise it with the desk that owns it and a person will answer.',
  };
}

/**
 * Rule 4 as a helper: the screen where the human performs the thing they just asked about. Returns
 * null for a kind with no screen, which is the two forbidden kinds and nothing else.
 */
export function actionLinkFor(kind: unknown): string | null {
  if (!PERSONAL_FACT_KINDS.includes(kind as PersonalFactKind)) return null;
  return ACTION_SURFACES[kind as PersonalFactKind];
}
