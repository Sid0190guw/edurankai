// src/lib/talent/access.ts — ACCESS GROUPS, POLICY, AND THE DERIVATION OF AUTHORIZATION.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 20, 21, 22, 23, 26.7 and 35.
//
// ---------------------------------------------------------------------------------------------
// ACCESS IS DERIVED. IT IS NOT A LIST SOMEBODY KEEPS.
// ---------------------------------------------------------------------------------------------
// The whole module exists to make one sentence true: for every group a person can reach, this
// system can say WHY, in words, without asking anybody to remember. Spec 23.2 writes it as
//
//   proposed_groups(identity) = department_default_groups(department_id)
//                             u position_groups(position_id)
//                             u type_groups(identity_type)
//                             u manual_grants(identity_id, unexpired)
//
// and deriveAccess() below is that formula as a PURE function: same inputs, same output, no writes,
// no connection, unit-tested in src/lib/talent/access.test.ts. Every screen that shows access reads
// the derivation, so no screen can quietly invent a grant.
//
// STATUS IS THE FIRST TERM, NOT THE LAST FILTER. Spec 21.2: gate(identity_status) is evaluated
// first, and a non-active identity resolves to the empty set before anything else is computed. A
// suspended department head is not a department head. That is the assertion the test file leads
// with, because every other rule here is worth nothing if a suspended identity keeps reaching
// things.
//
// A MANUAL GRANT IS AN EXCEPTION, AND IT STAYS VISIBLY AN EXCEPTION. It is always time-bounded
// (default 90 days, hard cap 365 — ACCESS_REQUEST_LIMITS in types.ts), always carries a written
// reason, and keeps source='manual' on its row for the whole of its life, so a later reconciliation
// reports it as an exception rather than absorbing it into the derived set. An expired manual grant
// is not access; a manual grant with no end date at all is not access either, because time-bounded
// is the rule and an unbounded exception is exactly the drift this subsystem exists to catch.
//
// ---------------------------------------------------------------------------------------------
// THE THREE-LAYER RULE, WHICH THIS MODULE MAY NOT BREAK
// ---------------------------------------------------------------------------------------------
// Organization, Authorization and Workflow are independent layers on this project and are never
// merged. This module resolves AUTHORIZATION: which capabilities a group carries, which policy
// implies which group, and what an identity therefore derives to.
//
// It does NOT encode who reports to whom. There is no reporting manager in a policy row, no
// department head read out of an access group, no approval chain hard-coded to a named person.
// Relationships resolve per ROW from the organization graph, capabilities resolve per USER, and a
// policy row that tried to hold both would be answering "manager of whom?" with silence. Where the
// access-request workflow below records that the manager step is done, it records THAT A STEP
// HAPPENED and who recorded it — never who the manager is.
//
// ---------------------------------------------------------------------------------------------
// tal_identity_access IS A CACHE
// ---------------------------------------------------------------------------------------------
// schema.ts says so on the table itself, and everything here treats it that way. The derivation is
// the source of truth; the table is a materialisation that reconciliation re-derives and diffs.
// diffAccess() below is that comparison, and accessForIdentity() runs it on every lookup so drift is
// visible on the screen rather than only in a job nobody watches. The one thing the cache genuinely
// OWNS is the exception rows (source 'manual' and 'request'): an exception has nowhere else to live,
// which is why grantManual() writes there and why those rows feed back into the derivation as an
// input rather than being read out of it.
//
// ---------------------------------------------------------------------------------------------
// NOTHING HERE PROVISIONS AN OUTSIDE SYSTEM
// ---------------------------------------------------------------------------------------------
// A provisioning run is a PROPOSAL. Reviewing one records a decision about what SHOULD be
// provisioned; a human still does it. There is no connector, no integration and no job that reaches
// any outside system in this repository, and the admin surface says that in those words. Copy that
// implied otherwise would be the most expensive kind of wrong: an operator would stop doing by hand
// the thing nothing is doing for them.
import { ensureTalentSchema } from './schema';
import {
  rowsOf, reasonOf, okResult, failResult,
  statusGrantsAccess,
  IDENTITY_TYPES, IDENTITY_TYPE_LABELS, IDENTITY_STATUS_LABELS,
  ACCESS_REQUEST_LIMITS,
  type AccessClassification, type AccessGroup, type AccessPolicy, type AccessSource,
  type AccessRequestStatus, type ProvisioningStatus, type IdentityStatus,
  type TalentResult,
} from './types';

// ---------------------------------------------------------------------------------------------
// VOCABULARY. Derived from the owned unions in types.ts and never a second spelling of them — the
// `satisfies` clause below fails to compile the moment this file and the contract disagree.
// ---------------------------------------------------------------------------------------------

export const ACCESS_CLASSIFICATIONS = ['public', 'internal', 'restricted', 'classified'] as const satisfies readonly AccessClassification[];

export const CLASSIFICATION_LABELS: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  restricted: 'Restricted',
  classified: 'Classified',
};

/** One sentence per classification, so a screen never prints a level with nothing to read it by. */
export const CLASSIFICATION_NOTES: Record<string, string> = {
  public: 'Nothing behind this group is confidential. Losing it embarrasses nobody.',
  internal: 'Ordinary working access. Everyone who belongs here may hold it.',
  restricted: 'Held by the people who need it for their work, and reviewed. Not a default.',
  classified: 'Granted one identity at a time, with an approval on the record. Never by a policy.',
};

export const SUBJECT_KINDS = ['department', 'position', 'identity_type'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_KIND_LABELS: Record<string, string> = {
  department: 'Department',
  position: 'Position',
  identity_type: 'Identity type',
};

export const ACCESS_SOURCE_LABELS: Record<string, string> = {
  department: 'Department policy',
  position: 'Position policy',
  type: 'Identity type policy',
  manual: 'Manual grant',
  request: 'Approved access request',
};

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting the manager step',
  manager: 'Awaiting the manager step',
  department: 'Awaiting the department step',
  security: 'Awaiting the security step',
  approved: 'Approved',
  rejected: 'Refused',
  expired: 'Expired',
};

export const PROVISIONING_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  awaiting_review: 'Awaiting review',
  approved: 'Approved for provisioning',
  provisioning: 'Being provisioned',
  provisioned: 'Provisioned',
  partially_failed: 'Partly failed',
  failed: 'Failed or declined',
};

/** Display order for a reason list: policy terms first, exceptions last, so exceptions stand out. */
const SOURCE_ORDER: Record<string, number> = {
  department: 1, position: 2, type: 3, manual: 4, request: 5,
};

// ---------------------------------------------------------------------------------------------
// PURE HELPERS
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Milliseconds, or null when the input is not a readable instant. Never NaN, never a guess. */
export function toMs(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v as any).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * '12 Sep 2026', computed in UTC from the arithmetic and not from the host's locale data.
 *
 * DELIBERATELY NOT toLocaleDateString. This string is asserted in unit tests and read back off an
 * admin screen; an ICU build that spells the month differently would make the same code pass on one
 * machine and fail on another, which is the least useful kind of red.
 */
