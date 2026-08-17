// src/lib/mailplatform/engine.test.ts — the behaviours that only show up over TIME and across
// PROCESSES: a delay that outlives its worker, an event delivered twice, a crash between the send
// and the record of it, a run cancelled while it waits.
//
// The graphs here are the CANVAS's own shape (src/lib/mail-product/automations.ts), and every
// fixture asserts validateGraph() would publish it — so what the engine is tested against is what an
// operator can actually draw at /mail/automations.
//
// All of it runs against MemoryStore, which enforces the same atomicity rules as the Postgres store.
// "The worker restarted" is modelled by throwing away every engine object and building new ones over
// the SAME store; "the database restarted" is modelled by serialising the store to JSON and reading
// it back, which is the honest test of whether anything important was living in a variable.
import { describe, expect, it } from 'vitest';
import { MemoryStore, newMemoryStore } from './memory-store';
import { advanceRun, type EngineDeps } from './engine';
import { emit, ingestEvent, makeEvent, withPublisher } from './router';
import { controlRun, tick } from './worker';
import { validateGraph } from './graph';
import type { AutomationGraph } from './graph';
import type { ChannelAdapter } from './adapters';
import { TemporaryFailure } from './errors';

const ORG = 'testorg';
const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const REMINDER_ID = '22222222-2222-4222-8222-222222222222';

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
        throw new Error('process died after the message left');
      }
      if (mode === 'temporary') throw new TemporaryFailure('421 4.7.0 try again later');
      if (mode === 'permanent') return { ok: false, error: '550 5.1.1 no such user' };
      sent.push({ to: m.to, subject: m.subject || '', key: m.idempotencyKey });
      return { ok: true, ref: 'msg_' + sent.length };
    },
  };
  return { adapter, sent, setMode: (m: typeof mode) => { mode = m; }, resolve: (id: string) => (id === 'email' ? adapter : null) };
}

/** A fixed, movable clock. Nothing here depends on real time passing. */
function clock(startIso: string) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advanceMs: (ms: number) => { t += ms; }, advanceHours: (h: number) => { t += h * 3_600_000; } };
}

/** stage changed -> is it 3? -> send -> wait 24h -> still incomplete? -> remind / tag. */
const stageThreeGraph = (): AutomationGraph => ({
  nodes: [
    { id: 'trigger_1', kind: 'trigger', config: { event: 'application_stage_changed' } },
    { id: 'condition_1', kind: 'condition', config: { field: 'stage', operator: 'equals', value: '3' } },
    { id: 'send_1', kind: 'send_email', config: { templateId: TEMPLATE_ID } },
    { id: 'delay_1', kind: 'delay', config: { minutes: 1440 } },
    { id: 'condition_2', kind: 'condition', config: { field: 'assessment_completed', operator: 'not_equals', value: 'true' } },
    { id: 'send_2', kind: 'send_email', config: { templateId: REMINDER_ID } },
    { id: 'add_tag_1', kind: 'add_tag', config: { tag: 'assessment-complete' } },
    { id: 'end_1', kind: 'end', config: {} },
    { id: 'end_2', kind: 'end', config: {} },
    { id: 'end_3', kind: 'end', config: {} },
  ],
  edges: [
    { from: 'trigger_1', to: 'condition_1' },
    { from: 'condition_1', to: 'send_1', branch: 'yes' },
    { from: 'condition_1', to: 'end_1', branch: 'no' },
    { from: 'send_1', to: 'delay_1' },
    { from: 'delay_1', to: 'condition_2' },
    { from: 'condition_2', to: 'send_2', branch: 'yes' },
    { from: 'condition_2', to: 'add_tag_1', branch: 'no' },
    { from: 'send_2', to: 'end_2' },
    { from: 'add_tag_1', to: 'end_3' },
  ],
});

