// src/lib/horizon/visibility.ts — WHICH FIELDS AN AUDIENCE MAY SEE, AND THE RECORD THAT THEY DID.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md sections 6 and 10.
//
// =================================================================================================
// THIS IS NOT src/lib/horizon/access.ts, AND THE DIFFERENCE IS THE WHOLE POINT
// =================================================================================================
//
// `access.ts` belongs to the profile-console patch and answers WHICH SECTION OF A SCREEN A VIEWER
// MAY OPEN, before anything is read. This module answers the question one level down: given that a
// reader is entitled to open a record at all, WHICH FIELDS OF THE STANDARD OUTPUT reach them. The
// two compose — a section grant decides whether a query runs, a visibility class decides what
// survives the query — and neither one substitutes for the other.
//
// They were briefly the same filename during a concurrent build. They are not the same concern, and
// merging them would have put per-field redaction rules inside a module whose contract is per-tab
// grants, which is how a redaction rule ends up applied on one screen and not the next.
//
// =================================================================================================
// THE SHAPE OF THE ANSWER: ONE RECORD, MANY VIEWS
// =================================================================================================
//
// The core principle of this system is one Master Employee Intelligence Record plus multiple
// role-based views. That only holds if the VIEW is a function of the record and the audience,
// computed in one place, rather than each screen deciding for itself what to hide. Twelve screens
// each making that judgement is twelve chances to leak, and the twelfth will be written at 2am by
// somebody who has not read this file.
//
// So: a field carries a VisibilityClass. An audience carries the set of classes it may see. The
// intersection is the view, and `redactForAudience()` computes it. A screen renders what it is
// given.
//
// =================================================================================================
// TWO THINGS THAT ARE NOT NEGOTIABLE, AND WHY THEY ARE HERE RATHER THAN IN A DOCUMENT
// =================================================================================================
//
//  1. NO PER-PERSON HEALTH DATA REACHES ANY ADMIN SURFACE. src/lib/wellness.ts is women-only, gated
//     server-side, and its oversight screens are aggregate-only with a MIN_GROUP floor of 5. The
//     project's own rule says it plainly: if you find yourself writing a query that returns a row
//     per user on an admin surface, that is the screen that must not exist. HORIZON therefore gives
//     the wellbeing family the class `prohibited`, which NO audience — including the founder, and
//     including an auditor — may see per person. Rule 27 sits alongside it: this system does not
//     diagnose anything.
//
//  2. THE ACCESS LOG IS A PRECONDITION, NOT A SIDE EFFECT. src/lib/legal-hold.ts already establishes
//     the pattern for this repository: logAccess() must SUCCEED before anything renders. A read that
//     happened with no record of it having happened is, for an audit, a read that cannot be
//     defended. `AUDIENCE_SPECS[...].logBeforeRender` says which audiences that applies to, and
//     `requireAccessLog()` is the helper that enforces it.
//
// NOTHING IN THIS FILE RESOLVES A RELATIONSHIP. Whether this manager manages this employee is a
// per-ROW question answered by the organisation graph — src/lib/org-graph.ts, which is Layer 1 of
// the three-layer architecture and is not HORIZON's to reimplement. This module takes the answer as
// an input (`AccessContext.relationshipConfirmed`) and decides what follows from it. That separation
// is the permanent directive on this project: organisation, authorisation and workflow are
// independent layers and are never merged.
//
// PURE, except for the logger interface. No database import, so every rule below is unit-testable.

import type { ActorRef, OrganisationId, SubjectRef } from './ids';
import type { DimensionFamily, EngineClass } from './types';
import { ENGINE_CLASS_SPECS } from './types';
import type { WithheldField } from './api';

// -------------------------------------------------------------------------------------------------
// VISIBILITY CLASSES
// -------------------------------------------------------------------------------------------------

export const VISIBILITY_CLASSES = ['open', 'internal', 'restricted', 'sensitive', 'prohibited'] as const;
export type VisibilityClass = (typeof VISIBILITY_CLASSES)[number];

export interface VisibilityClassSpec {
  visibility: VisibilityClass;
  label: string;
  meaning: string;
  /**
   * How a field of this class disappears when the reader may not see it.
   *
   *   'withhold'  the reader is told the field exists and is restricted.
   *   'omit'      the field is absent and its absence is not announced, because announcing it
   *               discloses the thing the restriction protects.
   */
  redaction: 'withhold' | 'omit';
}