export function formatDay(iso: string | null | undefined): string {
  const ms = toMs(iso);
  if (ms === null) return '';
  const d = new Date(ms);
  return String(d.getUTCDate()).padStart(2, '0') + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

const normKey = (v: unknown): string => String(v ?? '').trim().toLowerCase();

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// THE DERIVATION — spec 23.2. The heart of the module.
// ---------------------------------------------------------------------------------------------

/** The identity attributes the formula reads, and nothing else. */
export interface DerivableIdentity {
  id: string;
  identityType: string;
  departmentId: string | null;
  positionId: string | null;
  status: IdentityStatus;
}

/** One policy row. `isActive` is carried because a retired policy must derive nothing. */
export interface DerivablePolicy {
  id: string;
  subjectKind: string;
  subjectKey: string;
  accessGroupId: string;
  version: number;
  isActive: boolean;
}

/** A manual grant or an approved request, as it sits in tal_identity_access. */
export interface DerivableGrant {
  id: string;
  accessGroupId: string;
  source: string;
  reason: string | null;
  validUntil: string | null;
}

/**
 * WHY one group is reachable, in words that can be put next to it on a screen.
 *
 * A grant with no visible reason is the thing this whole subsystem exists to prevent, so there is
 * no path through deriveAccess() that produces a group id without one of these beside it.
 */
export interface AccessReason {
  accessGroupId: string;
  source: AccessSource;
  /** The sentence a screen prints: 'From department engineering', 'Manual grant, until 12 Sep 2026'. */
  explanation: string;
  /** The written reason recorded on an exception. Null for a policy-derived term. */
  note: string | null;
  validUntil: string | null;
  policyVersion: number | null;
  /**
   * TRUE ONLY on a `refused` entry that the STATUS GATE withheld, and it is the difference between
   * two rows that otherwise read alike.
   *
   * A refused entry is either DEAD — expired, unbounded, or carrying an end date nothing can read,
   * and it will never be access again without being reissued — or WITHHELD: a perfectly live term
   * that comes back by itself the moment the identity is active again. The admin surface offers a
   * withdraw control beside a refused exception, and it labelled every one of them "the dead
   * exception". Pressing it on a suspended person's live, reasoned, unexpired grant destroys it
   * permanently under a label saying it was already gone.
   */
  gated?: boolean;
}

export interface AccessDerivation {
  identityId: string;
  /** Distinct group ids, in SOURCE_ORDER. Empty whenever the status gate closes. */
  groups: string[];
  /** One entry per (group, source). Two sources for one group is two honest answers, not a bug. */
  reasons: AccessReason[];
  /** Inputs the derivation did NOT honour, and why. Never access; shown so nobody has to guess. */
  refused: AccessReason[];
  /** Non-null exactly when the status gate emptied the set, so a screen never shows a bare zero. */
  gatedReason: string | null;
}

/**
 * Resolve an identity to the access it derives to, with the reason for every element.
 *
 * PURE. No database, no clock of its own (pass `now`), no writes. Everything the formula needs is
 * an argument, which is what makes the rules testable at all.
 */
export function deriveAccess(
  identity: DerivableIdentity,
  policies: readonly DerivablePolicy[],
  manualGrants: readonly DerivableGrant[],
  now: Date | string | number = new Date(),
): AccessDerivation {
  const nowMs = toMs(now) ?? Date.now();
  const identityId = String(identity?.id || '');

  // TERM ZERO: the gate. Computed before anything else and applied unconditionally at the return,
  // so no arrangement of the terms below can produce a group for an identity that must have none.
  const gateOpen = statusGrantsAccess(identity.status);
  const statusLabel = IDENTITY_STATUS_LABELS[identity.status] || String(identity.status);

  const wanted: AccessReason[] = [];
  const refused: AccessReason[] = [];
  const seen = new Set<string>();

  const push = (r: AccessReason) => {
    const k = r.accessGroupId + '|' + r.source;
    if (seen.has(k)) return;
    seen.add(k);
    wanted.push(r);
  };

  // TERMS 1-3: department, position, identity type. A retired policy derives nothing — that is what
  // retirement means, and it is why a retired row and its replacement can coexist in the table.
  for (const p of policies || []) {
    if (!p || p.isActive !== true) continue;
    const kind = String(p.subjectKind || '');
    const key = normKey(p.subjectKey);
    if (!key) continue;
    const groupId = String(p.accessGroupId || '');
    if (!groupId) continue;
    const version = Number.isFinite(Number(p.version)) ? Number(p.version) : null;

    if (kind === 'department') {
      // department_id IS TEXT on this project, never a UUID, and the comparison is a trimmed,
      // case-folded string compare for that reason. A ::uuid cast here is a guaranteed 500.
      if (!identity.departmentId || normKey(identity.departmentId) !== key) continue;
      push({
        accessGroupId: groupId, source: 'department',
        explanation: 'From department ' + String(p.subjectKey).trim(),
        note: null, validUntil: null, policyVersion: version,
      });
    } else if (kind === 'position') {
      if (!identity.positionId || normKey(identity.positionId) !== key) continue;
      push({
        accessGroupId: groupId, source: 'position',
        explanation: 'From position ' + String(p.subjectKey).trim(),
        note: null, validUntil: null, policyVersion: version,
      });
    } else if (kind === 'identity_type') {
      if (normKey(identity.identityType) !== key) continue;
      const label = IDENTITY_TYPE_LABELS[key as keyof typeof IDENTITY_TYPE_LABELS] || String(p.subjectKey).trim();
      push({
        accessGroupId: groupId, source: 'type',
        explanation: 'From identity type ' + label,
        note: null, validUntil: null, policyVersion: version,
      });
    }
    // An unrecognised subject_kind derives nothing. Failing closed on a row nobody can interpret is
    // the only safe reading of it.
  }

  // TERM 4: exceptions. Time-bounded, reasoned, and marked for the rest of their life.
  for (const g of manualGrants || []) {
    if (!g) continue;
    const groupId = String(g.accessGroupId || '');
    if (!groupId) continue;
    const source: AccessSource = g.source === 'request' ? 'request' : 'manual';
    const label = ACCESS_SOURCE_LABELS[source];
    const base = {
      accessGroupId: groupId, source, note: g.reason ? String(g.reason) : null,
      validUntil: g.validUntil ? String(g.validUntil) : null, policyVersion: null,
    };
    if (!g.validUntil) {
      refused.push({
        ...base,
        explanation: label + ' with no end date. An exception outside policy must be time-bounded, so this grants nothing until it is reissued with one.',
      });
      continue;
    }
    const untilMs = toMs(g.validUntil);
    if (untilMs === null) {
      refused.push({ ...base, explanation: label + ' with an end date that cannot be read. It grants nothing.' });
      continue;
    }
    // THE BOUNDARY: live strictly BEFORE the end instant. At valid_until it is over, because that is
    // what an end date means, and a grant that lingers for one more request is a grant nobody chose.
    if (!(nowMs < untilMs)) {
      refused.push({ ...base, explanation: label + ' expired ' + formatDay(g.validUntil) + '. It is not access.' });
      continue;
    }
    push({ ...base, explanation: label + ', until ' + formatDay(g.validUntil) });
  }

  const order = (r: AccessReason) => (SOURCE_ORDER[r.source] || 9);
  const sorted = wanted.slice().sort((a, b) => (order(a) - order(b)) || a.accessGroupId.localeCompare(b.accessGroupId));

  if (!gateOpen) {
    // THE WHOLE SET IS DISCARDED. Not filtered, not narrowed — emptied. What would otherwise have
    // been derived is reported as refused so an administrator can see what reinstatement would
    // restore, and it is not, at any point, access.
    // TYPED AS AccessReason[] DELIBERATELY. Left to inference the element type carries a REQUIRED
    // `gated: boolean`, and `.concat(refused)` — whose elements have it optional — then fails to
    // compile. The array is a list of refusals like any other; the flag is the optional extra.
    const withheld: AccessReason[] = sorted.map((r) => ({
      ...r,
      gated: true,
      explanation: 'Withheld while the identity is ' + statusLabel.toLowerCase() + '. Would otherwise be: ' + r.explanation
        + '. It is not gone: it returns by itself if the identity becomes active again.',
    }));
    return {
      identityId,
      groups: [],
      reasons: [],
      refused: withheld.concat(refused),
      gatedReason:
        'This identity is ' + statusLabel.toLowerCase() + ', so it resolves to no access at all. Status is the first '
        + 'term in the formula: a department, a position and a standing exception are all read only after it, and a '
        + 'closed gate empties the set whatever they say.',
    };
  }

  const groups: string[] = [];
  for (const r of sorted) if (!groups.includes(r.accessGroupId)) groups.push(r.accessGroupId);

  return { identityId, groups, reasons: sorted, refused, gatedReason: null };
}

/**
 * What the cache says against what the formula says. Spec 23.2: reconciliation re-derives, diffs,
 * and reports divergence, because drift nobody notices is how an exited employee keeps access.
 *
 * `missing` — derived but not materialised: the cache is behind, and anything reading the cache is
 * under-granting. `stale` — materialised but no longer derived: the cache is over-granting, which is
 * the dangerous direction and the one an exit produces.
 */
export interface AccessDrift {
  missing: { accessGroupId: string; source: AccessSource }[];
  stale: { accessGroupId: string; source: string }[];
}

export function diffAccess(
  derived: readonly AccessReason[],
  cached: readonly { accessGroupId: string; source: string }[],
): AccessDrift {
  const key = (g: string, s: string) => g + '|' + s;
  const inCache = new Set((cached || []).map((c) => key(String(c.accessGroupId), String(c.source))));
  const inDerived = new Set((derived || []).map((d) => key(d.accessGroupId, d.source)));
  const missing = (derived || [])
    .filter((d) => !inCache.has(key(d.accessGroupId, d.source)))
    .map((d) => ({ accessGroupId: d.accessGroupId, source: d.source }));
  const stale = (cached || [])
    .filter((c) => !inDerived.has(key(String(c.accessGroupId), String(c.source))))
    .map((c) => ({ accessGroupId: String(c.accessGroupId), source: String(c.source) }));
  return { missing, stale };
}

// ---------------------------------------------------------------------------------------------
// VALIDATION — spec 23 "Validation rules". Pure, and tested.
// ---------------------------------------------------------------------------------------------

const GROUP_KEY_RE = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

export interface GroupInput {
  key: string;
  name: string;
  description?: string;
  departmentId?: string | null;
  classification: string;
  capabilities: string[];
  systems?: string[];
}

/**
 * Why an access group may not be saved as written, or null when it may.
 *
 * `knownCapabilities`, when supplied, is the permission catalogue. A capability key that is not in
 * it grants NOTHING at run time — can() would never match it — while reading on screen as though it
 * did, which is a group that lies about its own contents. Spec 22 rule 1 makes an unknown key a
 * compile failure where the keys are code; here they are data, so the check has to happen at save.
 */
export function groupProblem(input: GroupInput, knownCapabilities?: readonly string[]): string | null {
  const key = String(input?.key || '').trim().toLowerCase();
  if (!key) return 'An access group needs a key.';
  if (key.length > 60) return 'A group key is at most 60 characters.';
  if (!GROUP_KEY_RE.test(key)) {
    return 'A group key is lower case letters, digits, and single dots, hyphens or underscores between them.';
  }
  if (!String(input?.name || '').trim()) return 'An access group needs a name somebody can recognise.';
  const classification = String(input?.classification || '').trim();
  if (!(ACCESS_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    return 'Classification must be one of: ' + ACCESS_CLASSIFICATIONS.join(', ') + '.';
  }
  const caps = (input?.capabilities || []).map((c) => String(c).trim()).filter(Boolean);
  for (const c of caps) {
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(c)) {
      return 'Capability "' + c + '" is not a permission key. Keys are dotted and lower case, like access.manage.';
    }
  }
  if (knownCapabilities && knownCapabilities.length > 0) {
    for (const c of caps) {
      if (!knownCapabilities.includes(c)) {
        return 'Capability "' + c + '" does not exist in the permission catalogue. It would grant nothing while appearing to grant something.';
      }
    }
  }
  return null;
}

/**
 * Why a policy row may not be saved, or null when it may.
 *
 * THE RULE WORTH THE MOST HERE: a policy may not carry a SENSITIVE capability. Spec 23 refuses a
 * sensitive capability granted "through a department default" and then states the general form —
 * "sensitive access is granted per-identity, never by bulk default". All three subject kinds are
 * bulk defaults: a department, a position and an identity type each cover everyone who matches, now
 * and in future, with nobody deciding per person. So the refusal covers all three, and sensitive
 * access reaches an identity only through a manual grant or an approved request, each of which
 * names a person, carries a reason and expires.
 *
 * `sensitiveCapabilities` is passed in rather than imported. src/lib/auth/registry.ts is the owner
 * of that list, and importing it here would put the registry — and the whole permission catalogue —
 * inside the import graph of a pure function that must be testable with no database and no catalogue
 * at all. The persistence layer below loads it and FAILS CLOSED if it cannot.
 */
export function policyProblem(args: {
  subjectKind: string;
  subjectKey: string;
  group: { key: string; name: string; isActive: boolean; classification: string; capabilities: string[] } | null;
  sensitiveCapabilities: readonly string[];
}): string | null {
  const kind = String(args?.subjectKind || '').trim();
  if (!(SUBJECT_KINDS as readonly string[]).includes(kind)) {
    return 'A policy applies to a department, a position or an identity type.';
  }
  const subjectKey = String(args?.subjectKey || '').trim();
  if (!subjectKey) return 'A policy needs the ' + SUBJECT_KIND_LABELS[kind].toLowerCase() + ' it applies to.';
  if (kind === 'identity_type' && !(IDENTITY_TYPES as readonly string[]).includes(subjectKey.toLowerCase())) {
    return 'That is not an identity type. The types are: ' + IDENTITY_TYPES.join(', ') + '.';
  }
  const group = args?.group || null;
  if (!group) return 'That access group does not exist.';
  if (!group.isActive) return 'That access group has been retired. A retired group may not be given out by policy.';
  const sensitive = (group.capabilities || []).filter((c) => (args.sensitiveCapabilities || []).includes(String(c)));
  if (sensitive.length > 0) {
    return 'Group "' + group.key + '" carries the sensitive capability ' + sensitive.join(', ')
      + '. Sensitive access is granted one identity at a time, with a reason and an expiry, and never by a '
      + SUBJECT_KIND_LABELS[kind].toLowerCase() + ' default.';
  }
  if (group.classification === 'classified') {
    return 'Group "' + group.key + '" is classified. A classified group is granted one identity at a time, never by policy.';
  }
  return null;
}

/**
 * Why a manual grant window may not be used, or null when it may. Spec 23: always time-bounded,
 * default 90 days, hard cap 365.
 */
export function grantWindowProblem(untilIso: string | null | undefined, now: Date | string | number = new Date()): string | null {
  const nowMs = toMs(now) ?? Date.now();
  if (!untilIso) return 'A manual grant must end on a date. There is no open-ended exception.';
  const untilMs = toMs(untilIso);
  if (untilMs === null) return 'That end date cannot be read.';
  if (!(nowMs < untilMs)) return 'A manual grant must end in the future. An end date today or earlier grants nothing.';
  const days = Math.ceil((untilMs - nowMs) / DAY_MS);
  if (days > ACCESS_REQUEST_LIMITS.maxGrantDays) {
    return 'A manual grant runs for at most ' + ACCESS_REQUEST_LIMITS.maxGrantDays + ' days. That one runs for ' + days + '.';
  }
  return null;
}

/** The default end date offered on the form: 90 days out, per spec 23. */
export function defaultGrantUntil(now: Date | string | number = new Date()): string {
  const nowMs = toMs(now) ?? Date.now();
  return new Date(nowMs + ACCESS_REQUEST_LIMITS.defaultGrantDays * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------------------------
// WORKFLOW TRANSITIONS — spec 36. Pure, and tested.
// ---------------------------------------------------------------------------------------------

export type RequestDecision = 'approve' | 'reject';

export interface RequestAdvance {
  ok: boolean;
  problem?: string;
  /** Which decision column the outcome is written into. */
  stage?: 'manager' | 'department' | 'security';
  next?: AccessRequestStatus;
  /** True when `next` ends the request and decided_at is stamped. */
  terminal?: boolean;
}

/**
 * Move an access request one step. Spec 36: manager, then department, then security WHERE
 * CLASSIFIED. No step auto-advances on a timeout, and nothing here decides on anybody's behalf.
 *
 * THE STATUS NAMES THE STEP THE REQUEST IS WAITING ON, not the last one completed. 'pending' and
 * 'manager' both mean "waiting for the manager step" — the schema's union carries both spellings and
 * treating them as one avoids a request stalling on a value nobody can act on.
 *
 * THE ESCALATION IS DECIDED BY CLASSIFICATION, an attribute of the GROUP, and never by the
 * organization graph. Which human occupies the manager step is a relationship resolved per row
 * elsewhere; this function only knows that the step exists.
 */
export function advanceRequest(
  current: string,
  decision: RequestDecision,
  classification: string,
): RequestAdvance {
  const s = String(current || '').trim();
  if (s === 'approved' || s === 'rejected' || s === 'expired') {
    return { ok: false, problem: 'That request has already been decided. Reopening one is a new request, not an edit.' };
  }
  const stage: 'manager' | 'department' | 'security' | null =
    (s === 'pending' || s === 'manager') ? 'manager'
    : s === 'department' ? 'department'
    : s === 'security' ? 'security'
    : null;
  if (!stage) return { ok: false, problem: 'That request is in a state this workflow does not know: ' + s + '.' };

  if (decision === 'reject') {
    // A refusal is terminal from any step. There is no "refused, but continue up the chain".
    return { ok: true, stage, next: 'rejected', terminal: true };
  }

  if (stage === 'manager') return { ok: true, stage, next: 'department', terminal: false };
  if (stage === 'department') {
    const needsSecurity = String(classification || '') === 'classified';
    return needsSecurity
      ? { ok: true, stage, next: 'security', terminal: false }
      : { ok: true, stage, next: 'approved', terminal: true };
  }
  return { ok: true, stage: 'security', next: 'approved', terminal: true };
}

export type ReviewDecision = 'approve' | 'decline';

export interface ReviewOutcome {
  ok: boolean;
  problem?: string;
  next?: ProvisioningStatus;
  /** True when the outcome is a decline recorded in the `failures` column. */
  declined?: boolean;
}

/**
 * Review a proposed provisioning run.
 *
 * A RUN IS A PROPOSAL AND APPROVING IT IS STILL NOT AN ACTION. 'approved' here means a human read
 * the proposal and agreed it is what should be provisioned. Nothing in this repository then reaches
 * an outside system, and the surface says so.
 *
 * A DECLINE IS STORED AS 'failed' WITH A MARKER, and that is a compromise worth naming: the owned
 * ProvisioningStatus union (types.ts, which this module may not edit) has proposed, awaiting_review,
 * approved, provisioning, provisioned, partially_failed and failed — and no 'declined'. Rather than
 * invent an eighth value that no other reader knows, a decline lands on 'failed' and writes
 * { kind: 'declined_at_review' } into the run's `failures`, so the reason is legible and the status
 * is one the contract already defines.
 */
export function reviewOutcome(current: string, decision: ReviewDecision): ReviewOutcome {
  const s = String(current || '').trim();
  if (s !== 'proposed' && s !== 'awaiting_review') {
    return { ok: false, problem: 'Only a proposed run can be reviewed. That one is ' + (PROVISIONING_STATUS_LABELS[s] || s).toLowerCase() + '.' };
  }
  if (decision === 'approve') return { ok: true, next: 'approved', declined: false };
  return { ok: true, next: 'failed', declined: true };
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_access_group, tal_access_policy, tal_identity_access, tal_access_request,
// tal_provisioning_run. Every table is created by ensureTalentSchema(); nothing here writes DDL.
//
// EVERY READ RETHROWS. "There are none" and "we could not read whether there are any" render as the
// same empty table and mean opposite things, and the swallowed read presented as a confident empty
// state is the dominant defect class in this repository. The page catches and prints the reason.
// ---------------------------------------------------------------------------------------------

async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres refuses a malformed uuid with 22P02, which surfaces as a 500 rather than "not found".
 * Every id that arrives from a form or a query string is checked here first.
 */
export const isUuid = (v: unknown): boolean => UUID_RE.test(String(v || '').trim());

/** JSONB comes back parsed from postgres-js, but a text column or a driver change would not. */
function jsonArray(v: any): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map((s) => String(s).trim()).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

/** Split a comma or newline separated list from a form into keys. */
export function parseList(raw: unknown): string[] {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const GROUP_COLUMNS = 'id, key, name, description, department_id, classification, capabilities, systems, is_active, created_at';

function toGroup(x: any): AccessGroup {
  return {
    id: String(x.id),
    key: String(x.key || ''),
    name: String(x.name || ''),
    description: String(x.description || ''),
    departmentId: x.department_id ? String(x.department_id) : null,
    classification: String(x.classification || 'internal') as AccessClassification,
    capabilities: jsonArray(x.capabilities),
    systems: jsonArray(x.systems),
    isActive: x.is_active !== false,
  };
}

/**
 * The permission catalogue, read once per process from its OWNER.
 *
 * Imported lazily and from inside a function on purpose: src/lib/auth/registry.ts imports the
 * database handle at module scope, and a module-scope import here would drag it into the import
 * graph of the pure rules above, which must stay testable with no connection.
 *
 * Returns null when the catalogue cannot be read at all. addPolicy() then REFUSES, because it
 * cannot prove the group it is about to hand to a whole department carries nothing sensitive, and
 * "we could not check" must never be spent as "it is fine".
 */
let _catalogue: { known: string[]; sensitive: string[] } | null = null;
async function catalogue(): Promise<{ known: string[]; sensitive: string[] } | null> {
  if (_catalogue) return _catalogue;
  try {
    const reg: any = await import('@/lib/auth/registry');
    const entries = Object.entries(reg.BUILTIN_PERMISSIONS || {});
    if (entries.length === 0) return null;
    _catalogue = {
      known: entries.map(([k]) => String(k)),
      sensitive: entries.filter(([, m]) => (m as any)?.sensitive === true).map(([k]) => String(k)),
    };
    return _catalogue;
  } catch (e: any) {
    console.error('[talent-access] permission catalogue unreadable: ' + reasonOf(e));
    return null;
  }
}

/** The catalogue as the group form needs it. Null when unreadable — the key check is then skipped. */
export async function knownCapabilities(): Promise<string[] | null> {
  const c = await catalogue();
  return c ? c.known : null;
}

// ---------------------------------------------------------------------------------------------
// ACCESS GROUPS
// ---------------------------------------------------------------------------------------------

/** RETHROWS. An unreadable list must not render as "no groups exist". */
export async function listAccessGroups(includeInactive = false): Promise<AccessGroup[]> {
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(GROUP_COLUMNS)}
        FROM tal_access_group
       WHERE (${includeInactive}::boolean OR is_active)
       ORDER BY is_active DESC, key ASC
       LIMIT 500`));
    return rows.map(toGroup);
  } catch (e: any) {
    console.error('[talent-access] listAccessGroups: ' + reasonOf(e));
    throw e;
  }
}

export async function createAccessGroup(
  input: GroupInput,
  actorUserId: string,
): Promise<TalentResult<AccessGroup>> {
  try {
    const known = await knownCapabilities();
    const problem = groupProblem(input, known || undefined);
    if (problem) return failResult(problem);

    const { db, sql } = await ctx();
    const key = String(input.key).trim().toLowerCase();
    const caps = (input.capabilities || []).map((c) => String(c).trim()).filter(Boolean);
    const systems = (input.systems || []).map((s) => String(s).trim()).filter(Boolean);
    const dept = String(input.departmentId || '').trim() || null;
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO tal_access_group (key, name, description, department_id, classification, capabilities, systems)
      VALUES (${key}, ${String(input.name).trim()}, ${String(input.description || '').trim()},
              ${dept}, ${String(input.classification)},
              ${JSON.stringify(caps)}::jsonb, ${JSON.stringify(systems)}::jsonb)
      ON CONFLICT (key) DO NOTHING
      RETURNING ${sql.raw(GROUP_COLUMNS)}`));
    if (rows.length === 0) return failResult('An access group with the key "' + key + '" already exists.');
    return okResult(toGroup(rows[0]));
  } catch (e: any) {
    console.error('[talent-access] createAccessGroup: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

export interface GroupPatch {
  name?: string;
  description?: string;
  departmentId?: string | null;
  classification?: string;
  capabilities?: string[];
  systems?: string[];
}

/**
 * Change a group in place.
 *
 * tal_access_group HAS NO changed_by, change_reason OR updated_at COLUMN — it carries created_at and
 * nothing else. So the audit log is the only record of who changed a group and when, and the caller
 * writes it. That is a real gap in the schema rather than a decision made here, and it is reported
 * as one; this module will not add a column.
 */
export async function updateAccessGroup(
  id: string,
  patch: GroupPatch,
  actorUserId: string,
): Promise<TalentResult<AccessGroup>> {
  try {
    if (!isUuid(id)) return failResult('That is not a group reference.');
    const { db, sql } = await ctx();
    const existing = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(GROUP_COLUMNS)} FROM tal_access_group WHERE id = ${id}`));
    if (existing.length === 0) return failResult('That access group no longer exists.');
    const before = toGroup(existing[0]);

    const merged: GroupInput = {
      key: before.key,
      name: patch.name !== undefined ? String(patch.name) : before.name,
      description: patch.description !== undefined ? String(patch.description) : before.description,
      departmentId: patch.departmentId !== undefined ? patch.departmentId : before.departmentId,
      classification: patch.classification !== undefined ? String(patch.classification) : before.classification,
      capabilities: patch.capabilities !== undefined ? patch.capabilities : before.capabilities,
      systems: patch.systems !== undefined ? patch.systems : before.systems,
    };
    const known = await knownCapabilities();
    const problem = groupProblem(merged, known || undefined);
    if (problem) return failResult(problem);

    // A group already given out by an ACTIVE policy may not be raised to a level the policy layer
    // refuses to hand out — the policy would then be granting something no policy could be written
    // to grant, and the refusal in policyProblem() would only apply to new rows.
    //
    // AND IT FAILS CLOSED WHEN THE CATALOGUE IS UNREADABLE. Without the catalogue this cannot tell
    // whether the new capability list is sensitive, and an empty `nowSensitive` then means "could
    // not check", not "checked and clean". Spending it as the second is the exact way round the
    // "sensitive access is never granted by bulk default" rule: addPolicy() refuses to hand out a
    // sensitive group, so an unreadable-catalogue edit of a group a policy ALREADY hands out would
    // reach every matching identity by a door the policy layer has bolted. A group nothing hands
    // out is left alone — it grants nobody anything until a policy or a hand grant names it, and
    // both of those check for themselves.
    const caps = (merged.capabilities || []).map((c) => String(c).trim()).filter(Boolean);
    const cat = await catalogue();
    const nowSensitive = cat ? caps.filter((c) => cat.sensitive.includes(c)) : [];
    const beforeCaps = (before.capabilities || []).slice().sort().join(',');
    const capsChanged = caps.slice().sort().join(',') !== beforeCaps;
    const cannotCheck = !cat && capsChanged;
    if (nowSensitive.length > 0 || merged.classification === 'classified' || cannotCheck) {
      const used = rowsOf(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM tal_access_policy WHERE access_group_id = ${id} AND is_active`));
      const inUse = Number(used[0]?.n || 0);
      if (inUse > 0) {
        if (cannotCheck && nowSensitive.length === 0 && merged.classification !== 'classified') {
          return failResult(
            'The permission catalogue could not be read, so the capabilities on this group cannot be checked for '
            + 'sensitive keys — and it is handed out by ' + inUse + ' active policy row(s). Nothing was saved. '
            + 'Try again when the catalogue is readable, or retire those policy rows first.');
        }
        return failResult(
          'This group is handed out by ' + inUse + ' active policy row(s), so it may not be raised to '
          + (nowSensitive.length > 0 ? 'a sensitive capability' : 'classified')
          + '. Retire those policy rows first, then grant it per identity.');
      }
    }

    const rows = rowsOf(await db.execute(sql`
      UPDATE tal_access_group
         SET name = ${String(merged.name).trim()},
             description = ${String(merged.description || '').trim()},
             department_id = ${String(merged.departmentId || '').trim() || null},
             classification = ${String(merged.classification)},
             capabilities = ${JSON.stringify(caps)}::jsonb,
             systems = ${JSON.stringify((merged.systems || []).map((s) => String(s).trim()).filter(Boolean))}::jsonb
       WHERE id = ${id}
      RETURNING ${sql.raw(GROUP_COLUMNS)}`));
    if (rows.length === 0) return failResult('That access group no longer exists.');
    return okResult(toGroup(rows[0]));
  } catch (e: any) {
    console.error('[talent-access] updateAccessGroup: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

/**
 * Retire a group, and retire every active policy that hands it out, in the same act.
 *
 * WHY THE CASCADE. deriveAccess() reads policy rows, not group rows: a retired group still reachable
 * through a live policy would carry on being derived, and the screen would show a grant sourced from
 * a group that no longer exists as far as its administrator is concerned. Retiring the policy rows
 * with it keeps "retired" meaning the same thing on both tables.
 *
 * Existing manual grants in the cache are NOT deleted. They are exceptions somebody wrote a reason
 * for, and they surface on the lookup marked against a retired group so a human decides.
 */
export async function deactivateAccessGroup(
  id: string,
  reason: string,
  actorUserId: string,
): Promise<TalentResult<{ policiesRetired: number }>> {
  try {
    if (!isUuid(id)) return failResult('That is not a group reference.');
    const written = String(reason || '').trim();
    if (!written) return failResult('Retiring an access group needs a written reason.');
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      UPDATE tal_access_group SET is_active = FALSE WHERE id = ${id} AND is_active RETURNING id`));
    if (rows.length === 0) return failResult('That group is already retired, or no longer exists.');
    const retired = rowsOf(await db.execute(sql`
      UPDATE tal_access_policy
         SET is_active = FALSE, changed_by = ${isUuid(actorUserId) ? actorUserId : null},
             change_reason = ${'Group retired: ' + written}
       WHERE access_group_id = ${id} AND is_active
      RETURNING id`));
    return okResult({ policiesRetired: retired.length });
  } catch (e: any) {
    console.error('[talent-access] deactivateAccessGroup: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

// ---------------------------------------------------------------------------------------------
// POLICY — versioned and retired, never deleted.
// ---------------------------------------------------------------------------------------------

export interface PolicyRow extends AccessPolicy {
  groupKey: string;
  groupName: string;
  groupClassification: AccessClassification;
  groupCapabilities: string[];
  groupIsActive: boolean;
  changedByName: string;
  createdAt: string;
}

const POLICY_COLUMNS = 'id, subject_kind, subject_key, access_group_id, version, is_active, changed_by, change_reason, created_at';

function toPolicy(x: any): PolicyRow {
  return {
    id: String(x.id),
    subjectKind: String(x.subject_kind) as PolicyRow['subjectKind'],
    subjectKey: String(x.subject_key || ''),
    accessGroupId: String(x.access_group_id),
    version: Number(x.version || 1),
    isActive: x.is_active !== false,
    changeReason: x.change_reason ? String(x.change_reason) : null,
    groupKey: String(x.group_key || ''),
    groupName: String(x.group_name || ''),
    groupClassification: String(x.group_classification || 'internal') as AccessClassification,
    groupCapabilities: jsonArray(x.group_capabilities),
    groupIsActive: x.group_is_active !== false,
    changedByName: String(x.changed_by_name || ''),
    createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
  };
}

/** RETHROWS. An unreadable policy set must not render as "no policy exists". */
export async function listPolicies(filter: { subjectKind?: string; includeRetired?: boolean } = {}): Promise<PolicyRow[]> {
  try {
    const { db, sql } = await ctx();
    const kind = filter.subjectKind && (SUBJECT_KINDS as readonly string[]).includes(filter.subjectKind)
      ? filter.subjectKind : null;
    const includeRetired = filter.includeRetired === true;
    const rows = rowsOf(await db.execute(sql`
      SELECT p.id, p.subject_kind, p.subject_key, p.access_group_id, p.version, p.is_active,
             p.changed_by, p.change_reason, p.created_at,
             COALESCE(g.key, '')            AS group_key,
             COALESCE(g.name, '')           AS group_name,
             COALESCE(g.classification, '') AS group_classification,
             COALESCE(g.capabilities, '[]'::jsonb) AS group_capabilities,
             COALESCE(g.is_active, FALSE)   AS group_is_active,
             COALESCE(u.name, '')           AS changed_by_name
        FROM tal_access_policy p
        LEFT JOIN tal_access_group g ON g.id = p.access_group_id
        LEFT JOIN users u            ON u.id = p.changed_by
       WHERE (${includeRetired}::boolean OR p.is_active)
         AND (${kind}::text IS NULL OR p.subject_kind = ${kind})
       ORDER BY p.is_active DESC, p.subject_kind ASC, p.subject_key ASC, p.version DESC
       LIMIT 500`));
    return rows.map(toPolicy);
  } catch (e: any) {
    console.error('[talent-access] listPolicies: ' + reasonOf(e));
    throw e;
  }
}

/**
 * Add a policy row. The version is one past the highest this subject and group have ever held, so a
 * retired row and its replacement coexist and the history reads in order — the partial unique index
 * covers ACTIVE rows only, which is exactly what makes that possible.
 */
export async function addPolicy(
  subjectKind: string,
  subjectKey: string,
  groupId: string,
  reason: string,
  actorUserId: string,
): Promise<TalentResult<{ id: string; version: number }>> {
  try {
    if (!isUuid(groupId)) return failResult('That is not a group reference.');
    const written = String(reason || '').trim();
    if (!written) return failResult('A policy needs a written reason. It is the answer to "why does this department reach that?".');

    const cat = await catalogue();
    if (!cat) {
      // FAIL CLOSED. Without the catalogue this cannot prove the group carries nothing sensitive,
      // and a policy hands a group to everyone who matches it, now and in future.
      return failResult('The permission catalogue could not be read, so this policy cannot be checked for sensitive capabilities. Nothing was saved.');
    }

    const { db, sql } = await ctx();
    const groups = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(GROUP_COLUMNS)} FROM tal_access_group WHERE id = ${groupId}`));
    const group = groups.length > 0 ? toGroup(groups[0]) : null;

    const key = String(subjectKey || '').trim();
    const problem = policyProblem({
      subjectKind, subjectKey: key,
      group: group
        ? { key: group.key, name: group.name, isActive: group.isActive, classification: group.classification, capabilities: group.capabilities }
        : null,
      sensitiveCapabilities: cat.sensitive,
    });
    if (problem) return failResult(problem);

    const kind = String(subjectKind).trim();
    // identity_type keys are canonical lower case; a department id is TEXT and is stored as typed.
    const storedKey = kind === 'identity_type' ? key.toLowerCase() : key;

    const prior = rowsOf(await db.execute(sql`
      SELECT COALESCE(MAX(version), 0)::int AS v
        FROM tal_access_policy
       WHERE subject_kind = ${kind} AND subject_key = ${storedKey} AND access_group_id = ${groupId}`));
    const version = Number(prior[0]?.v || 0) + 1;

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO tal_access_policy (subject_kind, subject_key, access_group_id, version, is_active, changed_by, change_reason)
      VALUES (${kind}, ${storedKey}, ${groupId}, ${version}, TRUE,
              ${isUuid(actorUserId) ? actorUserId : null}, ${written})
      ON CONFLICT (subject_kind, subject_key, access_group_id) WHERE is_active DO NOTHING
      RETURNING id, version`));
    if (rows.length === 0) {
      return failResult('That policy is already active. Retire the existing row first if you are replacing it.');
    }
    return okResult({ id: String(rows[0].id), version });
  } catch (e: any) {
    console.error('[talent-access] addPolicy: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

/** Retire a policy. Never a DELETE: the row stays, is_active goes false, and the reason is recorded. */
export async function retirePolicy(id: string, reason: string, actorUserId: string): Promise<TalentResult> {
  try {
    if (!isUuid(id)) return failResult('That is not a policy reference.');
    const written = String(reason || '').trim();
    if (!written) return failResult('Retiring a policy needs a written reason.');
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      UPDATE tal_access_policy
         SET is_active = FALSE, changed_by = ${isUuid(actorUserId) ? actorUserId : null}, change_reason = ${written}
       WHERE id = ${id} AND is_active
      RETURNING id`));
    if (rows.length === 0) return failResult('That policy was already retired, or no longer exists.');
    return okResult();
  } catch (e: any) {
    console.error('[talent-access] retirePolicy: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

// ---------------------------------------------------------------------------------------------
// LOOKUP — what one identity derives to, and why.
// ---------------------------------------------------------------------------------------------

export interface IdentityBrief {
  id: string;
  identityCode: string;
  identityType: string;
  departmentId: string | null;
  positionId: string | null;
  status: IdentityStatus;
  personName: string;
  personCode: string;
  workEmail: string;
}

export interface CachedAccessRow {
  id: string;
  accessGroupId: string;
  source: string;
  reason: string | null;
  validUntil: string | null;
  grantedByName: string;
  createdAt: string;
}

export interface IdentityAccessView {
  identity: IdentityBrief;
  derivation: AccessDerivation;
  drift: AccessDrift;
  cached: CachedAccessRow[];
  /** Every group, active or retired, so a reason always has a name and a classification beside it. */
  groups: AccessGroup[];
}

function toIdentity(x: any): IdentityBrief {
  return {
    id: String(x.id),
    identityCode: String(x.identity_code || ''),
    identityType: String(x.identity_type || ''),
    departmentId: x.department_id ? String(x.department_id) : null,
    positionId: x.position_id ? String(x.position_id) : null,
    status: String(x.status || 'active') as IdentityStatus,
    personName: String(x.person_name || ''),
    personCode: String(x.person_code || ''),
    workEmail: String(x.work_email || ''),
  };
}

/** RETHROWS. An unreadable search must not render as "nobody matches". */
export async function lookupIdentities(q: string, limit = 10): Promise<IdentityBrief[]> {
  try {
    const term = String(q || '').trim();
    if (!term) return [];
    const { db, sql } = await ctx();
    // LIKE metacharacters escaped, so a per-cent sign does not silently become a match-everything
    // scan — which on a search box reads as "the filter is broken".
    const like = '%' + term.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const n = Math.min(50, Math.max(1, Number(limit) || 10));
    const rows = rowsOf(await db.execute(sql`
      SELECT i.id, i.identity_code, i.identity_type, i.department_id, i.position_id, i.status,
             COALESCE(i.work_email, '')    AS work_email,
             COALESCE(p.display_name, '')  AS person_name,
             COALESCE(p.person_code, '')   AS person_code
        FROM tal_identity i
        LEFT JOIN tal_person p ON p.id = i.person_id
       WHERE i.identity_code ILIKE ${like}
          OR i.work_email ILIKE ${like}
          OR p.display_name ILIKE ${like}
          OR p.person_code ILIKE ${like}
          OR p.primary_email ILIKE ${like}
       ORDER BY i.identity_code ASC
       LIMIT ${n}`));
    return rows.map(toIdentity);
  } catch (e: any) {
    console.error('[talent-access] lookupIdentities: ' + reasonOf(e));
    throw e;
  }
}

/**
 * The whole answer for one identity: what it derives to, why, what the cache thinks, and where the
 * two disagree.
 *
 * IT DOES NOT WRITE. A page render is a read, and reconciling the cache on a GET would make loading
 * a screen change the system. Reconciliation is a job; this shows what a job would find.
 *
 * RETHROWS. Returns null only when the identity genuinely does not exist.
 */
export async function accessForIdentity(identityId: string): Promise<IdentityAccessView | null> {
  try {
    if (!isUuid(identityId)) return null;
    const { db, sql } = await ctx();
    const idRows = rowsOf(await db.execute(sql`
      SELECT i.id, i.identity_code, i.identity_type, i.department_id, i.position_id, i.status,
             COALESCE(i.work_email, '')   AS work_email,
             COALESCE(p.display_name, '') AS person_name,
             COALESCE(p.person_code, '')  AS person_code
        FROM tal_identity i
        LEFT JOIN tal_person p ON p.id = i.person_id
       WHERE i.id = ${identityId}`));
    if (idRows.length === 0) return null;
    const identity = toIdentity(idRows[0]);

    // EVERY active policy is loaded and the PURE function does the matching. That is the point of a
    // pure derivation: the SQL does not get a second, subtly different copy of the rules.
    const policyRows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(POLICY_COLUMNS)} FROM tal_access_policy WHERE is_active LIMIT 2000`));
    const policies: DerivablePolicy[] = policyRows.map((x: any) => ({
      id: String(x.id),
      subjectKind: String(x.subject_kind || ''),
      subjectKey: String(x.subject_key || ''),
      accessGroupId: String(x.access_group_id || ''),
      version: Number(x.version || 1),
      isActive: x.is_active !== false,
    }));

    const cacheRows = rowsOf(await db.execute(sql`
      SELECT a.id, a.access_group_id, a.source, a.reason, a.valid_until, a.created_at,
             COALESCE(u.name, '') AS granted_by_name
        FROM tal_identity_access a
        LEFT JOIN users u ON u.id = a.granted_by
       WHERE a.identity_id = ${identityId}
       ORDER BY a.created_at DESC
       LIMIT 500`));
    const cached: CachedAccessRow[] = cacheRows.map((x: any) => ({
      id: String(x.id),
      accessGroupId: String(x.access_group_id),
      source: String(x.source || ''),
      reason: x.reason ? String(x.reason) : null,
      validUntil: x.valid_until ? new Date(x.valid_until).toISOString() : null,
      grantedByName: String(x.granted_by_name || ''),
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
    }));

    // The exception rows are the only part of the cache the derivation READS BACK, because an
    // exception has nowhere else to live. Everything else is recomputed from policy.
    const manual: DerivableGrant[] = cached
      .filter((c) => c.source === 'manual' || c.source === 'request')
      .map((c) => ({ id: c.id, accessGroupId: c.accessGroupId, source: c.source, reason: c.reason, validUntil: c.validUntil }));

    const derivation = deriveAccess(identity, policies, manual, new Date());
    const drift = diffAccess(derivation.reasons, cached);
    const groups = await listAccessGroups(true);
    return { identity, derivation, drift, cached, groups };
  } catch (e: any) {
    console.error('[talent-access] accessForIdentity: ' + reasonOf(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// EXCEPTIONS — manual grants. The audit row is the control, so it is written or the grant is undone.
// ---------------------------------------------------------------------------------------------

/**
 * Grant one group to one identity as a time-bounded exception.
 *
 * THE AUDIT ROW IS THE CONTROL (spec 23: permission.granted goes through logAuditOrThrow "because
 * the audit row is the control"). If it cannot be written, the grant is UNDONE — restored to exactly
 * what was there before, an extension included — and the caller is told. A grant nobody can see is
 * worse than a grant that failed, because only one of the two is discoverable later.
 */
export async function grantManual(
  identityId: string,
  groupId: string,
  untilIso: string,
  reason: string,
  actorUserId: string,
): Promise<TalentResult<{ extended: boolean; gatedNow: boolean; statusLabel: string }>> {
  try {
    if (!isUuid(identityId)) return failResult('That is not an identity reference.');
    if (!isUuid(groupId)) return failResult('That is not a group reference.');
    const written = String(reason || '').trim();
    if (!written) return failResult('A manual grant needs a written reason. It is an exception, and an exception has to be explainable.');
    const windowProblem = grantWindowProblem(untilIso, new Date());
    if (windowProblem) return failResult(windowProblem);

    const { db, sql } = await ctx();
    const groups = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(GROUP_COLUMNS)} FROM tal_access_group WHERE id = ${groupId}`));
    if (groups.length === 0) return failResult('That access group does not exist.');
    const group = toGroup(groups[0]);
    if (!group.isActive) return failResult('That access group has been retired and may not be granted.');

    const identities = rowsOf(await db.execute(sql`
      SELECT id, identity_code, status FROM tal_identity WHERE id = ${identityId}`));
    if (identities.length === 0) return failResult('That identity does not exist.');
    const identityCode = String(identities[0].identity_code || '');
    const identityStatus = String(identities[0].status || '') as IdentityStatus;

    // granted_by IS READ BACK TOO, and that is not padding. The upsert below overwrites it with the
    // current actor, so an undo that restored only the window and the reason would leave the row
    // saying this administrator granted an exception somebody else granted — while the audit row
    // that would have corrected the record is precisely the one that failed to write. "Restored to
    // exactly what was there before" has to include who put it there.
    const existingRows = rowsOf(await db.execute(sql`
      SELECT id, valid_until, reason, granted_by FROM tal_identity_access
       WHERE identity_id = ${identityId} AND access_group_id = ${groupId} AND source = 'manual'`));
    const previous = existingRows.length > 0
      ? {
          id: String(existingRows[0].id),
          validUntil: existingRows[0].valid_until ? new Date(existingRows[0].valid_until).toISOString() : null,
          reason: existingRows[0].reason ? String(existingRows[0].reason) : null,
          grantedBy: existingRows[0].granted_by ? String(existingRows[0].granted_by) : null,
        }
      : null;

    await db.execute(sql`
      INSERT INTO tal_identity_access (identity_id, access_group_id, source, granted_by, reason, valid_until)
      VALUES (${identityId}, ${groupId}, 'manual', ${isUuid(actorUserId) ? actorUserId : null}, ${written}, ${untilIso}::timestamptz)
      ON CONFLICT (identity_id, access_group_id, source)
      DO UPDATE SET granted_by = EXCLUDED.granted_by, reason = EXCLUDED.reason, valid_until = EXCLUDED.valid_until`);

    try {
      const { logAuditOrThrow } = await import('@/lib/audit');
      await logAuditOrThrow({
        userId: actorUserId,
        action: 'permission.granted',
        entity: 'tal_identity_access',
        entityId: identityId,
        diff: {
          identityCode, accessGroup: group.key, classification: group.classification,
          capabilities: group.capabilities, source: 'manual', validUntil: untilIso, reason: written,
          extended: !!previous, identityStatus,
        },
      });
    } catch (auditError: any) {
      // UNDO. Restore the previous window exactly, or remove a row that did not exist before.
      try {
        if (previous) {
          await db.execute(sql`
            UPDATE tal_identity_access
               SET valid_until = ${previous.validUntil}::timestamptz,
                   reason = ${previous.reason},
                   granted_by = ${previous.grantedBy}::uuid
             WHERE id = ${previous.id}`);
        } else {
          await db.execute(sql`
            DELETE FROM tal_identity_access
             WHERE identity_id = ${identityId} AND access_group_id = ${groupId} AND source = 'manual'`);
        }
      } catch (undoError: any) {
        return failResult(
          'The grant could not be written to the audit log (' + reasonOf(auditError) + ') AND could not be undone ('
          + reasonOf(undoError) + '). Check this identity on the lookup before doing anything else.');
      }
      return failResult('The grant was undone: it could not be written to the audit log (' + reasonOf(auditError) + ').');
    }

    // THE ROW IS WRITTEN; WHETHER IT IS ACCESS IS A DIFFERENT QUESTION, AND THE CALLER IS TOLD.
    //
    // A grant is deliberately allowed against a non-active identity: an administrator preparing a
    // reinstatement should be able to write the exception before the status changes. What must not
    // happen is the screen answering "Exception granted" and stopping there, because status is the
    // FIRST term of the derivation — the person reaches nothing today, and an operator who believed
    // otherwise would tell them their access is restored and stop looking.
    const gatedNow = !statusGrantsAccess(identityStatus);
    const statusLabel = IDENTITY_STATUS_LABELS[identityStatus] || String(identityStatus);
    return okResult({ extended: !!previous, gatedNow, statusLabel });
  } catch (e: any) {
    console.error('[talent-access] grantManual: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

/**
 * Withdraw an exception.
 *
 * A DELETE, and deliberately: tal_identity_access is a cache with no revoked_at column, so the row
 * has nowhere to record its own withdrawal. The audit log is the record — which is why this, like
 * the grant, is undone when the audit row cannot be written.
 */
export async function revokeManual(rowId: string, actorUserId: string): Promise<TalentResult> {
  try {
    if (!isUuid(rowId)) return failResult('That is not a grant reference.');
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM tal_identity_access
       WHERE id = ${rowId} AND source IN ('manual', 'request')
      RETURNING id, identity_id, access_group_id, source, granted_by, reason, valid_until`));
    if (rows.length === 0) {
      return failResult('That exception is already gone, or it is a derived row rather than an exception. A derived row is removed by retiring the policy behind it.');
    }
    const gone = rows[0];
    try {
      const { logAuditOrThrow } = await import('@/lib/audit');
      await logAuditOrThrow({
        userId: actorUserId,
        action: 'permission.revoked',
        entity: 'tal_identity_access',
        entityId: String(gone.identity_id),
        diff: {
          accessGroupId: String(gone.access_group_id), source: String(gone.source),
          reason: gone.reason ? String(gone.reason) : null,
          validUntil: gone.valid_until ? new Date(gone.valid_until).toISOString() : null,
        },
      });
    } catch (auditError: any) {
      try {
        await db.execute(sql`
          INSERT INTO tal_identity_access (id, identity_id, access_group_id, source, granted_by, reason, valid_until)
          VALUES (${String(gone.id)}, ${String(gone.identity_id)}, ${String(gone.access_group_id)},
                  ${String(gone.source)}, ${gone.granted_by ? String(gone.granted_by) : null},
                  ${gone.reason ? String(gone.reason) : null},
                  ${gone.valid_until ? new Date(gone.valid_until).toISOString() : null}::timestamptz)`);
      } catch (undoError: any) {
        return failResult(
          'The exception was removed but could not be written to the audit log (' + reasonOf(auditError)
          + '), and putting it back failed too (' + reasonOf(undoError) + '). The access is gone and the record of it is not.');
      }
      return failResult('The withdrawal was undone: it could not be written to the audit log (' + reasonOf(auditError) + ').');
    }
    return okResult();
  } catch (e: any) {
    console.error('[talent-access] revokeManual: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

// ---------------------------------------------------------------------------------------------
// ACCESS REQUESTS
// ---------------------------------------------------------------------------------------------

export interface AccessRequestRow {
  id: string;
  identityId: string;
  identityCode: string;
  personName: string;
  accessGroupId: string;
  groupKey: string;
  groupName: string;
  groupClassification: AccessClassification;
  groupCapabilities: string[];
  reason: string;
  requestedUntil: string | null;
  status: AccessRequestStatus;
  managerDecision: any;
  departmentDecision: any;
  securityDecision: any;
  createdAt: string;
  decidedAt: string | null;
}

/** RETHROWS. An unreadable queue must not render as "nobody is waiting". */
export async function listAccessRequests(status = 'open', limit = 100): Promise<AccessRequestRow[]> {
  try {
    const { db, sql } = await ctx();
    const n = Math.min(200, Math.max(1, Number(limit) || 100));
    const open = status === 'open';
    const exact = !open && status !== 'all' ? String(status) : null;
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id, r.identity_id, r.access_group_id, r.reason, r.requested_until, r.status,
             r.manager_decision, r.department_decision, r.security_decision, r.created_at, r.decided_at,
             COALESCE(i.identity_code, '')  AS identity_code,
             COALESCE(p.display_name, '')   AS person_name,
             COALESCE(g.key, '')            AS group_key,
             COALESCE(g.name, '')           AS group_name,
             COALESCE(g.classification, '') AS group_classification,
             COALESCE(g.capabilities, '[]'::jsonb) AS group_capabilities
        FROM tal_access_request r
        LEFT JOIN tal_identity i     ON i.id = r.identity_id
        LEFT JOIN tal_person p       ON p.id = i.person_id
        LEFT JOIN tal_access_group g ON g.id = r.access_group_id
       WHERE (${exact}::text IS NULL OR r.status = ${exact})
         AND (NOT ${open}::boolean OR r.status IN ('pending', 'manager', 'department', 'security'))
       ORDER BY r.created_at DESC
       LIMIT ${n}`));
    return rows.map((x: any) => ({
      id: String(x.id),
      identityId: String(x.identity_id),
      identityCode: String(x.identity_code || ''),
      personName: String(x.person_name || ''),
      accessGroupId: String(x.access_group_id),
      groupKey: String(x.group_key || ''),
      groupName: String(x.group_name || ''),
      groupClassification: String(x.group_classification || 'internal') as AccessClassification,
      groupCapabilities: jsonArray(x.group_capabilities),
      reason: String(x.reason || ''),
      requestedUntil: x.requested_until ? new Date(x.requested_until).toISOString() : null,
      status: String(x.status || 'pending') as AccessRequestStatus,
      managerDecision: x.manager_decision || null,
      departmentDecision: x.department_decision || null,
      securityDecision: x.security_decision || null,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
      decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : null,
    }));
  } catch (e: any) {
    console.error('[talent-access] listAccessRequests: ' + reasonOf(e));
    throw e;
  }
}

