// src/lib/horizon/behaviour/provider.ts — PATCH 04's contribution to the Master Employee
// Intelligence Record, expressed in the shared HORIZON contract and nothing else.
//
// =================================================================================================
// WHY THIS FILE EXISTS SEPARATELY FROM THE ENGINE
// =================================================================================================
//
// Everything under this directory computes behaviour from work records. NOTHING under it, except
// this file, knows that HORIZON exists. That separation is deliberate and it is what rule 5 asks
// for: the engine is testable, replaceable and readable on its own, and the coupling to another
// patch's contract lives in one adapter that can be rewritten when that contract moves.
//
// The mapping is one-directional and lossy on purpose. A `BehaviourTrend` carries a baseline, a
// tolerance, a sub-period pattern and a paragraph of caveats; an `IntelligenceResult` carries a
// value, a confidence and evidence. What does not survive the mapping stays reachable through
// `computeBehaviouralProfile()`, which is why the drill-down path is the profile and not this.
//
// =================================================================================================
// THE ACCESS HOLE THIS FILE REFUSES TO OPEN
// =================================================================================================
//
// `ProviderContext` carries a subject and a request id — NO VIEWER. `composeRecord()` does not
// authorise; it composes, and the surface above it is expected to have resolved access with
// resolveHorizonAccess() already.
//
// PATCH 04 will not read a person's work history on the strength of that expectation. Its own
// guarantee is that no record about anybody is read until authoriseBehaviourRead() has said yes AND
// the access-log row has landed, and a provider that quietly skipped both would make that guarantee
// false through the back door while every comment in this directory went on claiming it.
//
// So: this provider FAILS CLOSED. With no viewer resolved for the request it contributes a
// `not_computed` result whose reason says exactly that — which is a true, useful, auditable section
// of the record, and is the same shape the contract already uses for anything unreadable. The
// surface that composes records injects `setBehaviourViewerResolver()` once, at start-up, mapping
// its own request id to the viewer it has already authenticated. That seam is the integration
// instruction in the handoff, and until it is wired the record simply says this section was not
// opened.
import type {
  DimensionRef,
  Evidence,
  EvidenceId,
  IntelligenceResult,
  MeirProvider,
  OrganisationId,
  ProviderContext,
  ResultId,
  SourceContribution,
  Confidence as HorizonConfidence,
  EvidenceSourceType,
  EvidenceClass,
} from '@/lib/horizon';
import { buildIntelligenceResult, bandOf, DEFAULT_ORGANISATION_ID } from '@/lib/horizon';
import type {
  BehaviouralProfile,
  BehaviourMetricKey,
  BehaviourPurpose,
  BehaviourTrend,
  EvidenceRef,
  MetricValue,
} from './types';
import { METRIC_META } from './metrics';
import { computeBehaviouralProfile } from './profile';
import type { ViewerContext } from './access';

/** Unique across the patch series. registerProvider() refuses a second registration under it. */
export const PATCH_ID = 'horizon-behaviour';

export const ENGINE_ID = 'horizon.behaviour.work-pattern';

/**
 * Bumped whenever a metric definition, a threshold or a window boundary changes.
 *
 * It is not decoration. A result computed under 1.0.0 and one computed under 1.1.0 may disagree for
 * reasons that have nothing to do with the person, and a reviewer comparing them six months from now
 * has no other way to find that out.
 */
export const ENGINE_VERSION = '1.0.0';

/**
 * How long a behavioural result stands before a screen must call it stale.
 *
 * Fourteen days, matching the 'recent' window: past that, the most recent thing this result rests on
 * has fallen out of the shortest period the engine reports, so the result is describing a period the
 * reader is no longer looking at.
 */
export const RECOMPUTE_AFTER_DAYS = 14;

