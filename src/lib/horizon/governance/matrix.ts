// src/lib/horizon/governance/matrix.ts — THE PERMISSION MATRIX AND THE PURPOSE CATALOGUE.
// All of it is DATA, and every function here is PURE.
//
// =================================================================================================
// WHAT THIS FILE IS FOR, IN ONE SENTENCE
// =================================================================================================
//
// It is the BRIDGE between the two things this system already had and could not connect: the
// permission registry, which knows what a person holds, and src/lib/horizon/visibility.ts, which
// knows what each AUDIENCE may see.
//
// visibility.ts asks its caller for an audience — `hr_operations`, `auditor`, `reviewer_panel` — and
// takes it on trust. Nothing decided who was entitled to claim one. So the gate could be given
// `auditor` by any screen that felt like it, and the field-level rules underneath, which are correct
// and well tested, would faithfully serve an auditor's view to whoever asked. That is the hole this
// file closes: an audience is now a CAPABILITY, resolved from the permission registry, and it is
// narrowed further by the PURPOSE the reader stated.
//
// =================================================================================================
// WHY THIS IS NOT A FOURTH RBAC
// =================================================================================================
//
// This project has three authorisation surfaces and they are deliberately separate:
//
//   src/lib/auth/permissions.ts   the built-in role -> permission matrix. can(). Code, no database.
//   src/lib/auth/registry.ts      the catalogue + custom roles. resolvePermissions(). Admin-editable.
//   src/lib/rbac/*                the AquinTutor kernel capability engine. A different surface.
//
// registry.ts says in its own header that it EXTENDS what exists rather than replacing it. This
// module holds the same line: it declares HORIZON's permission KEYS and what each one means, and
// every runtime test resolves them through resolvePermissions(). There is no second resolver here
// and there must never be one.
//
// WHAT IS DELIBERATELY ABSENT. No field-level redaction — visibility.ts owns that and does it well.
// No signal weighting — contracts.ts owns SignalWeightClass and `outranks`, which is where brief
// rule 22 is expressed. An earlier draft of this file had both, before it had read the tree; a
// second copy of a redaction rule is how a field ends up hidden on one screen and not the next.
import type { HorizonAudience } from '@/lib/horizon/visibility';
import type { ImpactLevel, Purpose } from './types';

// ---------------------------------------------------------------------------------------------
// 1. THE PERMISSION MATRIX
// ---------------------------------------------------------------------------------------------

export interface GovernancePermissionMeta {
  key: string;
  label: string;
  group: string;
  description: string;
  /** Granting it must be provably on the record — the registry refuses an unaudited grant. */
  sensitive: boolean;
  /**
   * THE WILDCARD DOES NOT SATISFY THIS KEY.
   *
   * resolvePermissions() gives `super_admin` the WILDCARD, so holdsPermission() answers true for
   * every key in the system including ones nobody has ever granted. That is the right default for an
   * admin console and the wrong default for two things here: the interpretive layer, and one
   * person's attributed feedback. Both are readable only by somebody a named human granted the key
   * to by name, and "I am the founder" is not that grant.
   *
   * Enforced in holdsGovernancePermission() below, which is the ONLY membership test this layer
   * uses. It is a narrowing applied inside this patch to keys this patch defines; it changes nothing
   * for any existing permission or any existing caller of registry.holdsPermission().
   */
  explicitGrantOnly: boolean;
}

const P = (
  key: string,
  label: string,
  group: string,
  description: string,
  opts: { sensitive?: boolean; explicitGrantOnly?: boolean } = {},
): GovernancePermissionMeta => ({
  key, label, group, description,
  sensitive: opts.sensitive === true,
  explicitGrantOnly: opts.explicitGrantOnly === true,
});

/**
 * Every permission key this layer defines. Lowercase dotted words, which is the shape registry.ts
 * validates with PERMISSION_KEY_RE — a key that does not match is refused at registration, so the
 * shape is a gate rather than a convention.
 *
 * They are NOT added to the `Permission` union in src/lib/auth/permissions.ts. That union is the
 * built-in matrix; changing it is a code change and a deploy, and the registry exists precisely so
 * new capabilities need neither. They are published into permission_catalogue by a named human
 * (publishGovernancePermissions in publish.ts) and granted from /admin/team/roles like anything else.
 */