async function fixture(graph = stageThreeGraph(), startIso = '2026-08-16T09:00:00.000Z') {
  const store = newMemoryStore();
  const c = clock(startIso);
  store.now = c.now;
  const ch = recordingChannel();
  store.templates.set(TEMPLATE_ID, { id: TEMPLATE_ID, name: 'stage-3', subject: 'Stage 3, {{first_name}}', html: '', text: 'Hello {{first_name|default:there}}' });
  store.templates.set(REMINDER_ID, { id: REMINDER_ID, name: 'reminder', subject: 'Reminder', html: '', text: 'Your assessment is open' });

  // The graph must be one the canvas would actually publish. A test that exercised a shape the
  // validator refuses would prove the engine works on automations nobody can create.
  const v = validateGraph(graph);
  expect(v.ok, v.problems.map((p) => p.nodeId + ': ' + p.message).join('; ')).toBe(true);

  const automation = store.putAutomation({ orgId: ORG, name: 'Test automation', graph, status: 'active', version: 1 });
  await store.saveGraphVersion(ORG, automation.id, 1, graph);
  const contact = await store.upsertContact({ email: 'ananya@example.test', firstName: 'Ananya' });
  const deps = (): EngineDeps => ({ store, now: c.now, channels: ch.resolve });
  return { store, clock: c, ch, automation, contact, deps };
}

const stageEvent = (contactId: string, stage = '3', eventId = 'evt_stage_1') =>
  makeEvent({ type: 'application_stage_changed', orgId: ORG, contactId, payload: { stage }, eventId, source: 'internal' });

describe('trigger, condition, branch', () => {
  it('starts a run, takes the yes branch and sends', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(r.startedRuns.length).toBe(1);
    expect(f.ch.sent.length).toBe(1);
    expect(f.ch.sent[0].subject).toBe('Stage 3, Ananya');
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('waiting');            // parked at the 24-hour delay
    expect(run!.currentNode).toBe('condition_2');  // the step the wait is FOR
  });

  it('the underscored canvas key and the dotted event name are the same trigger', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true },
      makeEvent({ type: 'application.stage.changed', orgId: ORG, contactId: f.contact.id, payload: { stage: '3' }, eventId: 'evt_dotted' }));
    expect(r.startedRuns.length).toBe(1);
    expect(f.ch.sent.length).toBe(1);
  });

  it('runs but sends nothing when the condition does not match', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '2'));
    expect(r.startedRuns.length).toBe(1);          // a run IS started — the narrowing is a condition
    expect(f.ch.sent.length).toBe(0);              // …and it ends at the End step without sending
    expect((await f.store.getRun(ORG, r.startedRuns[0]))!.state).toBe('completed');
  });

  it('does not start an automation listening for a different event', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, makeEvent({ type: 'contact.created', orgId: ORG, contactId: f.contact.id, eventId: 'evt_other' }));
    expect(r.startedRuns.length).toBe(0);
  });

  it('will not start a run for another organisation', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true },
      makeEvent({ type: 'application_stage_changed', orgId: 'someone-else', contactId: f.contact.id, payload: { stage: '3' }, eventId: 'evt_x' }));
    expect(r.startedRuns.length).toBe(0);
    expect(f.ch.sent.length).toBe(0);
  });
});