/**
 * WHICH FAMILY EACH METRIC BELONGS TO.
 *
 * The families are the shared contract's, not this patch's, and the mapping is written out rather
 * than derived so that a reader can disagree with a single line of it. Two judgements worth naming:
 *
 *   REWORK IS 'growth', NOT 'risk'. Work coming back from review is how somebody's output gets
 *   better, and filing it under attention areas would put a person on a risk screen for having been
 *   reviewed carefully.
 *
 *   NOTHING MAPS TO 'risk' OR 'wellbeing_aggregate' AT ALL. This engine reads task timestamps. It
 *   has no basis for saying anybody is a risk, and it must never be the reason a wellbeing surface
 *   lights up — that data is gated elsewhere, individually invisible by design, and nothing here
 *   goes anywhere near it.
 */
export const DIMENSIONS: Readonly<Record<BehaviourMetricKey, DimensionRef>> = Object.freeze({
  acceptance_latency_hours: {
    family: 'reliability', key: 'behaviour.acceptance_latency', label: 'Time to accept assigned work',
  },
  first_response_latency_hours: {
    family: 'reliability', key: 'behaviour.first_response', label: 'Time to first action on assigned work',
  },
  on_time_completion_rate: {
    family: 'reliability', key: 'behaviour.on_time_completion', label: 'Completed by the recorded due date',
  },
  overdue_days_when_late: {
    family: 'reliability', key: 'behaviour.overdue_extent', label: 'How late, when late',
  },
  follow_through_rate: {
    family: 'reliability', key: 'behaviour.follow_through', label: 'Accepted work that reached completion',
  },
  timing_consistency: {
    family: 'reliability', key: 'behaviour.timing_consistency', label: 'Predictability of delivery against due dates',
  },
  revision_frequency: {
    family: 'growth', key: 'behaviour.revision_frequency', label: 'Returns per submitted task',
  },
  rework_rate: {
    family: 'growth', key: 'behaviour.rework_rate', label: 'Tasks returned at least once',
  },
  assessment_submission_rate: {
    family: 'growth', key: 'behaviour.assessment_submission', label: 'Started assessments that were submitted',
  },
  assessment_time_to_submit_hours: {
    family: 'growth', key: 'behaviour.assessment_pace', label: 'Time taken between starting and submitting',
  },
  blocked_with_stated_reason_rate: {
    family: 'collaboration', key: 'behaviour.blocked_disclosure', label: 'Blocks raised with a stated reason',
  },
  self_driven_transition_share: {
    family: 'contribution', key: 'behaviour.self_driven', label: 'Changes made by this person on their own tasks',
  },
  project_participation_count: {
    family: 'contribution', key: 'behaviour.project_participation', label: 'Distinct projects with recorded activity',
  },
});

/** Which contract source type each of this patch's tables reports as. */
const SOURCE_TYPE: Record<EvidenceRef['sourceTable'], EvidenceSourceType> = {
  employee_tasks: 'task',
  // A transition row is the platform's own record of a task moving. It is task evidence about the
  // work, not a separate kind of thing, and calling it 'system_computation' would let a real
  // recorded event be read as something the system worked out.
  audit_log: 'task',
  edu_attempts: 'assessment',
};

/**
 * EVIDENCE CLASS. 'observed', and not 'demonstrated', for every row this patch produces.
 *
 * The distinction matters under rule 22. A completed assessment with a passing mark is DEMONSTRATED
 * job-related evidence — somebody did a thing and the platform holds the result. A timestamp saying
 * a task moved from one column to another is an OBSERVATION about how work flowed. Claiming the
 * stronger class would let punctuality outrank a demonstrated skill in the confidence arithmetic,
 * which is precisely the inversion rule 22 exists to prevent.
 */
const EVIDENCE_CLASS: EvidenceClass = 'observed';

// -------------------------------------------------------------------------------------------------
// THE VIEWER SEAM
// -------------------------------------------------------------------------------------------------

export type BehaviourViewerResolver = (
  ctx: ProviderContext,
) => Promise<{ viewer: ViewerContext; purpose: BehaviourPurpose } | null>;

let viewerResolver: BehaviourViewerResolver | null = null;

/**
 * Tell this provider how to find the viewer for a composition request.
 *
 * Called ONCE at start-up by whichever surface composes records. Passing null returns the provider
 * to its default, which is to contribute nothing and say why.
 */
