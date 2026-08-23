// src/lib/horizon/interpretation/contract.ts — THE BOUNDARY BETWEEN PATCH 02 AND PATCH 03.
//
// =================================================================================================
// WHAT THIS FILE IS
// =================================================================================================
//
// PATCH 03 (the Professional Interpretation Layer) consumes structured foundational factors from
// PATCH 02 and emits neutral professional dimensions.
//
// This file is the CONTRACT, not the computation. It declares the shape PATCH 02 must hand over,
// validates anything claiming to be that shape, and holds a provider slot PATCH 02 registers into.
// It computes no foundational factor of its own and it never will: inventing an upstream factor here
// would make a person's interpretation depend on a number nobody upstream ever produced.
//
// The shape is deliberately NOT src/lib/foundational's own `FoundationalFactor`. That module is
// another patch's owned contract and this one must not depend on its internals; the translation
// between them lives in foundational-adapter.ts, on this side of the boundary, where it can be
// changed without touching a file this patch does not own.
//
// WHEN NOTHING IS REGISTERED, THE ANSWER IS THAT NOTHING IS REGISTERED. `not_configured` is a
// first-class state, carried all the way to the surface. This repository already learned the
// difference between "there is nothing on record" and "we could not read it" in
// src/lib/evidence-graph.ts, and the same rule holds here: an empty interpretation rendered from a
// missing provider is a lie about a person, so it is never rendered as an interpretation at all.
//
// =================================================================================================
// WHO OWNS THE SEMANTICS OF A FACTOR
// =================================================================================================
//
// PATCH 02 does. This layer cannot know what an upstream factor code means, and guessing would be
// the single most damaging thing it could do. A factor therefore reaches a dimension in exactly one
// of two DECLARED ways:
//
//   1. THE FACTOR DECLARES IT. `factor.contributesTo` names dimension ids and weights. This is the
//      preferred path: the module that owns the meaning of a factor also owns where it lands.
//   2. A REGISTERED MAPPING DECLARES IT. registerFactorMapping() takes a table keyed by factor code,
//      for upstreams that keep their semantics in configuration rather than on each row.
//
// A factor matching NEITHER is `unmapped`. It contributes to nothing, it is counted, and the count
// is reported on every output. Silence about a dropped input is how a partial interpretation gets
// mistaken for a complete one.
//
// =================================================================================================
// THE UPSTREAM VOCABULARY NEVER REACHES A HUMAN
// =================================================================================================
//
// `code`, `method` and `note` are upstream-internal. Nothing in this layer renders them: the trace
// record stores factor IDS rather than factor descriptions, and every string that could reach a
// screen goes through language-guard.ts first. That is the mechanism behind the requirement that the
// underlying methodology is never exposed in standard UI language.
import { createHash } from 'node:crypto';
import { DIMENSION_IDS, isDimensionId, type DimensionId } from './dimensions';

/** Whose interpretation this is. Mirrors SUBJECT_KINDS in src/lib/evidence-graph.ts exactly — three
 *  id spaces, never merged, so a subject is always a kind plus an id and never a bare string. */
