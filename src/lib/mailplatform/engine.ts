// src/lib/mailplatform/engine.ts — THE STATE MACHINE. One run, moved forward as far as it will go.
//
// This is the executor `mail_automation_runs` was created for and never had: until now nothing in
// the codebase inserted a run, and nothing advanced one. The canvas at /mail/automations could draw
// and publish an automation that would then sit there, correct and inert.
//
// =================================================================================================
// THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
// =================================================================================================
//
// 1. A DELAY IS A ROW, NOT A TIMER. Reaching a delay writes an absolute instant to
//    mail_automation_runs.wait_until and sets the state 'waiting'. Nothing is held in memory, so a
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
// 3. A RUN NEVER CHANGES SHAPE MID-FLIGHT. It executes the graph VERSION it started on. An operator
//    editing a live automation moves new runs onto the new shape and leaves the in-flight ones
//    alone; without this, deleting a node re-points every waiting run at whatever now occupies that
//    position, and a run waiting to send a reminder resumes into the rejection branch.
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
import type { AutomationRecord, AutomationStore, ContactRecord, RunRecord, RunState } from './store';
import { applicationNumberOf, stageOf } from './store';
import type { AutomationGraph, AutomationNode, Branch } from './graph';
import { conditionFromNode, delayFromNode, findNode, nextNodeAfter } from './graph';
import type { Facts } from './conditions';
import { evaluateCondition } from './conditions';
import { resolveDelay } from './delay';
import { actionDefinition, isIrreversible, type ActionContext, type EmittedEvent } from './actions';
import { channel as defaultChannel, type ChannelAdapter } from './adapters';
import { classifyError, decideRetry, reasonOf, DEFAULT_MAX_RETRIES, type FailureKind } from './errors';

/** How long a claimed step or a running run may sit untouched before it is considered abandoned.
 *  Longer than any single action should take (the webhook timeout is 15s, SMTP rarely more), short
 *  enough that a crash does not strand a candidate's mail for an afternoon. */
export const STALE_MS = 10 * 60 * 1000;

/** A single advance() will not walk more than this many nodes. The validator refuses a loop with no
 *  delay in it, so this is a backstop against a pathological graph rather than a design constraint —
 *  and it bounds one function invocation on a platform that will kill it anyway. */
export const MAX_STEPS_PER_ADVANCE = 50;

export interface EngineDeps {
  store: AutomationStore;
  now?: () => Date;
  maxRetries?: number;
  staleMs?: number;
  /** Where follow-on events go. The router supplies this; the default drops them with a log line
   *  rather than throwing, because an add_tag that succeeded must not be reported as failed because
   *  the announcement of it could not be delivered. */
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
    status: c.status,
    tags: c.tags || [],
    application_stage: stageOf(c),
    application_number: applicationNumberOf(c),
    fields: c.fields || {},
  };
  for (const [k, v] of Object.entries(c.fields || {})) f['fields.' + k] = v as unknown;
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
  // THE ONE VIRTUAL FACT. "Application stage" on the canvas means the stage this run is about: the
  // value the event carried if it carried one, and the contact's current stage otherwise. Without
  // this, a stage-changed automation asks the contact row for a value the event has only just
  // announced and has not necessarily been written yet.
  if (facts['stage'] === undefined || facts['stage'] === null || facts['stage'] === '') {
    facts['stage'] = cf['application_stage'] ?? '';
  }
  facts['run.id'] = run.runId;
  facts['run.started_at'] = run.startedAt instanceof Date ? run.startedAt.toISOString() : String(run.startedAt);
  facts['run.retry_count'] = run.retryCount;
  return facts;
}

/** The graph a run must execute: the snapshot of the version it started on, falling back to the live
 *  one when no snapshot was kept (an automation published before snapshots existed). */
async function graphFor(store: AutomationStore, a: AutomationRecord, version: number): Promise<{ graph: AutomationGraph; exact: boolean }> {
  const snap = await store.getGraphVersion(a.orgId, a.id, version);
  if (snap) return { graph: snap, exact: true };
  return { graph: a.graph, exact: version === a.version };
}

