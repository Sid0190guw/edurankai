// src/lib/horizon/governance/types.ts — PATCH 17 OWNED CONTRACTS.
//
// WHAT IS HERE, AND WHAT IS DELIBERATELY NOT.
//
// This file declares only what the governance layer itself owns. It does NOT redeclare a subject, an
// actor, a data class, an evidence reference or a confidence — those are HORIZON's shared contracts
// and they already exist:
//
//   SubjectRef, ActorRef, OrganisationId    @/lib/horizon/ids
//   DataClass, EvidenceRef, Confidence      @/lib/horizon (contracts.ts)
//   VisibilityClass, HorizonAudience        @/lib/horizon (visibility.ts)
//
// A second definition of `SubjectRef` in this file would compile, would be structurally similar, and
// would quietly diverge the first time either side added a field. One name, one definition.
//
// THE RULE FOR EVERY OTHER PATCH: what IS declared here is additive-only. Add a union member, add an
// optional field. Do not rename, narrow or remove — a stored decision row means what the type meant
// when it was written, and changing that turns a record into a reconstruction.
import type { SubjectRef } from '@/lib/horizon/ids';

/**
 * WHY SOMEBODY IS READING. Purpose limitation means an access is authorised for a stated reason and
 * for nothing else; holding a permission is not authorisation (brief rule 17).
 *
 * visibility.ts already requires a purpose STRING of at least MIN_PURPOSE_CHARS for the audiences
 * that need one. This is the vocabulary that free text was missing: "I am an admin" is not a purpose,
 * and neither is "checking". "Deciding a promotion case that is open right now" is.
 */
export type Purpose =
  | 'employment_administration'
  | 'performance_review'
  | 'promotion_assessment'
  | 'compensation_review'
  | 'hiring_assessment'
  | 'learning_development'
  | 'workforce_planning'
  | 'grievance_investigation'
  | 'legal_or_regulatory'
  | 'security_incident'
  | 'subject_access_request'
  | 'system_administration';

export type LawfulBasis =
  | 'consent'
  | 'contract'
  | 'legal_obligation'
  | 'legitimate_interest'
  | 'vital_interest';

/**
 * IMPACT decides how hard the human-in-the-loop requirement bites. `high` covers everything brief
 * rule 14 names — hiring, rejection, promotion, termination, discipline.
 */
export type ImpactLevel = 'informational' | 'advisory' | 'high';

export type DecisionKind = 'accepted' | 'rejected' | 'modified' | 'deferred';

/**
 * WHAT A NAMED HUMAN DECIDED. The only record in this layer that may change somebody's standing.
 *
 * `decidedBy` is a real user id, checked against `users` before the row is written. There is no
 * service account, no "system" value and no scheduled writer — brief rule 14 is enforced by the
 * absence of a caller that could write this row without a person.
 *
 * `recommendationRef` is an OPAQUE string. Whatever produced the suggestion owns it; this layer
 * records that a decision was taken about it and never joins to it.
 */
export interface HumanDecisionRecord {
  id: string;
  subject: SubjectRef;
  recommendationRef: string | null;
  /** The hzn_intelligence_result row this decision was taken on, where there was one. */
  resultId: string | null;
  decidedBy: string;
  decidedByName: string | null;
  decision: DecisionKind;
  /** Mandatory and substantive. A decision whose reason is "ok" is refused. */
  rationale: string;
  /**
   * False whenever the human departed from what the system suggested.
   *
   * Recorded SEPARATELY from `decision`, and the two can legitimately disagree — somebody can accept
   * a suggestion for reasons of their own, or reject one they privately agree with. Keeping both is
   * what lets a later reader see how often the humans and the machine actually align, which is the
   * only honest measure of whether the machine is worth anything.
   */
  agreedWithSystem: boolean;
  impact: ImpactLevel;
  /** What the human actually did, where it differed from the suggestion. */
  actionTaken: string | null;
  /** Which engine version was on screen when they decided. */
  engineVersion: string | null;
  decidedAt: string;
}

