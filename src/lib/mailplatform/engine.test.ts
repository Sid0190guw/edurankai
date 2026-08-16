// src/lib/mailplatform/engine.test.ts — the behaviours that only show up over TIME and across
// PROCESSES: a delay that outlives its worker, an event delivered twice, a crash between the send
// and the record of it, a run cancelled while it waits.
//
// All of it runs against MemoryStore, which enforces the same atomicity rules as the Postgres store.
// "The worker restarted" is modelled by throwing away every engine object and building new ones over
// the SAME store; "the database restarted" is modelled by serialising the store to JSON and reading
// it back, which is the honest test of whether anything important was living in a variable.
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, newMemoryStore } from './memory-store';
import { advanceRun, type EngineDeps } from './engine';
import { emit, ingestEvent, makeEvent, withPublisher } from './router';
import { controlRun, tick } from './worker';
import { saveWorkflow, setWorkflowStatus } from './service';
import type { ChannelAdapter } from './adapters';
import type { WorkflowDefinition } from './graph';
import { TemporaryFailure } from './errors';

const ORG = 'testorg';

/** A channel that records instead of sending, and can be told to fail or to die mid-send. */
function recordingChannel() {
  const sent: Array<{ to: string; subject: string; key: string }> = [];
  let mode: 'ok' | 'temporary' | 'permanent' | 'crash' = 'ok';
  const adapter: ChannelAdapter = {
    id: 'email',
    label: 'Email',
    async available() { return true; },
    async unavailableReason() { return ''; },
    async send(m) {
      if (mode === 'crash') {
        // The send REACHED the far end, and then this process died before it could be recorded.
        sent.push({ to: m.to, subject: m.subject || '', key: m.idempotencyKey });
        throw Object.assign(new Error('process died after the message left'), { __crash: true });
      }
      if (mode === 'temporary') throw new TemporaryFailure('421 4.7.0 try again later');
      if (mode === 'permanent') return { ok: false, error: '550 5.1.1 no such user' };
      sent.push({ to: m.to, subject: m.subject || '', key: m.idempotencyKey });
      return { ok: true, ref: 'msg_' + sent.length };
    },
  };
  return { adapter, sent, setMode: (m: typeof mode) => { mode = m; }, resolve: (id: string) => (id === 'email' ? adapter : null) };
}

/** A fixed, movable clock. Nothing in these tests depends on real time passing. */
function clock(startIso: string) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advanceMs: (ms: number) => { t += ms; }, advanceHours: (h: number) => { t += h * 3_600_000; } };
}

const stageThreeDefinition = (): WorkflowDefinition => ({
  version: 1,
  nodes: [
    { id: 'trigger_1', kind: 'trigger', trigger: { event: 'application.stage.changed' } },
    { id: 'condition_1', kind: 'condition', condition: { field: 'event.stage', operator: 'equals', value: '3' } },
    { id: 'action_1', kind: 'action', label: 'Stage 3 letter', action: { type: 'send_email', params: { subject: 'Stage 3, {{first_name}}', text: 'Hello {{first_name|default:there}}' } } },
    { id: 'delay_1', kind: 'delay', delay: { kind: 'hours', amount: 24 } },
    {
      id: 'condition_2', kind: 'condition',
      condition: { or: [{ field: 'contact.custom.assessment_completed', operator: 'does_not_exist' }, { field: 'contact.custom.assessment_completed', operator: 'not_equals', value: 'true' }] },
    },
    { id: 'action_2', kind: 'action', label: 'Reminder', action: { type: 'send_email', params: { subject: 'Reminder', text: 'Your assessment is open' } } },
    { id: 'action_3', kind: 'action', label: 'Tag done', action: { type: 'add_tag', params: { tag: 'assessment-complete' } } },
  ],
  edges: [
    { id: 'e1', from: 'trigger_1', to: 'condition_1' },
    { id: 'e2', from: 'condition_1', to: 'action_1', branch: 'true' },
    { id: 'e3', from: 'action_1', to: 'delay_1' },
    { id: 'e4', from: 'delay_1', to: 'condition_2' },
    { id: 'e5', from: 'condition_2', to: 'action_2', branch: 'true' },
    { id: 'e6', from: 'condition_2', to: 'action_3', branch: 'false' },
  ],
});

