// src/lib/mailplatform/engine.ts — THE STATE MACHINE. One run, moved forward as far as it will go.
//
// =================================================================================================
// THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
// =================================================================================================
//
// 1. A DELAY IS A ROW, NOT A TIMER. Reaching a delay writes an absolute instant to
//    mail_workflow_runs.wait_until and sets the state WAITING. Nothing is held in memory, so a
//    delay survives a worker restart, a deploy, a database failover and a serverless function that
//    lived 300ms. Waking up is a query. There is no setTimeout anywhere in this engine.
//
// 2. AN EFFECT HAPPENS AT MOST ONCE PER (RUN, NODE). Before an action runs, a step row is CLAIMED —
//    an atomic insert keyed on (run_id, node_id). Whoever gets the row performs the effect; anybody
//    else sees it already done and skips it. A crash between claiming and finishing is the only
//    ambiguous state in the system, and it is resolved by asking the action whether repeating it is
//    visible outside this platform: a tag is re-applied, an email is NOT re-sent — that run stops
//    and a person decides. Mail cannot be recalled, so "possibly not sent, and said so" beats
//    "possibly sent twice, and said nothing".
//
// 3. A RUN NEVER CHANGES SHAPE MID-FLIGHT. It executes the definition VERSION it started on. An
//    operator editing a live workflow moves new runs onto the new shape and leaves the in-flight
//    ones alone; without this, deleting a node re-points every waiting run at whatever now occupies
//    that position, and a run waiting to send a reminder resumes into the rejection branch.
//
// =================================================================================================
// WHAT IS RE-READ AT EACH STEP, AND WHAT IS FROZEN
// =================================================================================================
//
// FROZEN: the event that started the run. It is a fact about the past — the stage WAS changed to 3 —
// and a condition asking about it must get the same answer in an hour as it did at the trigger.
//
// RE-READ: the contact. "Wait 24 hours, then check whether the assessment is still incomplete" is
// the whole point of the delay, and it is unanswerable from a copy taken before the wait began.
import type { AutomationStore, ContactRecord, RunRecord, RunState, WorkflowRecord } from './store';
import type { WorkflowDefinition, WorkflowNode } from './graph';
import { findNode, nextNodeAfter } from './graph';
import type { Facts } from './conditions';
import { evaluateCondition } from './conditions';
import { resolveDelay } from './delay';
import { actionDefinition, isIrreversible, type ActionContext, type EmittedEvent } from './actions';
import { channel as defaultChannel, type ChannelAdapter } from './adapters';
import { classifyError, decideRetry, reasonOf, DEFAULT_MAX_RETRIES, type FailureKind } from './errors';

/** How long a claimed step or a RUNNING run may sit untouched before it is considered abandoned.
 *  Longer than any single action should take (the webhook timeout is 15s, SMTP rarely more), short
 *  enough that a crash does not strand a candidate's mail for an afternoon. */
export const STALE_MS = 10 * 60 * 1000;

/** A single advance() will not walk more than this many nodes. A definition is acyclic, so this is
 *  a backstop against a pathological graph, not a design constraint — and it bounds one function
 *  invocation on a platform that will kill it anyway. */
export const MAX_STEPS_PER_ADVANCE = 50;

export interface EngineDeps {
  store: AutomationStore;
  now?: () => Date;
  maxRetries?: number;
  staleMs?: number;
  /** Where follow-on events go. The router supplies this; the default drops them with a log line
   *  rather than throwing, because an add_tag that succeeded must not be reported as failed
   *  because the announcement of it could not be delivered. */
  publish?: (e: EmittedEvent & { orgId: string; causedByRunId: string }) => Promise<void>;
  /** Override the channel registry. Only a test supplies this; production uses the real adapters. */
  channels?: (id: string) => ChannelAdapter | null;
}

export interface StepReport {
  nodeId: string;
  kind: string;
  outcome: 'ran' | 'skipped' | 'branched' | 'waiting' | 'failed' | 'ended' | 'needs_review';
  summary: string;
}

export interface AdvanceReport {
  runId: string;
  state: RunState;
  steps: StepReport[];
  /** Why the loop stopped. Always a sentence a person can read. */
  stopped: string;
}

