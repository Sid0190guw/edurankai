// src/lib/manager-intelligence/horizon-bridge.ts — PATCH 14 PLUGGED INTO HORIZON'S OWN CONTRACTS.
//
// =================================================================================================
// WHY THIS FILE EXISTS SEPARATELY FROM THE REST OF THE PATCH
// =================================================================================================
//
// record-port.ts was written when no central employee intelligence record existed in this tree: it
// queues every manager act durably in mti_record_outbox so nothing is lost while the owning patch is
// absent. HORIZON has since landed (src/lib/horizon/), and it defines the real seams:
//
//   registerProvider()   src/lib/horizon/record.ts — a patch contributes to the master record by
//                        being READ, never by writing into somebody else's schema.
//   emitHorizonEvent()   src/lib/horizon/events.ts — 'feedback.submitted' is the event
//                        docs/horizon/INTEGRATION_MAP.md records Patch 14 as emitting.
//
// So this file is the adapter, and it is deliberately the ONLY file in this patch that imports from
// src/lib/horizon. Everything else — types, signals, recommend, read, write — stays independent of
// it, which is what lets the pure modules keep running with no database and no HORIZON present.
//
// =================================================================================================
// WHAT PATCH 14 CONTRIBUTES TO THE MASTER RECORD, AND WHAT IT REFUSES TO
// =================================================================================================
//
// IT CONTRIBUTES ITS OWN TABLES AND NOTHING ELSE. mti_development_actions holds a thing that exists
// nowhere else in this system: a development action a named manager and a person agreed to try.
// That is a recorded human act, and the integration map classifies it exactly that way.
//
// IT CONTRIBUTES NO DERIVED SIGNAL. The manager view's signals are computed from tasks, reports and
// attendance under a scope resolved from the organization graph for ONE viewer
// (performance-scope.ts). A provider is called with a subject and no viewer, so feeding those
// signals in would mean either re-deriving them without a scope — a second, weaker access path of
// exactly the kind the rules forbid — or handing HORIZON numbers whose authorisation nobody checked.
// Anything that needs them calls signalsFor() with facts it is entitled to read.
//
// IT CONTRIBUTES NO IntelligenceResult, AND THE TYPE SYSTEM AGREES. ENGINE_WRITABLE_LAYERS is
// ['computed', 'ai_interpretation', 'recommendation']; a development action is none of those. It is
// a human act, so it travels as a Signal, where `layer: 'human_feedback'` is representable and where
// the absent `computationId` correctly says no engine produced it.
//
// IT REFUSES A MANAGER'S PRIVATE PREPARATION NOTE. `visible_to_employee = false` items are excluded
// from every read below. The master record is a record ABOUT a person that the person may read; a
// note they were never shown does not become theirs to discover there.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { registerProvider, type MeirProvider, type ProviderContext } from '@/lib/horizon/record';
import { emitHorizonEvent, HORIZON_EVENTS } from '@/lib/horizon/events';
import { employeeSubject, newHorizonId, type ActorRef, type EmployeeId } from '@/lib/horizon/ids';
import type { IntelligenceResult, Signal } from '@/lib/horizon/types';

const MOD = 'manager-intelligence/horizon-bridge';

/** The patch id HORIZON attributes this contribution to. Unique; registerProvider refuses a clash. */
export const PATCH_ID = 'manager-intelligence';

/** How long a development action stands as an open signal before it must be looked at again. */
export const SIGNAL_TTL_DAYS = 180;

const DAY_MS = 86400000;

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message || e);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** mti_development_actions.status to a HORIZON signal status. */
function signalStatusOf(status: string): Signal['status'] {
  const k = String(status || '');
  if (k === 'in_progress') return 'in_progress';
  if (k === 'done') return 'resolved';
  if (k === 'dropped') return 'dismissed';
  return 'open';
}

// -------------------------------------------------------------------------------------------------
// THE PROVIDER
// -------------------------------------------------------------------------------------------------

/**
 * Development actions this manager and this person agreed to try, as HORIZON signals.
 *
 * ONLY OPEN AND IN-PROGRESS ONES, and only ones shared with the person. A closed action is history
 * and belongs on the timeline rather than as a standing signal — a signal that never clears becomes
 * a permanent mark, which is the reason `expiresAt` is required on the type at all.
 */