export const VISIBILITY_SPECS: Readonly<Record<VisibilityClass, VisibilityClassSpec>> = Object.freeze({
  open: {
    visibility: 'open', label: 'Open',
    meaning: 'Anyone with a reason to look at this record may see it.', redaction: 'withhold',
  },
  internal: {
    visibility: 'internal', label: 'Internal',
    meaning: 'Ordinary working information for people with a role in this person’s work.',
    redaction: 'withhold',
  },
  restricted: {
    visibility: 'restricted', label: 'Restricted',
    meaning: 'The system’s internal workings. Shown only to readers who are accountable for them.',
    redaction: 'omit',
  },
  sensitive: {
    visibility: 'sensitive', label: 'Sensitive',
    meaning: 'Personal information with a specific purpose and a consent record behind it.',
    redaction: 'omit',
  },
  prohibited: {
    visibility: 'prohibited', label: 'Never shown per person',
    meaning: 'Exists only as an aggregate above the minimum group size. No individual view exists.',
    redaction: 'omit',
  },
});

// -------------------------------------------------------------------------------------------------
// AUDIENCES
// -------------------------------------------------------------------------------------------------

export const HORIZON_AUDIENCES = [
  'self',
  'reporting_manager',
  'department_head',
  'reviewer_panel',
  'hr_operations',
  'hr_leadership',
  'auditor',
  'system',
] as const;

export type HorizonAudience = (typeof HORIZON_AUDIENCES)[number];

export interface AudienceSpec {
  audience: HorizonAudience;
  label: string;
  /** The visibility classes this audience may see. `prohibited` appears in none of them. */
  maySee: readonly VisibilityClass[];
  /** True when a stated purpose is required before the read is served. Rule 17, purpose limitation. */
  requiresPurpose: boolean;
  /** True when the access log row must be written BEFORE anything renders. */
  logBeforeRender: boolean;
  /**
   * True when this audience's authority is a per-ROW relationship that the org graph must confirm,
   * rather than an organisation-wide capability. A manager may see their own reports and nobody
   * else's, and that is a different question from "does this user hold hr.read".
   */
  relationshipScoped: boolean;
}

export const AUDIENCE_SPECS: Readonly<Record<HorizonAudience, AudienceSpec>> = Object.freeze({
  // THE SUBJECT SEES THEIR OWN RECORD, and sees it as it is. What they may NOT see is the system's
  // internal workings about them (`restricted`) — not to keep them in the dark, but because a
  // person shown the machinery that grades them will optimise against the machinery rather than do
  // the work, and because rule 20 keeps the traditional-computation layer away from the person it
  // is about. What they see instead is every result, its evidence, and its summary.
  self: {
    audience: 'self', label: 'The person themselves',
    maySee: ['open', 'internal'], requiresPurpose: false, logBeforeRender: false,
    relationshipScoped: false,
  },
  reporting_manager: {
    audience: 'reporting_manager', label: 'Reporting manager',
    maySee: ['open', 'internal'], requiresPurpose: false, logBeforeRender: true,
    relationshipScoped: true,
  },
  department_head: {
    audience: 'department_head', label: 'Department head',
    maySee: ['open', 'internal'], requiresPurpose: false, logBeforeRender: true,
    relationshipScoped: true,
  },
  // A PANEL SEES WHAT IT NEEDS TO ASSESS AND NOTHING ELSE. A reviewer looking at a candidate is not
  // entitled to that candidate's whole history, and a reviewer looking at a colleague is not
  // entitled to their manager's view of them.
  reviewer_panel: {
    audience: 'reviewer_panel', label: 'Review or interview panel',
    maySee: ['open'], requiresPurpose: true, logBeforeRender: true, relationshipScoped: true,
  },
  hr_operations: {
    audience: 'hr_operations', label: 'HR operations',
    maySee: ['open', 'internal'], requiresPurpose: true, logBeforeRender: true,
    relationshipScoped: false,
  },
  hr_leadership: {
    audience: 'hr_leadership', label: 'HR leadership',
    maySee: ['open', 'internal', 'sensitive'], requiresPurpose: true, logBeforeRender: true,
    relationshipScoped: false,
  },
  // THE ONLY AUDIENCE THAT SEES THE MACHINERY. An auditor's job is the machinery — which engine ran,
  // on what, with what weights — and the trade-off is that every one of those reads is logged and
  // purpose-bound. Note what an auditor still cannot see: `prohibited`. Nobody sees that per person.
  auditor: {
    audience: 'auditor', label: 'Auditor',
    maySee: ['open', 'internal', 'restricted'], requiresPurpose: true, logBeforeRender: true,
    relationshipScoped: false,
  },
  // NOT A PERSON. An engine reading inputs to compute something. It is granted `restricted` because
  // it computes over the machinery, and it is granted nothing sensitive, because an engine that
  // needs sensitive personal data to work is an engine this system should not run.
  system: {
    audience: 'system', label: 'System engine',
    maySee: ['open', 'internal', 'restricted'], requiresPurpose: false, logBeforeRender: false,
    relationshipScoped: false,
  },
});