/** The contact, flattened into the names a condition and a merge field use. One function, so the
 *  builder's field list, the evaluator and the renderer cannot disagree about what a field is called. */
export function contactFacts(c: ContactRecord | null): Record<string, unknown> {
  if (!c) return {};
  const f: Record<string, unknown> = {
    id: c.id,
    email: c.email,
    first_name: c.firstName || '',
    last_name: c.lastName || '',
    full_name: [c.firstName || '', c.lastName || ''].filter(Boolean).join(' '),
    organization: c.organization || '',
    phone: c.phone || '',
    role_title: c.roleTitle || '',
    application_stage: c.applicationStage || '',
    application_number: c.applicationNumber || '',
    tags: c.tags || [],
    unsubscribed: !!c.unsubscribed,
  };
  for (const [k, v] of Object.entries(c.custom || {})) f['custom.' + k] = v as unknown;
  return f;
}

/**
 * The facts this run's conditions see: the frozen event facts with the LIVE contact laid over them.
 * The overlay direction matters — a contact re-read a day later must win over the copy taken at
 * trigger time, or every "has it happened yet?" check answers with yesterday's data.
 */
export function runFacts(run: RunRecord, contact: ContactRecord | null): Facts {
  const frozen = ((run.context as any)?.facts || {}) as Facts;
  const facts: Facts = { ...frozen };
  const cf = contactFacts(contact);
  if (contact) {
    facts['contact'] = cf;
    for (const [k, v] of Object.entries(cf)) facts['contact.' + k] = v;
  }
  facts['run.id'] = run.runId;
  facts['run.started_at'] = run.startedAt instanceof Date ? run.startedAt.toISOString() : String(run.startedAt);
  facts['run.retry_count'] = run.retryCount;
  return facts;
}

/** The definition a run must execute: the snapshot of the version it started on, falling back to the
 *  live one when no snapshot was kept (a workflow authored before snapshots existed). */
async function definitionFor(store: AutomationStore, wf: WorkflowRecord, version: number): Promise<{ def: WorkflowDefinition; exact: boolean }> {
  const snap = await store.getWorkflowDefinition(wf.orgId, wf.id, version);
  if (snap) return { def: snap, exact: true };
  return { def: wf.definition, exact: version === wf.version };
}

/**
 * Move one run as far forward as it will go, then stop.
 *
 * "As far as it will go" means: until it hits a delay, finishes, fails, or reaches a step another
 * worker is holding. Every stop writes a state to the database first, so if this function's process
 * disappears immediately afterwards the run is exactly where it says it is.
 */