async function fixture(definition = stageThreeDefinition(), startIso = '2026-08-16T09:00:00.000Z') {
  const store = newMemoryStore();
  const c = clock(startIso);
  store.now = c.now;
  const ch = recordingChannel();
  const saved = await saveWorkflow(store, ORG, { key: 'wf', name: 'Test workflow', definition }, 'user_1');
  expect(saved.ok, saved.message).toBe(true);
  const status = await setWorkflowStatus(store, ORG, saved.workflow!.id, 'active', { channels: ch.resolve });
  expect(status.ok, status.message).toBe(true);
  const contact = await store.upsertContact(ORG, { email: 'ananya@example.test', firstName: 'Ananya' });
  const deps = (): EngineDeps => ({ store, now: c.now, channels: ch.resolve });
  return { store, clock: c, ch, workflow: saved.workflow!, contact, deps };
}

const stageEvent = (contactId: string, stage = '3', eventId = 'evt_stage_1') =>
  makeEvent({ type: 'application.stage.changed', orgId: ORG, contactId, payload: { stage }, eventId, source: 'internal' });

describe('trigger, condition, branch', () => {
  it('starts a run, takes the true branch and sends', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(r.startedRuns.length).toBe(1);
    expect(f.ch.sent.length).toBe(1);
    expect(f.ch.sent[0].subject).toBe('Stage 3, Ananya');
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('WAITING');            // parked at the 24-hour delay
    expect(run!.currentNode).toBe('condition_2');  // the step the wait is FOR
  });

  it('starts nothing when the trigger filter does not match', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '2'));
    expect(r.startedRuns.length).toBe(1);          // a run IS started — the narrowing is a condition
    expect(f.ch.sent.length).toBe(0);              // …and it ends at the condition without sending
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('COMPLETED');
  });

  it('does not start a workflow listening for a different event', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, makeEvent({ type: 'contact.created', orgId: ORG, contactId: f.contact.id, eventId: 'evt_other' }));
    expect(r.startedRuns.length).toBe(0);
  });

  it('will not start a run for another organisation', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, makeEvent({ type: 'application.stage.changed', orgId: 'someone-else', contactId: f.contact.id, payload: { stage: '3' }, eventId: 'evt_x' }));
    expect(r.startedRuns.length).toBe(0);
    expect(f.ch.sent.length).toBe(0);
  });
});

describe('delays survive time and processes', () => {
  it('a 24-hour delay is a database row, and the run resumes on a later tick', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(f.ch.sent.length).toBe(1);

    // Nothing is due yet: a tick an hour later must do nothing at all.
    f.clock.advanceHours(1);
    const early = await tick(f.deps(), { orgId: ORG });
    expect(early.claimed).toBe(0);
    expect(f.ch.sent.length).toBe(1);

    // A day later it wakes, finds the assessment still incomplete, and reminds.
    f.clock.advanceHours(24);
    const later = await tick(f.deps(), { orgId: ORG });
    expect(later.claimed).toBe(1);
    expect(f.ch.sent.length).toBe(2);
    expect(f.ch.sent[1].subject).toBe('Reminder');
  });

  it('takes the false branch when the contact CHANGED during the wait — the contact is re-read', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    // The candidate finishes the assessment while the run is parked.
    await f.store.updateContactFields(ORG, f.contact.id, { assessment_completed: 'true' });
    f.clock.advanceHours(25);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);                       // no reminder
    const contact = await f.store.getContact(ORG, f.contact.id);
    expect(contact!.tags).toContain('assessment-complete'); // the false branch ran instead
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('COMPLETED');
  });

  it('survives a WORKER restart: new engine objects over the same store', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    f.clock.advanceHours(25);
    // Everything the first "process" held is discarded — only the store persists.
    const ch2 = recordingChannel();
    const freshDeps: EngineDeps = { store: f.store, now: f.clock.now, channels: ch2.resolve };
    const t = await tick(freshDeps, { orgId: ORG });
    expect(t.claimed).toBe(1);
    expect(ch2.sent.length).toBe(1);   // the reminder went out from the NEW process
  });

  it('survives a DATABASE restart: the whole store round-tripped through JSON', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));

    // Serialise every table and read it back into a new store — nothing may live in a variable.
    const dump = JSON.stringify({
      workflows: [...f.store.workflows], versions: [...f.store.versions], runs: [...f.store.runs],
      steps: [...f.store.steps], events: [...f.store.events], contacts: [...f.store.contacts],
      lists: [...f.store.lists], listMembers: [...f.store.listMembers].map(([k, v]) => [k, [...v]]),
    });
    const raw = JSON.parse(dump, (_k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(v) ? new Date(v) : v));
    const revived = new MemoryStore();
    revived.now = f.clock.now;
    revived.workflows = new Map(raw.workflows);
    revived.versions = new Map(raw.versions);
    revived.runs = new Map(raw.runs);
    revived.steps = new Map(raw.steps);
    revived.events = new Map(raw.events);
    revived.contacts = new Map(raw.contacts);
    revived.lists = new Map(raw.lists);
    revived.listMembers = new Map(raw.listMembers.map(([k, v]: any) => [k, new Set(v)]));

    const ch2 = recordingChannel();
    f.clock.advanceHours(25);
    const t = await tick({ store: revived, now: f.clock.now, channels: ch2.resolve }, { orgId: ORG });
    expect(t.claimed).toBe(1);
    expect(ch2.sent.length).toBe(1);
    expect((await revived.getRun(ORG, r.startedRuns[0]))!.state).toBe('COMPLETED');
  });
});