describe('delays survive time and processes', () => {
  it('a 24-hour delay is a database row, and the run resumes on a later tick', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(f.ch.sent.length).toBe(1);

    f.clock.advanceHours(1);
    expect((await tick(f.deps(), { orgId: ORG })).claimed).toBe(0);   // nothing is due yet
    expect(f.ch.sent.length).toBe(1);

    f.clock.advanceHours(24);
    expect((await tick(f.deps(), { orgId: ORG })).claimed).toBe(1);
    expect(f.ch.sent.length).toBe(2);
    expect(f.ch.sent[1].subject).toBe('Reminder');
  });

  it('takes the no branch when the contact CHANGED during the wait — the contact is re-read', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    await f.store.updateContactFields(f.contact.id, { assessment_completed: 'true' });
    f.clock.advanceHours(25);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);                       // no reminder
    expect((await f.store.getContact(f.contact.id))!.tags).toContain('assessment-complete');
    expect((await f.store.getRun(ORG, r.startedRuns[0]))!.state).toBe('completed');
  });

  it('survives a WORKER restart: new engine objects over the same store', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    f.clock.advanceHours(25);
    const ch2 = recordingChannel();
    const fresh: EngineDeps = { store: f.store, now: f.clock.now, channels: ch2.resolve };
    expect((await tick(fresh, { orgId: ORG })).claimed).toBe(1);
    expect(ch2.sent.length).toBe(1);   // the reminder went out from the NEW process
  });

  it('survives a DATABASE restart: the whole store round-tripped through JSON', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));

    const dump = JSON.stringify({
      automations: [...f.store.automations], versions: [...f.store.versions], runs: [...f.store.runs],
      steps: [...f.store.steps], events: [...f.store.events], contacts: [...f.store.contacts],
      templates: [...f.store.templates],
    });
    const raw = JSON.parse(dump, (_k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(v) ? new Date(v) : v));
    const revived = new MemoryStore();
    revived.now = f.clock.now;
    revived.automations = new Map(raw.automations);
    revived.versions = new Map(raw.versions);
    revived.runs = new Map(raw.runs);
    revived.steps = new Map(raw.steps);
    revived.events = new Map(raw.events);
    revived.contacts = new Map(raw.contacts);
    revived.templates = new Map(raw.templates);

    const ch2 = recordingChannel();
    f.clock.advanceHours(25);
    expect((await tick({ store: revived, now: f.clock.now, channels: ch2.resolve }, { orgId: ORG })).claimed).toBe(1);
    expect(ch2.sent.length).toBe(1);
    expect((await revived.getRun(ORG, r.startedRuns[0]))!.state).toBe('completed');
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
    const runId = r.startedRuns[0];
    await f.store.updateRun(runId, { state: 'running', currentNode: 'send_1' });
    const again = await advanceRun(f.deps(), (await f.store.getRun(ORG, runId))!);
    expect(f.ch.sent.length).toBe(1);                                        // NOT two
    expect(again.steps.some((s) => /Already done/.test(s.summary))).toBe(true);
  });

  it('a crash between the send and the record of it does NOT re-send — it stops for a person', async () => {
    const f = await fixture();
    f.ch.setMode('crash');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    expect(f.ch.sent.length).toBe(1);                       // the message DID leave
    const runId = r.startedRuns[0];

    // The crash left the step claimed-but-unfinished. Put it back to 'running' and move the clock
    // past the stale window — exactly how an abandoned step looks to the next worker.
    await f.store.finishStep(runId, 'send_1', 'running', {});
    await f.store.updateRun(runId, { state: 'waiting', waitUntil: new Date(0), completedAt: null });
    f.clock.advanceMs(20 * 60_000);

    f.ch.setMode('ok');
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);                        // still one. No second copy.
    const run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('failed');
    expect(run!.deadLetter).toBe(true);
    expect(run!.error).toMatch(/could send the same message again/);
  });

  it('a REVERSIBLE step abandoned the same way is simply re-run', async () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: 'trigger_1', kind: 'trigger', config: { event: 'application_stage_changed' } },
        { id: 'add_tag_1', kind: 'add_tag', config: { tag: 'seen' } },
        { id: 'end_1', kind: 'end', config: {} },
      ],
      edges: [{ from: 'trigger_1', to: 'add_tag_1' }, { from: 'add_tag_1', to: 'end_1' }],
    };
    const f = await fixture(graph);
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    await f.store.finishStep(runId, 'add_tag_1', 'running', {});
    await f.store.updateRun(runId, { state: 'waiting', waitUntil: new Date(0), completedAt: null });
    f.clock.advanceMs(20 * 60_000);
    await tick(f.deps(), { orgId: ORG });
    const run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('completed');           // no needs_review; a tag can be re-applied
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
    expect(run!.state).toBe('waiting');
    expect(run!.retryCount).toBe(1);
    expect(run!.error).toMatch(/421/);

    f.ch.setMode('ok');
    f.clock.advanceMs(2 * 60_000);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent.length).toBe(1);
    run = await f.store.getRun(ORG, runId);
    expect(run!.state).toBe('waiting');            // now on the 24-hour delay, not a retry
    expect(run!.retryCount).toBe(0);
  });

  it('dead-letters after the retry cap', async () => {
    const f = await fixture();
    f.ch.setMode('temporary');
    const deps = { ...f.deps(), maxRetries: 2 };
    const r = await ingestEvent({ ...deps, advance: true }, stageEvent(f.contact.id));
    for (let i = 0; i < 5; i++) { f.clock.advanceMs(60 * 60_000); await tick(deps, { orgId: ORG }); }
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('failed');
    expect(run!.deadLetter).toBe(true);
    expect(run!.errorKind).toBe('temporary');
  });

  it('dead-letters a permanent failure immediately, with no retries', async () => {
    const f = await fixture();
    f.ch.setMode('permanent');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(run!.state).toBe('failed');
    expect(run!.retryCount).toBe(0);
    expect(run!.errorKind).toBe('permanent');
  });

  it('ends the run — without an error — when the contact is not subscribed', async () => {
    const f = await fixture();
    await f.store.setStatus(f.contact.id, 'unsubscribed');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(f.ch.sent.length).toBe(0);
    expect(run!.state).toBe('completed');          // not failed
    expect(run!.deadLetter).toBe(false);
    expect(run!.errorKind).toBe('business');
    expect(run!.error).toMatch(/not subscribed/);
  });

  it('ends the run when the address is suppressed, even though the contact looks subscribed', async () => {
    const f = await fixture();
    f.store.suppressed.add(f.contact.email);
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(f.ch.sent.length).toBe(0);
    expect(run!.errorKind).toBe('business');
    expect(run!.error).toMatch(/suppression list/);
  });

  it('refuses to send when the template is missing or switched off', async () => {
    const f = await fixture();
    f.store.templates.delete(TEMPLATE_ID);
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const run = await f.store.getRun(ORG, r.startedRuns[0]);
    expect(f.ch.sent.length).toBe(0);
    expect(run!.state).toBe('failed');
    expect(run!.errorKind).toBe('permanent');
  });

  it('a dead-lettered run can be retried by a person, and the stopped step is released', async () => {
    const f = await fixture();
    f.ch.setMode('permanent');
    const r = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));
    const runId = r.startedRuns[0];
    expect((await f.store.getRun(ORG, runId))!.state).toBe('failed');

    f.ch.setMode('ok');
    expect((await controlRun(f.store, ORG, runId, 'retry')).changed).toBe(true);
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
    expect((await tick(f.deps(), { orgId: ORG })).claimed).toBe(0);
    expect(f.ch.sent.length).toBe(1);              // only the first send, never the reminder
    expect((await f.store.getRun(ORG, runId))!.state).toBe('cancelled');
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
    expect((await f.store.getRun(ORG, runId))!.state).toBe('completed');
  });

  it('a paused automation starts no new runs', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_1'));
    f.store.putAutomation({ ...f.automation, status: 'paused' });
    const after = await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id, '3', 'evt_2'));
    expect(after.startedRuns.length).toBe(0);
  });
});

