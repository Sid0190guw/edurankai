// src/lib/horizon/interpretation/evidence.ts — DEMONSTRATED WORK OUTRANKS EVERY INDICATION.
//
// =================================================================================================
// THE RULE THIS FILE MAKES MECHANICAL
// =================================================================================================
//
// Actual demonstrated job-related evidence carries more decision weight than any inferred insight.
// That is easy to write in a policy and easy to lose in a UI, where a confident-looking indication
// and a thin evidence chain sit side by side and the eye goes to whichever is rendered larger.
//
// So precedence is not left to a template. Every dimension the engine emits carries a resolved
// `precedence` field, and where demonstrated evidence exists for that dimension the interpretation is
// marked SUPERSEDED: its confidence is demoted, its implications are held back, and the surface is
// told in words to read the evidence instead. The indication is not deleted — deleting it would hide
// a disagreement that a human should see — it is DEMOTED, visibly.
//
// =================================================================================================
// THIS MODULE OWNS NO EVIDENCE
// =================================================================================================
//
// src/lib/evidence-graph.ts already owns capability claims, their evidence chains and their
// verification status, and it is the only writer of that record. Nothing here duplicates it. What
// this file provides is an INTERFACE — a provider slot an adapter can fill by asking the evidence
// graph, or by asking whatever the deployment uses — plus the precedence arithmetic, which is small,
// pure and testable without a database.
//
// With no provider registered the answer is `unknown`, and `unknown` is NOT the same as "no evidence
// exists". An interpretation computed while the evidence side is unreadable says so on every
// dimension, because "we did not check" presented as "nothing was found" is how an indication
// quietly acquires authority it was never given.
import type { DimensionId } from './dimensions';
import type { HorizonSubject } from './contract';

export type EvidencePresence = 'demonstrated' | 'claimed_only' | 'nothing_on_record' | 'unknown';

export interface DimensionEvidence {
  dimension: DimensionId;
  presence: EvidencePresence;
  /**
   * Where the evidence lives, as a pointer a human can follow — a module name, a record type, a
   * count. NEVER the evidence content itself: this layer has no authorisation to read or restate it,
   * and a summary of somebody's record copied into an interpretation is a second, unverified copy of
   * a fact that already has an owner.
   */
  sources: string[];
}

export type EvidenceProviderState = 'ok' | 'not_configured' | 'unreadable';

export interface EvidenceContext {
  state: EvidenceProviderState;
  items: DimensionEvidence[];
  reason?: string;
}

export type EvidenceProvider = (subject: HorizonSubject) => Promise<EvidenceContext>;

let _provider: EvidenceProvider | null = null;
let _providerName = '';

export function registerEvidenceProvider(name: string, fn: EvidenceProvider): void {
  _provider = fn;
  _providerName = String(name || 'unnamed');
}

export function evidenceProviderName(): string {
  return _provider ? _providerName : '';
}

export function clearEvidenceProvider(): void {
  _provider = null;
  _providerName = '';
}

export const NO_EVIDENCE_CONTEXT: EvidenceContext = {
  state: 'not_configured',
  items: [],
  reason: 'No demonstrated-evidence source is connected, so this interpretation could not be compared against work on record.',
};

export async function fetchEvidenceContext(subject: HorizonSubject): Promise<EvidenceContext> {
  if (!_provider) return NO_EVIDENCE_CONTEXT;
  try {
    const r = await _provider(subject);
    if (!r || typeof r !== 'object' || !Array.isArray(r.items)) {
      return { state: 'unreadable', items: [], reason: 'The demonstrated-evidence source returned nothing usable.' };
    }
    return r;
  } catch (e: any) {
    console.error('[horizon-interpretation] evidence provider', e?.cause?.message || e?.message);
    return { state: 'unreadable', items: [], reason: 'The demonstrated-evidence source could not be read.' };
  }
}

// =================================================================================================
// PRECEDENCE
// =================================================================================================

export type Precedence =
  /** Work on record covers this dimension. That record governs; this indication is context only. */
  | 'demonstrated_evidence_governs'
  /** Nothing demonstrated on record. The indication stands alone — which is the WEAKEST case, not
   *  the strongest, and the wording on the surface says so. */
  | 'no_demonstrated_evidence'
  /** Somebody has asserted something but nothing supports it yet. Still not demonstrated. */
  | 'claimed_only'
  /** The evidence side was not consulted or could not be read. */
  | 'evidence_unknown';

export interface PrecedenceOutcome {
  precedence: Precedence;
  /** True when the evidence record governs and this indication must be read as secondary. */
  superseded: boolean;
  /** Multiplier applied to the indication's confidence. Never above 1: this file only demotes. */
  confidenceFactor: number;
  /** The sentence the surface prints beside the dimension. Neutral, and honest about which way
   *  the weight falls. */
  sentence: string;
  sources: string[];
}

/**
 * How much an indication is demoted when demonstrated work already covers the same ground.
 *
 * Half, and stated as a named constant rather than buried in an expression, because it is a POLICY
 * number: it decides how loud an inference is allowed to be next to a fact. Changing it is a policy
 * change and should be reviewed as one.
 */
export const SUPERSEDED_CONFIDENCE_FACTOR = 0.5;

/** Demotion when the evidence side could not be consulted at all. Smaller than the superseded case
 *  is large: not knowing is not the same as knowing there is nothing, and an unchecked indication
 *  must not read as a confirmed one. */
export const UNKNOWN_EVIDENCE_CONFIDENCE_FACTOR = 0.75;

export function resolvePrecedence(dimension: DimensionId, ctx: EvidenceContext): PrecedenceOutcome {
  if (!ctx || ctx.state !== 'ok') {
    return {
      precedence: 'evidence_unknown',
      superseded: false,
      confidenceFactor: UNKNOWN_EVIDENCE_CONFIDENCE_FACTOR,
      sentence:
        'Work on record was not consulted for this dimension' +
        (ctx?.reason ? ' (' + ctx.reason + ')' : '') +
        ', so this indication has not been compared against anything demonstrated.',
      sources: [],
    };
  }
  const item = ctx.items.find((i) => i && i.dimension === dimension);
  if (!item || item.presence === 'unknown') {
    return {
      precedence: 'evidence_unknown',
      superseded: false,
      confidenceFactor: UNKNOWN_EVIDENCE_CONFIDENCE_FACTOR,
      sentence: 'Work on record was not consulted for this dimension, so this indication stands unchecked.',
      sources: [],
    };
  }
  if (item.presence === 'demonstrated') {
    return {
      precedence: 'demonstrated_evidence_governs',
      superseded: true,
      confidenceFactor: SUPERSEDED_CONFIDENCE_FACTOR,
      sentence:
        'There is demonstrated work on record covering this dimension. That record governs and this indication is background context only.',
      sources: item.sources || [],
    };
  }
  if (item.presence === 'claimed_only') {
    return {
      precedence: 'claimed_only',
      superseded: false,
      confidenceFactor: 1,
      sentence:
        'Something has been stated about this dimension but nothing on record supports it yet. Neither the statement nor this indication is demonstrated work.',
      sources: item.sources || [],
    };
  }
  return {
    precedence: 'no_demonstrated_evidence',
    superseded: false,
    confidenceFactor: 1,
    sentence:
      'Nothing demonstrated is on record for this dimension. This indication is the weakest kind of signal available and must not be treated as a substitute for evidence.',
    sources: item.sources || [],
  };
}
