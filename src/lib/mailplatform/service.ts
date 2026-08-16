// src/lib/mailplatform/service.ts — the operations an operator performs, in one place.
//
// The admin page and the JSON API both call these. Two callers doing their own validation is how one
// of them ends up able to activate a workflow the other would refuse.
import type { AutomationStore, WorkflowRecord, WorkflowStatus } from './store';
import type { WorkflowDefinition } from './graph';
import { validateWorkflow, type ValidationProblem } from './graph';
import { isUsableEventType } from './triggers';
import { actionDefinition } from './actions';
import { channel } from './adapters';
import { pgStore } from './pg-store';
import { DEFAULT_ORG_ID, newWebhookSecret, newWebhookToken, newWorkflowId } from './security';
import { WORKFLOW_EXAMPLES, exampleByKey } from './examples';
import { setWebhookCredentials } from './pg-store';

export const ORG_ID = DEFAULT_ORG_ID;

/** The production store. Taken as a parameter everywhere below so a test can pass a memory store. */
export function defaultStore(): AutomationStore { return pgStore; }

export interface SaveInput {
  id?: string | null;
  key: string;
  name: string;
  description?: string;
  status?: WorkflowStatus;
  definition: WorkflowDefinition;
}

export interface SaveResult {
  ok: boolean;
  workflow: WorkflowRecord | null;
  problems: ValidationProblem[];
  /** True when the definition changed and the version was bumped. */
  versioned: boolean;
  message: string;
}

/**
 * Checks the graph validator cannot make, because they are about what this platform HAS rather than
 * about the shape of the drawing: an action nobody implemented, a channel nobody wired up, an event
 * type that is not a usable name.
 */
export function checkAgainstPlatform(def: WorkflowDefinition): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const n of def?.nodes || []) {
    if (n.kind === 'trigger' && n.trigger?.event && !isUsableEventType(n.trigger.event)) {
      problems.push({ level: 'error', at: n.id, message: '"' + n.trigger.event + '" is not a usable event type. Use a dotted lower-case name, e.g. application.stage.changed.' });
    }
    if (n.kind === 'trigger' && (n.trigger?.event === 'schedule.date' || n.trigger?.event === 'schedule.time') && !n.trigger?.schedule?.at) {
      problems.push({ level: 'error', at: n.id, message: 'A scheduled trigger needs a date and time to fire at, or it never fires.' });
    }
    if (n.kind !== 'action') continue;
    const type = n.action?.type || '';
    const def_ = actionDefinition(type);
    if (!def_) { problems.push({ level: 'error', at: n.id, message: 'There is no action called "' + type + '" on this platform.' }); continue; }
    for (const p of def_.params) {
      if (p.required && !String((n.action?.params || {})[p.name] ?? '').trim()) {
        problems.push({ level: 'error', at: n.id, message: '"' + def_.label + '" needs ' + p.label.toLowerCase() + '.' });
      }
    }
    const ch = String((n.action?.params || {}).channel || '');
    if (ch) {
      const adapter = channel(ch);
      if (!adapter) problems.push({ level: 'error', at: n.id, message: 'There is no "' + ch + '" channel.' });
      // Whether it is CONFIGURED is checked at activation, not here — a draft written on a laptop
      // with no SMTP is a normal thing to save.
    }
  }
  return problems;
}

/** Definitions compared by value, so a save that changed nothing does not bump the version and
 *  orphan every in-flight run onto a snapshot identical to the one they already had. */
function sameDefinition(a: WorkflowDefinition | null | undefined, b: WorkflowDefinition | null | undefined): boolean {
  try { return JSON.stringify(a || null) === JSON.stringify(b || null); } catch { return false; }
}