describe('chained automations and follow-on events', () => {
  it('a tag added by one automation starts another, and re-adding it emits nothing', async () => {
    const f = await fixture({
      nodes: [
        { id: 'trigger_1', kind: 'trigger', config: { event: 'application_stage_changed' } },
        { id: 'add_tag_1', kind: 'add_tag', config: { tag: 'shortlisted' } },
        { id: 'end_1', kind: 'end', config: {} },
      ],
      edges: [{ from: 'trigger_1', to: 'add_tag_1' }, { from: 'add_tag_1', to: 'end_1' }],
    });

    const welcomer = f.store.putAutomation({
      orgId: ORG, name: 'Welcome the shortlisted', status: 'active', version: 1,
      graph: {
        nodes: [
          { id: 'trigger_1', kind: 'trigger', config: { event: 'tag_added', filter: { field: 'event.tag', operator: 'equals', value: 'shortlisted' } } },
          { id: 'send_1', kind: 'send_email', config: { templateId: TEMPLATE_ID } },
          { id: 'end_1', kind: 'end', config: {} },
        ],
        edges: [{ from: 'trigger_1', to: 'send_1' }, { from: 'send_1', to: 'end_1' }],
      },
    });
    await f.store.saveGraphVersion(ORG, welcomer.id, 1, welcomer.graph);

    await ingestEvent({ ...withPublisher(f.deps(), 0), advance: true }, stageEvent(f.contact.id));
    expect((await f.store.getContact(f.contact.id))!.tags).toContain('shortlisted');
    expect(f.ch.sent.length).toBe(1);

    // The tag is already there, so a second run of the tagger emits nothing and the welcomer does not
    // fire again — which is what stops two automations looping on a no-op.
    await ingestEvent({ ...withPublisher(f.deps(), 0), advance: true }, stageEvent(f.contact.id, '3', 'evt_second'));
    expect(f.ch.sent.length).toBe(1);
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
    expect((await f.store.findContactByEmail('new.person@example.test'))!.firstName).toBe('Nikhil');
    expect((await f.store.listEvents(ORG, {})).some((e) => e.type === 'contact.created')).toBe(true);
    expect(f.ch.sent[0].subject).toBe('Stage 3, Nikhil');
  });

  it('refuses an event type that is not a usable name', async () => {
    const f = await fixture();
    const r = await ingestEvent({ ...f.deps(), advance: true }, makeEvent({ type: 'Stage Changed!!', orgId: ORG, contactId: f.contact.id }));
    expect(r.accepted).toBe(false);
    expect(r.error).toMatch(/not a usable event type/);
  });
});

