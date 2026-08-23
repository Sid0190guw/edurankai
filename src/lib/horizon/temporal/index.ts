// src/lib/horizon/temporal/index.ts — THE PUBLIC CONTRACT OF PATCH 07, TIME INTELLIGENCE.
//
// =================================================================================================
// WHERE THIS SITS
// =================================================================================================
//
// `@/lib/horizon` is the SHARED contract surface and belongs to the HORIZON core patch. This module
// is Patch 07's own subdirectory underneath it, and it is imported as `@/lib/horizon/temporal`.
// Nothing here is re-exported from the shared barrel, and nothing here edits a shared file: Patch 07
// registers itself through the contracts the core patch published, which is what rule 5 asks for.
//
// What Patch 07 owns:  the seven horizons, the four layers, the confidence arithmetic, the
//                      projection hedge, the foundational-cycle providers, and the trend maths.
// What Patch 07 uses:  hzn_computation / hzn_intelligence_result / hzn_evidence (schema.ts),
//                      the section-provider contract (contracts.ts), the identifier helpers
//                      (ids.ts), and the performance-scope viewer resolution.
// What Patch 07 owns none of: tables, notifications, decisions.
//
// =================================================================================================
// ACCESS: THREE WAYS IN, NO FOURTH
// =================================================================================================
//
// The same three the master employee record uses, asked of the same modules, so a person cannot see
// through this screen what they could not see through that one:
//
//   1. it is you;
//   2. a RELATIONSHIP the Organization Graph records, per row, via canSeePerformanceOf();
//   3. a CAPABILITY, meaning the whole organization without a relationship.
//
// This module imports no authorization engine and must never become one. `holds` is passed in by the
// caller, exactly as src/lib/performance-scope.ts and src/lib/digital-twin.ts require.
//
// ANYBODY PERMITTED TO SEE A READING SEES THE WHOLE CHAIN BEHIND IT: inputs, processing, evidence
// rows, confidence terms. Rule 18 warns against exposing internal computation to roles without
// permission, and the gate that implements it is the gate on the READING. Showing somebody a
// sentence about a person while hiding what produced it is the failure rule 12 exists to prevent.

import { resolvePerfViewer, canSeePerformanceOf, PERF_MANAGE, type PerfViewer } from '@/lib/performance-scope';
import { EMPLOYEE_MANAGE } from '@/lib/digital-twin';
import { gatherEvidence } from './evidence';
import { buildAll, ENGINE_VERSION, type HorizonSet } from './engine';
import { activeResults, recomputeFor, sweepRecompute, staleTargets, type StoredResult } from './store';
import { VERSIONED_HORIZONS, HORIZONS, type Horizon } from './time';

// -------------------------------------------------------------------------------------------------
// Re-exports: the surface the two screens and any later patch use.
// -------------------------------------------------------------------------------------------------

export {
  HORIZONS, VERSIONED_HORIZONS, LIVE_HORIZONS, HORIZON_SPECS, horizonSpec, isHorizon,
  LAYERS, LAYER_LABELS, LAYER_MEANING, LAYER_DECISION_WEIGHT, LAYER_ASSERTION,
  PROJECTION_DISCLAIMER, FOUNDATIONAL_DISCLAIMER,
  confidenceFor, confidenceBand, CONFIDENCE_BAND_LABELS, claimsCertainty, hedged,
  lookbackWindow, forwardWindow, daysBetween, shiftDays, toDay, round2,
  type Horizon, type Layer, type HorizonSpec, type ConfidenceBreakdown, type EvidenceShape, type Window,
} from './time';

export {
  OUTPUT_KEYS, OUTPUT_LABELS, ENGINE_VERSION, trendOf, buildHorizon, buildAll,
  type HorizonReading, type HorizonSet, type HorizonSection, type Signal, type OutputKey,
  type EvidenceRef, type Trend, type Direction, type DecisionWeight,
} from './engine';

export {
  SOURCES, sourceSpec, gatherEvidence, shapeWithin, seriesWithin,
  type TemporalEvidence, type SourceFacts, type SourceSpec, type SeriesPoint, type EmployeeAnchors,
} from './evidence';