export const SUBJECT_KINDS = ['employee', 'candidate', 'learner'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface HorizonSubject {
  kind: SubjectKind;
  /** hr_employees.id, applications.id or users.id, depending on kind. */
  id: string;
}

export function isSubjectKind(v: unknown): v is SubjectKind {
  return typeof v === 'string' && (SUBJECT_KINDS as readonly string[]).includes(v);
}

export function isSubject(v: unknown): v is HorizonSubject {
  const s = v as HorizonSubject;
  return !!s && isSubjectKind(s.kind) && typeof s.id === 'string' && s.id.trim().length > 0 && s.id.length <= 80;
}

/** Where a factor lands, when the factor itself declares it. */
export interface FactorContribution {
  dimension: DimensionId;
  /** How much of this factor reaches that dimension. 0..1. */
  weight: number;
  /**
   * Which way this contribution points, -1..1, when direction belongs to the MAPPING rather than to
   * the factor.
   *
   * ADDED FOR A REAL UPSTREAM. PATCH 02 publishes a `strength` — a magnitude with no sign, correctly,
   * because a magnitude that arrived with a direction would already be an interpretation. Direction
   * is therefore a property of the claim "this structure relates to that professional dimension in
   * this way", which is a mapping decision made by a named human, not an arithmetic result.
   *
   * Optional, and falls back to the factor's own polarity, so every existing declaration keeps its
   * present meaning.
   */
  polarity?: number;
}

/**
 * ONE STRUCTURED FOUNDATIONAL FACTOR, AS PATCH 02 PRODUCES IT.
 *
 * Everything here belongs to upstream. This layer reads it, weighs it and forgets it — no field on
 * this interface is stored in rendered form, and only `id` survives into the stored trace.
 */
export interface FoundationalFactor {
  /** Stable identifier for this factor within the upstream run. The ONLY field that reaches the
   *  stored trace, so an interpretation can be walked back to its inputs in PATCH 02. */
  id: string;
  /** Upstream's internal code. Never rendered. Used only to look up a registered mapping when the
   *  factor does not declare its own contributions. */
  code: string;
  /** Strength of the factor as computed upstream, normalised to 0..1 by PATCH 02. */
  weight: number;
  /** Direction. -1 pushes a dimension down, +1 pushes it up, 0 is present but directionless. */
  polarity: number;
  /** Upstream's own confidence in this factor, 0..1. Never raised by this layer — only lowered. */
  confidence: number;
  /** Opaque identifier of the computation that produced the factor, and its version. Stored in the
   *  trace for reproducibility; never rendered. */
  method: string;
  methodVersion: string;
  /** Optional upstream commentary. Never rendered without passing the language guard, and never
   *  rendered at all to a viewer without the trace capability. */
  note?: string;
  /** Where this factor lands, declared by the module that owns its meaning. */
  contributesTo?: FactorContribution[];
}

/** THE HANDOVER OBJECT. One subject, one upstream run. */
export interface FoundationalFactorSet {
  subject: HorizonSubject;
  factors: FoundationalFactor[];
  /** ISO timestamp of the UPSTREAM computation, not of this interpretation. Both are stored. */
  computedAt: string;
  /** Which module produced this, and at which version. Recorded on every interpretation. */
  sourceModule: string;
  sourceVersion: string;
  /**
   * Upstream's own statement about whether its inputs were complete. FALSE is not an error and is
   * never suppressed: it lowers confidence and is printed in the limitations of every dimension.
   */
  complete: boolean;
  /**
   * The consent record this processing is covered by. Sensitive personal data is consent-controlled
   * and purpose-limited, so an interpretation without one is REFUSED rather than computed and then
   * hidden. Held as a reference into whatever consent store the organisation already uses; this
   * layer does not own consent and deliberately creates no table for it.
   */
  consentRef?: string | null;
}

/** A mapping table for upstreams that keep factor semantics in configuration. */
export type FactorMappingTable = Record<string, FactorContribution[]>;

export type ProviderState = 'ok' | 'not_configured' | 'refused' | 'unreadable';

export interface FoundationalProviderResult {
  state: ProviderState;
  set?: FoundationalFactorSet;
  /** Why, in a sentence a human can read. Present whenever state is not 'ok'. */
  reason?: string;
}

/** Who is asking, when the upstream needs to know in order to log the read against a person.
 *  Optional throughout: a provider that does not care may ignore it. */
export interface UpstreamContext {
  actorUserId?: string | null;
}

/** What PATCH 02 registers. Asked per subject; may legitimately answer that it has nothing. */
export type FoundationalProvider = (
  subject: HorizonSubject,
  ctx?: UpstreamContext,
) => Promise<FoundationalProviderResult>;

// =================================================================================================
// THE PROVIDER SLOT
// =================================================================================================
//
// Module-scope state, deliberately. There is exactly one foundational upstream for a deployment, and
// a registry keyed by name would invite two of them disagreeing about the same person with no rule
// for which one a screen shows.

let _provider: FoundationalProvider | null = null;
let _providerName = '';
let _mapping: FactorMappingTable = {};
let _mappingName = '';

export function registerFoundationalProvider(name: string, fn: FoundationalProvider): void {
  _provider = fn;
  _providerName = String(name || 'unnamed');
}

export function foundationalProviderName(): string {
  return _provider ? _providerName : '';
}

/** Test seam, and the way a deployment turns this layer off entirely. */
export function clearFoundationalProvider(): void {
  _provider = null;
  _providerName = '';
}

export interface MappingValidation {
  ok: boolean;
  /** Every problem found, not just the first: a mapping is configuration and gets fixed all at once. */
  problems: string[];
  /** Factor codes accepted. */
  codes: string[];
}

/**
 * Validate a mapping table BEFORE it can influence anybody's interpretation.
 *
 * An invalid mapping is not partially applied — registerFactorMapping() refuses the whole table,
 * because a half-applied mapping produces a dimension that is low for a reason nobody can find.
 */
export function validateFactorMapping(table: unknown): MappingValidation {
  const problems: string[] = [];
  const codes: string[] = [];
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { ok: false, problems: ['The mapping must be an object keyed by factor code.'], codes: [] };
  }
  for (const [code, contribs] of Object.entries(table as Record<string, unknown>)) {
    if (!code.trim()) {
      problems.push('A mapping entry has an empty factor code.');
      continue;
    }
    if (!Array.isArray(contribs) || contribs.length === 0) {
      problems.push('Factor code "' + code + '" maps to no dimension.');
      continue;
    }
    let bad = false;
    for (const c of contribs as FactorContribution[]) {
      if (!c || !isDimensionId(c.dimension)) {
        problems.push('Factor code "' + code + '" names an unknown dimension: ' + String((c as any)?.dimension));
        bad = true;
        continue;
      }
      if (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight < 0 || c.weight > 1) {
        problems.push('Factor code "' + code + '" maps to ' + c.dimension + ' with a weight outside 0..1.');
        bad = true;
      }
      if (
        c.polarity !== undefined &&
        (typeof c.polarity !== 'number' || !Number.isFinite(c.polarity) || c.polarity < -1 || c.polarity > 1)
      ) {
        problems.push('Factor code "' + code + '" maps to ' + c.dimension + ' with a direction outside -1..1.');
        bad = true;
      }
    }
    if (!bad) codes.push(code);
  }
  return { ok: problems.length === 0, problems, codes };
}