describe('editing a live automation', () => {
  it('an in-flight run keeps the version it started on', async () => {
    const f = await fixture();
    await ingestEvent({ ...f.deps(), advance: true }, stageEvent(f.contact.id));

    // Version 2: the reminder now uses a different template. The snapshot of version 1 is untouched.
    const next = stageThreeGraph();
    (next.nodes.find((n) => n.id === 'send_2') as any).config.templateId = TEMPLATE_ID;
    f.store.putAutomation({ ...f.automation, graph: next, version: 2 });
    await f.store.saveGraphVersion(ORG, f.automation.id, 2, next);

    f.clock.advanceHours(25);
    await tick(f.deps(), { orgId: ORG });
    expect(f.ch.sent[1].subject).toBe('Reminder');   // version 1's template, not the rewrite
  });
});

describe('the tick reports what it did not get to', () => {
  it('says moreDue when it hits its limit', async () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: 'trigger_1', kind: 'trigger', config: { event: 'application_stage_changed' } },
        { id: 'delay_1', kind: 'delay', config: { minutes: 1 } },
        { id: 'add_tag_1', kind: 'add_tag', config: { tag: 'done' } },
        { id: 'end_1', kind: 'end', config: {} },
      ],
      edges: [{ from: 'trigger_1', to: 'delay_1' }, { from: 'delay_1', to: 'add_tag_1' }, { from: 'add_tag_1', to: 'end_1' }],
    };
    const f = await fixture(graph);
    for (let i = 0; i < 5; i++) {
      const c = await f.store.upsertContact({ email: 'p' + i + '@example.test' });
      await ingestEvent({ ...f.deps(), advance: true }, stageEvent(c.id, '3', 'evt_' + i));
    }
    f.clock.advanceMs(120_000);
    const t = await tick(f.deps(), { orgId: ORG, limit: 2 });
    expect(t.claimed).toBe(2);
    expect(t.moreDue).toBe(true);
  });
});