export {
  CYCLE_PROVIDERS, CYCLE_BASIS_LABELS, BIRTH_CYCLE_PRECONDITIONS,
  birthGateFailures, currentBirthGate, setBirthGate, computeCycles, cycleProvider,
  tenureCycleProvider, birthCycleProvider, engagementPhase, isRefusal,
  type CycleReading, type CycleRefusal, type CycleLayer, type CycleProvider, type CycleBasis, type CycleInput,
} from './cycles';

export {
  activeResults, resultHistory, recomputeFor, sweepRecompute, staleTargets, storeReading,
  startRun, finishRun, dimensionKeyFor, ENGINE_ID, ENGINE_CLASS, DIMENSION_FAMILY,
  type StoredResult, type RecomputeResult, type SweepResult, type StaleTarget, type ComputationRun,
} from './store';

// =================================================================================================
// ACCESS
// =================================================================================================

export type HorizonScope = 'self' | 'responsible' | 'org' | 'none';

export interface HorizonAccess {
  granted: boolean;
  scope: HorizonScope;
  /** Reading a horizon and asking for it to be rebuilt are different permissions. */
  mayRecompute: boolean;
  /** A sentence a screen prints verbatim. It never guesses and never apologises. */
  because: string;
}

export const NO_ACCESS: HorizonAccess = Object.freeze({
  granted: false,
  scope: 'none',
  mayRecompute: false,
  because:
    'You can see a time reading for yourself, for people you are recorded as responsible for in the '
    + 'organization graph, or with an organization-wide capability. None of those applies here.',
});

/**
 * Resolve, BEFORE any evidence is read, whether this viewer may see this person's horizons.
 *
 * Same shape and same order as twinAccess() in src/lib/digital-twin.ts, deliberately: two screens
 * that answer the same question differently is a defect this repository has already paid for once,
 * in the two performance consoles that gated the same table two different ways.
 */
export async function horizonAccess(
  viewer: PerfViewer,
  employeeId: string,
  holds: (key: string) => boolean,
): Promise<HorizonAccess> {
  const ask = (key: string): boolean => {
    try { return holds(key) === true; } catch { return false; }
  };

  const isSelf = !!viewer.employeeId && viewer.employeeId === employeeId;
  if (isSelf) {
    return {
      granted: true,
      scope: 'self',
      // A person may rebuild their OWN reading. It reads only their own records and writes only
      // their own rows, and refusing it would mean asking permission to see an up-to-date version
      // of a statement about yourself.
      mayRecompute: true,
      because: 'This is your own record.',
    };
  }

  const orgWide = ask(PERF_MANAGE);
  const hrDesk = ask(EMPLOYEE_MANAGE);
  if (orgWide || hrDesk) {
    return {
      granted: true,
      scope: 'org',
      mayRecompute: orgWide,
      because: orgWide
        ? 'You hold an organization-wide performance capability.'
        : 'You hold the employee-management capability.',
    };
  }

  const responsible = await canSeePerformanceOf(viewer, employeeId);
  if (responsible) {
    return {
      granted: true,
      scope: 'responsible',
      mayRecompute: false,
      because:
        'The organization graph records you as responsible for this person. That relationship lets '
        + 'you read their record; it does not let you rebuild it.',
    };
  }

  return NO_ACCESS;
}

// =================================================================================================
// THE READ
// =================================================================================================

export interface HorizonView {
  access: HorizonAccess;
  employeeId: string;
  /** null when access was refused, so a caller cannot render a reading it was not granted. */
  set: HorizonSet | null;
  /** The stored versions behind the versioned horizons, where any exist. */
  stored: Partial<Record<Horizon, StoredResult>>;
  /** Versioned horizons with nothing stored yet. Shown live and labelled as not yet versioned. */
  notYetVersioned: Horizon[];
  engineVersion: string;
  computedAt: string;
}

/**
 * THE ONE FUNCTION A SCREEN CALLS.
 *
 * Short horizons are computed live from a fresh gather. Long horizons come from the store when an
 * active version exists, because the point of versioning them is that the screen and the audit trail
 * show the same sentence. Where nothing is stored yet the live computation is shown and NAMED as not
 * yet versioned, rather than silently written on a read.
 *
 * `today` is a parameter so a caller rendering several people anchors them all on one day.
 */