/**
 * Record one step of a decision on an access request.
 *
 * On the final approval the exception is materialised into tal_identity_access with source
 * 'request', so it appears on the lookup with its own reason and its own expiry, and expires like
 * any other exception. The window is the requested one, capped and defaulted by the same rules a
 * manual grant obeys — a request cannot buy a longer exception than an administrator can grant.
 */
export async function decideAccessRequest(
  id: string,
  decision: RequestDecision,
  actorUserId: string,
  note: string,
): Promise<TalentResult<{ status: AccessRequestStatus; granted: boolean; auditProblem: string | null }>> {
  try {
    if (!isUuid(id)) return failResult('That is not a request reference.');
    if (decision !== 'approve' && decision !== 'reject') return failResult('A decision is approve or reject.');
    const written = String(note || '').trim();
    if (!written) return failResult('A decision on an access request needs a written note. It is the record of why.');

    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id, r.identity_id, r.access_group_id, r.status, r.reason, r.requested_until,
             COALESCE(g.classification, '') AS classification,
             COALESCE(g.is_active, FALSE)   AS group_active,
             COALESCE(g.key, '')            AS group_key
        FROM tal_access_request r
        LEFT JOIN tal_access_group g ON g.id = r.access_group_id
       WHERE r.id = ${id}`));
    if (rows.length === 0) return failResult('That request no longer exists.');
    const r = rows[0];
    const classification = String(r.classification || 'internal');

    const step = advanceRequest(String(r.status || ''), decision, classification);
    if (!step.ok || !step.next || !step.stage) return failResult(step.problem || 'That request cannot move.');

    if (step.next === 'approved' && r.group_active !== true) {
      return failResult('That access group has been retired, so this request cannot be approved. Refuse it, or restore the group first.');
    }

    const payload = JSON.stringify({ decision, note: written, by: actorUserId, at: new Date().toISOString() });
    const terminal = step.terminal === true;
    const column = step.stage === 'manager' ? 'manager_decision'
      : step.stage === 'department' ? 'department_decision' : 'security_decision';

    await db.execute(sql`
      UPDATE tal_access_request
         SET status = ${String(step.next)},
             ${sql.raw(column)} = ${payload}::jsonb,
             decided_at = ${terminal ? new Date().toISOString() : null}::timestamptz
       WHERE id = ${id}`);

    let granted = false;
    let auditProblem: string | null = null;
    if (step.next === 'approved') {
      const requested = r.requested_until ? new Date(r.requested_until).toISOString() : null;
      const fallback = defaultGrantUntil(new Date());
      const until = requested && !grantWindowProblem(requested, new Date()) ? requested : fallback;
      await db.execute(sql`
        INSERT INTO tal_identity_access (identity_id, access_group_id, source, granted_by, reason, valid_until)
        VALUES (${String(r.identity_id)}, ${String(r.access_group_id)}, 'request',
                ${isUuid(actorUserId) ? actorUserId : null},
                ${'Access request approved: ' + written}, ${until}::timestamptz)
        ON CONFLICT (identity_id, access_group_id, source)
        DO UPDATE SET granted_by = EXCLUDED.granted_by, reason = EXCLUDED.reason, valid_until = EXCLUDED.valid_until`);
      granted = true;

      // THIS IS A permission.granted, AND IT GETS THE SAME AUDIT ROW A HAND GRANT GETS.
      //
      // The surface writes access.request.decided for the DECISION, which records the note and the
      // new status and nothing about the access itself — not the group, not the classification, not
      // the window. Approving the last step hands somebody a capability, and an audit trail where
      // the only permission.granted rows are the ones an administrator typed by hand describes half
      // the grants on the system while reading as though it described all of them.
      //
      // NOT logAuditOrThrow, and not an undo. Unlike grantManual this is the tail of a multi-row
      // state change that is already committed and already audited: rolling the grant back would
      // leave a request marked approved with no access behind it, which is a worse record than an
      // approved request with a missing audit line. So the write is attempted, and if it fails the
      // caller is TOLD rather than shown an unqualified success.
      try {
        const { logAudit } = await import('@/lib/audit');
        const audited = await logAudit({
          userId: actorUserId,
          action: 'permission.granted',
          entity: 'tal_identity_access',
          entityId: String(r.identity_id),
          diff: {
            accessGroupId: String(r.access_group_id), accessGroup: String(r.group_key || ''),
            classification, source: 'request', validUntil: until,
            reason: 'Access request approved: ' + written, accessRequestId: id,
          },
        });
        if (!audited?.ok) auditProblem = String(audited?.error || 'unknown reason');
      } catch (e: any) {
        auditProblem = reasonOf(e);
      }
      if (auditProblem) console.error('[talent-access] permission.granted audit failed: ' + auditProblem);
    }
    return okResult({ status: step.next, granted, auditProblem });
  } catch (e: any) {
    console.error('[talent-access] decideAccessRequest: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}

// ---------------------------------------------------------------------------------------------
// PROVISIONING RUNS — proposals, reviewed by a human, provisioned by a human.
// ---------------------------------------------------------------------------------------------

export interface ProvisioningRunRow {
  id: string;
  identityId: string;
  identityCode: string;
  personName: string;
  trigger: string;
  proposed: any[];
  diff: Record<string, any>;
  status: ProvisioningStatus;
  reviewedByName: string;
  reviewedAt: string | null;
  completedAt: string | null;
  failures: any[];
  createdAt: string;
}

/** RETHROWS. An unreadable queue must not render as "nothing is waiting for review". */
export async function listProvisioningRuns(status = 'open', limit = 100): Promise<ProvisioningRunRow[]> {
  try {
    const { db, sql } = await ctx();
    const n = Math.min(200, Math.max(1, Number(limit) || 100));
    const open = status === 'open';
    const exact = !open && status !== 'all' ? String(status) : null;
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id, r.identity_id, r.trigger, r.proposed, r.diff, r.status,
             r.reviewed_at, r.completed_at, r.failures, r.created_at,
             COALESCE(i.identity_code, '') AS identity_code,
             COALESCE(p.display_name, '')  AS person_name,
             COALESCE(u.name, '')          AS reviewed_by_name
        FROM tal_provisioning_run r
        LEFT JOIN tal_identity i ON i.id = r.identity_id
        LEFT JOIN tal_person p   ON p.id = i.person_id
        LEFT JOIN users u        ON u.id = r.reviewed_by
       WHERE (${exact}::text IS NULL OR r.status = ${exact})
         AND (NOT ${open}::boolean OR r.status IN ('proposed', 'awaiting_review'))
       ORDER BY r.created_at DESC
       LIMIT ${n}`));
    return rows.map((x: any) => ({
      id: String(x.id),
      identityId: String(x.identity_id),
      identityCode: String(x.identity_code || ''),
      personName: String(x.person_name || ''),
      trigger: String(x.trigger || ''),
      proposed: Array.isArray(x.proposed) ? x.proposed : [],
      diff: (x.diff && typeof x.diff === 'object') ? x.diff : {},
      status: String(x.status || 'proposed') as ProvisioningStatus,
      reviewedByName: String(x.reviewed_by_name || ''),
      reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
      completedAt: x.completed_at ? new Date(x.completed_at).toISOString() : null,
      failures: Array.isArray(x.failures) ? x.failures : [],
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : '',
    }));
  } catch (e: any) {
    console.error('[talent-access] listProvisioningRuns: ' + reasonOf(e));
    throw e;
  }
}