export function registerFactorMapping(name: string, table: FactorMappingTable): MappingValidation {
  const v = validateFactorMapping(table);
  if (!v.ok) return v;
  _mapping = table;
  _mappingName = String(name || 'unnamed');
  return v;
}

export function factorMappingName(): string {
  return Object.keys(_mapping).length ? _mappingName : '';
}

export function clearFactorMapping(): void {
  _mapping = {};
  _mappingName = '';
}

/**
 * Where a factor lands, resolved through the two declared paths and NOTHING ELSE.
 *
 * Returns an empty array for an unmapped factor. The caller counts those and reports them; it must
 * never fall back to a guess.
 */
export function contributionsFor(factor: FoundationalFactor): FactorContribution[] {
  const declared = Array.isArray(factor.contributesTo) ? factor.contributesTo : [];
  const source = declared.length ? declared : (_mapping[factor.code] || []);
  const out: FactorContribution[] = [];
  for (const c of source) {
    if (!c || !isDimensionId(c.dimension)) continue;
    const w = typeof c.weight === 'number' && Number.isFinite(c.weight) ? Math.max(0, Math.min(1, c.weight)) : 0;
    if (w <= 0) continue;
    const p =
      typeof c.polarity === 'number' && Number.isFinite(c.polarity)
        ? Math.max(-1, Math.min(1, c.polarity))
        : undefined;
    out.push(p === undefined ? { dimension: c.dimension, weight: w } : { dimension: c.dimension, weight: w, polarity: p });
  }
  return out;
}

export interface FactorSetValidation {
  ok: boolean;
  problems: string[];
  /** Factors that survived validation. A malformed factor is DROPPED and counted, never coerced. */
  factors: FoundationalFactor[];
  dropped: number;
}

const clamp01 = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

const clampPolarity = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;

/**
 * Validate a handover object.
 *
 * A factor missing an id, a code or a usable weight is DROPPED rather than defaulted, because a
 * defaulted weight is a number this layer would have invented about a person. Values that are merely
 * out of range are clamped, and the clamping is counted in `dropped` only when it empties a factor.
 */
