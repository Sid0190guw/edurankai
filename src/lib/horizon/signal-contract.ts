// src/lib/horizon/signal-contract.ts — PATCH 08 · HORIZON Signal Engine · THE ADMISSION RULES.
//
// =================================================================================================
// THIS PATCH DOES NOT DEFINE WHAT A SIGNAL IS. THE SHARED CONTRACT DOES.
// =================================================================================================
//
// `Signal`, `SIGNAL_CATEGORIES`, `SIGNAL_SEVERITIES`, `SIGNAL_STATUSES`, `Evidence`, `SubjectRef`,
// `Confidence`, `RecommendedAction`, `validateSignal()` and the `hzn_signal` / `hzn_evidence` tables
// all belong to the HORIZON shared contracts and are imported from '@/lib/horizon'. Patch 08 builds
// the ENGINE that produces those rows: the detectors, the admission gate, and the anti-spam
// lifecycle. It creates no second signal type and no second signal table.
//
// WHAT THIS FILE ADDS, and why each addition is not already in the contract:
//
//   ATTENTION BANDS      the brief's four categories — Opportunity, Growth, Watch, Attention. These
//                        are a READING OF SEVERITY, not a new axis: green/blue/yellow/red map onto
//                        the shared info/low/medium/high. The shared `category` stays what it is —
//                        the DOMAIN of the finding (workload, reliability, growth_opportunity …).
//                        One signal therefore carries both: what it is about, and how loudly it asks.
//
//   ADMISSION            the shared validateSignal() checks that a signal is well-formed. It cannot
//                        know whether the EVIDENCE BEHIND THIS ONE is strong enough for the band it
//                        is asking for, because that is a generation-time question and generation is
//                        this patch. admit() answers it, and refuses or downgrades.
//
//   THE ANTI-SPAM DECISION  dedupe, cooldown, escalation, resolution, reactivation. Engine
//                        bookkeeping; the contract has no opinion about it and should not.
//
// =================================================================================================
// THE THREE RULES ADMISSION ENFORCES IN CODE
// =================================================================================================
//
// 1. NOTHING HIGH-IMPACT RESTS ON INFERENCE ALONE. A candidate that admits it could be quoted in one
//    of the consequential decisions must carry at least one piece of DEMONSTRATED or OBSERVED
//    evidence. Stated, attested and inferred evidence may describe a change; it may not stand behind
//    a high-impact act. Refused, with the reason, rather than quietly downgraded.
//
// 2. RED COSTS MORE. An Attention band needs evidence from at least two DISTINCT source types and at
//    least one demonstrated-or-observed item, and it always requires human review. A candidate that
//    asks for red without paying for it is DOWNGRADED to Watch with the shortfall recorded on the
//    row — not dropped, because the change may still be real, and not promoted, because it does not
//    reach.
//
// 3. NON-EVIDENTIAL INPUT IS NEVER LOAD-BEARING. The shared evidence vocabulary already has the
//    right word for a foundational or traditional interpretation: `non_evidential`, weight 0. Here
//    that word is given teeth — such items are excluded from the confidence arithmetic entirely,
//    can never satisfy an evidence floor, and a candidate whose evidence is ONLY non-evidential is
//    refused outright. Demonstrated job-related evidence outweighs it by construction rather than by
//    policy, and checkPublicCopy() refuses the terminology in any signal's own words.
//
// Every export here is pure: no database, no clock of its own, no I/O. That is what lets the whole
// rule set be tested exhaustively before it is ever pointed at a real person.
import {
  bandOf,
  checkPublicCopy,
  EVIDENCE_CLASS_WEIGHT,
  subjectKey,
  type Confidence,
  type Evidence,
  type EvidenceClass,
  type EvidenceSourceType,
  type RecommendedAction,
  type Signal,
  type SignalCategory,
  type SignalSeverity,
  type SubjectRef,
} from '@/lib/horizon';
import { CONSEQUENTIAL_DECISIONS, isConsequentialDecision, type ConsequentialDecision } from '@/lib/ai-boundary';

// =================================================================================================
// ATTENTION BANDS
// =================================================================================================

export const ATTENTION_BANDS = ['green', 'blue', 'yellow', 'red'] as const;
export type AttentionBand = (typeof ATTENTION_BANDS)[number];

export function isAttentionBand(v: unknown): v is AttentionBand {
  return typeof v === 'string' && (ATTENTION_BANDS as readonly string[]).indexOf(v) >= 0;
}

export const BAND_LABELS: Record<AttentionBand, string> = {
  green: 'Opportunity',
  blue: 'Growth',
  yellow: 'Watch',
  red: 'Attention',
};

export const BAND_MEANING: Record<AttentionBand, string> = {
  green: 'Something became possible that was not possible before.',
  blue: 'Somebody is demonstrably further along than they were.',
  yellow: 'Something changed in a way worth looking at before it becomes a problem.',
  red: 'Something needs a named person to look at it now.',
};

/**
 * THE BAND IS THE SHARED SEVERITY, READ ALOUD. One value is stored — `hzn_signal.severity` — and the
 * band is how this engine and its screens name it. Storing both would be storing the same fact twice
 * and inviting them to disagree.
 */
export const BAND_SEVERITY: Record<AttentionBand, SignalSeverity> = {
  green: 'info',
  blue: 'low',
  yellow: 'medium',
  red: 'high',
};

const SEVERITY_BAND: Record<SignalSeverity, AttentionBand> = {
  info: 'green',
  low: 'blue',
  medium: 'yellow',
  high: 'red',
};

export function bandOfSeverity(s: SignalSeverity): AttentionBand {
  return SEVERITY_BAND[s] || 'yellow';
}

/**
 * HOW MUCH ATTENTION EACH BAND ASKS FOR. The only ordering in this module, and deliberately NOT a
 * goodness scale: Opportunity and Growth are the two best things that can happen to somebody, and
 * they sit at the bottom because they can wait until Tuesday.
 */
export const ATTENTION_RANK: Record<AttentionBand, number> = { green: 1, blue: 2, yellow: 3, red: 4 };

export function escalates(from: AttentionBand, to: AttentionBand): boolean {
  return ATTENTION_RANK[to] > ATTENTION_RANK[from];
}

/**
 * HOW LONG A SIGNAL LIVES BEFORE IT EXPIRES.
 *
 * The shared schema requires `expires_at` and says why: a signal that never expires is a permanent
 * mark on a person. These are the engine's defaults. Attention is the SHORTEST, which reads
 * backwards until you see it the right way round — a signal asking for a human to look now is either
 * looked at within a fortnight or it was never really urgent, and leaving it standing for a year
 * turns "please look" into a file entry.
 */
export const BAND_TTL_DAYS: Record<AttentionBand, number> = { green: 90, blue: 90, yellow: 45, red: 14 };

export function expiryFor(band: AttentionBand, from: Date): string {
  return new Date(from.getTime() + BAND_TTL_DAYS[band] * 86400000).toISOString();
}

// =================================================================================================
// EVIDENCE STRENGTH, ON THE SHARED SCALE
// =================================================================================================

/** At or above this weight, somebody actually did the thing. Below it, somebody said so. */
export const LOAD_BEARING_WEIGHT = EVIDENCE_CLASS_WEIGHT.observed; // 4 — 'observed' and 'demonstrated'

export function isLoadBearing(cls: EvidenceClass): boolean {
  return (EVIDENCE_CLASS_WEIGHT[cls] || 0) >= LOAD_BEARING_WEIGHT;
}

/** Weight 0 in the shared table. Context, never a finding. */
export function isNonEvidential(cls: EvidenceClass): boolean {
  return (EVIDENCE_CLASS_WEIGHT[cls] || 0) === 0;
}

export interface EvidenceProfile {
  total: number;
  /** Items left after non-evidential context is set aside. */
  weighted: number;
  distinctSourceTypes: EvidenceSourceType[];
  loadBearingCount: number;
  strongestClass: EvidenceClass | null;
  nonEvidentialCount: number;
  nonEvidentialOnly: boolean;
  newestAt: string | null;
  oldestAt: string | null;
}

function validEvidence(e: unknown): e is Evidence {
  const v = e as Evidence;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.sourceType === 'string' &&
    typeof v.sourceId === 'string' &&
    typeof v.summary === 'string' &&
    !!v.summary.trim() &&
    typeof v.timestamp === 'string' &&
    !Number.isNaN(Date.parse(v.timestamp)) &&
    !!v.relevance &&
    !!v.reliability &&
    !!v.rawReference
  );
}

/**
 * Read a set of evidence without flattering it.
 *
 * NON-EVIDENTIAL ITEMS ARE COUNTED AND THEN SET ASIDE. They appear in `nonEvidentialCount` so a
 * reader can see they were present, and they are absent from everything the arithmetic touches.
 * That is rule 3 of this file expressed as one branch.
 */
export function evidenceProfile(evidence: readonly Evidence[]): EvidenceProfile {
  const valid = (evidence || []).filter(validEvidence);
  const weighted = valid.filter((e) => !isNonEvidential(e.evidenceClass));
  const context = valid.length - weighted.length;

  const types: EvidenceSourceType[] = [];
  for (const e of weighted) if (types.indexOf(e.sourceType) < 0) types.push(e.sourceType);

  let strongest: EvidenceClass | null = null;
  for (const e of weighted) {
    if (!strongest || (EVIDENCE_CLASS_WEIGHT[e.evidenceClass] || 0) > (EVIDENCE_CLASS_WEIGHT[strongest] || 0)) {
      strongest = e.evidenceClass;
    }
  }

  const times = weighted.map((e) => Date.parse(e.timestamp)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);

  return {
    total: valid.length,
    weighted: weighted.length,
    distinctSourceTypes: types,
    loadBearingCount: weighted.filter((e) => isLoadBearing(e.evidenceClass)).length,
    strongestClass: strongest,
    nonEvidentialCount: context,
    nonEvidentialOnly: valid.length > 0 && weighted.length === 0,
    newestAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    oldestAt: times.length ? new Date(times[0]).toISOString() : null,
  };
}

// =================================================================================================
// CONFIDENCE
// =================================================================================================

const CLASS_BASE: Record<EvidenceClass, number> = {
  demonstrated: 0.6,
  observed: 0.5,
  attested: 0.35,
  stated: 0.25,
  inferred: 0.2,
  non_evidential: 0,
};

export const CONFIDENCE_CEILING = 0.95;
export const CONFIDENCE_FLOOR = 0.05;

export interface ConfidenceWorking extends Confidence {
  value: number;
  /** Every term that produced the number, in order. The shared `basis` is these joined up. */
  terms: string[];
}

/**
 * A NUMBER THAT SHOWS ITS WORKING.
 *
 * The shared `Confidence` carries one `basis` sentence, which is the right shape for a contract and
 * the wrong shape for a screen that has to answer "why that number". So the terms are kept as an
 * array here and joined for storage — the sentence a reader sees IS the arithmetic, not a summary
 * of it. It never reaches 1.0: a system reporting certainty about a person has stopped describing
 * evidence and started describing itself.
 */
export function confidenceFor(profile: EvidenceProfile, now: Date): ConfidenceWorking {
  const terms: string[] = [];
  if (!profile.weighted || !profile.strongestClass) {
    terms.push('No evidence that carries weight, so confidence is at the floor.');
    return { band: 'low', value: CONFIDENCE_FLOOR, basis: terms.join(' '), terms };
  }

  let v = CLASS_BASE[profile.strongestClass];
  terms.push('Strongest evidence is "' + profile.strongestClass + '", which starts at ' + v.toFixed(2) + '.');

  const extraTypes = Math.max(0, profile.distinctSourceTypes.length - 1);
  if (extraTypes > 0) {
    const add = Math.min(0.15, extraTypes * 0.05);
    v += add;
    terms.push('Corroborated across ' + profile.distinctSourceTypes.length + ' source types (+' + add.toFixed(2) + ').');
  } else {
    terms.push('One source type only, so nothing is added for corroboration.');
  }

  const extraLoadBearing = Math.max(0, profile.loadBearingCount - 1);
  if (extraLoadBearing > 0) {
    const add = Math.min(0.1, extraLoadBearing * 0.05);
    v += add;
    terms.push(extraLoadBearing + ' further demonstrated or observed item(s) (+' + add.toFixed(2) + ').');
  }

  if (profile.newestAt) {
    const ageDays = (now.getTime() - Date.parse(profile.newestAt)) / 86400000;
    if (ageDays > 60) {
      v -= 0.1;
      terms.push('Newest evidence is ' + Math.round(ageDays) + ' days old (-0.10).');
    }
  }

  if (profile.nonEvidentialCount > 0) {
    terms.push(
      profile.nonEvidentialCount +
        ' non-evidential item(s) were present as context and were excluded from this figure entirely; they add nothing and take nothing away.',
    );
  }

  v = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, v));
  terms.push('Result ' + v.toFixed(2) + ', capped at ' + CONFIDENCE_CEILING + '.');
  return { band: bandOf(v), value: Number(v.toFixed(3)), basis: terms.join(' '), terms };
}

// =================================================================================================
// WHAT A DETECTOR PROPOSES
// =================================================================================================

/** Which table or module the engine actually read, and what it took. The INPUTS of the chain. */
export interface SignalInput {
  source: string;
  description: string;
}

export interface SignalCandidate {
  detectorKey: string;
  detectorVersion: string;
  band: AttentionBand;
  /** The DOMAIN of the finding, from the shared vocabulary. */
  category: SignalCategory;
  /** The professional dimension, from the shared interpretation taxonomy or a detector's own key. */
  dimension: string;
  title: string;
  /** WHAT CHANGED, in one plain sentence a subject could read without harm. */
  whatChanged: string;
  subject: SubjectRef;
  evidence: Evidence[];
  inputs: SignalInput[];
  /** HOW the inputs became this conclusion. The PROCESSING of the chain. */
  processing: string;
  recommendedActions: RecommendedAction[];
  periodStart: string;
  periodEnd: string;
  /**
   * Set ONLY when this finding could plausibly be quoted in service of one of the six consequential
   * decisions. Setting it makes the evidence floor stricter. It authorises nothing.
   */
  touchesDecision?: ConsequentialDecision | null;
}

export interface AdmittedSignal extends SignalCandidate {
  band: AttentionBand;
  severity: SignalSeverity;
  dedupeKey: string;
  profile: EvidenceProfile;
  confidence: ConfidenceWorking;
  humanReviewRequired: boolean;
  /** Who has to look. A relationship for everything except HR; resolved per row by the engine. */
  reviewerKind: ReviewerKind;
  downgradedFrom: AttentionBand | null;
  downgradeReason: string | null;
  sourceTypes: EvidenceSourceType[];
  expiresAt: string;
  /** Where this sits in the canonical separation. Never 'human_decision'. */
  layer: 'computed' | 'ai_interpretation';
  /** What it may be used for. Never 'may_decide' — the shared validator refuses that outright. */
  decisionUse: 'supporting_only' | 'advisory_only';
}

export const REVIEWER_KINDS = ['none', 'reporting_manager', 'department_head', 'hr'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

export const REVIEWER_KIND_LABELS: Record<ReviewerKind, string> = {
  none: 'No review required',
  reporting_manager: 'The reporting manager',
  department_head: 'The department head',
  hr: 'HR',
};

export type AdmitResult =
  | { ok: true; signal: AdmittedSignal; notes: string[] }
  | { ok: false; refusals: string[] };

// =================================================================================================
// DEDUPE KEY
// =================================================================================================

/**
 * THE SAME OBSERVATION ABOUT THE SAME PERSON IS ONE ROW, FOREVER.
 *
 * Detector + dimension + subject. NOT the band and NOT the evidence: a Watch that becomes an
 * Attention is the same finding getting worse, and giving it a new row is exactly how a queue fills
 * with four versions of one problem. `subjectKey()` is the shared function, so this key means the
 * same thing as every other subject key in HORIZON.
 */
export function dedupeKeyFor(c: Pick<SignalCandidate, 'detectorKey' | 'dimension' | 'subject'>): string {
  return (
    (c.detectorKey || '').trim().toLowerCase() +
    '|' +
    (c.dimension || '').trim().toLowerCase() +
    '|' +
    (c.subject ? subjectKey(c.subject) : '')
  ).slice(0, 200);
}

// =================================================================================================
// ADMISSION
// =================================================================================================

/** Red needs this many distinct, weight-carrying source types before it may be raised as red. */
export const RED_MIN_SOURCE_TYPES = 2;

function reviewerFor(band: AttentionBand, touchesDecision: boolean): ReviewerKind {
  if (band === 'red' || touchesDecision) return 'hr';
  if (band === 'yellow') return 'reporting_manager';
  return 'none';
}

/**
 * Does a sentence read as one of the six decisions being MADE rather than considered?
 *
 * A WORD LIST, AND ITS LIMITS ARE STATED. It catches the obvious phrasing a detector might drift
 * into; it is not a semantic guarantee and it is not the real control. The real control is that this
 * patch exports nothing that acts, that every RecommendedAction is addressed to a person rather than
 * to a handler, and that the six live behind src/lib/ai-boundary.ts with a named human and a written
 * reason. Treat this as a lint, and review new detectors by reading them.
 */
export function decisionNamedIn(text: string): string | null {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const banned = [
    'promote', 'terminate', 'termination', 'dismiss', 'reject', 'rejection', 'hire',
    'discipline', 'disciplinary action', 'demote', 'cut pay', 'reduce salary', 'withhold increment',
  ];
  for (const needle of banned) if (t.indexOf(' ' + needle + ' ') >= 0) return needle;
  return null;
}

/**
 * Decide whether a candidate may become a signal, and at what band.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE INTERESTING ONE:
 *   refused    it may not be raised at all, and every reason is returned
 *   downgraded it is raised, at a lower band, with the shortfall recorded on the row
 *   admitted   it is raised as asked
 *
 * A refusal is never silent and never partial. A downgrade is never silent either — `downgradedFrom`
 * and `downgradeReason` travel with the signal onto the screen, because "this was going to be an
 * Attention" is information the reviewer needs.
 */
export function admit(candidate: SignalCandidate, now: Date): AdmitResult {
  const refusals: string[] = [];
  const notes: string[] = [];

  if (!candidate || typeof candidate !== 'object') return { ok: false, refusals: ['No candidate given.'] };
  if (!String(candidate.detectorKey || '').trim()) refusals.push('A signal must name the detector that produced it.');
  if (!String(candidate.detectorVersion || '').trim()) {
    refusals.push('A signal must name the detector version, so an old row can be read against the rule that made it.');
  }
  if (!isAttentionBand(candidate.band)) refusals.push('Unknown attention band.');
  if (!String(candidate.category || '').trim()) refusals.push('A signal must name the domain category it belongs to.');
  if (!String(candidate.dimension || '').trim()) refusals.push('A signal must name the professional dimension it is about.');
  if (String(candidate.title || '').trim().length < 4) refusals.push('A signal must have a title.');
  if (String(candidate.whatChanged || '').trim().length < 10) refusals.push('A signal must say what changed, in a sentence.');
  if (String(candidate.processing || '').trim().length < 10) refusals.push('A signal must say how its inputs became this conclusion.');
  if (!Array.isArray(candidate.recommendedActions) || candidate.recommendedActions.length === 0) {
    refusals.push('A signal must name at least one recommended action, addressed to a person.');
  }
  if (!candidate.subject || !subjectKey(candidate.subject)) refusals.push('A signal must be about somebody.');
  if (!Array.isArray(candidate.inputs) || candidate.inputs.length === 0) {
    refusals.push('A signal must record which records it read.');
  }
  if (Number.isNaN(Date.parse(String(candidate.periodStart)))) refusals.push('A signal must state the start of the period it covers.');
  if (Number.isNaN(Date.parse(String(candidate.periodEnd)))) refusals.push('A signal must state the end of the period it covers.');

  // RULE 19 — the terminology check the shared contract already owns, applied to every word this
  // engine writes about a person.
  const copy = checkPublicCopy(
    [candidate.title, candidate.whatChanged, candidate.processing]
      .concat((candidate.recommendedActions || []).map((a) => a?.label || ''))
      .join(' '),
  );
  if (!copy.ok) refusals.push('Signal copy uses forbidden terminology: ' + copy.found.join(', ') + '.');

  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const invalid = evidence.length - evidence.filter(validEvidence).length;
  if (invalid > 0) notes.push(invalid + ' evidence item(s) were malformed and were dropped.');
  const profile = evidenceProfile(evidence);
  if (profile.total === 0) refusals.push('A signal must rest on at least one piece of evidence that points at a real record.');

  // RULE 3 — non-evidential context can never be the whole basis of anything.
  if (profile.total > 0 && profile.nonEvidentialOnly) {
    refusals.push(
      'Every piece of evidence is non-evidential context. That is background, not a finding, and no signal may rest on it alone.',
    );
  }

  if (candidate.touchesDecision != null && !isConsequentialDecision(candidate.touchesDecision)) {
    refusals.push('touchesDecision must be one of: ' + CONSEQUENTIAL_DECISIONS.join(', ') + '.');
  }

  for (const action of candidate.recommendedActions || []) {
    const named = decisionNamedIn(action?.label || '');
    if (named) {
      refusals.push(
        'A recommended action reads as a decision ("' +
          named +
          '"). This engine may recommend a conversation, an opportunity or a check. Deciding belongs to a named human through src/lib/ai-boundary.ts.',
      );
    }
  }

  if (refusals.length) return { ok: false, refusals };

  const touches = isConsequentialDecision(candidate.touchesDecision) ? candidate.touchesDecision : null;

  // RULE 1 — nothing high-impact rests on inference alone.
  if (touches && profile.loadBearingCount < 1) {
    return {
      ok: false,
      refusals: [
        'This signal is marked as touching ' +
          touches +
          ', and it carries no demonstrated or observed evidence. Stated, attested and inferred records may describe a change; they may not stand behind a high-impact act.',
      ],
    };
  }

  // RULE 2 — red costs more.
  let band = candidate.band as AttentionBand;
  let downgradedFrom: AttentionBand | null = null;
  let downgradeReason: string | null = null;
  if (band === 'red') {
    const shortfalls: string[] = [];
    if (profile.distinctSourceTypes.length < RED_MIN_SOURCE_TYPES) {
      shortfalls.push('needs ' + RED_MIN_SOURCE_TYPES + ' distinct source types and has ' + profile.distinctSourceTypes.length);
    }
    if (profile.loadBearingCount < 1) shortfalls.push('needs at least one demonstrated or observed record and has none');
    if (shortfalls.length) {
      downgradedFrom = 'red';
      band = 'yellow';
      downgradeReason =
        'Raised as Watch rather than Attention: ' +
        shortfalls.join('; ') +
        '. The change may still be real — the evidence does not yet reach the bar Attention requires.';
      notes.push(downgradeReason);
    }
  }

  const confidence = confidenceFor(profile, now);
  const humanReviewRequired = band === 'red' || band === 'yellow' || !!touches;

  return {
    ok: true,
    notes,
    signal: {
      ...candidate,
      band,
      severity: BAND_SEVERITY[band],
      touchesDecision: touches,
      evidence: evidence.filter(validEvidence),
      dedupeKey: dedupeKeyFor(candidate),
      profile,
      confidence,
      humanReviewRequired,
      reviewerKind: reviewerFor(band, !!touches),
      downgradedFrom,
      downgradeReason,
      sourceTypes: profile.distinctSourceTypes.slice(),
      expiresAt: expiryFor(band, now),
      // A pattern counted out of organisational records is COMPUTED. It becomes an interpretation the
      // moment a model reads intent into it, and no detector in this patch does that.
      layer: 'computed',
      // Supporting, never deciding. The shared validator refuses 'may_decide' on a signal outright.
      decisionUse: profile.loadBearingCount > 0 ? 'supporting_only' : 'advisory_only',
    },
  };
}

/**
 * The admitted signal as the SHARED `Signal` the contract defines, ready for validateSignal().
 *
 * The engine calls this immediately before it writes, so the row that lands in hzn_signal is one the
 * shared validator has passed. Evidence ids are passed in because they are only known once the
 * evidence rows exist — a signal that names evidence that was never written is exactly the kind of
 * unfalsifiable claim this whole apparatus is built to prevent.
 */
export function toSharedSignal(
  s: AdmittedSignal,
  args: { id: string; evidenceIds: string[]; organisationId: string; computationId?: string | null },
): Signal {
  return {
    id: args.id as Signal['id'],
    subject: s.subject,
    category: s.category,
    severity: s.severity,
    title: s.title,
    explanation: s.whatChanged,
    evidenceIds: args.evidenceIds as unknown as Signal['evidenceIds'],
    sourceTypes: s.sourceTypes,
    confidence: { band: s.confidence.band, value: s.confidence.value, basis: s.confidence.basis },
    generatedAt: new Date(s.periodEnd).toISOString(),
    expiresAt: s.expiresAt,
    status: 'open',
    recommendedActions: s.recommendedActions,
    humanReviewRequired: s.humanReviewRequired,
    layer: s.layer,
    decisionUse: s.decisionUse,
    organisationId: args.organisationId as Signal['organisationId'],
    computationId: (args.computationId || null) as Signal['computationId'],
  };
}

// =================================================================================================
// THE ANTI-SPAM DECISION
// =================================================================================================
//
// FIVE MECHANISMS, ONE FUNCTION, NO DATABASE.
//
//   deduplication  the same finding about the same person is one row (dedupeKeyFor)
//   cooldown       a row already notified about stays quiet for a per-band window
//   escalation     a finding that gets worse breaks its own cooldown, because that is the case a
//                  cooldown exists to survive rather than to suppress
//   resolution     a closed row stays closed
//   reactivation   ...unless there is evidence that did not exist when it was closed
//
// The engine calls this BEFORE it writes anything and does exactly what it says.

export const COOLDOWN_HOURS: Record<AttentionBand, number> = { green: 168, blue: 168, yellow: 72, red: 12 };

/** The engine bookkeeping for a signal already on file. Held in this patch's sidecar table. */
export interface ExistingSignalState {
  signalId: string;
  band: AttentionBand;
  status: string;
  evidenceRefs: string[];
  lastNotifiedAt: string | null;
  cooldownUntil: string | null;
  closedAt: string | null;
  occurrenceCount: number;
}

/** A human has already engaged with these: re-notifying is noise unless it escalates. */
export const ENGAGED_STATUSES: readonly string[] = Object.freeze(['acknowledged', 'in_progress']);
/** Closed out. Only NEW evidence may bring one back. */
export const CLOSED_STATUSES: readonly string[] = Object.freeze(['resolved', 'dismissed', 'expired']);

export type SignalAction = 'insert' | 'update' | 'escalate' | 'reactivate' | 'suppress';

export interface NotificationDecision {
  action: SignalAction;
  notify: boolean;
  reason: string;
  newEvidenceRefs: string[];
  cooldownUntil: string | null;
}

/**
 * Evidence the stored row has never seen.
 *
 * COMPARED BY THE SOURCE REFERENCE — the row the evidence IS — not by its summary, which is prose. A
 * detector that reworded its own sentence must not be able to resurrect a signal somebody closed.
 */
export function evidenceRefOf(e: Evidence): string {
  return String(e.sourceType) + ':' + String(e.sourceId);
}

export function newEvidenceRefs(existing: ExistingSignalState, candidate: AdmittedSignal): string[] {
  const seen = new Set((existing?.evidenceRefs || []).map(String));
  const fresh: string[] = [];
  for (const e of candidate.evidence) {
    const ref = evidenceRefOf(e);
    if (!seen.has(ref) && fresh.indexOf(ref) < 0) fresh.push(ref);
  }
  return fresh;
}

/**
 * Evidence that is both new AND happened after the row was closed.
 *
 * The second half matters. Backfilling an old record is not a new development, and a detector that
 * reads further back next week must not reopen everything that was ever settled.
 */
export function reactivatingEvidence(existing: ExistingSignalState, candidate: AdmittedSignal): string[] {
  const closedAt = existing?.closedAt ? Date.parse(existing.closedAt) : NaN;
  const fresh = new Set(newEvidenceRefs(existing, candidate));
  return candidate.evidence
    .filter((e) => fresh.has(evidenceRefOf(e)))
    .filter((e) => (Number.isNaN(closedAt) ? true : Date.parse(e.timestamp) > closedAt))
    .map(evidenceRefOf);
}

export function cooldownEndsAt(band: AttentionBand, from: Date): string {
  return new Date(from.getTime() + COOLDOWN_HOURS[band] * 3600000).toISOString();
}

export function notificationDecision(
  existing: ExistingSignalState | null,
  candidate: AdmittedSignal,
  now: Date,
): NotificationDecision {
  if (!existing) {
    return {
      action: 'insert',
      notify: true,
      reason: 'First time this finding has been raised for this person.',
      newEvidenceRefs: candidate.evidence.map(evidenceRefOf),
      cooldownUntil: cooldownEndsAt(candidate.band, now),
    };
  }

  const fresh = newEvidenceRefs(existing, candidate);

  if (CLOSED_STATUSES.indexOf(existing.status) >= 0) {
    const reactivating = reactivatingEvidence(existing, candidate);
    if (reactivating.length === 0) {
      return {
        action: 'suppress',
        notify: false,
        reason:
          'Already ' +
          existing.status +
          ', and nothing has happened since that was not already considered. A closed signal reopens only on new evidence.',
        newEvidenceRefs: [],
        cooldownUntil: existing.cooldownUntil,
      };
    }
    return {
      action: 'reactivate',
      notify: true,
      reason:
        'Reopened: ' + reactivating.length + ' record(s) dated after it was ' + existing.status + ' that it had not seen.',
      newEvidenceRefs: reactivating,
      cooldownUntil: cooldownEndsAt(candidate.band, now),
    };
  }

  if (escalates(existing.band, candidate.band)) {
    return {
      action: 'escalate',
      notify: true,
      reason:
        'Escalated from ' +
        BAND_LABELS[existing.band] +
        ' to ' +
        BAND_LABELS[candidate.band] +
        '. An escalation is told immediately; a cooldown exists to stop repetition, not to hold back a change.',
      newEvidenceRefs: fresh,
      cooldownUntil: cooldownEndsAt(candidate.band, now),
    };
  }

  if (fresh.length === 0) {
    return {
      action: 'update',
      notify: false,
      reason: 'Seen again with the same evidence. The row records that it is still current; nobody is told twice.',
      newEvidenceRefs: [],
      cooldownUntil: existing.cooldownUntil,
    };
  }

  if (ENGAGED_STATUSES.indexOf(existing.status) >= 0) {
    return {
      action: 'update',
      notify: false,
      reason:
        'Somebody has already ' +
        (existing.status === 'in_progress' ? 'started working on' : 'acknowledged') +
        ' this. New evidence is added to the row; they are not re-notified unless it escalates.',
      newEvidenceRefs: fresh,
      cooldownUntil: existing.cooldownUntil,
    };
  }

  const until = existing.cooldownUntil ? Date.parse(existing.cooldownUntil) : NaN;
  if (!Number.isNaN(until) && now.getTime() < until) {
    return {
      action: 'update',
      notify: false,
      reason:
        'Within the ' +
        COOLDOWN_HOURS[candidate.band] +
        '-hour cooldown for ' +
        BAND_LABELS[candidate.band] +
        '. The evidence is added; the notification is not repeated.',
      newEvidenceRefs: fresh,
      cooldownUntil: existing.cooldownUntil,
    };
  }

  return {
    action: 'update',
    notify: true,
    reason: 'New evidence after the cooldown had passed.',
    newEvidenceRefs: fresh,
    cooldownUntil: cooldownEndsAt(candidate.band, now),
  };
}

// =================================================================================================
// THE EXPLAINABILITY CHAIN
// =================================================================================================

export interface SignalExplanation {
  inputs: SignalInput[];
  processing: string;
  output: {
    title: string;
    whatChanged: string;
    band: AttentionBand;
    bandLabel: string;
    severity: SignalSeverity;
    category: string;
    dimension: string;
    recommendedActions: RecommendedAction[];
  };
  evidence: { ref: string; summary: string; sourceType: string; evidenceClass: string; occurredAt: string }[];
  sourceTypes: string[];
  confidence: { band: string; value: number; terms: string[] };
  timestamp: { periodStart: string; periodEnd: string; expiresAt: string; computedAt: string };
  humanReview: { required: boolean; reviewer: ReviewerKind; reviewerLabel: string; note: string };
  contextNote: string | null;
}

/** INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP, assembled from the row. */
export function explain(s: AdmittedSignal, computedAt: Date): SignalExplanation {
  return {
    inputs: s.inputs,
    processing: s.processing,
    output: {
      title: s.title,
      whatChanged: s.whatChanged,
      band: s.band,
      bandLabel: BAND_LABELS[s.band],
      severity: s.severity,
      category: s.category,
      dimension: s.dimension,
      recommendedActions: s.recommendedActions,
    },
    evidence: s.evidence.map((e) => ({
      ref: evidenceRefOf(e),
      summary: e.summary,
      sourceType: String(e.sourceType),
      evidenceClass: String(e.evidenceClass),
      occurredAt: e.timestamp,
    })),
    sourceTypes: s.sourceTypes.map(String),
    confidence: { band: s.confidence.band, value: s.confidence.value, terms: s.confidence.terms },
    timestamp: {
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      expiresAt: s.expiresAt,
      computedAt: computedAt.toISOString(),
    },
    humanReview: {
      required: s.humanReviewRequired,
      reviewer: s.reviewerKind,
      reviewerLabel: REVIEWER_KIND_LABELS[s.reviewerKind],
      note:
        s.band === 'red'
          ? 'An Attention signal is a request for a person to look. It is not a finding against anybody and it authorises nothing.'
          : 'This is an observation. Whatever follows from it is a human’s call.',
    },
    contextNote:
      s.profile.nonEvidentialCount > 0
        ? s.profile.nonEvidentialCount +
          ' non-evidential item(s) were present as context and were excluded from the confidence figure. They carry no weight here and are not presented as established fact.'
        : null,
  };
}