export const HORIZON_PERMISSIONS: GovernancePermissionMeta[] = [
  // ---- who may act as which audience ---------------------------------------------------------
  P('horizon.read.operations', 'Read records as HR operations', 'HORIZON',
    'Open a person\'s intelligence record with the HR operations view. Requires a stated purpose, and every read is logged.',
    { sensitive: true }),
  P('horizon.read.leadership', 'Read records as HR leadership', 'HORIZON',
    'The HR operations view plus fields classed as sensitive personal data.',
    { sensitive: true }),
  P('horizon.read.panel', 'Read records as a review panel', 'HORIZON',
    'The narrowest view: what a panel needs to assess somebody, and nothing else.'),
  P('horizon.read.audit', 'Read records as an auditor', 'HORIZON',
    'The only view that includes the machinery — which engine ran, on what, with what weights. Never sensitive personal data.',
    { sensitive: true }),

  // ---- the intelligence layer ------------------------------------------------------------------
  P('horizon.intelligence.view', 'See intelligence outputs', 'HORIZON',
    'See results and signals with their evidence, confidence and engine version.'),
  P('horizon.recommendation.decide', 'Record a human decision', 'HORIZON',
    'Accept, reject, modify or defer what the system suggested. A high-impact case cannot close without this.',
    { sensitive: true }),

  // ---- feedback ------------------------------------------------------------------------------
  P('horizon.feedback.view.aggregate', 'See aggregated feedback', 'HORIZON',
    'See feedback about a person as an aggregate, with disagreement and outliers shown.'),
  P('horizon.feedback.view.attributed', 'See who said what', 'HORIZON',
    'See individual, attributed feedback rather than the aggregate. Explicit grant only.',
    { sensitive: true, explicitGrantOnly: true }),

  // ---- the interpretive layer (brief rules 19-22) --------------------------------------------
  P('horizon.interpretive.view', 'See interpretive profile output', 'HORIZON',
    'See the professional interpretation layer. Advisory only, and it may never outweigh demonstrated evidence.',
    { sensitive: true, explicitGrantOnly: true }),
  P('horizon.interpretive.internals', 'See interpretive method detail', 'HORIZON',
    'See the underlying traditional computational input separately from its professional interpretation. Explicit grant only.',
    { sensitive: true, explicitGrantOnly: true }),

  // ---- governance itself ---------------------------------------------------------------------
  P('horizon.governance.view', 'Open the governance console', 'HORIZON governance',
    'Open the governance, consent, retention and audit screens.', { sensitive: true }),
  P('horizon.audit.view', 'Read the governance audit trail', 'HORIZON governance',
    'Read who accessed what, when, why, what changed, which engine version was used and what followed.',
    { sensitive: true }),
  P('horizon.audit.export', 'Export the audit trail', 'HORIZON governance',
    'Take the audit trail out as a file, for a regulator or a subject access request.',
    { sensitive: true }),
  P('horizon.consent.view', 'See consent records', 'HORIZON governance',
    'See what each person has consented to, when, and what they have withdrawn.', { sensitive: true }),
  P('horizon.consent.manage', 'Record and withdraw consent', 'HORIZON governance',
    'Record a consent given offline, and action a withdrawal on somebody\'s behalf.', { sensitive: true }),
  P('horizon.version.manage', 'Register engine versions', 'HORIZON governance',
    'Register and retire the engine versions that computation rows resolve against.', { sensitive: true }),
  P('horizon.retention.manage', 'Set retention policy', 'HORIZON governance',
    'Change how long each class of record is kept and what happens when the period ends.', { sensitive: true }),
  P('horizon.erasure.request', 'Request erasure or anonymisation', 'HORIZON governance',
    'Open a request to delete or anonymise a person\'s records.', { sensitive: true }),
  P('horizon.erasure.approve', 'Approve erasure or anonymisation', 'HORIZON governance',
    'Approve somebody else\'s erasure request. Self-approval is refused.', { sensitive: true }),
];

export const HORIZON_PERMISSION_KEYS: string[] = HORIZON_PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map<string, GovernancePermissionMeta>(HORIZON_PERMISSIONS.map((p) => [p.key, p]));

export function governancePermission(key: string): GovernancePermissionMeta | null {
  return BY_KEY.get(key) || null;
}

/** The registry's wildcard, restated rather than imported so this file needs no database-backed import. */
export const WILDCARD_KEY = '*';

/**
 * THE ONLY MEMBERSHIP TEST THIS LAYER USES. Wildcard-aware exactly as registry.holdsPermission() is,
 * EXCEPT for keys marked explicitGrantOnly, which must be present by name.
 */
export function holdsGovernancePermission(permissions: Set<string> | null | undefined, key: string): boolean {
  if (!permissions || !key) return false;
  if (permissions.has(key)) return true;
  if (governancePermission(key)?.explicitGrantOnly) return false;
  return permissions.has(WILDCARD_KEY);
}

// ---------------------------------------------------------------------------------------------
// 2. THE BRIDGE: WHICH AUDIENCE MAY A PERSON CLAIM
// ---------------------------------------------------------------------------------------------

/**
 * The permission that entitles somebody to act as each audience.
 *
 * `self` has no key: you are entitled to your own record by being its subject, and requiring a grant
 * for that would mean a person could be locked out of their own data by an administrator forgetting
 * something.
 *
 * `system` has no key either, and deliberately cannot be claimed by a human at all — see
 * resolveAudience(). An engine computing over inputs is not a person with a session, and the way
 * that stays true is that no permission key maps to it.
 */
export const AUDIENCE_PERMISSION: Readonly<Record<HorizonAudience, string | null>> = Object.freeze({
  self: null,
  system: null,
  // Relationship-scoped audiences: the KEY says the person is the kind of person who can hold this
  // authority; the ORG GRAPH says whether they hold it over THIS person. visibility.authoriseAccess
  // refuses both audiences unless relationshipConfirmed is explicitly true, so a key alone opens
  // nothing. That is the three-layer rule: capabilities resolve per user, relationships per row.
  reporting_manager: 'horizon.read.operations',
  department_head: 'horizon.read.operations',
  reviewer_panel: 'horizon.read.panel',
  hr_operations: 'horizon.read.operations',
  hr_leadership: 'horizon.read.leadership',
  auditor: 'horizon.read.audit',
});

/**
 * Strongest first. `resolveAudience` walks this order and takes the first audience the person is
 * entitled to AND the purpose permits, so somebody holding several keys reads under the most capable
 * view their stated purpose allows rather than whichever the caller happened to name.
 */
const AUDIENCE_STRENGTH: HorizonAudience[] = [
  'auditor', 'hr_leadership', 'hr_operations', 'department_head', 'reporting_manager', 'reviewer_panel',
];

// ---------------------------------------------------------------------------------------------
// 3. THE PURPOSE CATALOGUE
// ---------------------------------------------------------------------------------------------

export interface PurposeMeta {
  purpose: Purpose;
  label: string;
  /** Shown to the person who has to pick one. Written so that picking the wrong one feels wrong. */
  description: string;
  /**
   * The audiences a read under this purpose may be served as. PURPOSE LIMITATION, as a list.
   *
   * Note what workforce planning does NOT include: any audience at all. Planning is an aggregate
   * activity, it is the purpose most likely to be used as a pretext for opening one person's record,
   * and giving it an empty list means it cannot be.
   */
  audiences: HorizonAudience[];
  /** Reading under this purpose requires a live, un-withdrawn consent for it. */
  requiresConsent: boolean;
  /** How long an access under this purpose stays justifiable without being restated. */
  justificationValidDays: number;
}

export const PURPOSES: PurposeMeta[] = [
  {
    purpose: 'employment_administration',
    label: 'Employment administration',
    description: 'Running the employment relationship — records, leave, payroll, statutory returns.',
    audiences: ['hr_operations', 'hr_leadership'],
    requiresConsent: false,
    justificationValidDays: 365,
  },
  {
    purpose: 'performance_review',
    label: 'Performance review',
    description: 'An open review cycle for this person. Not general curiosity about how they are doing.',
    audiences: ['reporting_manager', 'department_head', 'reviewer_panel', 'hr_operations'],
    requiresConsent: false,
    justificationValidDays: 120,
  },
  {
    purpose: 'promotion_assessment',
    label: 'Promotion assessment',
    description: 'An open promotion case. High impact: nothing here decides on its own.',
    audiences: ['department_head', 'reviewer_panel', 'hr_operations', 'hr_leadership'],
    requiresConsent: false,
    justificationValidDays: 90,
  },
  {
    purpose: 'compensation_review',
    label: 'Compensation review',
    description: 'An open compensation decision for this person.',
    audiences: ['hr_leadership'],
    requiresConsent: false,
    justificationValidDays: 90,
  },
  {
    purpose: 'hiring_assessment',
    label: 'Hiring assessment',
    description: 'Assessing a candidate against a role they applied for.',
    audiences: ['reviewer_panel', 'hr_operations'],
    requiresConsent: false,
    justificationValidDays: 180,
  },
  {
    purpose: 'learning_development',
    label: 'Learning and development',
    description: 'Planning training or development for this person. The only purpose that reaches the interpretive layer, and only with their consent.',
    audiences: ['self', 'reporting_manager', 'hr_operations'],
    requiresConsent: true,
    justificationValidDays: 365,
  },
  {
    purpose: 'workforce_planning',
    label: 'Workforce planning',
    description: 'Aggregate planning. This purpose does not open an individual record at all.',
    audiences: [],
    requiresConsent: false,
    justificationValidDays: 180,
  },
  {
    purpose: 'grievance_investigation',
    label: 'Grievance or conduct investigation',
    description: 'A specific, opened matter. Reaches further than any other purpose and is logged accordingly.',
    audiences: ['hr_leadership', 'auditor'],
    requiresConsent: false,
    justificationValidDays: 60,
  },
  {
    purpose: 'legal_or_regulatory',
    label: 'Legal or regulatory obligation',
    description: 'A statutory requirement, a regulator, or an open legal matter.',
    audiences: ['hr_leadership', 'auditor'],
    requiresConsent: false,
    justificationValidDays: 365,
  },
  {
    purpose: 'security_incident',
    label: 'Security incident',
    description: 'An open security incident involving this account.',
    audiences: ['auditor'],
    requiresConsent: false,
    justificationValidDays: 30,
  },
  {
    purpose: 'subject_access_request',
    label: 'Subject access request',
    description: 'The person has asked for their own record. The only purpose where the subject is the beneficiary.',
    audiences: ['self', 'auditor'],
    requiresConsent: false,
    justificationValidDays: 60,
  },
  {
    purpose: 'system_administration',
    label: 'System administration',
    description: 'Keeping the system working. It reaches operational metadata, never a person\'s record.',
    audiences: [],
    requiresConsent: false,
    justificationValidDays: 365,
  },
];

const PURPOSE_BY_KEY = new Map<string, PurposeMeta>(PURPOSES.map((p) => [p.purpose, p]));

export function purposeMeta(purpose: string): PurposeMeta | null {
  return PURPOSE_BY_KEY.get(purpose) || null;
}

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && PURPOSE_BY_KEY.has(value);
}

/** Impact of acting on data read for a purpose. Drives the human-in-the-loop requirement. */
export function impactOfPurpose(purpose: string): ImpactLevel {
  switch (purpose) {
    case 'promotion_assessment':
    case 'compensation_review':
    case 'hiring_assessment':
    case 'grievance_investigation':
      return 'high';
    case 'performance_review':
    case 'learning_development':
      return 'advisory';
    default:
      return 'informational';
  }
}

// ---------------------------------------------------------------------------------------------
// 4. RESOLUTION — PURE, AND THE WHOLE OF THE POLICY
// ---------------------------------------------------------------------------------------------

export interface AudienceResolution {
  /** The audience to hand to visibility.authoriseAccess, or null when the read may not proceed. */
  audience: HorizonAudience | null;
  /** Stated in words a reader can act on, and recorded verbatim in the access log. */
  reason: string;
  /** The permission key the resolution rested on. Answers "under which permission". */
  permission: string | null;
}

/**
 * Which audience may this person be served as, for this stated purpose?
 *
 * THREE THINGS HAPPEN HERE AND EACH ONE CAN ONLY NARROW:
 *
 *   1. An unknown purpose resolves to nothing. Not to a default — to nothing.
 *   2. `self` wins whenever the reader IS the subject and the purpose admits it, ahead of any key
 *      they hold. A manager reading their own record reads it as themselves, which is the narrower
 *      view and the correct one: their authority over other people is not authority over their own
 *      record's machinery.
 *   3. Otherwise the strongest audience that the purpose lists AND the person holds a key for.
 *
 * `system` is unreachable from here by construction. It has no permission key, it appears in no
 * purpose's audience list, and it is filtered out below as well — three times, because an engine
 * audience reachable by a human session would hand out `restricted` to whoever asked.
 */
export function resolveAudience(input: {
  permissions: Set<string> | null | undefined;
  purpose: string;
  isSelf: boolean;
}): AudienceResolution {
  const meta = PURPOSE_BY_KEY.get(input.purpose);
  if (!meta) {
    return { audience: null, permission: null, reason: '"' + input.purpose + '" is not a purpose this system recognises, so there is nothing to authorise against.' };
  }
  if (meta.audiences.length === 0) {
    return { audience: null, permission: null, reason: meta.label + ' does not open an individual record. ' + meta.description };
  }
  if (input.isSelf && meta.audiences.includes('self')) {
    return { audience: 'self', permission: null, reason: 'The reader is the subject.' };
  }
  for (const audience of AUDIENCE_STRENGTH) {
    if (audience === 'system') continue;
    if (!meta.audiences.includes(audience)) continue;
    const key = AUDIENCE_PERMISSION[audience];
    if (!key) continue;
    if (holdsGovernancePermission(input.permissions, key)) {
      return { audience, permission: key, reason: 'Served as ' + audience + ' under ' + key + ' for "' + input.purpose + '".' };
    }
  }
  const wanted = meta.audiences
    .filter((a) => a !== 'self' && a !== 'system')
    .map((a) => AUDIENCE_PERMISSION[a])
    .filter(Boolean);
  return {
    audience: null,
    permission: null,
    reason: wanted.length > 0
      ? 'Reading for "' + input.purpose + '" needs one of: ' + Array.from(new Set(wanted)).join(', ') + '.'
      : 'Nothing entitles this reader to open the record for "' + input.purpose + '".',
  };
}