/**
 * Record a review decision on a proposed run. See reviewOutcome() for why a decline is stored as
 * 'failed' with a marker, and for what 'approved' does and does not mean.
 */
export async function reviewProvisioningRun(
  id: string,
  decision: ReviewDecision,
  actorUserId: string,
  note = '',
): Promise<TalentResult<{ status: ProvisioningStatus }>> {
  try {
    if (!isUuid(id)) return failResult('That is not a run reference.');
    if (decision !== 'approve' && decision !== 'decline') return failResult('A review is approve or decline.');
    const written = String(note || '').trim();
    if (decision === 'decline' && !written) return failResult('Declining a proposed run needs a written reason.');

    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, status, failures FROM tal_provisioning_run WHERE id = ${id}`));
    if (rows.length === 0) return failResult('That run no longer exists.');
    const outcome = reviewOutcome(String(rows[0].status || ''), decision);
    if (!outcome.ok || !outcome.next) return failResult(outcome.problem || 'That run cannot be reviewed.');

    const priorFailures = Array.isArray(rows[0].failures) ? rows[0].failures : [];
    const failures = outcome.declined
      ? priorFailures.concat([{ kind: 'declined_at_review', reason: written, by: actorUserId, at: new Date().toISOString() }])
      : priorFailures;

    await db.execute(sql`
      UPDATE tal_provisioning_run
         SET status = ${String(outcome.next)},
             reviewed_by = ${isUuid(actorUserId) ? actorUserId : null},
             reviewed_at = NOW(),
             failures = ${JSON.stringify(failures)}::jsonb
       WHERE id = ${id}`);
    return okResult({ status: outcome.next });
  } catch (e: any) {
    console.error('[talent-access] reviewProvisioningRun: ' + reasonOf(e));
    return failResult(reasonOf(e));
  }
}
