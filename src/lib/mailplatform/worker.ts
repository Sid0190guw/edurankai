// src/lib/mailplatform/worker.ts — THE TICK. What a scheduled URL calls, and the run lifecycle.
//
// One tick does two things, in this order:
//
//   1. THE SCHEDULER. Emit the events for date-triggered automations whose instant has passed. Their
//      event ids are DETERMINISTIC — automation, version, instant, contact — so a tick that runs
//      twice, or two ticks that overlap, produce the same ids and the router's idempotency gate
//      discards the repeats. That is why there is no "already fired" column to fall out of step.
//
//   2. THE RUNS. Claim every run whose wait has ended, plus any left running by a worker that died,
//      and advance each one. Claiming is a single atomic statement in the Postgres store, so two
//      overlapping ticks cannot both take the same run.
//
// A tick is bounded, and it says what it did NOT get to. An operator reading "advanced 100 of 340
// due" knows to run it again or raise the frequency; a tick that silently processed the first
// hundred and reported success would look identical on a screen and be wrong.
import type { AutomationStore, RunRecord, RunState } from './store';
import { TERMINAL_STATES } from './store';
import { triggerNode } from './graph';
import { canonicalEventType } from './triggers';
import { advanceRun, STALE_MS, type AdvanceReport, type EngineDeps } from './engine';
import { ingestEvent, makeEvent, withPublisher } from './router';
import { reasonOf } from './errors';

export const DEFAULT_TICK_LIMIT = 100;
/** The largest audience one scheduled trigger fires for in a single tick. A bigger list is not
 *  dropped — the next tick emits the rest, because the ids are deterministic and the ones already
 *  emitted are discarded as duplicates. */
export const SCHEDULE_FANOUT_LIMIT = 500;

export interface TickReport {
  scheduledEvents: number;
  claimed: number;
  advanced: AdvanceReport[];
  /** True when the limit was hit and there is more waiting. Say so; never imply the queue is empty. */
  moreDue: boolean;
  errors: string[];
}

/** Deterministic, and therefore the whole idempotency story for scheduled fan-out. */
export function scheduleEventId(automationId: string, version: number, at: string, contactId: string): string {
  return 'sched_' + automationId + '_v' + version + '_' + Date.parse(at) + '_' + contactId;
}

/** Emit the due scheduled events. Safe to call as often as you like. */
export async function runScheduler(deps: EngineDeps, orgId: string): Promise<{ emitted: number; errors: string[] }> {
  const store = deps.store;
  const now = (deps.now || (() => new Date()))();
  const errors: string[] = [];
  let emitted = 0;

  for (const a of await store.activeAutomations(orgId)) {
    const trigger = triggerNode(a.graph);
    const type = canonicalEventType(String((trigger?.config || {}).event || ''));
    if (type !== 'schedule.date' && type !== 'schedule.time') continue;

    const cfg = (trigger?.config || {}) as Record<string, unknown>;
    const at = String(cfg.at || cfg.scheduledFor || '');
    if (!at) { errors.push('"' + a.name + '" is scheduled but names no date, so it will never fire.'); continue; }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) { errors.push('"' + a.name + '" has an unreadable scheduled date: ' + at); continue; }
    if (atMs > now.getTime()) continue;   // not yet

    let contacts;
    try {
      contacts = await store.listContacts({ listKey: cfg.listKey ? String(cfg.listKey) : undefined, tag: cfg.tag ? String(cfg.tag) : undefined, limit: SCHEDULE_FANOUT_LIMIT });
    } catch (e: any) { errors.push('"' + a.name + '": the audience could not be read: ' + reasonOf(e)); continue; }

    for (const c of contacts) {
      const r = await ingestEvent(
        { ...withPublisher(deps, 0), advance: false },   // the tick's run loop advances them, once
        makeEvent({
          type, orgId, contactId: c.id, source: 'scheduler',
          eventId: scheduleEventId(a.id, a.version, at, c.id),
          payload: { scheduled_for: new Date(atMs).toISOString(), automation: a.name },
        }),
      );
      if (!r.duplicate && r.accepted) emitted += 1;
      if (r.error) errors.push('"' + a.name + '": ' + r.error);
    }
  }
  return { emitted, errors };
}