export async function readHorizonsFor(input: {
  viewerUserId: string;
  employeeId: string;
  holds: (key: string) => boolean;
  today?: string;
}): Promise<HorizonView> {
  const today = input.today || new Date().toISOString().slice(0, 10);
  const computedAt = new Date().toISOString();

  const viewer = await resolvePerfViewer(input.viewerUserId, input.holds);
  const access = await horizonAccess(viewer, input.employeeId, input.holds);

  if (!access.granted) {
    return {
      access, employeeId: input.employeeId, set: null, stored: {},
      notYetVersioned: [], engineVersion: ENGINE_VERSION, computedAt,
    };
  }

  const ev = await gatherEvidence({ employeeId: input.employeeId, today, fromDay: '1970-01-01' });
  const set = buildAll(ev, computedAt);

  // One round trip for every stored horizon, not one per horizon.
  const stored = await activeResults(input.employeeId);
  const notYetVersioned: Horizon[] = [];
  for (const h of VERSIONED_HORIZONS) {
    const s = stored[h];
    if (s && s.reading) set.readings[h] = s.reading;
    else notYetVersioned.push(h);
  }

  return { access, employeeId: input.employeeId, set, stored, notYetVersioned, engineVersion: ENGINE_VERSION, computedAt };
}

// =================================================================================================
// THE EVENT CONTRACT FOR PATCH 08
// =================================================================================================
//
// PATCH 08 OWNS NOTIFICATION. Nothing here sends, enqueues, schedules or delivers one, and nothing
// here imports a notifier. What it does is describe, in a typed shape, the moments in a person's time
// record a notifier might reasonably care about — so Patch 08 consumes a contract instead of reaching
// into this engine's internals or re-deriving them from raw tables.
//
// deriveEvents() is PURE. It takes a reading set and returns descriptions. It writes nothing and has
// no side effects. Whether any of these becomes a message, to whom, how often and with what consent
// is entirely Patch 08's decision, and this module expresses no opinion about it beyond the audience
// hint — which Patch 08 must narrow or honour, never widen.

export const HORIZON_EVENT_KINDS = [
  'horizon.reading_versioned',
  'horizon.confidence_fell',
  'horizon.evidence_stale',
  'horizon.evidence_unreadable',
  'horizon.cycle_phase_changed',
] as const;

export type HorizonEventKind = (typeof HORIZON_EVENT_KINDS)[number];

export interface HorizonTemporalEvent {
  kind: HorizonEventKind;
  employeeId: string;
  horizon: Horizon | null;
  /** A sentence describing what happened, already safe for the audience named below. */
  summary: string;
  /**
   * WHO THIS IS ABOUT AND WHO MAY BE TOLD. 'subject' means the person and nobody else; 'responsible'
   * means the person and whoever the org graph records as responsible for them; 'desk' means the
   * people desk. Patch 08 must not widen it.
   */
  audience: 'subject' | 'responsible' | 'desk';
  /** Never a decision, never an instruction. A notifier must not turn one of these into either. */
  advisory: true;
  occurredAt: string;
  evidence: { table: string; rowCount: number }[];
}