export function setBehaviourViewerResolver(fn: BehaviourViewerResolver | null): void {
  viewerResolver = fn;
}

// -------------------------------------------------------------------------------------------------
// MAPPING
// -------------------------------------------------------------------------------------------------

const evidenceId = (r: EvidenceRef): EvidenceId => `${r.sourceTable}:${r.sourceId}:${r.sourceField}`;

function toEvidence(r: EvidenceRef, organisationId: OrganisationId): Evidence {
  return {
    id: evidenceId(r),
    sourceType: SOURCE_TYPE[r.sourceTable],
    sourceId: r.sourceId,
    timestamp: r.occurredAt,
    // RELEVANCE IS HIGH AND RELIABILITY IS HIGHER, and the two are not the same claim. The row is a
    // machine-written record of an event that certainly happened, so it is reliable; whether that
    // event bears on the dimension is a judgement, so it is graded a shade lower and says why.
    relevance: {
      value: 0.7,
      band: bandOf(0.7),
      basis: 'A recorded transition on this person’s own assigned work, inside the period reported.',
    },
    reliability: {
      value: 0.9,
      band: bandOf(0.9),
      basis: 'Written by the platform at the moment the change was made, not entered afterwards by anybody.',
    },
    summary: r.statement,
    rawReference: {
      ownerModule:
        r.sourceTable === 'edu_attempts' ? 'src/lib/assessment.ts' : 'src/lib/employee-tasks.ts',
      table: r.sourceTable,
      recordId: r.sourceId,
      locator: r.sourceField,
      documentUrl: null,
    },
    evidenceClass: EVIDENCE_CLASS,
    // Arithmetic over rows the platform already held. Not an inference and not a raw record.
    layer: 'computed',
    // These are organisational work records kept to run the work. Nothing here was collected under a
    // consent given for something else, and nothing was collected covertly.
    collectedUnder: 'organisational_record',
    organisationId,
  };
}

function confidenceOf(t: BehaviourTrend): HorizonConfidence {
  // 'none' has no counterpart in the contract's three-band vocabulary, and the honest mapping is
  // down, not up: a result the engine has no confidence in is reported at the floor with the reason
  // attached rather than promoted to 'low'.
  const band = t.confidence.band === 'none' || t.confidence.band === 'low' ? 'low' : t.confidence.band;
  return {
    band,
    value: null,
    basis: t.confidence.reasons.join(' '),
  };
}

function contributionsOf(evidence: readonly EvidenceRef[]): SourceContribution[] {
  const byType = new Map<EvidenceSourceType, EvidenceRef[]>();
  for (const e of evidence) {
    const t = SOURCE_TYPE[e.sourceTable];
    const list = byType.get(t) || [];
    list.push(e);
    byType.set(t, list);
  }
  const total = evidence.length || 1;
  // Weights are the honest thing they look like: the share of the cited rows that came from each
  // source type. This engine does not weight sources differently, so a weight that claimed otherwise
  // would be a fabricated number in the one field rule 23 exists to make checkable.
  return [...byType.entries()].map(([sourceType, list]) => ({
    sourceType,
    weight: list.length / total,
    evidenceIds: list.map(evidenceId),
    strongestClass: EVIDENCE_CLASS,
    note: `${list.length} of ${evidence.length} cited rows.`,
  }));
}

/** The scale a metric's value sits on, so a screen never has to guess where 0.4 falls. */
function scaleFor(key: BehaviourMetricKey, value: number): { min: number; max: number } {
  const unit = METRIC_META[key].unit;
  if (unit === 'ratio' || unit === 'index') return { min: 0, max: 1 };
  // Durations and counts have no natural ceiling. The observed value is the top of its own scale,
  // which at least stops a renderer inventing one.
  return { min: 0, max: Math.max(value, 1) };
}

/**
 * ONE TREND -> ONE RESULT.
 *
 * `not_computed` is returned wherever the trend could not be assessed, carrying the engine's own
 * sentence. That is the contract's own idiom and it is why nothing here has to invent a zero.
 */