/** Nobody, in any audience, may see a `prohibited` field about an individual. Asserted in tests. */
export const NEVER_VISIBLE: VisibilityClass = 'prohibited';

// -------------------------------------------------------------------------------------------------
// FIELD CLASSIFICATION
// -------------------------------------------------------------------------------------------------

/**
 * The visibility class of each field of the standard intelligence output.
 *
 * Paths are dotted, relative to the object being redacted. A path not listed here defaults to
 * `restricted` — FAIL CLOSED. A field somebody adds next year and forgets to classify is hidden from
 * everyone but an auditor rather than shown to everyone, which is the direction an unclassified
 * field should fail in.
 */
export const RESULT_FIELD_VISIBILITY: Readonly<Record<string, VisibilityClass>> = Object.freeze({
  id: 'open',
  subject: 'open',
  dimension: 'open',
  scoreOrLevel: 'open',
  confidence: 'open',
  status: 'open',
  summary: 'open',
  computedAt: 'open',
  validFor: 'open',
  humanReviewStatus: 'open',
  layer: 'open',
  decisionUse: 'open',
  scientificStatus: 'open',
  unreadable: 'open',
  organisationId: 'internal',
  profileId: 'internal',
  supersedes: 'internal',
  // THE EVIDENCE IS PART OF THE ANSWER, NOT PART OF THE MACHINERY. A person told they scored low is
  // entitled to know what that rests on; rule 12 and rule 23 are worth nothing if the evidence is
  // classified out of the subject's view.
  evidence: 'open',
  // THE WEIGHTS ARE THE MACHINERY. How much each source contributed is exactly what a person would
  // game if they could see it, and exactly what an auditor must see.
  sourceBreakdown: 'restricted',
  modelOrEngineVersion: 'restricted',
});

export const SIGNAL_FIELD_VISIBILITY: Readonly<Record<string, VisibilityClass>> = Object.freeze({
  id: 'open',
  subject: 'open',
  category: 'open',
  severity: 'open',
  title: 'open',
  explanation: 'open',
  generatedAt: 'open',
  expiresAt: 'open',
  status: 'open',
  recommendedActions: 'internal',
  humanReviewRequired: 'open',
  confidence: 'open',
  layer: 'open',
  decisionUse: 'open',
  evidenceIds: 'internal',
  sourceTypes: 'internal',
  organisationId: 'internal',
  computationId: 'restricted',
});

/**
 * Whole DIMENSION FAMILIES can be restricted regardless of the field.
 *
 * `wellbeing_aggregate` is `prohibited` — see the header. `temporal_pattern` is `restricted` because
 * rule 20 requires the traditional computation layer to be kept apart from the professional
 * interpretation layer, and rule 22 requires it never to outweigh demonstrated work: a family that
 * no operational audience can see per person cannot quietly become the reason for a decision.
 */
export const FAMILY_VISIBILITY: Readonly<Record<DimensionFamily, VisibilityClass>> = Object.freeze({
  capability: 'open',
  contribution: 'open',
  collaboration: 'open',
  reliability: 'open',
  growth: 'open',
  risk: 'internal',
  wellbeing_aggregate: 'prohibited',
  temporal_pattern: 'restricted',
});

/**
 * The floor for an individual field, given the family it belongs to and the engine that produced it.
 *
 * The STRICTEST of the three applies. An `open` field inside a `prohibited` family is prohibited; an
 * `open` field produced by an engine class marked `interpretationLayerOnly` is restricted. Rules
 * that only apply when the field-level rule happens to agree with them are not rules.
 */