export function validateFactorSet(input: unknown): FactorSetValidation {
  const problems: string[] = [];
  const set = input as FoundationalFactorSet;
  if (!set || typeof set !== 'object') {
    return { ok: false, problems: ['No foundational factor set was supplied.'], factors: [], dropped: 0 };
  }
  if (!isSubject(set.subject)) problems.push('The factor set names no valid subject.');
  if (!Array.isArray(set.factors)) problems.push('The factor set carries no factor list.');
  if (!set.sourceModule) problems.push('The factor set does not say which module produced it.');
  if (!set.computedAt || Number.isNaN(Date.parse(String(set.computedAt)))) {
    problems.push('The factor set does not carry a valid computation timestamp.');
  }

  const factors: FoundationalFactor[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const f of Array.isArray(set.factors) ? set.factors : []) {
    if (!f || typeof f !== 'object' || !f.id || !f.code) {
      dropped++;
      continue;
    }
    const id = String(f.id);
    if (seen.has(id)) {
      // Two factors with one id cannot be told apart in the trace, so the second is refused rather
      // than counted twice into the same dimension.
      dropped++;
      problems.push('Duplicate factor id "' + id + '" was dropped.');
      continue;
    }
    const weight = clamp01(f.weight);
    if (weight <= 0) {
      // Weight zero is not a factor, it is the absence of one. Kept out rather than carried as a
      // contribution of nothing, which would inflate the "factors considered" count on the output.
      dropped++;
      continue;
    }
    seen.add(id);
    factors.push({
      id,
      code: String(f.code),
      weight,
      polarity: clampPolarity(f.polarity),
      confidence: clamp01(f.confidence),
      method: String(f.method || ''),
      methodVersion: String(f.methodVersion || ''),
      note: typeof f.note === 'string' ? f.note : undefined,
      contributesTo: Array.isArray(f.contributesTo) ? f.contributesTo : undefined,
    });
  }
  if (dropped) problems.push(dropped + ' factor(s) were dropped as malformed, duplicated or empty.');
  return { ok: problems.length === 0, problems, factors, dropped };
}

/**
 * A STABLE FINGERPRINT OF THE INPUT, SO AN OUTPUT CAN BE PROVED TO COME FROM IT.
 *
 * Sorted by factor id and built from the fields that can change an outcome, so the same input always
 * digests the same way and any upstream edit — a weight, a polarity, a contribution — produces a
 * different digest. Stored on every interpretation: this is the traceability link back to PATCH 02.
 *
 * `note` is deliberately excluded. It is commentary, it does not enter the arithmetic, and hashing
 * free text would make an interpretation look changed when nothing that produced it did.
 */
export function digestFactorSet(set: FoundationalFactorSet): string {
  const parts = [...(set.factors || [])]
    .map((f) => ({
      id: String(f.id),
      code: String(f.code),
      w: clamp01(f.weight),
      p: clampPolarity(f.polarity),
      c: clamp01(f.confidence),
      m: String(f.method || '') + '@' + String(f.methodVersion || ''),
      t: contributionsFor(f)
        .map((x) => x.dimension + ':' + x.weight + ':' + (x.polarity === undefined ? 'f' : x.polarity))
        .sort()
        .join(','),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = JSON.stringify({
    subject: set.subject,
    source: String(set.sourceModule || '') + '@' + String(set.sourceVersion || ''),
    computedAt: String(set.computedAt || ''),
    complete: !!set.complete,
    factors: parts,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Ask the registered upstream for a subject's factors. Never throws: a throwing provider is
 *  `unreadable`, which is a different answer from `not_configured` and must stay different. */
export async function fetchFoundationalFactors(
  subject: HorizonSubject,
  ctx?: UpstreamContext,
): Promise<FoundationalProviderResult> {
  if (!isSubject(subject)) {
    return { state: 'refused', reason: 'No person was named.' };
  }
  if (!_provider) {
    return {
      state: 'not_configured',
      reason: 'No foundational input source is connected, so there is nothing to interpret.',
    };
  }
  try {
    const r = await _provider(subject, ctx);
    if (!r || typeof r !== 'object') {
      return { state: 'unreadable', reason: 'The foundational input source returned nothing usable.' };
    }
    return r;
  } catch (e: any) {
    console.error('[horizon-interpretation] provider', e?.cause?.message || e?.message);
    return { state: 'unreadable', reason: 'The foundational input source could not be read.' };
  }
}

/** Every dimension id this contract will accept. Exported for tests and for the self-check. */
export const ACCEPTED_DIMENSIONS: readonly DimensionId[] = DIMENSION_IDS;