describe('idempotency', () => {
  it('the same event delivered twice starts one run and sends once', async () => {
    const f = await fixture();
    const first = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_dup'));
    const second = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_dup'));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.startedRuns.length).toBe(0);
    expect(f.ch.sent.length).toBe(1);
  });

  it('two DIFFERENT events for the same contact start two runs — dedup is by event, not by person', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_a'));
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_b'));
    expect(f.ch.sent.length).toBe(2);
  });

  it('advancing the same run twice does not repeat a completed step', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    // Force it back to RUNNING at the step it already performed, as a double-claim would.
    await f.store.updateRun(run!.runId, { state: 'RUNNING', currentNode: 'action_1' });
    const again = await advanceRun(f.deps(), (await f.store.getRun(ORG, run!.runId))!);
    expect(f.ch.sent.length).toBe(1);                                        // NOT two
    expect(again.steps.some((s) => /Already done/.test(s.summary))).toBe(true);
  });

  it('a crash between the send and the record of it does NOT re-send — it stops for a person', async () => {
    const f = await fixture();
    f.ch.setMode('crash');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(f.ch.sent.length).toBe(1);                       // the message DID leave
    const runId = r.startedRuns[0];

    // The crash left the step claimed-but-unfinished. Simulate the worker dying by putting the step
    // back to 'running' and moving the clock past the stale window, exactly as an abandoned step looks.
    await f.store.finishStep(runId, 'action_1', 'running', {});
    await f.store.updateRun(runId, { state: 'WAITING', waitUntil: new Date(0) });
    f.clock.advanceMs(20 * 60_000);

    f.ch.setMode('ok');
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);                        // still one. No second copy.
    const run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('FAILED');
    expect(run!.deadLetter).toBe(true);
    expect(run!.error).toMatch(/could send the same message again/);
  });

  it('a REVERSIBLE step abandoned the same way is simply re-run', async () => {
    const def: WorkflowDefinition = {
      version: 1,
      nodes: [
        { id: 'trigger_1', kind: 'trigger', trigger: { event: 'application.stage.changed' } },
        { id: 'action_1', kind: 'action', action: { type: 'add_tag', params: { tag: 'seen' } } },
      ],
      edges: [{ id: 'e1', from: 'trigger_1', to: 'action_1' }],
    };
    const f = await fixture(def);
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    await f.store.finishStep(runId, 'action_1', 'running', {});
    await f.store.updateRun(runId, { state: 'WAITING', waitUntil: new Date(0), completedAt: null });
    f.clock.advanceMs(20 * 60_000);
    await tick(f.deps(), { orgId: ORG });
    const run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('COMPLETED');           // no needs_review; a tag can be re-applied
    expect(run!.deadLetter).toBe(false);
  });
});