export function toIntelligenceResult(
  profile: BehaviouralProfile,
  trend: BehaviourTrend,
  metric: MetricValue | undefined,
  organisationId: OrganisationId,
  computationId: string,
): IntelligenceResult | null {
  const dimension = DIMENSIONS[trend.key];
  if (!dimension) return null;

  const evidence = trend.evidence.map((e) => toEvidence(e, organisationId));
  const notComputed = trend.verdict === 'insufficient_evidence' || trend.current === null;

  const id: ResultId = `${PATCH_ID}:${profile.employeeId}:${dimension.key}:${trend.window}:${computationId}`;

  return {
    id,
    subject: {
      kind: 'employee',
      id: profile.employeeId,
      idScheme: 'hr_employee',
      organisationId,
    },
    dimension,
    scoreOrLevel: notComputed
      ? { kind: 'not_computed', reason: trend.statement }
      : {
          kind: 'numeric',
          value: trend.current as number,
          ...(() => {
            const s = scaleFor(trend.key, trend.current as number);
            return { scaleMin: s.min, scaleMax: s.max };
          })(),
          unit: METRIC_META[trend.key].unit,
        },
    confidence: confidenceOf(trend),
    status: notComputed ? 'unreadable' : 'active',
    // The engine's own sentence, verbatim. It already names the baseline, the sample size, the
    // pattern and the fact that it decides nothing — rewriting it here would be a second, shorter,
    // less careful account of the same finding.
    summary: trend.statement,
    evidence,
    sourceBreakdown: notComputed ? [] : contributionsOf(trend.evidence),
    computedAt: profile.computedAtIso,
    validFor: {
      staleAt: new Date(Date.parse(profile.computedAtIso) + RECOMPUTE_AFTER_DAYS * 86_400_000).toISOString(),
      recomputeAfterDays: RECOMPUTE_AFTER_DAYS,
    },
    modelOrEngineVersion: {
      engineId: ENGINE_ID,
      // Medians, dispersion and threshold comparison over recorded events. Not a model, and calling
      // it one would claim a sophistication that would make the output harder to argue with.
      engineClass: 'statistical',
      version: ENGINE_VERSION,
      computationId,
    },
    // Rule 15. Nothing here is acted on until a named human has read it, and the contract is where
    // that gets enforced rather than remembered.
    humanReviewStatus: 'pending',
    layer: 'computed',
    decisionUse: 'advisory_only',
    // These are this platform's own records of what happened, which is the weakest and most honest
    // of the four standings available. It is not an established method and does not claim to be.
    scientificStatus: 'platform_record',
    organisationId,
    profileId: null,
    supersedes: null,
    unreadable: notComputed ? trend.statement : null,
  };
}

/** The one result contributed when the provider declines to read anything. */
function refusalResult(ctx: ProviderContext, reason: string): IntelligenceResult {
  const organisationId = ctx.organisationId || DEFAULT_ORGANISATION_ID;
  const now = new Date().toISOString();
  return {
    id: `${PATCH_ID}:${ctx.subject.id}:section:${ctx.requestId}`,
    subject: ctx.subject,
    dimension: {
      family: 'reliability',
      key: 'behaviour.section',
      label: 'Working patterns from recorded work',
    },
    scoreOrLevel: { kind: 'not_computed', reason },
    confidence: { band: 'low', value: null, basis: reason },
    status: 'unreadable',
    summary: reason,
    evidence: [],
    sourceBreakdown: [],
    computedAt: now,
    validFor: { staleAt: new Date(Date.now() + 3_600_000).toISOString(), recomputeAfterDays: 1 },
    modelOrEngineVersion: {
      engineId: ENGINE_ID,
      engineClass: 'statistical',
      version: ENGINE_VERSION,
      computationId: `${PATCH_ID}:refused:${ctx.requestId}`,
    },
    humanReviewStatus: 'not_required',
    layer: 'computed',
    decisionUse: 'advisory_only',
    scientificStatus: 'platform_record',
    organisationId,
    unreadable: reason,
  };
}

// -------------------------------------------------------------------------------------------------
// THE PROVIDER
// -------------------------------------------------------------------------------------------------

