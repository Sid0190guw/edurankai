// src/lib/mailplatform/memory-store.ts — AutomationStore, in one process. Tests and dry runs.
//
// This is not a mock. It implements the same contract with the same atomicity rules, which is what
// makes it worth having: the tests that matter for this engine (a worker dying between claiming a
// step and finishing it, an event delivered twice, a run resumed after everything was thrown away)
// are all about ORDERING, and ordering is exactly what this reproduces. A mock returning canned
// answers would prove none of them.
//
// The one behaviour it cannot reproduce is genuine concurrency, so wherever the Postgres version
// relies on a UNIQUE index or SKIP LOCKED, the equivalent invariant is enforced here in the same
// method — never by the caller. If a test can drive this store into a duplicate send, so can two
// Vercel functions.
import type {
  AutomationStore, ClaimOutcome, ContactRecord, EventRecord, ListRecord, ListRunsFilter,
  RunRecord, RunState, StepRecord, StepStatus, WorkflowRecord, WorkflowStatus,
} from './store';
import { normalizeEmail, normalizeKey, normalizeTag } from './store';
import type { WorkflowDefinition } from './graph';
import type { IncomingEvent } from './triggers';

let counter = 0;
/** Deterministic ids. A test that prints a run id and a fixture that expects one must agree. */
function nextId(prefix: string): string { counter += 1; return prefix + '_' + String(counter).padStart(6, '0'); }

export function resetMemoryIds(): void { counter = 0; }

export class MemoryStore implements AutomationStore {
  workflows = new Map<string, WorkflowRecord>();
  versions = new Map<string, WorkflowDefinition>();   // key: orgId + '|' + workflowId + '|' + version
  runs = new Map<string, RunRecord>();
  steps = new Map<string, StepRecord>();          // key: runId + '|' + nodeId
  events = new Map<string, EventRecord>();        // key: eventId
  contacts = new Map<string, ContactRecord>();
  lists = new Map<string, ListRecord>();          // key: orgId + '|' + listKey
  listMembers = new Map<string, Set<string>>();   // key: orgId + '|' + listKey -> contact ids

  /** Set by a test to make time explicit. The engine always passes `now` in, so this is only used
   *  for the timestamps the store itself writes. */
  now: () => Date = () => new Date();