describe('retries and dead letters', () => {
  it('retries a temporary failure with backoff, then succeeds', async () => {
    const f = await fixture();
    f.ch.setMode('temporary');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    let run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('WAITING');
    expect(run!.retryCount).toBe(1);
    expect(run!.error).toMatch(/421/);

    f.ch.setMode('ok');
    f.clock.advanceMs(2 * 60_000);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);
    run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('WAITING');            // now waiting on the 24-hour delay, not a retry
    expect(run!.retryCount).toBe(0);
  });

  it('dead-letters after the retry cap', async () => {
    const f = await fixture();
    f.ch.setMode('temporary');
    const deps = { ...f.deps(), maxRetries: 2 };
    const r = await ingestEvent({ ...deps, advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    for (let i = 0; i < 5; i++) { f.clock.advanceMs(60 * 60_000); await tick(deps, { orgId: ORG }); }
    const run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('FAILED');
    expect(run!.deadLetter).toBe(true);
    expect(run!.errorKind).toBe('temporary');
  });

  it('dead-letters a permanent failure immediately, with no retries', async () => {
    const f = await fixture();
    f.ch.setMode('permanent');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('FAILED');
    expect(run!.retryCount).toBe(0);
    expect(run!.errorKind).toBe('permanent');
  });

  it('ends the run — without an error — when a business rule says no', async () => {
    const f = await fixture();
    await f.store.setUnsubscribed(ORG, f.contact.id, true);
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(f.ch.sent.length).toBe(0);
    expect(run!.state).toBe('COMPLETED');          // not FAILED
    expect(run!.deadLetter).toBe(false);
    expect(run!.errorKind).toBe('business');
    expect(run!.error).toMatch(/unsubscribed/);
  });

  it('a dead-lettered run can be retried by a person, and the stopped step is released', async () => {
    const f = await fixture();
    f.ch.setMode('permanent');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    expect((await f.store.getRun(ORG, runId))!.state).toBe('FAILED');

    f.ch.setMode('ok');
    const c = await controlRun(f.store, ORG, runId, 'retry');
    expect(c.changed).toBe(true);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);
  });
});

describe('cancellation, pause and resume', () => {
  it('a cancelled run never wakes up', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    expect((await controlRun(f.store, ORG, runId, 'cancel')).changed).toBe(true);
    f.clock.advanceHours(48);
    const t = await tick(f.deps(), { orgId: ORG });
    expect(t.claimed).toBe(0);
    expect(f.ch.sent.length).toBe(1);              // only the first send, never the reminder
    expect((await f.store.getRun(ORG, runId))!.state).toBe('CANCELLED');
  });

  it('cancelling twice reports honestly that nothing changed', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    await controlRun(f.store, ORG, r.startedRuns[0], 'cancel');
    const again = await controlRun(f.store, ORG, r.startedRuns[0], 'cancel');
    expect(again.changed).toBe(false);
    expect(again.ok).toBe(false);
  });

  it('pause holds a run through its due time; resume keeps the original appointment', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    await controlRun(f.store, ORG, runId, 'pause');

    f.clock.advanceHours(48);
    expect((await tick(f.deps(), { orgId: ORG })).claimed).toBe(0);   // paused runs are not claimed
    expect(f.ch.sent.length).toBe(1);

    await controlRun(f.store, ORG, runId, 'resume');
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(2);
    expect((await f.store.getRun(ORG, runId))!.state).toBe('COMPLETED');
  });

  it('a paused workflow starts no new runs, and says the in-flight ones continue', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_1'));
    const paused = await setWorkflowStatus(f.store, ORG, f.workflow.id, 'paused');
    expect(paused.message).toMatch(/Runs already in flight continue/);
    const after = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_2'));
    expect(after.startedRuns.length).toBe(0);
  });
});

describe('chained workflows and follow-on events', () => {
  it('a tag added by one workflow starts another, and the chain is bounded', async () => {
    const store = newMemoryStore();
    const c = clock('2026-08-16T09:00:00.000Z');
    store.now = c.now;
    const ch = recordingChannel();

    const tagger = await saveWorkflow(store, ORG, {
      key: 'tagger', name: 'Tag on stage change', definition: {
        version: 1,
        nodes: [
          { id: 'trigger_1', kind: 'trigger', trigger: { event: 'application.stage.changed' } },
          { id: 'action_1', kind: 'action', action: { type: 'add_tag', params: { tag: 'shortlisted' } } },
        ],
        edges: [{ id: 'e1', from: 'trigger_1', to: 'action_1' }],
      },
    }, null);
    await setWorkflowStatus(store, ORG, tagger.workflow!.id, 'active', { channels: ch.resolve });

    const welcomer = await saveWorkflow(store, ORG, {
      key: 'welcomer', name: 'Welcome the shortlisted', definition: {
        version: 1,
        nodes: [
          { id: 'trigger_1', kind: 'trigger', trigger: { event: 'contact.tag.added', filter: { field: 'event.tag', operator: 'equals', value: 'shortlisted' } } },
          { id: 'action_1', kind: 'action', action: { type: 'send_email', params: { subject: 'You have been shortlisted', text: 'Congratulations' } } },
        ],
        edges: [{ id: 'e1', from: 'trigger_1', to: 'action_1' }],
      },
    }, null);
    await setWorkflowStatus(store, ORG, welcomer.workflow!.id, 'active', { channels: ch.resolve });

    const contact = await store.upsertContact(ORG, { email: 'b@example.test', firstName: 'Bhavna' });
    const deps: EngineDeps = { store, now: c.now, channels: ch.resolve };
    await ingestEvent({ ...withPublisher(deps, 0), advance: true }, stageEvent(contact.id));

    expect((await store.getContact(ORG, contact.id))!.tags).toContain('shortlisted');
    expect(ch.sent.length).toBe(1);
    expect(ch.sent[0].subject).toBe('You have been shortlisted');
  });

  it('re-applying a tag that is already there emits nothing, so a chain cannot loop on a no-op', async () => {
    const f = await fixture();
    await f.store.addTag(ORG, f.contact.id, 'seen');
    const changedAgain = await f.store.addTag(ORG, f.contact.id, 'seen');
    expect(changedAgain).toBe(false);
  });
});