/** One pass of the whole engine. This is what the cron URL calls. */
export async function tick(deps: EngineDeps, opts: { orgId: string; limit?: number }): Promise<TickReport> {
  const store = deps.store;
  const now = (deps.now || (() => new Date()))();
  const limit = opts.limit || DEFAULT_TICK_LIMIT;
  const report: TickReport = { scheduledEvents: 0, claimed: 0, advanced: [], moreDue: false, errors: [] };

  try {
    const s = await runScheduler(deps, opts.orgId);
    report.scheduledEvents = s.emitted;
    report.errors.push(...s.errors);
  } catch (e: any) {
    // The scheduler failing must not stop waiting runs from being advanced — they are unrelated, and
    // a candidate's 24-hour reminder should not be held up by a broken scheduled campaign.
    report.errors.push('The scheduler did not run: ' + reasonOf(e));
  }

  let due: RunRecord[] = [];
  try {
    due = await store.claimDueRuns(now, limit, STALE_MS);
  } catch (e: any) {
    report.errors.push('No runs could be claimed: ' + reasonOf(e));
    return report;
  }
  report.claimed = due.length;
  report.moreDue = due.length >= limit;

  const engine = withPublisher(deps, 0);
  for (const run of due) {
    try {
      report.advanced.push(await advanceRun(engine, run));
    } catch (e: any) {
      // advanceRun handles its own failures; reaching here means the store itself threw. The run
      // stays running and is reclaimed as abandoned after STALE_MS, which is the correct outcome —
      // but it is recorded, because a run that quietly re-enters the claim loop every tick looks
      // exactly like a healthy queue.
      const why = reasonOf(e);
      report.errors.push('Run ' + run.runId + ' could not be advanced: ' + why);
      console.error('[mailplatform/worker] run ' + run.runId + ':', why);
    }
  }
  return report;
}

// =================================================================================================
// RUN LIFECYCLE — pause, resume, cancel, retry
// =================================================================================================
//
// Each of these reports whether it CHANGED anything. A control that always says "paused" is one an
// operator cannot trust: a run that had already completed, or that another tab cancelled a second
// earlier, must not be reported as paused when it is not.

export type ControlAction = 'pause' | 'resume' | 'cancel' | 'retry';

export interface ControlResult { ok: boolean; changed: boolean; state: RunState | null; message: string }

export async function controlRun(store: AutomationStore, orgId: string, runId: string, action: ControlAction): Promise<ControlResult> {
  const run = await store.getRun(orgId, runId);
  if (!run) return { ok: false, changed: false, state: null, message: 'There is no run with that id here.' };

  if (action === 'pause') {
    if (run.state === 'paused') return { ok: true, changed: false, state: 'paused', message: 'It was already paused.' };
    if (TERMINAL_STATES.includes(run.state)) return { ok: false, changed: false, state: run.state, message: 'That run is ' + run.state + ' and has already finished; there is nothing to pause.' };
    // waitUntil is KEPT. Pausing a run that was waiting until Friday and resuming it on Thursday must
    // not send Friday's mail on Thursday.
    await store.updateRun(runId, { state: 'paused' });
    return { ok: true, changed: true, state: 'paused', message: 'Paused. It will not move until it is resumed.' };
  }

  if (action === 'resume') {
    if (run.state !== 'paused') return { ok: false, changed: false, state: run.state, message: 'That run is ' + run.state + ', not paused.' };
    // Back to waiting, not running: the tick's claim is the only thing that may set running, or two
    // workers could hold the same run. A wait_until in the past means "due now".
    await store.updateRun(runId, { state: 'waiting', waitUntil: run.waitUntil || new Date(0) });
    return { ok: true, changed: true, state: 'waiting', message: 'Resumed. It will continue on the next tick' + (run.waitUntil ? ', when its wait ends.' : '.') };
  }

  if (action === 'cancel') {
    if (TERMINAL_STATES.includes(run.state)) return { ok: false, changed: false, state: run.state, message: 'That run is already ' + run.state + '.' };
    await store.updateRun(runId, { state: 'cancelled', completedAt: new Date(), waitUntil: null });
    return { ok: true, changed: true, state: 'cancelled', message: 'Cancelled. Nothing further will be sent for this contact from this automation.' };
  }

  // retry: put a dead-lettered run back to work at the step it stopped on.
  if (run.state !== 'failed') return { ok: false, changed: false, state: run.state, message: 'Only a failed run can be retried; that one is ' + run.state + '.' };
  // The step ledger has to be released too, or a run stopped at needs_review is re-claimed, sees the
  // same needs_review row and dead-letters again — a retry button that reports success and changes
  // nothing. resetStep leaves a step already 'done' alone, so this cannot repeat a finished send.
  if (run.currentNode) await store.resetStep(runId, run.currentNode);
  await store.updateRun(runId, { state: 'waiting', waitUntil: new Date(0), retryCount: 0, deadLetter: false, completedAt: null, error: null, errorKind: null });
  return {
    ok: true,
    changed: true,
    state: 'waiting',
    // Said plainly, because this is the one control that can send a second copy of something. The
    // engine refused to make this decision on its own; a person making it should know what it is.
    message: 'Queued to retry from "' + (run.currentNode || 'the start') + '". If that step had already partly run, retrying it may repeat its effect — including a send.',
  };
}
