// src/lib/runtime/lesson-engine.ts — Block 03: the named lesson orchestrator.
// A thin, stateless wrapper over the existing pure pipeline core in edu-runtime.ts. It runs
// the ordered lesson pipeline (startLesson), maps the trace+assembled into one LessonRunResult,
// appends the previously-open `prepare_offline_package` step (opt-in), and exposes complete +
// offline. The heavy pipeline logic and estimators live in edu-runtime.ts (already tested);
// this module adds the JSON-friendly surface the API/SPA consume.
import { z } from 'zod';
import {
  startLesson, completeLesson,
  type RenderTier, type RenderPlan, type SessionTrace, type Assembled, type TraceStep,
} from '@/lib/edu-runtime';
import { contentService } from '@/lib/kernel-content';
import { compileForUser, type OfflineManifest } from '@/lib/offline-package';

// Re-export the pure core so callers have a single import for the runtime.
export { runPipeline, STEP_ORDER, applyCompletion } from '@/lib/edu-runtime';
export type { RenderTier, RenderPlan, SessionTrace, Assembled, PipelineInput } from '@/lib/edu-runtime';

export interface OfflineSummary { unitCount: number; totalBytes: number; droppedUnitIds: string[] }

export interface LessonRunResult {
  koId: string;
  outcome: 'served' | 'denied' | 'not-ready';
  servedUnitId: string | null;
  renderPlan: RenderPlan;
  language: string;
  notReady: boolean;
  prerequisites: { id: string; title: string; mastery: number; mastered: boolean }[];
  trace: SessionTrace;
  offline: OfflineSummary | null;
}

export const LessonRequest = z.object({
  action: z.enum(['start', 'complete', 'offline']),
  koId: z.string().uuid(),
  seconds: z.number().int().nonnegative().max(86_400).optional(),
  unitIds: z.array(z.string().uuid()).max(200).optional(),
  tier: z.enum(['lite', 'standard', 'rich']).optional(),
  maxBytes: z.number().int().positive().optional(),
});
export type LessonRequestInput = z.infer<typeof LessonRequest>;

// ---- pure mapping helpers (unit-tested without a DB) ----

/** The trace step for the offline stage: a compiled summary, a failure, or an on-demand skip. */
export function offlineTraceStep(offline: OfflineSummary | null, requested: boolean, failed = false): TraceStep {
  if (!requested) return { step: 'prepare_offline_package', ok: true, detail: 'skipped (on-demand)' };
  if (failed || !offline) return { step: 'prepare_offline_package', ok: false, detail: 'offline compile failed' };
  return { step: 'prepare_offline_package', ok: true, detail: `${offline.unitCount} units, ${offline.totalBytes}B` };
}

/** Map the pipeline's (assembled, trace) into the API-facing LessonRunResult. Pure. */
export function toLessonRunResult(koId: string, assembled: Assembled, trace: SessionTrace, offline: OfflineSummary | null): LessonRunResult {
  return {
    koId,
    outcome: assembled.outcome,
    servedUnitId: assembled.servedUnitId,
    renderPlan: assembled.renderPlan,
    language: assembled.language,
    notReady: assembled.notReady,
    prerequisites: assembled.prerequisites,
    trace,
    offline,
  };
}

// ---- orchestrator surface (DB-backed) ----

/** Run one lesson start: pipeline + persist (via startLesson), then the opt-in offline step. */
export async function runLesson(
  user: any, koId: string, request: Request,
  opts: { offline?: boolean; offlineTier?: RenderTier } = {},
): Promise<{ view: unknown; result: LessonRunResult | null; isStaff: boolean }> {
  const { view, assembled, trace, isStaff } = await startLesson(user, koId, request);
  if (!view || !assembled || !trace) return { view: null, result: null, isStaff };

  let offline: OfflineSummary | null = null;
  const wantOffline = !!opts.offline && assembled.outcome !== 'denied';
  if (wantOffline) {
    try {
      const manifest = await prepareOffline(user?.id ?? null, koId, opts.offlineTier ?? assembled.renderPlan.tier);
      offline = { unitCount: manifest.unitCount, totalBytes: manifest.totalBytes, droppedUnitIds: manifest.droppedUnitIds };
      trace.steps.push(offlineTraceStep(offline, true));
    } catch {
      trace.steps.push(offlineTraceStep(null, true, true));
    }
  } else {
    trace.steps.push(offlineTraceStep(null, false));
  }

  return { view, result: toLessonRunResult(koId, assembled, trace, offline), isStaff };
}

/** Completion signal: advance mastery forward-only; normalize to growing|mastered. */
export async function completeLessonRun(userId: string, koId: string, seconds?: number): Promise<{ state: 'growing' | 'mastered' }> {
  const { state } = await completeLesson(userId, koId, seconds ?? 0);
  return { state: state === 'mastered' ? 'mastered' : 'growing' };
}

/** Package a KO plus its (published, permitted) prerequisite subgraph as an offline manifest.
 *  Security/publish filtering + the byte-budget planner are applied inside compileForUser. */
export async function prepareOffline(userId: string | null, koId: string, tier: RenderTier = 'lite', maxBytes?: number): Promise<OfflineManifest> {
  const svc = contentService();
  const view = await svc.getUnitView(koId).catch(() => null);
  const ids = view ? [koId, ...view.prerequisites.map((p) => p.id)] : [koId];
  return compileForUser(userId, ids, tier, maxBytes);
}