export async function advanceRun(deps: EngineDeps, runIn: RunRecord): Promise<AdvanceReport> {
  const store = deps.store;
  const now = deps.now || (() => new Date());
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const staleMs = deps.staleMs ?? STALE_MS;
  const steps: StepReport[] = [];
  let run = runIn;

  const finish = (state: RunState, stopped: string): AdvanceReport => ({ runId: run.runId, state, steps, stopped });

  if (run.state !== 'RUNNING') {
    return finish(run.state, 'The run is ' + run.state + ', so nothing was done. Only a RUNNING run advances.');
  }

  const wf = await store.getWorkflow(run.orgId, run.workflowId);
  if (!wf) {
    // The workflow was deleted under a live run. Permanent by definition; there is no shape to follow.
    await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, error: 'The workflow this run belongs to no longer exists.', errorKind: 'permanent', completedAt: now() });
    return finish('FAILED', 'The workflow no longer exists.');
  }

  const { def, exact } = await definitionFor(store, wf, run.workflowVersion);
  if (!exact) {
    steps.push({ nodeId: run.currentNode || '', kind: 'note', outcome: 'skipped', summary: 'No snapshot of version ' + run.workflowVersion + ' was kept, so this run is following the workflow as it stands now.' });
  }

  const emitted: Array<EmittedEvent> = [];
  const publish = (e: EmittedEvent) => { emitted.push(e); };

  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const nodeId = run.currentNode;
    if (!nodeId) {
      run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
      await flush(deps, run, emitted);
      return finish('COMPLETED', 'The path ended, so the run is complete.');
    }

    const node = findNode(def, nodeId);
    if (!node) {
      const msg = 'The workflow changed while this run was in flight: the node "' + nodeId + '" it was at no longer exists. Nothing further was done.';
      await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
      steps.push({ nodeId, kind: 'unknown', outcome: 'failed', summary: msg });
      await flush(deps, run, emitted);
      return finish('FAILED', msg);
    }

    // ---- trigger: the entry marker. It performs nothing; it points at the first real step. ----
    if (node.kind === 'trigger') {
      const next = nextNodeAfter(def, node.id);
      steps.push({ nodeId, kind: 'trigger', outcome: 'skipped', summary: 'Started by ' + (node.trigger?.event || 'an event') + '.' });
      run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
      continue;
    }

    if (node.kind === 'end') {
      run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
      steps.push({ nodeId, kind: 'end', outcome: 'ended', summary: 'Reached the end of the workflow.' });
      await flush(deps, run, emitted);
      return finish('COMPLETED', 'The run reached an end node.');
    }

    // The contact is re-read HERE, once per node, not once per run. See the header.
    const contact = run.contactId ? await store.getContact(run.orgId, run.contactId) : null;
    const facts = runFacts(run, contact);

    // ---- condition: evaluate, branch, and record the trace an operator will want later ----
    if (node.kind === 'condition') {
      const verdict = evaluateCondition(node.condition, facts);
      const branch: 'true' | 'false' = verdict.result ? 'true' : 'false';
      const next = nextNodeAfter(def, node.id, branch);
      await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
      await store.finishStep(run.runId, node.id, 'done', { result: { branch, trace: verdict.trace, summary: 'Answered ' + branch } });
      steps.push({ nodeId, kind: 'condition', outcome: 'branched', summary: 'Answered ' + branch + (next ? '' : ', and that branch ends the workflow.') });
      if (!next) {
        run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('COMPLETED', 'The "' + branch + '" branch has no next step, so the run is complete.');
      }
      run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
      continue;
    }

    // ---- delay: resolve once, park in the database, and leave ----
    if (node.kind === 'delay') {
      const resolution = resolveDelay(node.delay, now(), (path) => facts[path] ?? undefined);
      if (!resolution.ok) {
        // A delay that cannot be resolved is a BUSINESS answer, not a crash: the event carried no
        // deadline. Retrying reads the same absent field, so the run ends and says why.
        await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
        await store.finishStep(run.runId, node.id, 'done', { result: { summary: resolution.error }, error: resolution.error });
        run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null, error: resolution.error, errorKind: 'business' })) as RunRecord;
        steps.push({ nodeId, kind: 'delay', outcome: 'ended', summary: resolution.error });
        await flush(deps, run, emitted);
        return finish('COMPLETED', resolution.error);
      }
      const next = nextNodeAfter(def, node.id);
      await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
      await store.finishStep(run.runId, node.id, 'done', { result: { wait_until: resolution.at.toISOString(), summary: 'Waiting until ' + resolution.at.toISOString() } });
      if (!next) {
        run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
        steps.push({ nodeId, kind: 'delay', outcome: 'ended', summary: 'Nothing follows this delay, so the run is complete.' });
        await flush(deps, run, emitted);
        return finish('COMPLETED', 'Nothing follows the delay.');
      }
      if (resolution.immediate) {
        // The target instant has already passed (a replayed event, a backfill). Continuing now is
        // the only behaviour that finishes the run; parking it would be a wait for a past date.
        steps.push({ nodeId, kind: 'delay', outcome: 'skipped', summary: 'That moment has already passed, so the run continued immediately.' });
        run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
        continue;
      }
      // currentNode moves to the step the wait is FOR, so the runs list reads "waiting to send the
      // stage-3 reminder" and so waking up needs no bookkeeping beyond the timestamp.
      run = (await store.updateRun(run.runId, { state: 'WAITING', waitUntil: resolution.at, currentNode: next })) as RunRecord;
      steps.push({ nodeId, kind: 'delay', outcome: 'waiting', summary: 'Waiting until ' + resolution.at.toISOString() + '.' });
      await flush(deps, run, emitted);
      return finish('WAITING', 'Parked until ' + resolution.at.toISOString() + '. Nothing is held in memory.');
    }

    // ---- action: the only node kind with an effect outside this system ----
    if (node.kind === 'action') {
      const type = node.action?.type || '';
      const def_ = actionDefinition(type);
      if (!def_) {
        const msg = 'This workflow uses an action called "' + type + '", which this platform does not have.';
        await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
        steps.push({ nodeId, kind: 'action', outcome: 'failed', summary: msg });
        await flush(deps, run, emitted);
        return finish('FAILED', msg);
      }

      const claim = await store.claimStep(run.runId, node.id, { reclaimStale: !isIrreversible(type), staleMs, now: now() });

      if (claim.outcome === 'already_done') {
        // The effect happened; only the bookkeeping after it was lost. Replay the RECORDED result
        // instead of the action, which is what makes a crash between the effect and the state write
        // harmless rather than a second send.
        const r = (claim.step.result || {}) as any;
        steps.push({ nodeId, kind: 'action', outcome: 'skipped', summary: 'Already done on an earlier attempt: ' + String(r.summary || type) });
        if (r.endWorkflow) {
          run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
          await flush(deps, run, emitted);
          return finish('COMPLETED', 'The workflow was ended by ' + node.id + '.');
        }
        const next = nextNodeAfter(def, node.id);
        if (!next) {
          run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null })) as RunRecord;
          await flush(deps, run, emitted);
          return finish('COMPLETED', 'That was the last step.');
        }
        run = (await store.updateRun(run.runId, { currentNode: next, retryCount: 0 })) as RunRecord;
        continue;
      }

      if (claim.outcome === 'in_flight') {
        steps.push({ nodeId, kind: 'action', outcome: 'skipped', summary: 'Another worker is running this step right now.' });
        return finish(run.state, 'Another worker holds this step. The run is not stuck; it will be picked up when that worker finishes or times out.');
      }

      if (claim.outcome === 'needs_review') {
        // THE ONE AMBIGUOUS STATE, RESOLVED IN FAVOUR OF NOT SENDING TWICE. See the header.
        const msg = 'This run stopped at "' + (node.label || node.id) + '". A worker began that step and did not finish it, and repeating it could ' +
          'send the same message again — so nothing further was done automatically. Check whether it went out, then resume or cancel this run.';
        await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
        steps.push({ nodeId, kind: 'action', outcome: 'needs_review', summary: msg });
        await flush(deps, run, emitted);
        return finish('FAILED', msg);
      }

      // claimed: this worker owns the effect.
      const ctx: ActionContext = {
        store, orgId: run.orgId, run, workflow: wf, node: node as WorkflowNode,
        contact, facts, now: now(),
        // Stable per (run, node) and NOT per attempt: a retry of a send must look like the same
        // message to any transport that deduplicates, not like a new one.
        idempotencyKey: run.runId + ':' + node.id,
        publish,
        resolveChannel: deps.channels || defaultChannel,
      };

      const emitMark = emitted.length;
      let result;
      try {
        result = await def_.handler(ctx);
      } catch (e: any) {
        const kind: FailureKind = classifyError(e);
        const reason = reasonOf(e);
        const decision = decideRetry(kind, run.retryCount, maxRetries);
        await store.finishStep(run.runId, node.id, kind === 'business' ? 'done' : 'failed', { error: reason, result: { summary: reason, kind } });

        if (decision.action === 'end_run') {
          // A business rule. The run is COMPLETED — not FAILED — because nothing went wrong, and a
          // red count for "this candidate had unsubscribed" trains operators to ignore red counts.
          run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null, error: reason, errorKind: 'business' })) as RunRecord;
          steps.push({ nodeId, kind: 'action', outcome: 'ended', summary: reason });
          await flush(deps, run, emitted);
          return finish('COMPLETED', reason);
        }
        if (decision.action === 'retry') {
          run = (await store.updateRun(run.runId, {
            state: 'WAITING',
            waitUntil: new Date(now().getTime() + decision.delayMs),
            retryCount: run.retryCount + 1,
            error: reason,
            errorKind: kind,
          })) as RunRecord;
          steps.push({ nodeId, kind: 'action', outcome: 'failed', summary: reason + ' — ' + decision.reason + '.' });
          await flush(deps, run, emitted);
          return finish('WAITING', decision.reason);
        }
        run = (await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, completedAt: now(), error: reason, errorKind: kind })) as RunRecord;
        steps.push({ nodeId, kind: 'action', outcome: 'failed', summary: reason + ' — ' + decision.reason + '.' });
        await flush(deps, run, emitted);
        return finish('FAILED', decision.reason);
      }

      // THE EFFECT HAPPENED. Record it before anything else, so a crash on the next line is read as
      // "already done" rather than repeated.
      await store.finishStep(run.runId, node.id, 'done', {
        result: {
          summary: result.summary,
          data: result.data || null,
          endWorkflow: !!result.endWorkflow,
          waitUntil: result.waitUntil ? result.waitUntil.toISOString() : null,
          // The follow-on events this step produced, recorded BEFORE they are published. If the
          // process dies in that window the announcement is lost (flush() logs it loudly), and this
          // list is the only record of what should have been emitted — so it is written down where
          // the run detail page can show it rather than existing only in a variable.
          emitted: emitted.slice(emitMark).map((e) => ({ type: e.type, payload: e.payload })),
        },
        externalRef: result.externalRef ?? null,
      });
      steps.push({ nodeId, kind: 'action', outcome: 'ran', summary: result.summary });

      if (result.endWorkflow) {
        run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null, retryCount: 0, error: null, errorKind: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('COMPLETED', result.summary);
      }

      const next = nextNodeAfter(def, node.id);
      if (!next) {
        run = (await store.updateRun(run.runId, { state: 'COMPLETED', completedAt: now(), currentNode: null, retryCount: 0, error: null, errorKind: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('COMPLETED', 'That was the last step.');
      }
      if (result.waitUntil && result.waitUntil.getTime() > now().getTime()) {
        run = (await store.updateRun(run.runId, { state: 'WAITING', waitUntil: result.waitUntil, currentNode: next, retryCount: 0, error: null, errorKind: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('WAITING', 'Parked until ' + result.waitUntil.toISOString() + '.');
      }
      // retryCount resets per step, not per run: five retries are five retries of THIS step, not a
      // budget the whole run shares and exhausts on its third node.
      run = (await store.updateRun(run.runId, { currentNode: next, retryCount: 0, error: null, errorKind: null })) as RunRecord;
      continue;
    }

    const msg = 'The node "' + nodeId + '" has an unknown kind "' + String((node as any).kind) + '".';
    await store.updateRun(run.runId, { state: 'FAILED', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
    steps.push({ nodeId, kind: String((node as any).kind), outcome: 'failed', summary: msg });
    await flush(deps, run, emitted);
    return finish('FAILED', msg);
  }

  await flush(deps, run, emitted);
  return finish(run.state, 'Stopped after ' + MAX_STEPS_PER_ADVANCE + ' steps in one pass; the run will continue on the next tick.');
}

/**
 * Publish the follow-on events collected while advancing.
 *
 * AFTER the steps that produced them are recorded, and never in a way that can fail the run: an
 * add_tag that succeeded must not be reported as failed because the announcement of it could not be
 * delivered. A dropped announcement is logged loudly, because a workflow chained off "tag added"
 * would silently not start.
 */
async function flush(deps: EngineDeps, run: RunRecord, emitted: EmittedEvent[]): Promise<void> {
  if (!emitted.length) return;
  const publish = deps.publish;
  const pending = emitted.splice(0, emitted.length);
  if (!publish) {
    console.error('[mailplatform/engine] ' + pending.length + ' follow-on event(s) from run ' + run.runId + ' were dropped: no publisher is configured. Any workflow triggering on them did not start.');
    return;
  }
  for (const e of pending) {
    try {
      await publish({ ...e, orgId: run.orgId, causedByRunId: run.runId });
    } catch (err: any) {
      console.error('[mailplatform/engine] follow-on event "' + e.type + '" from run ' + run.runId + ' was not published:', reasonOf(err));
    }
  }
}