export const behaviourProvider: MeirProvider = {
  patchId: PATCH_ID,
  label: 'Working patterns from recorded work',
  dimensions: Object.values(DIMENSIONS),
  // HONEST 'false'. The engine reads a fixed window ending now and does not reconstruct what the
  // record said on an arbitrary past date. Claiming otherwise would return today's answer under an
  // old date, which the contract's own comment on `asOf` names as the thing not to do.
  historicalSupport: false,

  async read(ctx: ProviderContext): Promise<readonly IntelligenceResult[]> {
    if (ctx.subject.kind !== 'employee' || ctx.subject.idScheme !== 'hr_employee') {
      return [
        refusalResult(
          ctx,
          'Working patterns are computed from employment work records, so they are reported for employee records only.',
        ),
      ];
    }

    if (ctx.asOf) {
      return [
        refusalResult(
          ctx,
          'This section cannot reconstruct what the record said on a past date, so it declines rather than return today’s figures under an earlier one.',
        ),
      ];
    }

    if (!viewerResolver) {
      return [
        refusalResult(
          ctx,
          'This section was not opened: no viewer has been established for this request, and working patterns are never read without an authorised reader and an access-log entry.',
        ),
      ];
    }

    let resolved: { viewer: ViewerContext; purpose: BehaviourPurpose } | null = null;
    try {
      resolved = await viewerResolver(ctx);
    } catch (e: any) {
      console.error('[behaviour/provider] viewerResolver ' + (e?.cause?.message || e?.message));
      resolved = null;
    }
    if (!resolved) {
      return [
        refusalResult(
          ctx,
          'This section was not opened: the reader for this request could not be established, and working patterns are never read without one.',
        ),
      ];
    }

    const organisationId = ctx.organisationId || DEFAULT_ORGANISATION_ID;
    const result = await computeBehaviouralProfile({
      employeeId: String(ctx.subject.id),
      purpose: resolved.purpose,
      viewer: resolved.viewer,
    });

    if (!result.ok) return [refusalResult(ctx, result.access.reason)];

    const profile = result.profile;
    const computationId = `${PATCH_ID}:${profile.computedAtIso}:${ctx.requestId}`;
    const metricsByKey = new Map(profile.metrics.map((m) => [`${m.key}:${m.window}`, m] as const));

    const wanted = ctx.families?.length ? new Set(ctx.families) : null;
    const out: IntelligenceResult[] = [];

    for (const trend of profile.trends) {
      const dimension = DIMENSIONS[trend.key];
      if (!dimension) continue;
      if (wanted && !wanted.has(dimension.family)) continue;

      const built = toIntelligenceResult(
        profile,
        trend,
        metricsByKey.get(`${trend.key}:${trend.window}`),
        organisationId,
        computationId,
      );
      if (!built) continue;

      // VALIDATED BEFORE IT LEAVES. A result that fails the shared contract's own rules is DROPPED
      // and logged rather than handed on: the contract exists so that nothing downstream has to
      // re-check, and quietly emitting an invalid one would make that assumption false everywhere.
      const check = buildIntelligenceResult(built);
      if (check.ok) out.push(check.value);
      else console.error('[behaviour/provider] invalid result ' + built.id + ': ' + check.errors.join('; '));
    }

    if (out.length === 0) {
      return [
        refusalResult(
          ctx,
          profile.inputs.observationCount === 0
            ? 'No recorded work events for this person in the periods examined. Nothing here is a statement about them.'
            : 'There were records, but none of them supported a finding that met this engine’s minimum sample. That is unknown, not zero.',
        ),
      ];
    }

    return out;
  },
};

/**
 * Register with the record composer.
 *
 * Idempotent by way of registerProvider() itself, which REFUSES a second registration under the same
 * patchId rather than overwriting — so calling this twice throws loudly instead of silently
 * replacing a live provider.
 */
export async function registerBehaviourProvider(): Promise<() => void> {
  const { registerProvider } = await import('@/lib/horizon');
  return registerProvider(behaviourProvider);
}