/**
 * A registered engine version.
 *
 * hzn_computation stores `engine_version` as free text. That is correct for the computation row —
 * it records what actually ran — but it means a version string resolves to nothing. This is what it
 * resolves against.
 */
export interface EngineVersion {
  version: string;
  engineId: string;
  engineClass: string;
  /** What kind of thing it is: 'ruleset', 'statistical', 'model', 'traditional_computation'. */
  method: string;
  /** A stable digest of the parameters, so two runs claiming one version can be told apart. */
  paramsDigest: string | null;
  notes: string | null;
  activatedAt: string;
  retiredAt: string | null;
}

export type RetentionAction = 'delete' | 'anonymise' | 'review';

export interface RetentionPolicy {
  /** The class of record this governs. */
  recordClass: string;
  /**
   * Which module owns the table behind it.
   *
   * THIS FIELD IS WHY THE SWEEP IS SAFE. A class owned by another patch is COUNTED and reported and
   * never touched: deleting rows out of somebody else's table because a policy row said so is the
   * cross-patch write this build forbids, and it is also how a retention job silently breaks a
   * feature nobody connected to it.
   */
  ownerModule: string;
  dataClass: string;
  retainDays: number;
  action: RetentionAction;
  /** Why the period is what it is. A retention period with no stated basis is a guess. */
  basis: string;
  overriddenBy: string | null;
  updatedAt: string;
}

export type ErasureStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'executing'
  | 'completed';

export interface ErasureRequest {
  id: string;
  subject: SubjectRef;
  /** 'delete' destroys; 'anonymise' keeps the aggregate and severs the identity. */
  action: Exclude<RetentionAction, 'review'>;
  /** Which record classes are in scope. Empty means every class this layer owns. */
  scope: string[];
  requestedBy: string;
  reason: string;
  status: ErasureStatus;
  /** A second named human. Self-approval is refused. */
  approvedBy: string | null;
  approvedAt: string | null;
  /** Why it cannot proceed — an open legal matter, a statutory period still running. */
  blockers: string[];
  /** What each participating patch reported doing. Written by executeErasure(). */
  report: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

/** Who is asking. Assembled by the caller from the session; this layer never invents one. */
export interface GovernanceActor {
  id: string;
  email?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * THE REQUIRED AUDIT ANSWER, as one object.
 *
 *   WHO accessed WHAT, WHEN, WHY / under which permission, WHAT was changed,
 *   WHICH intelligence version was used, and WHAT human action followed.
 *
 * Assembled by `auditAnswer()` in ledger.ts by READING the logs the other patches already write —
 * hzn_access_log, hzn_computation, hzn_intelligence_result, hzn_feedback_contribution,
 * hzn_recompute_request — plus this layer's own decision log. Every field comes from a stored row.
 * Nothing is inferred, and where a link genuinely does not exist the entry says so rather than
 * filling the gap with something plausible.
 */
export interface AuditAnswer {
  subject: SubjectRef;
  window: { from: string; to: string };
  entries: AuditAnswerEntry[];
  /** Classes of record deliberately not included, and why. Honesty about coverage. */
  omitted: { what: string; why: string }[];
}

export interface AuditAnswerEntry {
  /** WHEN. */
  at: string;
  /** WHO. */
  actorId: string | null;
  actorLabel: string;
  /** WHAT — the record type and, where one applies, the record id. */
  what: string;
  /** WHY — the stated purpose. */
  why: string;
  /** UNDER WHICH PERMISSION, or for a read, which audience was served. */
  permission: string | null;
  /** WHAT WAS CHANGED. Empty string where the entry was a read. */
  changed: string;
  /** WHICH INTELLIGENCE VERSION. Null where no intelligence was involved. */
  engineVersion: string | null;
  /** WHAT HUMAN ACTION FOLLOWED. Null where nothing has followed yet — stated, not guessed. */
  humanAction: string | null;
  /** Which log this row came from, so a reader can go back to the source. */
  source: 'access' | 'computation' | 'result' | 'decision' | 'feedback' | 'recompute';
  sourceId: string;
}

/** Uniform result shape, matching what the permission registry already returns to its callers. */
export type GovernanceResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };
