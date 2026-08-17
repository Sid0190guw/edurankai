// src/lib/mailplatform/memory-store.ts — AutomationStore, in one process. Tests and dry runs.
//
// This is not a mock. It implements the same contract with the same atomicity rules, which is what
// makes it worth having: the behaviours that matter for this engine (a worker dying between claiming
// a step and finishing it, an event delivered twice, a run resumed after everything was thrown away)
// are all about ORDERING, and ordering is exactly what this reproduces. A mock returning canned
// answers would prove none of them.
//
// The one thing it cannot reproduce is genuine concurrency, so wherever the Postgres version relies
// on a UNIQUE index or SKIP LOCKED, the equivalent invariant is enforced here in the same method —
// never by the caller. If a test can drive this store into a duplicate send, so can two functions.
import type {
  AutomationRecord, AutomationStatus, AutomationStore, ClaimOutcome, ContactRecord, EventRecord,
  ListRecord, ListRunsFilter, RunRecord, RunState, StepRecord, StepStatus,
} from './store';
import { normalizeEmail, normalizeKey, normalizeTag } from './store';
import type { AutomationGraph } from './graph';
import type { IncomingEvent } from './triggers';

let counter = 0;
/** Deterministic ids. A test that prints one and a fixture that expects it must agree. */
function nextId(prefix: string): string { counter += 1; return prefix + '_' + String(counter).padStart(6, '0'); }
export function resetMemoryIds(): void { counter = 0; }

export class MemoryStore implements AutomationStore {
  automations = new Map<string, AutomationRecord>();
  versions = new Map<string, AutomationGraph>();   // key: orgId|automationId|version
  runs = new Map<string, RunRecord>();
  steps = new Map<string, StepRecord>();           // key: runId|nodeId
  events = new Map<string, EventRecord>();         // key: eventId
  contacts = new Map<string, ContactRecord>();
  lists = new Map<string, ListRecord>();           // key: list key
  listMembers = new Map<string, Set<string>>();    // key: list key -> contact ids
  suppressed = new Set<string>();
  templates = new Map<string, { id: string; name: string; subject: string; html: string; text: string }>();

  /** Set by a test to make time explicit. The engine always passes `now` in; this is only for the
   *  timestamps the store itself writes. */
  now: () => Date = () => new Date();