export async function saveWorkflow(store: AutomationStore, orgId: string, input: SaveInput, userId: string | null): Promise<SaveResult> {
  const key = String(input.key || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  if (!key) return { ok: false, workflow: null, problems: [{ level: 'error', message: 'The workflow needs a key.' }], versioned: false, message: 'The workflow needs a key.' };
  if (!String(input.name || '').trim()) return { ok: false, workflow: null, problems: [{ level: 'error', message: 'The workflow needs a name.' }], versioned: false, message: 'The workflow needs a name.' };

  const structural = validateWorkflow(input.definition);
  const platform = checkAgainstPlatform(input.definition);
  const problems = [...structural.problems, ...platform];
  const hasErrors = problems.some((p) => p.level === 'error');

  const existing = input.id ? await store.getWorkflow(orgId, input.id) : await store.getWorkflowByKey(orgId, key);
  const wantedStatus: WorkflowStatus = input.status || existing?.status || 'draft';

  // A DRAFT MAY BE BROKEN; AN ACTIVE WORKFLOW MAY NOT. Saving work in progress must always be
  // possible, or an operator loses an afternoon's drawing to a validator.
  if (hasErrors && wantedStatus === 'active') {
    return { ok: false, workflow: existing || null, problems, versioned: false, message: 'This workflow cannot be switched on until the errors below are fixed. It has not been changed.' };
  }

  const changed = !existing || !sameDefinition(existing.definition, input.definition);
  const version = existing ? (changed ? existing.version + 1 : existing.version) : 1;
  const triggerEvent = (input.definition?.nodes || []).find((n) => n.kind === 'trigger')?.trigger?.event || '';

  const saved = await store.saveWorkflow({
    id: existing?.id || input.id || newWorkflowId(),
    orgId,
    key,
    name: String(input.name).trim().slice(0, 200),
    description: String(input.description || '').trim().slice(0, 2000),
    status: hasErrors ? (wantedStatus === 'active' ? 'draft' : wantedStatus) : wantedStatus,
    version,
    definition: { ...input.definition, version },
    triggerEvent,
    webhookToken: existing?.webhookToken || null,
    createdByUserId: existing?.createdByUserId || userId,
  });

  // The snapshot is written AFTER the workflow row, and always — including for version 1, so the
  // very first run has a snapshot to follow rather than the "no snapshot was kept" fallback.
  if (changed || !(await store.getWorkflowDefinition(orgId, saved.id, version))) {
    await store.saveWorkflowVersion(orgId, saved.id, version, saved.definition);
  }

  const inflight = changed && existing
    ? (await store.listRuns(orgId, { workflowId: saved.id, limit: 500 })).filter((r) => r.state === 'WAITING' || r.state === 'RUNNING' || r.state === 'PAUSED').length
    : 0;

  return {
    ok: true,
    workflow: saved,
    problems,
    versioned: changed,
    message: changed
      ? 'Saved as version ' + version + '.' + (inflight ? ' ' + inflight + ' run' + (inflight === 1 ? '' : 's') + ' already in flight will finish on version ' + (existing as WorkflowRecord).version + ' — they do not change shape mid-way.' : '')
      : 'Saved. The steps were unchanged, so the version stayed at ' + version + '.',
  };
}

export interface StatusResult { ok: boolean; message: string; problems: ValidationProblem[] }

/** Switch a workflow on or off. Activation re-validates, and it also checks the CHANNELS are
 *  configured — because a workflow that is on and cannot send is worse than one that is off. */
export async function setWorkflowStatus(
  store: AutomationStore,
  orgId: string,
  id: string,
  status: WorkflowStatus,
  // Injected the same way the engine takes it, so a test can activate a workflow without an SMTP
  // server and production still checks the real adapters. Defaulted, never globally switched.
  opts: { channels?: (id: string) => ReturnType<typeof channel> } = {},
): Promise<StatusResult> {
  const resolveChannel = opts.channels || channel;
  const wf = await store.getWorkflow(orgId, id);
  if (!wf) return { ok: false, message: 'There is no workflow with that id here.', problems: [] };

  if (status === 'active') {
    const problems = [...validateWorkflow(wf.definition).problems, ...checkAgainstPlatform(wf.definition)];
    if (problems.some((p) => p.level === 'error')) {
      return { ok: false, message: 'This workflow cannot be switched on while it has errors.', problems };
    }
    const sends = (wf.definition?.nodes || []).filter((n) => n.kind === 'action' && (n.action?.type === 'send_email' || n.action?.type === 'send_template'));
    for (const n of sends) {
      const ch = resolveChannel(String((n.action?.params || {}).channel || 'email'));
      if (!ch) continue;
      if (!(await ch.available())) {
        return { ok: false, message: 'Not switched on: "' + (n.label || n.id) + '" sends by ' + ch.label + ', and ' + (await ch.unavailableReason()), problems };
      }
    }
    await store.saveWorkflow({ ...wf, status: 'active' });
    return { ok: true, message: 'Switched on. New matching events will start runs from now; nothing that happened before is replayed.', problems };
  }

  await store.saveWorkflow({ ...wf, status });
  return {
    ok: true,
    problems: [],
    message: status === 'paused'
      // Said explicitly because it is the surprising half: pausing stops NEW runs, and the runs
      // already parked on a 24-hour delay keep their appointment unless they are paused too.
      ? 'Paused. No new runs will start. Runs already in flight continue — pause or cancel them individually on the runs list.'
      : 'Saved as ' + status + '.',
  };
}

export async function installExample(store: AutomationStore, orgId: string, key: string, userId: string | null): Promise<SaveResult> {
  const ex = exampleByKey(key);
  if (!ex) return { ok: false, workflow: null, problems: [{ level: 'error', message: 'There is no example called "' + key + '".' }], versioned: false, message: 'Unknown example.' };
  const existing = await store.getWorkflowByKey(orgId, ex.key);
  if (existing) return { ok: false, workflow: existing, problems: [], versioned: false, message: 'That example is already installed as "' + existing.name + '". Open it rather than installing a second copy.' };
  // Installed as a DRAFT, always. An example that switched itself on would start mailing candidates
  // the moment somebody clicked it to see what it looked like.
  return saveWorkflow(store, orgId, { key: ex.key, name: ex.name, description: ex.description, status: 'draft', definition: ex.definition }, userId);
}

export function listExamples() {
  return WORKFLOW_EXAMPLES.map((e) => ({ key: e.key, name: e.name, description: e.description, nodes: e.definition.nodes.length }));
}

/** Turn the webhook door on, returning the credentials ONCE. The secret is not readable afterwards
 *  from any listing endpoint — it is shown here and stored hashed nowhere else in this module's
 *  read paths, which is why regenerating is the recovery for a lost one. */
export async function enableWebhook(store: AutomationStore, orgId: string, id: string): Promise<{ ok: boolean; token?: string; secret?: string; message: string }> {
  const wf = await store.getWorkflow(orgId, id);
  if (!wf) return { ok: false, message: 'There is no workflow with that id here.' };
  const token = newWebhookToken();
  const secret = newWebhookSecret();
  await setWebhookCredentials(orgId, id, token, secret);
  return { ok: true, token, secret, message: 'Copy the secret now — it is shown once. Regenerate if it is lost.' };
}

export async function disableWebhook(store: AutomationStore, orgId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const wf = await store.getWorkflow(orgId, id);
  if (!wf) return { ok: false, message: 'There is no workflow with that id here.' };
  await setWebhookCredentials(orgId, id, null, null);
  return { ok: true, message: 'The webhook URL no longer accepts anything. Any sender still posting to it now gets a 404.' };
}