async function readSignals(ctx: ProviderContext): Promise<readonly Signal[]> {
  const employeeId = String(ctx?.subject?.id || '');
  if (ctx?.subject?.kind !== 'employee' || !isUuid(employeeId)) return [];

  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, title, detail, status, target_date::text AS target_date, created_at
        FROM mti_development_actions
       WHERE subject_employee_id = ${employeeId}::uuid
         AND status IN ('open', 'in_progress')
         AND visible_to_employee = TRUE
       ORDER BY created_at DESC
       LIMIT 50`));

    return rows.map((r: any): Signal => {
      const generatedAt = r.created_at ? new Date(r.created_at) : new Date();
      const expires = r.target_date
        ? new Date(String(r.target_date) + 'T23:59:59.000Z')
        : new Date(generatedAt.getTime() + SIGNAL_TTL_DAYS * DAY_MS);
      return {
        id: newHorizonId('signal'),
        subject: ctx.subject,
        category: 'growth_opportunity',
        severity: 'info',
        title: String(r.title || 'A development action is open'),
        explanation: r.detail
          ? String(r.detail).slice(0, 600)
          : 'A development action recorded by this person’s manager and shared with them. It is '
            + 'something they agreed to try, not a finding about them.',
        // No HORIZON Evidence rows stand behind this; saying so with an empty list is honest, and
        // inventing evidence ids that resolve to nothing would be worse than none.
        evidenceIds: [],
        sourceTypes: ['performance_review'],
        confidence: {
          band: 'high',
          value: 1,
          basis: 'A named manager recorded this act. It is not an estimate — the only thing being '
            + 'claimed is that the record exists and says what it says.',
        },
        generatedAt: generatedAt.toISOString(),
        expiresAt: expires.toISOString(),
        status: signalStatusOf(String(r.status || 'open')),
        recommendedActions: [{
          key: 'mti.review_development_action',
          label: 'Review this development action with them at the next one-to-one.',
          addressedTo: 'reporting_manager',
        }],
        humanReviewRequired: false,
        layer: 'human_feedback',
        decisionUse: 'supporting_only',
        organisationId: ctx.organisationId,
        // Absent on purpose: no engine produced this. A human wrote it down.
        computationId: null,
      };
    });
  } catch (e: any) {
    // Expected on a database where db/manager-intelligence-schema.sql has not been run. HORIZON
    // isolates a failing provider and marks the section unreadable; returning [] here would be the
    // one thing it must not see — an absence presented as "this person has nothing".
    logFail('readSignals', e);
    throw new Error('Patch 14 development actions could not be read: '
      + String(e?.cause?.message || e?.message || 'unknown database error'));
  }
}

/**
 * Patch 14's provider.
 *
 * `dimensions: []` is not an omission. A dimension is a thing the record SCORES a person on, and
 * this patch computes none: it records what managers did. The contribution travels through
 * readSignals(), which is exactly the optional half of the interface.
 */
export const MANAGER_INTELLIGENCE_PROVIDER: MeirProvider = {
  patchId: PATCH_ID,
  label: 'Manager and team lead intelligence',
  dimensions: [],
  // The tables carry created_at and status but keep no history of the status itself, so an as-of
  // read would return today's answer with an old date on it. Saying false is the honest answer.
  historicalSupport: false,
  async read(_ctx: ProviderContext): Promise<readonly IntelligenceResult[]> {
    return [];
  },
  readSignals,
};

let unregister: (() => void) | null = null;

/**
 * Wire Patch 14 into the master record. Call once, at application start.
 *
 * IT IS NOT CALLED AT MODULE LOAD, deliberately. This module imports the database, and a
 * registration that ran as a side effect of any import would put Patch 14's pure modules — types,
 * signals, recommend — behind a live connection for anything that transitively reached them.
 *
 * Registering twice is a no-op rather than an error: registerProvider() refuses a second DIFFERENT
 * provider for one patch id, and the object here is a module constant, so the second call is the
 * same object and the guard passes it through.
 */
export function registerManagerIntelligenceProvider(): { ok: boolean; error?: string } {
  try {
    unregister = registerProvider(MANAGER_INTELLIGENCE_PROVIDER);
    return { ok: true };
  } catch (e: any) {
    logFail('registerProvider', e);
    return { ok: false, error: String(e?.message || 'registration refused') };
  }
}

/** Test hygiene only. */
export function unregisterManagerIntelligenceProvider(): void {
  if (unregister) { unregister(); unregister = null; }
}

// -------------------------------------------------------------------------------------------------
// THE EVENT PATCH 14 EMITS
// -------------------------------------------------------------------------------------------------

export interface FeedbackEmitInput {
  /** hr_feedback.id — the row that holds the words. */
  feedbackId: string;
  subjectEmployeeId: string;
  actorUserId: string;
  actorName?: string | null;
  /** The signal key the note answered, or 'general' when it answered none. */
  dimensionKey: string;
  /** How the author holds authority over the subject, as resolved by read.ts authorityBasisFor(). */
  relationship: string;
  submittedAt: string;
}

/**
 * Announce that a manager wrote feedback.
 *
 * THE EVENT CARRIES NO WORDS. `ownerModule` and `feedbackId` point at the row in hr_feedback, which
 * is where the text lives and where its access rules live with it. An event bus is the last place a
 * copy of somebody's appraisal note should end up.
 *
 * NEVER THROWS. It runs after the feedback is already written; a failed announcement must not cost
 * somebody their note. emitHorizonEvent() already records its own gap rather than swallowing.
 */
export async function emitFeedbackSubmitted(input: FeedbackEmitInput): Promise<{ ok: boolean }> {
  if (!isUuid(input.subjectEmployeeId) || !input.feedbackId) return { ok: false };
  const actor: ActorRef = {
    kind: 'user',
    id: String(input.actorUserId || ''),
    displayName: input.actorName || null,
  };
  try {
    const res = await emitHorizonEvent({
      type: HORIZON_EVENTS.FEEDBACK_SUBMITTED,
      subject: employeeSubject(input.subjectEmployeeId as EmployeeId),
      actor,
      payload: {
        feedbackId: input.feedbackId,
        ownerModule: 'src/lib/performance.ts',
        dimensionKey: input.dimensionKey || 'general',
        relationship: input.relationship || 'unrecorded',
        submittedAt: input.submittedAt,
      },
    });
    return { ok: !!res?.ok };
  } catch (e: any) {
    logFail('emitFeedbackSubmitted', e);
    return { ok: false };
  }
}