/**
 * Move one run as far forward as it will go, then stop.
 *
 * "As far as it will go" means: until it hits a delay, finishes, fails, or reaches a step another
 * worker is holding. Every stop writes a state to the database FIRST, so if this function's process
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

  if (run.state !== 'running') {
    return finish(run.state, 'The run is ' + run.state + ', so nothing was done. Only a running run advances.');
  }

  const automation = await store.getAutomation(run.orgId, run.automationId);
  if (!automation) {
    // The automation was deleted under a live run. Permanent by definition; there is no shape to follow.
    await store.updateRun(run.runId, { state: 'failed', deadLetter: true, error: 'The automation this run belongs to no longer exists.', errorKind: 'permanent', completedAt: now() });
    return finish('failed', 'The automation no longer exists.');
  }

  const { graph, exact } = await graphFor(store, automation, run.graphVersion);
  if (!exact) {
    steps.push({ nodeId: run.currentNode || '', kind: 'note', outcome: 'skipped', summary: 'No snapshot of version ' + run.graphVersion + ' was kept, so this run is following the automation as it stands now.' });
  }

  const emitted: EmittedEvent[] = [];
  const publish = (e: EmittedEvent) => { emitted.push(e); };

  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const nodeId = run.currentNode;
    if (!nodeId) {
      run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null })) as RunRecord;
      await flush(deps, run, emitted);
      return finish('completed', 'The path ended, so the run is complete.');
    }

    const node = findNode(graph, nodeId);
    if (!node) {
      const msg = 'The automation changed while this run was in flight: the step "' + nodeId + '" it was at no longer exists. Nothing further was done.';
      await store.updateRun(run.runId, { state: 'failed', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
      steps.push({ nodeId, kind: 'unknown', outcome: 'failed', summary: msg });
      await flush(deps, run, emitted);
      return finish('failed', msg);
    }

    // ---- trigger: the entry marker. It performs nothing; it points at the first real step. ----
    if (node.kind === 'trigger') {
      const next = nextNodeAfter(graph, node.id);
      steps.push({ nodeId, kind: 'trigger', outcome: 'skipped', summary: 'Started by ' + String((node.config || {}).event || 'an event') + '.' });
      run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
      continue;
    }

    if (node.kind === 'end') {
      run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null })) as RunRecord;
      steps.push({ nodeId, kind: 'end', outcome: 'ended', summary: 'Reached the end of the automation.' });
      await flush(deps, run, emitted);
      return finish('completed', 'The run reached an End step.');
    }

    // The contact is re-read HERE, once per node, not once per run. See the header.
    const contact = run.contactId ? await store.getContact(run.contactId) : null;
    const facts = runFacts(run, contact);

    // ---- condition: evaluate, branch, and record the trace an operator will want later ----
    if (node.kind === 'condition') {
      const condition = conditionFromNode(node);
      const verdict = evaluateCondition(condition, facts);
      const branch: Branch = verdict.result ? 'yes' : 'no';
      const next = nextNodeAfter(graph, node.id, branch);
      await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
      await store.finishStep(run.runId, node.id, 'done', { result: { branch, trace: verdict.trace, summary: 'Answered ' + branch } });
      steps.push({ nodeId, kind: 'condition', outcome: 'branched', summary: 'Answered ' + branch + (next ? '' : ', and that branch leads nowhere.') });
      if (!next) {
        // validateGraph() refuses to publish a condition missing a branch, so reaching this means the
        // graph was edited after the run started. Ending is right; guessing the other branch is not.
        run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('completed', 'The "' + branch + '" branch has no next step, so the run is complete.');
      }
      run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
      continue;
    }

    // ---- delay: resolve once, park in the database, and leave ----
    if (node.kind === 'delay') {
      const spec = delayFromNode(node);
      const resolution = resolveDelay(spec, now(), (path) => facts[path] ?? undefined);
      if (!resolution.ok) {
        // A delay that cannot be resolved is a BUSINESS answer, not a crash: the event carried no
        // deadline. Retrying reads the same absent field, so the run ends and says why.
        await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
        await store.finishStep(run.runId, node.id, 'done', { result: { summary: resolution.error }, error: resolution.error });
        run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null, error: resolution.error, errorKind: 'business' })) as RunRecord;
        steps.push({ nodeId, kind: 'delay', outcome: 'ended', summary: resolution.error });
        await flush(deps, run, emitted);
        return finish('completed', resolution.error);
      }
      const next = nextNodeAfter(graph, node.id);
      await store.claimStep(run.runId, node.id, { reclaimStale: true, staleMs, now: now() });
      await store.finishStep(run.runId, node.id, 'done', { result: { wait_until: resolution.at.toISOString(), summary: 'Waiting until ' + resolution.at.toISOString() } });
      if (!next) {
        run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null })) as RunRecord;
        steps.push({ nodeId, kind: 'delay', outcome: 'ended', summary: 'Nothing follows this delay, so the run is complete.' });
        await flush(deps, run, emitted);
        return finish('completed', 'Nothing follows the delay.');
      }
      if (resolution.immediate) {
        // The instant has already passed (a replayed event, a backfill). Continuing now is the only
        // behaviour that finishes the run; parking it would be a wait for a past date.
        steps.push({ nodeId, kind: 'delay', outcome: 'skipped', summary: 'That moment has already passed, so the run continued immediately.' });
        run = (await store.updateRun(run.runId, { currentNode: next })) as RunRecord;
        continue;
      }
      // currentNode moves to the step the wait is FOR, so the runs list reads "waiting to send the
      // reminder" and so waking up needs no bookkeeping beyond the timestamp.
      run = (await store.updateRun(run.runId, { state: 'waiting', waitUntil: resolution.at, currentNode: next })) as RunRecord;
      steps.push({ nodeId, kind: 'delay', outcome: 'waiting', summary: 'Waiting until ' + resolution.at.toISOString() + '.' });
      await flush(deps, run, emitted);
      return finish('waiting', 'Parked until ' + resolution.at.toISOString() + '. Nothing is held in memory.');
    }

    // ---- everything else is an action: the only nodes with an effect outside this system ----
    const def = actionDefinition(node.kind);
    if (!def) {
      const msg = 'This automation uses a step called "' + String(node.kind) + '", which this platform cannot run.';
      await store.updateRun(run.runId, { state: 'failed', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
      steps.push({ nodeId, kind: String(node.kind), outcome: 'failed', summary: msg });
      await flush(deps, run, emitted);
      return finish('failed', msg);
    }

    const claim = await store.claimStep(run.runId, node.id, { reclaimStale: !isIrreversible(node.kind), staleMs, now: now() });

    if (claim.outcome === 'already_done') {
      // The effect happened; only the bookkeeping after it was lost. Replay the RECORDED result
      // instead of the action, which is what makes a crash between the effect and the state write
      // harmless rather than a second send.
      const r = (claim.step.result || {}) as any;
      steps.push({ nodeId, kind: node.kind, outcome: 'skipped', summary: 'Already done on an earlier attempt: ' + String(r.summary || node.kind) });
      const next = nextNodeAfter(graph, node.id);
      if (!next) {
        run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null })) as RunRecord;
        await flush(deps, run, emitted);
        return finish('completed', 'That was the last step.');
      }
      run = (await store.updateRun(run.runId, { currentNode: next, retryCount: 0 })) as RunRecord;
      continue;
    }

    if (claim.outcome === 'in_flight') {
      steps.push({ nodeId, kind: node.kind, outcome: 'skipped', summary: 'Another worker is running this step right now.' });
      return finish(run.state, 'Another worker holds this step. The run is not stuck; it will be picked up when that worker finishes or times out.');
    }

    if (claim.outcome === 'needs_review') {
      // THE ONE AMBIGUOUS STATE, RESOLVED IN FAVOUR OF NOT SENDING TWICE. See the header.
      const msg = 'This run stopped at "' + node.id + '". A worker began that step and did not finish it, and repeating it could send the same message again — so nothing further was done automatically. Check whether it went out, then retry or cancel this run.';
      await store.updateRun(run.runId, { state: 'failed', deadLetter: true, error: msg, errorKind: 'permanent', completedAt: now() });
      steps.push({ nodeId, kind: node.kind, outcome: 'needs_review', summary: msg });
      await flush(deps, run, emitted);
      return finish('failed', msg);
    }

    // claimed: this worker owns the effect.
    const ctx: ActionContext = {
      store, orgId: run.orgId, run, automation, node: node as AutomationNode,
      contact, facts, now: now(),
      // Stable per (run, node) and NOT per attempt: a retry of a send must look like the same message
      // to any transport that deduplicates, not like a new one.
      idempotencyKey: run.runId + ':' + node.id,
      publish,
      resolveChannel: deps.channels || defaultChannel,
    };

    const emitMark = emitted.length;
    let result;
    try {
      result = await def.handler(ctx);
    } catch (e: any) {
      const kind: FailureKind = classifyError(e);
      const why = reasonOf(e);
      const decision = decideRetry(kind, run.retryCount, maxRetries);
      await store.finishStep(run.runId, node.id, kind === 'business' ? 'done' : 'failed', { error: why, result: { summary: why, kind } });

      if (decision.action === 'end_run') {
        // A business rule. The run is COMPLETED — not failed — because nothing went wrong, and a red
        // count for "this candidate had unsubscribed" trains operators to ignore red counts.
        run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null, error: why, errorKind: 'business' })) as RunRecord;
        steps.push({ nodeId, kind: node.kind, outcome: 'ended', summary: why });
        await flush(deps, run, emitted);
        return finish('completed', why);
      }
      if (decision.action === 'retry') {
        run = (await store.updateRun(run.runId, {
          state: 'waiting',
          waitUntil: new Date(now().getTime() + decision.delayMs),
          retryCount: run.retryCount + 1,
          error: why,
          errorKind: kind,
        })) as RunRecord;
        steps.push({ nodeId, kind: node.kind, outcome: 'failed', summary: why + ' — ' + decision.reason + '.' });
        await flush(deps, run, emitted);
        return finish('waiting', decision.reason);
      }
      run = (await store.updateRun(run.runId, { state: 'failed', deadLetter: true, completedAt: now(), error: why, errorKind: kind })) as RunRecord;
      steps.push({ nodeId, kind: node.kind, outcome: 'failed', summary: why + ' — ' + decision.reason + '.' });
      await flush(deps, run, emitted);
      return finish('failed', decision.reason);
    }

    // THE EFFECT HAPPENED. Record it before anything else, so a crash on the next line is read as
    // "already done" rather than repeated.
    await store.finishStep(run.runId, node.id, 'done', {
      result: {
        summary: result.summary,
        data: result.data || null,
        waitUntil: result.waitUntil ? result.waitUntil.toISOString() : null,
        // The follow-on events this step produced, recorded BEFORE they are published. If the process
        // dies in that window the announcement is lost (flush() logs it loudly), and this list is the
        // only record of what should have been emitted — so it is written where the run page can show it.
        emitted: emitted.slice(emitMark).map((e) => ({ type: e.type, payload: e.payload })),
      },
      externalRef: result.externalRef ?? null,
    });
    steps.push({ nodeId, kind: node.kind, outcome: 'ran', summary: result.summary });

    const next = nextNodeAfter(graph, node.id);
    if (!next) {
      run = (await store.updateRun(run.runId, { state: 'completed', completedAt: now(), currentNode: null, retryCount: 0, error: null, errorKind: null })) as RunRecord;
      await flush(deps, run, emitted);
      return finish('completed', 'That was the last step.');
    }
    if (result.waitUntil && result.waitUntil.getTime() > now().getTime()) {
      run = (await store.updateRun(run.runId, { state: 'waiting', waitUntil: result.waitUntil, currentNode: next, retryCount: 0, error: null, errorKind: null })) as RunRecord;
      await flush(deps, run, emitted);
      return finish('waiting', 'Parked until ' + result.waitUntil.toISOString() + '.');
    }
    // retryCount resets per STEP, not per run: five retries are five retries of this step, not a
    // budget the whole run shares and exhausts on its third node.
    run = (await store.updateRun(run.runId, { currentNode: next, retryCount: 0, error: null, errorKind: null })) as RunRecord;
  }

  await flush(deps, run, emitted);
  return finish(run.state, 'Stopped after ' + MAX_STEPS_PER_ADVANCE + ' steps in one pass; the run will continue on the next tick.');
}

/**
 * Publish the follow-on events collected while advancing.
 *
 * AFTER the steps that produced them are recorded, and never in a way that can fail the run: an
 * add_tag that succeeded must not be reported as failed because the announcement of it could not be
 * delivered. A dropped announcement is logged loudly, because an automation chained off "tag added"
 * would silently not start.
 */
async function flush(deps: EngineDeps, run: RunRecord, emitted: EmittedEvent[]): Promise<void> {
  if (!emitted.length) return;
  const publish = deps.publish;
  const pending = emitted.splice(0, emitted.length);
  if (!publish) {
    console.error('[mailplatform/engine] ' + pending.length + ' follow-on event(s) from run ' + run.runId + ' were dropped: no publisher is configured. Any automation triggering on them did not start.');
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