  /**
   * A deep copy that KEEPS Date objects as Dates.
   *
   * The obvious JSON.stringify/parse round trip does not work here and fails silently: Date has its
   * own toJSON, so a replacer function never sees a Date — it sees the ISO string Date already
   * produced. Every timestamp came back as a string, `waitUntil.getTime()` threw, and the failure
   * surfaced as "no runs were due" rather than as a type error. Real Postgres hands back Date
   * objects, so a store that hands back strings is not a faithful stand-in.
   */
  private clone<T>(v: T): T {
    if (v === null || v === undefined) return v;
    if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.clone(x)) as unknown as T;
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = this.clone(x);
      return out as unknown as T;
    }
    return v;
  }

  // ---- workflows ----
  async getWorkflow(orgId: string, id: string): Promise<WorkflowRecord | null> {
    const w = this.workflows.get(id);
    return w && w.orgId === orgId ? this.clone(w) : null;
  }
  async getWorkflowByKey(orgId: string, key: string): Promise<WorkflowRecord | null> {
    for (const w of this.workflows.values()) if (w.orgId === orgId && w.key === key) return this.clone(w);
    return null;
  }
  async getWorkflowByWebhookToken(token: string): Promise<WorkflowRecord | null> {
    if (!token) return null;
    for (const w of this.workflows.values()) if (w.webhookToken && w.webhookToken === token) return this.clone(w);
    return null;
  }
  async listWorkflows(orgId: string, opts: { status?: WorkflowStatus; limit?: number } = {}): Promise<WorkflowRecord[]> {
    return [...this.workflows.values()]
      .filter((w) => w.orgId === orgId && (!opts.status || w.status === opts.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, opts.limit || 200)
      .map((w) => this.clone(w));
  }
  async saveWorkflow(w: Omit<WorkflowRecord, 'createdAt' | 'updatedAt'>): Promise<WorkflowRecord> {
    const existing = this.workflows.get(w.id);
    const rec: WorkflowRecord = { ...(w as any), createdAt: existing?.createdAt || this.now(), updatedAt: this.now() };
    this.workflows.set(rec.id, this.clone(rec));
    return this.clone(rec);
  }
  async deleteWorkflow(orgId: string, id: string): Promise<boolean> {
    const w = this.workflows.get(id);
    if (!w || w.orgId !== orgId) return false;
    this.workflows.delete(id);
    return true;
  }
  async workflowsListeningFor(orgId: string, eventType: string): Promise<WorkflowRecord[]> {
    return [...this.workflows.values()]
      .filter((w) => w.orgId === orgId && w.status === 'active' && w.triggerEvent === eventType)
      .map((w) => this.clone(w));
  }
  async saveWorkflowVersion(orgId: string, workflowId: string, version: number, definition: WorkflowDefinition): Promise<void> {
    this.versions.set(orgId + '|' + workflowId + '|' + version, this.clone(definition));
  }
  async getWorkflowDefinition(orgId: string, workflowId: string, version: number): Promise<WorkflowDefinition | null> {
    return this.clone(this.versions.get(orgId + '|' + workflowId + '|' + version) || null);
  }

  // ---- events ----
  async recordEvent(e: IncomingEvent): Promise<{ stored: boolean; record: EventRecord }> {
    const existing = this.events.get(e.eventId);
    if (existing) return { stored: false, record: this.clone(existing) };   // the duplicate, refused
    const rec: EventRecord = {
      eventId: e.eventId, orgId: e.orgId, type: e.type, contactId: e.contactId,
      payload: e.payload || {}, source: e.source, occurredAt: e.occurredAt,
      receivedAt: this.now(), processedAt: null, startedRuns: 0, error: null,
    };
    this.events.set(rec.eventId, this.clone(rec));
    return { stored: true, record: this.clone(rec) };
  }
  async markEventProcessed(eventId: string, startedRuns: number, error: string | null = null): Promise<void> {
    const e = this.events.get(eventId);
    if (!e) return;
    e.processedAt = this.now();
    e.startedRuns = startedRuns;
    e.error = error;
  }
  async listEvents(orgId: string, opts: { type?: string; limit?: number } = {}): Promise<EventRecord[]> {
    return [...this.events.values()]
      .filter((e) => e.orgId === orgId && (!opts.type || e.type === opts.type))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, opts.limit || 100)
      .map((e) => this.clone(e));
  }

  // ---- runs ----
  async createRun(r: RunRecord): Promise<{ created: boolean; run: RunRecord }> {
    if (r.triggerEventId) {
      for (const existing of this.runs.values()) {
        // The UNIQUE (workflow_id, trigger_event_id) index, enforced here so a test cannot get a
        // duplicate run past this store either.
        if (existing.workflowId === r.workflowId && existing.triggerEventId === r.triggerEventId) {
          return { created: false, run: this.clone(existing) };
        }
      }
    }
    const run = this.clone(r);
    this.runs.set(run.runId, run);
    return { created: true, run: this.clone(run) };
  }
  async getRun(orgId: string, runId: string): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    return r && r.orgId === orgId ? this.clone(r) : null;
  }
  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    if (!r) return null;
    Object.assign(r, this.clone(patch), { updatedAt: this.now() });
    return this.clone(r);
  }
  async listRuns(orgId: string, f: ListRunsFilter = {}): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.orgId === orgId)
      .filter((r) => (!f.workflowId || r.workflowId === f.workflowId))
      .filter((r) => (!f.contactId || r.contactId === f.contactId))
      .filter((r) => (!f.state || r.state === f.state))
      .filter((r) => (!f.deadLetterOnly || r.deadLetter))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, f.limit || 100)
      .map((r) => this.clone(r));
  }
  async claimDueRuns(now: Date, limit: number, staleMs: number): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const r of this.runs.values()) {
      if (out.length >= limit) break;
      const dueWait = r.state === 'WAITING' && r.waitUntil !== null && r.waitUntil.getTime() <= now.getTime();
      const abandoned = r.state === 'RUNNING' && now.getTime() - r.updatedAt.getTime() >= staleMs;
      if (!dueWait && !abandoned) continue;
      r.state = 'RUNNING';
      r.waitUntil = null;
      r.updatedAt = now;
      out.push(this.clone(r));
    }
    return out;
  }
  async countRuns(orgId: string): Promise<Record<RunState, number>> {
    const c: Record<RunState, number> = { RUNNING: 0, WAITING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, PAUSED: 0 };
    for (const r of this.runs.values()) if (r.orgId === orgId) c[r.state] += 1;
    return c;
  }

  // ---- steps ----
  async claimStep(runId: string, nodeId: string, opts: { reclaimStale: boolean; staleMs: number; now: Date }): Promise<ClaimOutcome> {
    const key = runId + '|' + nodeId;
    const existing = this.steps.get(key);
    if (!existing) {
      const step: StepRecord = { runId, nodeId, attempt: 1, status: 'running', claimedAt: opts.now, finishedAt: null, result: null, error: null, externalRef: null };
      this.steps.set(key, step);
      return { outcome: 'claimed', step: this.clone(step) };
    }
    if (existing.status === 'done') return { outcome: 'already_done', step: this.clone(existing) };
    if (existing.status === 'needs_review') return { outcome: 'needs_review', step: this.clone(existing) };
    if (existing.status === 'failed') {
      existing.attempt += 1;
      existing.status = 'running';
      existing.claimedAt = opts.now;
      existing.finishedAt = null;
      existing.error = null;
      return { outcome: 'claimed', step: this.clone(existing) };
    }
    // status === 'running': somebody claimed it and has not finished.
    const stale = opts.now.getTime() - existing.claimedAt.getTime() >= opts.staleMs;
    if (!stale) return { outcome: 'in_flight', step: this.clone(existing) };
    if (!opts.reclaimStale) {
      // THE CRASHED IRREVERSIBLE STEP. It was claimed, the process died, and we cannot tell from
      // here whether the mail went out. Re-running it might send a candidate the same letter twice
      // and mail cannot be recalled, so it stops and a person decides. See engine.ts.
      existing.status = 'needs_review';
      existing.error = 'The worker stopped while this step was running, and repeating it could send the same message twice.';
      return { outcome: 'needs_review', step: this.clone(existing) };
    }
    existing.attempt += 1;
    existing.claimedAt = opts.now;
    return { outcome: 'claimed', step: this.clone(existing) };
  }
  async finishStep(runId: string, nodeId: string, status: StepStatus, patch: { result?: Record<string, unknown> | null; error?: string | null; externalRef?: string | null }): Promise<void> {
    const key = runId + '|' + nodeId;
    const s = this.steps.get(key);
    if (!s) return;
    s.status = status;
    s.finishedAt = this.now();
    if (patch.result !== undefined) s.result = this.clone(patch.result);
    if (patch.error !== undefined) s.error = patch.error;
    if (patch.externalRef !== undefined) s.externalRef = patch.externalRef;
  }
  async resetStep(runId: string, nodeId: string): Promise<boolean> {
    const s = this.steps.get(runId + '|' + nodeId);
    if (!s || s.status === 'done') return false;
    s.status = 'failed';       // 'failed' is the claimable-again state; claimStep bumps the attempt
    s.finishedAt = this.now();
    return true;
  }
  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...this.steps.values()].filter((s) => s.runId === runId).map((s) => this.clone(s));
  }

  // ---- audience ----
  async getContact(orgId: string, contactId: string): Promise<ContactRecord | null> {
    const c = this.contacts.get(contactId);
    return c && c.orgId === orgId ? this.clone(c) : null;
  }
  async findContactByEmail(orgId: string, email: string): Promise<ContactRecord | null> {
    const e = normalizeEmail(email);
    for (const c of this.contacts.values()) if (c.orgId === orgId && c.email === e) return this.clone(c);
    return null;
  }
  async upsertContact(orgId: string, c: Partial<ContactRecord> & { email: string }): Promise<ContactRecord> {
    const email = normalizeEmail(c.email);
    const found = await this.findContactByEmail(orgId, email);
    if (found) {
      const live = this.contacts.get(found.id) as ContactRecord;
      for (const k of ['firstName', 'lastName', 'organization', 'phone', 'roleTitle', 'applicationStage', 'applicationNumber'] as const) {
        if (c[k] !== undefined) (live as any)[k] = c[k];
      }
      if (c.custom) live.custom = { ...live.custom, ...c.custom };
      live.updatedAt = this.now();
      return this.clone(live);
    }
    const rec: ContactRecord = {
      id: nextId('contact'), orgId, email,
      firstName: c.firstName ?? null, lastName: c.lastName ?? null, organization: c.organization ?? null,
      phone: c.phone ?? null, roleTitle: c.roleTitle ?? null,
      applicationStage: c.applicationStage ?? null, applicationNumber: c.applicationNumber ?? null,
      custom: c.custom || {}, tags: [...(c.tags || [])], unsubscribed: !!c.unsubscribed,
      createdAt: this.now(), updatedAt: this.now(),
    };
    this.contacts.set(rec.id, rec);
    return this.clone(rec);
  }
  async updateContactFields(orgId: string, contactId: string, fields: Record<string, unknown>): Promise<ContactRecord | null> {
    const c = this.contacts.get(contactId);
    if (!c || c.orgId !== orgId) return null;
    const known: Record<string, keyof ContactRecord> = {
      first_name: 'firstName', last_name: 'lastName', organization: 'organization', phone: 'phone',
      role_title: 'roleTitle', application_stage: 'applicationStage', application_number: 'applicationNumber',
    };
    for (const [k, v] of Object.entries(fields || {})) {
      const mapped = known[k];
      if (mapped) (c as any)[mapped] = v === null ? null : String(v);
      else c.custom = { ...c.custom, [k]: v };   // anything unrecognised is custom, never dropped
    }
    c.updatedAt = this.now();
    return this.clone(c);
  }
  async addTag(orgId: string, contactId: string, tag: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const t = normalizeTag(tag);
    if (!c || c.orgId !== orgId || !t || c.tags.includes(t)) return false;
    c.tags.push(t);
    c.updatedAt = this.now();
    return true;
  }
  async removeTag(orgId: string, contactId: string, tag: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const t = normalizeTag(tag);
    if (!c || c.orgId !== orgId) return false;
    const i = c.tags.indexOf(t);
    if (i < 0) return false;
    c.tags.splice(i, 1);
    c.updatedAt = this.now();
    return true;
  }
  async addToList(orgId: string, contactId: string, listKey: string): Promise<boolean> {
    const key = orgId + '|' + normalizeKey(listKey);
    const c = this.contacts.get(contactId);
    if (!c || c.orgId !== orgId) return false;
    if (!this.lists.has(key)) this.lists.set(key, { id: nextId('list'), orgId, key: normalizeKey(listKey), name: listKey });
    const set = this.listMembers.get(key) || new Set<string>();
    if (set.has(contactId)) return false;
    set.add(contactId);
    this.listMembers.set(key, set);
    return true;
  }
  async removeFromList(orgId: string, contactId: string, listKey: string): Promise<boolean> {
    const key = orgId + '|' + normalizeKey(listKey);
    const set = this.listMembers.get(key);
    if (!set || !set.has(contactId)) return false;
    set.delete(contactId);
    return true;
  }
  async getList(orgId: string, listKey: string): Promise<ListRecord | null> {
    return this.clone(this.lists.get(orgId + '|' + normalizeKey(listKey)) || null);
  }
  async listContacts(orgId: string, opts: { listKey?: string; tag?: string; limit: number }): Promise<ContactRecord[]> {
    const members = opts.listKey ? this.listMembers.get(orgId + '|' + normalizeKey(opts.listKey)) || new Set<string>() : null;
    const tag = opts.tag ? normalizeTag(opts.tag) : null;
    return [...this.contacts.values()]
      .filter((c) => c.orgId === orgId)
      .filter((c) => (!members || members.has(c.id)))
      .filter((c) => (!tag || c.tags.includes(tag)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, opts.limit)
      .map((c) => this.clone(c));
  }
  async setUnsubscribed(orgId: string, contactId: string, on: boolean): Promise<boolean> {
    const c = this.contacts.get(contactId);
    if (!c || c.orgId !== orgId || c.unsubscribed === on) return false;
    c.unsubscribed = on;
    c.updatedAt = this.now();
    return true;
  }
}

export function newMemoryStore(): MemoryStore { return new MemoryStore(); }
export { nextId as memoryNextId };