  /**
   * A deep copy that KEEPS Date objects as Dates.
   *
   * The obvious JSON round trip does not work and fails silently: Date has its own toJSON, so a
   * replacer never sees a Date — it sees the ISO string Date already produced. Every timestamp came
   * back as a string, `waitUntil.getTime()` threw, and it surfaced as "no runs were due" rather than
   * as a type error. Real Postgres hands back Date objects, so a store that hands back strings is
   * not a faithful stand-in.
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

  // ---- automations ----
  async getAutomation(orgId: string, id: string): Promise<AutomationRecord | null> {
    const a = this.automations.get(id);
    return a && a.orgId === orgId ? this.clone(a) : null;
  }
  async getAutomationByWebhookToken(token: string): Promise<AutomationRecord | null> {
    if (!token) return null;
    for (const a of this.automations.values()) if (a.webhookToken && a.webhookToken === token) return this.clone(a);
    return null;
  }
  async listAutomations(orgId: string, opts: { status?: AutomationStatus; limit?: number } = {}): Promise<AutomationRecord[]> {
    return [...this.automations.values()]
      .filter((a) => a.orgId === orgId && (!opts.status || a.status === opts.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, opts.limit || 200)
      .map((a) => this.clone(a));
  }
  async activeAutomations(orgId: string): Promise<AutomationRecord[]> {
    return [...this.automations.values()].filter((a) => a.orgId === orgId && a.status === 'active').map((a) => this.clone(a));
  }
  async setVersion(orgId: string, id: string, version: number): Promise<void> {
    const a = this.automations.get(id);
    if (a && a.orgId === orgId) { a.version = version; a.updatedAt = this.now(); }
  }
  async saveGraphVersion(orgId: string, automationId: string, version: number, graph: AutomationGraph): Promise<void> {
    this.versions.set(orgId + '|' + automationId + '|' + version, this.clone(graph));
  }
  async getGraphVersion(orgId: string, automationId: string, version: number): Promise<AutomationGraph | null> {
    return this.clone(this.versions.get(orgId + '|' + automationId + '|' + version) || null);
  }

  /** Test helper — the real automation row is written by mail-product's saveAutomation(). */
  putAutomation(a: Partial<AutomationRecord> & { id?: string; name: string; graph: AutomationGraph; orgId: string }): AutomationRecord {
    const rec: AutomationRecord = {
      id: a.id || nextId('auto'), orgId: a.orgId, name: a.name, description: a.description || '',
      status: a.status || 'draft', version: a.version || 1, graph: a.graph,
      webhookToken: a.webhookToken ?? null, createdByUserId: a.createdByUserId ?? null,
      createdAt: this.automations.get(a.id || '')?.createdAt || this.now(), updatedAt: this.now(),
    };
    this.automations.set(rec.id, this.clone(rec));
    return this.clone(rec);
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
        // The UNIQUE (automation_id, trigger_event_id) index, enforced here so a test cannot get a
        // duplicate run past this store either.
        if (existing.automationId === r.automationId && existing.triggerEventId === r.triggerEventId) {
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
      .filter((r) => (!f.automationId || r.automationId === f.automationId))
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
      const dueWait = r.state === 'waiting' && r.waitUntil !== null && r.waitUntil.getTime() <= now.getTime();
      const abandoned = r.state === 'running' && now.getTime() - r.updatedAt.getTime() >= staleMs;
      if (!dueWait && !abandoned) continue;
      r.state = 'running';
      r.waitUntil = null;
      r.updatedAt = now;
      out.push(this.clone(r));
    }
    return out;
  }
  async countRuns(orgId: string): Promise<Record<RunState, number>> {
    const c: Record<RunState, number> = { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0, paused: 0 };
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
    const stale = opts.now.getTime() - existing.claimedAt.getTime() >= opts.staleMs;
    if (!stale) return { outcome: 'in_flight', step: this.clone(existing) };
    if (!opts.reclaimStale) {
      // THE CRASHED IRREVERSIBLE STEP. It was claimed, the process died, and we cannot tell from here
      // whether the mail went out. Re-running it might send a candidate the same letter twice and mail
      // cannot be recalled, so it stops and a person decides. See engine.ts.
      existing.status = 'needs_review';
      existing.error = 'The worker stopped while this step was running, and repeating it could send the same message twice.';
      return { outcome: 'needs_review', step: this.clone(existing) };
    }
    existing.attempt += 1;
    existing.claimedAt = opts.now;
    return { outcome: 'claimed', step: this.clone(existing) };
  }
  async finishStep(runId: string, nodeId: string, status: StepStatus, patch: { result?: Record<string, unknown> | null; error?: string | null; externalRef?: string | null }): Promise<void> {
    const s = this.steps.get(runId + '|' + nodeId);
    if (!s) return;
    s.status = status;
    s.finishedAt = this.now();
    if (patch.result !== undefined) s.result = this.clone(patch.result);
    if (patch.error !== undefined) s.error = patch.error;
    if (patch.externalRef !== undefined) s.externalRef = patch.externalRef;
  }
  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...this.steps.values()].filter((s) => s.runId === runId).map((s) => this.clone(s));
  }
  async resetStep(runId: string, nodeId: string): Promise<boolean> {
    const s = this.steps.get(runId + '|' + nodeId);
    if (!s || s.status === 'done') return false;
    s.status = 'failed';       // 'failed' is the claimable-again state; claimStep bumps the attempt
    s.finishedAt = this.now();
    return true;
  }

  // ---- audience ----
  async getContact(contactId: string): Promise<ContactRecord | null> {
    return this.clone(this.contacts.get(contactId) || null);
  }
  async findContactByEmail(email: string): Promise<ContactRecord | null> {
    const e = normalizeEmail(email);
    for (const c of this.contacts.values()) if (c.email === e) return this.clone(c);
    return null;
  }
  async upsertContact(c: { email: string; firstName?: string | null; lastName?: string | null; organization?: string | null; phone?: string | null; roleTitle?: string | null; fields?: Record<string, unknown> }): Promise<ContactRecord> {
    const email = normalizeEmail(c.email);
    const found = await this.findContactByEmail(email);
    if (found) {
      const live = this.contacts.get(found.id) as ContactRecord;
      for (const k of ['firstName', 'lastName', 'organization', 'phone', 'roleTitle'] as const) {
        if (c[k] !== undefined && c[k] !== null) (live as any)[k] = c[k];
      }
      if (c.fields) live.fields = { ...live.fields, ...c.fields };
      live.updatedAt = this.now();
      return this.clone(live);
    }
    const rec: ContactRecord = {
      id: nextId('contact'), email,
      firstName: c.firstName ?? null, lastName: c.lastName ?? null, organization: c.organization ?? null,
      phone: c.phone ?? null, roleTitle: c.roleTitle ?? null, status: 'subscribed',
      fields: c.fields || {}, tags: [],
      createdAt: this.now(), updatedAt: this.now(),
    };
    this.contacts.set(rec.id, rec);
    return this.clone(rec);
  }
  async updateContactFields(contactId: string, fields: Record<string, unknown>): Promise<ContactRecord | null> {
    const c = this.contacts.get(contactId);
    if (!c) return null;
    const known: Record<string, keyof ContactRecord> = {
      first_name: 'firstName', last_name: 'lastName', organization: 'organization', phone: 'phone', role_title: 'roleTitle',
    };
    for (const [k, v] of Object.entries(fields || {})) {
      const mapped = known[k];
      if (mapped) (c as any)[mapped] = v === null ? null : String(v);
      else c.fields = { ...c.fields, [k]: v };   // anything unrecognised is a custom field, never dropped
    }
    c.updatedAt = this.now();
    return this.clone(c);
  }
  async addTag(contactId: string, tag: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const t = normalizeTag(tag);
    if (!c || !t || c.tags.includes(t)) return false;
    c.tags.push(t);
    c.updatedAt = this.now();
    return true;
  }
  async removeTag(contactId: string, tag: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const t = normalizeTag(tag);
    if (!c) return false;
    const i = c.tags.indexOf(t);
    if (i < 0) return false;
    c.tags.splice(i, 1);
    c.updatedAt = this.now();
    return true;
  }
  async addToList(contactId: string, listKey: string): Promise<boolean> {
    const key = normalizeKey(listKey);
    // Mirrors the Postgres store: a list an operator has not created is not invented here.
    if (!this.lists.has(key) || !this.contacts.has(contactId)) return false;
    const set = this.listMembers.get(key) || new Set<string>();
    if (set.has(contactId)) return false;
    set.add(contactId);
    this.listMembers.set(key, set);
    return true;
  }
  async removeFromList(contactId: string, listKey: string): Promise<boolean> {
    const set = this.listMembers.get(normalizeKey(listKey));
    if (!set || !set.has(contactId)) return false;
    set.delete(contactId);
    return true;
  }
  async getList(listKey: string): Promise<ListRecord | null> {
    return this.clone(this.lists.get(normalizeKey(listKey)) || null);
  }
  async listContacts(opts: { listKey?: string; tag?: string; limit: number }): Promise<ContactRecord[]> {
    const members = opts.listKey ? this.listMembers.get(normalizeKey(opts.listKey)) || new Set<string>() : null;
    const tag = opts.tag ? normalizeTag(opts.tag) : null;
    return [...this.contacts.values()]
      .filter((c) => (!members || members.has(c.id)))
      .filter((c) => (!tag || c.tags.includes(tag)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, opts.limit)
      .map((c) => this.clone(c));
  }
  async isSuppressed(email: string): Promise<boolean> {
    return this.suppressed.has(normalizeEmail(email));
  }
  async setStatus(contactId: string, status: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    if (!c || c.status === status) return false;
    c.status = status;
    c.updatedAt = this.now();
    return true;
  }
  async getTemplate(templateId: string) {
    return this.clone(this.templates.get(templateId) || null);
  }
}

export function newMemoryStore(): MemoryStore { return new MemoryStore(); }
export { nextId as memoryNextId };