export function effectiveVisibility(
  fieldVisibility: VisibilityClass,
  family: DimensionFamily,
  engineClass?: EngineClass | null,
): VisibilityClass {
  const order: VisibilityClass[] = ['open', 'internal', 'restricted', 'sensitive', 'prohibited'];
  const rank = (v: VisibilityClass) => order.indexOf(v);
  let out = fieldVisibility;
  const fam = FAMILY_VISIBILITY[family];
  if (fam && rank(fam) > rank(out)) out = fam;
  if (engineClass && ENGINE_CLASS_SPECS[engineClass]?.interpretationLayerOnly && rank('restricted') > rank(out)) {
    out = 'restricted';
  }
  return out;
}

export function audienceMaySee(audience: HorizonAudience, visibility: VisibilityClass): boolean {
  if (visibility === NEVER_VISIBLE) return false;
  return AUDIENCE_SPECS[audience].maySee.includes(visibility);
}

// -------------------------------------------------------------------------------------------------
// REDACTION
// -------------------------------------------------------------------------------------------------

export interface RedactionOutcome<T> {
  value: Partial<T>;
  /** Fields the reader may know exist. Surfaced in ResponseMeta.withheld. */
  withheld: WithheldField[];
  /** Fields removed without announcement. Reported to the ACCESS LOG, never to the reader. */
  omitted: string[];
}

/**
 * Shape one object for one audience.
 *
 * A SHALLOW copy is deliberate: nested redaction would need a path map per nested shape, and a
 * half-implemented deep redaction that looks thorough is more dangerous than a shallow one that is
 * documented. Nested objects are classified as a whole — `sourceBreakdown` is restricted in its
 * entirety, not field by field.
 *
 * UNLISTED FIELDS FAIL CLOSED at `restricted`.
 */
export function redactForAudience<T extends Record<string, any>>(
  obj: T,
  audience: HorizonAudience,
  fieldVisibility: Readonly<Record<string, VisibilityClass>>,
  opts: { family?: DimensionFamily; engineClass?: EngineClass | null; pathPrefix?: string } = {},
): RedactionOutcome<T> {
  const out: Partial<T> = {};
  const withheld: WithheldField[] = [];
  const omitted: string[] = [];
  const prefix = opts.pathPrefix ? opts.pathPrefix + '.' : '';

  for (const key of Object.keys(obj)) {
    const declared = fieldVisibility[key] ?? 'restricted';
    const effective = opts.family
      ? effectiveVisibility(declared, opts.family, opts.engineClass ?? null)
      : declared;

    if (audienceMaySee(audience, effective)) {
      (out as Record<string, unknown>)[key] = obj[key];
      continue;
    }
    if (VISIBILITY_SPECS[effective].redaction === 'withhold') {
      withheld.push({
        path: prefix + key,
        reason: VISIBILITY_SPECS[effective].meaning,
        availableTo: audienceThatCanSee(effective),
      });
    } else {
      omitted.push(prefix + key);
    }
  }
  return { value: out, withheld, omitted };
}