export function deriveEvents(
  set: HorizonSet,
  previous?: Partial<Record<Horizon, StoredResult>>,
): HorizonTemporalEvent[] {
  const out: HorizonTemporalEvent[] = [];
  const at = new Date().toISOString();

  const first = set.readings[HORIZONS[0]];
  const unreadable = first ? first.evidenceSources.filter((s) => s.unreadable) : [];
  if (unreadable.length) {
    out.push({
      kind: 'horizon.evidence_unreadable',
      employeeId: set.employeeId,
      horizon: null,
      summary:
        'Time-intelligence evidence could not be read for ' + unreadable.length + ' sources ('
        + unreadable.map((s) => s.label).join(', ') + '). Any reading shown is incomplete.',
      // The desk, not the person: an outage in our tables is ours to fix, and telling somebody their
      // own record is broken helps them not at all.
      audience: 'desk',
      advisory: true,
      occurredAt: at,
      evidence: unreadable.map((s) => ({ table: s.table, rowCount: 0 })),
    });
  }

  const month = set.readings.month;
  if (month) {
    const stale = month.evidenceSources.filter((s) => !s.unreadable && s.latestDay
      && (new Date(set.today).getTime() - new Date(s.latestDay).getTime()) / 86400000 > 90);
    if (stale.length) {
      out.push({
        kind: 'horizon.evidence_stale',
        employeeId: set.employeeId,
        horizon: 'month',
        summary:
          'No new records in over ninety days from: ' + stale.map((s) => s.label).join(', ')
          + '. Every horizon resting on them is weaker than it looks.',
        audience: 'responsible',
        advisory: true,
        occurredAt: at,
        evidence: stale.map((s) => ({ table: s.table, rowCount: s.rowCount })),
      });
    }
  }

  for (const h of VERSIONED_HORIZONS) {
    const r = set.readings[h];
    const prev = previous?.[h];
    if (!r || !prev) continue;
    if (prev.confidenceValue - r.confidence.value >= 0.1) {
      out.push({
        kind: 'horizon.confidence_fell',
        employeeId: set.employeeId,
        horizon: h,
        summary:
          'Confidence in the ' + r.label + ' reading fell from ' + prev.confidenceValue + ' to '
          + r.confidence.value + '. This describes the RECORD getting thinner or staler, not the person.',
        audience: 'desk',
        advisory: true,
        occurredAt: at,
        evidence: r.evidenceSources.filter((s) => !s.unreadable).map((s) => ({ table: s.table, rowCount: s.rowCount })),
      });
    }
  }

  for (const c of set.cycles.readings) {
    if (c.cycleName === 'Engagement stage' && c.phase === 'confirmation pending') {
      out.push({
        kind: 'horizon.cycle_phase_changed',
        employeeId: set.employeeId,
        horizon: null,
        summary:
          'The recorded probation date has passed and no confirmation date is on file. This is a '
          + 'paperwork gap on the employee record, not a judgement about the person.',
        audience: 'desk',
        advisory: true,
        occurredAt: at,
        evidence: [],
      });
    }
  }

  return out;
}

// =================================================================================================
// THE JOB HANDLERS
// =================================================================================================
//
// Registered additively into src/lib/job-handlers.ts. That file's own test scans the repository for
// enqueue() call sites and fails when one names a kind the worker cannot process — an unregistered
// kind is retried to exhaustion and parked in `failed`, which looks like success from every screen.

import type { JobHandler } from '@/lib/job-queue';

export const HORIZON_TEMPORAL_JOB_KINDS = ['horizon.recompute', 'horizon.sweep'] as const;

export const HORIZON_TEMPORAL_HANDLERS: Record<string, JobHandler> = {
  'horizon.recompute': async (payload: any) => {
    const employeeId = String(payload?.employeeId || '');
    const today = String(payload?.today || new Date().toISOString().slice(0, 10));
    if (!employeeId) throw new Error('horizon.recompute needs an employeeId');
    const r = await recomputeFor(employeeId, today, String(payload?.reason || 'queued'));
    // A blind recompute is a FAILURE, not a no-op: throwing puts the job through the queue's retry
    // and backoff, which is right for a transient database problem. Returning quietly would mark it
    // done and leave the reading stale forever.
    if (r.blind) throw new Error('every evidence source was unreadable for ' + employeeId);
  },
  'horizon.sweep': async (payload: any) => {
    const today = String(payload?.today || new Date().toISOString().slice(0, 10));
    const max = Number(payload?.maxPeople) || 25;
    await sweepRecompute(today, max);
  },
};

// =================================================================================================
// HEALTH, FOR THE OPS PANEL
// =================================================================================================

export interface TemporalHealth {
  staleCount: number;
  neverComputed: number;
  sentence: string;
}

export async function temporalHealth(): Promise<TemporalHealth> {
  const stale = await staleTargets(500);
  const never = stale.filter((s) => s.neverComputed).length;
  return {
    staleCount: stale.length,
    neverComputed: never,
    sentence: stale.length
      ? stale.length + ' versioned readings are due a recompute, ' + never + ' of them never computed at all.'
      : 'Every versioned reading is inside its recompute window.',
  };
}