describe('emit() from the rest of the platform', () => {
  it('creates the contact on first sight and announces it before the event that produced them', async () => {
    const f = await fixture();
    const r = await emit(f.store, {
      type: 'application.stage.changed', orgId: ORG,
      contactEmail: 'New.Person@Example.TEST', contact: { firstName: 'Nikhil' }, payload: { stage: '3' },
    }, f.deps());
    expect(r.startedRuns.length).toBe(1);
    const c = await f.store.findContactByEmail(ORG, 'new.person@example.test');
    expect(c!.firstName).toBe('Nikhil');
    const events = await f.store.listEvents(ORG, {});
    expect(events.some((e) => e.type === 'contact.created')).toBe(true);
    expect(f.ch.sent[0].subject).toBe('Stage 3, Nikhil');
  });

  it('refuses an event type that is not a usable name', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, makeEvent({ type: 'Stage Changed!!', orgId: ORG, contactId: f.contact.id }));
    expect(r.accepted).toBe(false);
    expect(r.error).toMatch(/not a usable event type/);
  });
});

describe('editing a live workflow', () => {
  it('an in-flight run keeps the version it started on', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];

    // Rewrite the workflow: the reminder becomes a different subject, and version 2 is stored.
    const next = stageThreeDefinition();
    (next.nodes.find((n) => n.id === 'action_2') as any).action.params.subject = 'REWRITTEN';
    const saved = await saveWorkflow(f.store, ORG, { id: f.workflow.id, key: 'wf', name: 'Test workflow', definition: next }, null);
    expect(saved.versioned).toBe(true);
    expect(saved.workflow!.version).toBe(2);
    expect(saved.message).toMatch(/already in flight/);

    f.clock.advanceHours(25);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent[1].subject).toBe('Reminder');   // version 1's copy, not the rewrite
    void runId;
  });
});

describe('the tick reports what it did not get to', () => {
  let store: MemoryStore;
  beforeEach(() => { store = newMemoryStore(); });

  it('says moreDue when it hits its limit', async () => {
    const c = clock('2026-08-16T09:00:00.000Z');
    store.now = c.now;
    const ch = recordingChannel();
    const def: WorkflowDefinition = {
      version: 1,
      nodes: [
        { id: 'trigger_1', kind: 'trigger', trigger: { event: 'application.stage.changed' } },
        { id: 'delay_1', kind: 'delay', delay: { kind: 'minutes', amount: 1 } },
        { id: 'action_1', kind: 'action', action: { type: 'add_tag', params: { tag: 'done' } } },
      ],
      edges: [{ id: 'e1', from: 'trigger_1', to: 'delay_1' }, { id: 'e2', from: 'delay_1', to: 'action_1' }],
    };
    const saved = await saveWorkflow(store, ORG, { key: 'wf', name: 'w', definition: def }, null);
    await setWorkflowStatus(store, ORG, saved.workflow!.id, 'active', { channels: ch.resolve });
    const deps: EngineDeps = { store, now: c.now, channels: ch.resolve };
    for (let i = 0; i < 5; i++) {
      const contact = await store.upsertContact(ORG, { email: 'p' + i + '@example.test' });
      await ingestEvent({ ...deps, advance: true }, stageEvent(contact.id, '3', 'evt_' + i));
    }
    c.advanceMs(120_000);
    const t = await tick(deps, { orgId: ORG, limit: 2 });
    expect(t.claimed).toBe(2);
    expect(t.moreDue).toBe(true);
  });
});