/** The first audience label that may see this class, so a reader knows who to ask. Null for prohibited. */
export function audienceThatCanSee(visibility: VisibilityClass): string | null {
  if (visibility === NEVER_VISIBLE) return null;
  for (const a of HORIZON_AUDIENCES) {
    if (a === 'system') continue;
    if (AUDIENCE_SPECS[a].maySee.includes(visibility)) return AUDIENCE_SPECS[a].label;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// AUTHORISATION INPUT — RESOLVED ELSEWHERE, DECIDED HERE
// -------------------------------------------------------------------------------------------------

/**
 * What the caller must establish before HORIZON will serve a record.
 *
 * `relationshipConfirmed` is the org graph's answer for THIS reader and THIS subject, and it is
 * required for every relationship-scoped audience. HORIZON does not compute it: relationships
 * resolve per row from src/lib/org-graph.ts, and duplicating that here would be the merge of two
 * layers that this project has permanently forbidden.
 */
export interface AccessContext {
  actor: ActorRef;
  audience: HorizonAudience;
  subject: SubjectRef;
  organisationId: OrganisationId;
  /** The org graph's per-row answer. Required whenever AUDIENCE_SPECS[...].relationshipScoped. */
  relationshipConfirmed?: boolean;
  /** Why this read is happening. Required whenever AUDIENCE_SPECS[...].requiresPurpose. */
  purpose?: string | null;
  requestId: string;
}

export type AccessDecision =
  | { allowed: true; audience: HorizonAudience }
  | { allowed: false; reason: string; code: 'forbidden' | 'purpose_required' };

export const MIN_PURPOSE_CHARS = 8;

/**
 * PURE. May this read proceed at all?
 *
 * Note what this does NOT decide: which fields are visible. That is redaction, and it happens after.
 * A reader may legitimately be allowed to open a record and see very little of it.
 */
export function authoriseAccess(ctx: AccessContext): AccessDecision {
  const spec = AUDIENCE_SPECS[ctx.audience];
  if (!spec) return { allowed: false, reason: 'Unknown audience.', code: 'forbidden' };

  if (spec.relationshipScoped && ctx.relationshipConfirmed !== true) {
    // FAIL CLOSED ON UNDEFINED. A caller that forgot to resolve the relationship gets a refusal, not
    // a record. `undefined` meaning "allow" is how an authorisation check becomes decoration.
    return {
      allowed: false,
      code: 'forbidden',
      reason: 'This view requires a confirmed working relationship with the person, and none was resolved.',
    };
  }
  if (spec.requiresPurpose) {
    const p = String(ctx.purpose || '').trim();
    if (p.length < MIN_PURPOSE_CHARS) {
      return {
        allowed: false,
        code: 'purpose_required',
        reason: 'A stated purpose of at least ' + MIN_PURPOSE_CHARS + ' characters is required for this view.',
      };
    }
  }
  return { allowed: true, audience: ctx.audience };
}

// -------------------------------------------------------------------------------------------------
// THE ACCESS LOG
// -------------------------------------------------------------------------------------------------

export interface AccessLogEntry {
  id: string;
  organisationId: OrganisationId;
  actor: ActorRef;
  subject: SubjectRef;
  audience: HorizonAudience;
  /** The strongest visibility class actually served. Not what was asked for — what was handed over. */
  visibilityServed: VisibilityClass;
  purpose: string | null;
  requestId: string;
  at: string;
  /** Fields removed without announcement. The reader did not see these; the auditor must. */
  omitted: readonly string[];
  /** False when the read was refused. A refused read is still a read that was attempted. */
  succeeded: boolean;
  refusalReason?: string | null;
}

export interface AccessLogResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * The sink for access records.
 *
 * An interface, not a function, because the eventual implementation writes hzn_access_log AND emits
 * `access.logged`, and a later deployment may want it to write somewhere else entirely. Nothing in
 * this module logs access by reaching for the database directly.
 */
export interface AccessLogger {
  log(entry: Omit<AccessLogEntry, 'id' | 'at'>): Promise<AccessLogResult>;
}

/**
 * Log the read, and say whether the caller may now render.
 *
 * THE RULE, AND IT IS THE SAME ONE src/lib/legal-hold.ts ALREADY ENFORCES: for an audience marked
 * `logBeforeRender`, a failed log means the response is REFUSED. Not degraded, not rendered with a
 * warning — refused, with a 503, because a read that leaves no record is a read that cannot be
 * defended to an auditor and the person it is about never gets to know it happened.
 *
 * For audiences not marked `logBeforeRender` — a person reading their own record — a logging failure
 * is recorded and the render proceeds. Blocking somebody from their own record over a logging hiccup
 * is a worse outcome than a gap in a log that nobody will ever query for that case.
 */
export async function requireAccessLog(
  logger: AccessLogger,
  entry: Omit<AccessLogEntry, 'id' | 'at'>,
): Promise<{ mayRender: boolean; logged: boolean; error?: string }> {
  let result: AccessLogResult;
  try {
    result = await logger.log(entry);
  } catch (e: any) {
    // NEVER A BARE SWALLOW. The real Postgres reason is on e.cause; e.message is the failed SQL.
    result = { ok: false, error: String(e?.cause?.message || e?.message || e) };
  }
  const mustLog = AUDIENCE_SPECS[entry.audience]?.logBeforeRender === true;
  if (result.ok) return { mayRender: true, logged: true };
  return {
    mayRender: !mustLog,
    logged: false,
    error: result.error || 'the access log write did not succeed',
  };
}
