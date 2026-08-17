// src/lib/mailplatform/service.ts — the operations the engine adds around the existing builder.
//
// THIS FILE DELIBERATELY DOES NOT SAVE AUTOMATIONS. src/lib/mail-product/automations.ts already owns
// createAutomation / saveAutomation / deleteAutomation and the Publish gate, and /mail/automations
// calls them. A second writer would be a second set of rules about when a graph may go live.
//
// What is added here is what only an EXECUTOR needs:
//   - a version snapshot on every graph change, so in-flight runs keep the shape they started on
//   - the webhook credentials for the inbound door
//   - the extra validation that is about what this installation HAS, not about the drawing
import type { AutomationRecord, AutomationStore } from './store';
import type { AutomationGraph, GraphProblem } from './graph';
import { checkAgainstPlatform, coerceGraph, validateGraph } from './graph';
import { pgStore, setWebhookCredentials } from './pg-store';
import { DEFAULT_ORG_ID, newWebhookSecret, newWebhookToken } from './security';
import { channel } from './adapters';
import { reasonOf } from './errors';
import { exampleByKey, listExamples } from './examples';

export const ORG_ID = DEFAULT_ORG_ID;

/** The production store. Taken as a parameter everywhere below so a test can pass a memory store. */
export function defaultStore(): AutomationStore { return pgStore; }

export { checkAgainstPlatform };

export interface ReadinessResult {
  ok: boolean;
  problems: GraphProblem[];
  /** Present when the reason is a channel rather than the graph. */
  channelProblem: string | null;
}

/**
 * Is this automation safe to switch on?
 *
 * validateGraph() answers the structural half and mail-product's saveAutomation() already refuses to
 * activate without it. This adds the two questions only the runtime can answer: can the engine
 * actually execute every step, and is the channel each send step uses configured on THIS deployment?
 *
 * An automation that is on and cannot send is worse than one that is off: it looks live, enters
 * contacts, and fails every one of them at the send.
 */
export async function checkReadyToActivate(
  store: AutomationStore,
  orgId: string,
  id: string,
  opts: { channels?: (id: string) => ReturnType<typeof channel> } = {},
): Promise<ReadinessResult> {
  const resolveChannel = opts.channels || channel;
  const a = await store.getAutomation(orgId, id);
  if (!a) return { ok: false, problems: [{ nodeId: null, message: 'There is no automation with that id here.' }], channelProblem: null };

  const graph = coerceGraph(a.graph);
  const problems = [...validateGraph(graph).problems, ...checkAgainstPlatform(graph)];
  if (problems.length) return { ok: false, problems, channelProblem: null };

  for (const n of graph.nodes) {
    if (n.kind !== 'send_email') continue;
    const ch = resolveChannel(String((n.config || {}).channel || 'email'));
    if (!ch) return { ok: false, problems, channelProblem: 'Step "' + n.id + '" names a channel this platform does not have.' };
    if (!(await ch.available())) {
      return { ok: false, problems, channelProblem: 'Step "' + n.id + '" sends by ' + ch.label + ', and ' + (await ch.unavailableReason()) };
    }
  }
  return { ok: true, problems: [], channelProblem: null };
}

export interface SnapshotResult { ok: boolean; version: number; inFlight: number; message: string }

/**
 * Record the current graph as a numbered version, and say how many runs are still on the old one.
 *
 * Called after mail-product's saveAutomation() has written the graph. Keeping it separate is what
 * lets the canvas keep its own save path unchanged; the cost is that a graph saved by some future
 * writer that forgets to call this gets no snapshot, which the engine reports at run time ("no
 * snapshot of version N was kept") rather than silently guessing.
 */
export async function snapshotGraph(store: AutomationStore, orgId: string, id: string, previousGraph?: AutomationGraph | null): Promise<SnapshotResult> {
  const a = await store.getAutomation(orgId, id);
  if (!a) return { ok: false, version: 0, inFlight: 0, message: 'There is no automation with that id here.' };

  const changed = !previousGraph || JSON.stringify(coerceGraph(previousGraph)) !== JSON.stringify(coerceGraph(a.graph));
  const inFlight = (await store.listRuns(orgId, { automationId: id, limit: 500 }))
    .filter((r) => r.state === 'waiting' || r.state === 'running' || r.state === 'paused').length;

  if (!changed) {
    // Still make sure a snapshot EXISTS for the current version, including version 1 — otherwise the
    // very first run has nothing to follow but the live graph.
    if (!(await store.getGraphVersion(orgId, id, a.version))) await store.saveGraphVersion(orgId, id, a.version, a.graph);
    return { ok: true, version: a.version, inFlight, message: 'The steps were unchanged, so the version stayed at ' + a.version + '.' };
  }

  const version = a.version + 1;
  await store.saveGraphVersion(orgId, id, version, a.graph);
  await store.setVersion(orgId, id, version);
  return {
    ok: true,
    version,
    inFlight,
    message: 'Saved as version ' + version + '.' + (inFlight
      ? ' ' + inFlight + ' run' + (inFlight === 1 ? '' : 's') + ' already in flight will finish on version ' + a.version + ' — they do not change shape mid-way.'
      : ''),
  };
}

/** Make sure the current version has a snapshot. Cheap, idempotent, and safe to call on every read
 *  of an automation that is about to start runs. */
export async function ensureSnapshot(store: AutomationStore, orgId: string, id: string): Promise<void> {
  try {
    const a = await store.getAutomation(orgId, id);
    if (!a) return;
    if (!(await store.getGraphVersion(orgId, id, a.version))) await store.saveGraphVersion(orgId, id, a.version, a.graph);
  } catch (e: any) {
    // Best effort: a missing snapshot degrades to "follow the live graph and say so", which the
    // engine already handles. It must not stop an automation being used.
    console.error('[mailplatform/service] snapshot check failed:', reasonOf(e));
  }
}

/** Turn the webhook door on, returning the credentials ONCE. The secret is never returned by any
 *  listing endpoint, which is why regenerating is the recovery for a lost one. */
export async function enableWebhook(store: AutomationStore, orgId: string, id: string): Promise<{ ok: boolean; token?: string; secret?: string; message: string }> {
  const a = await store.getAutomation(orgId, id);
  if (!a) return { ok: false, message: 'There is no automation with that id here.' };
  const token = newWebhookToken();
  const secret = newWebhookSecret();
  await setWebhookCredentials(orgId, id, token, secret);
  return { ok: true, token, secret, message: 'Copy the secret now — it is shown once. Regenerate if it is lost.' };
}

export async function disableWebhook(store: AutomationStore, orgId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const a = await store.getAutomation(orgId, id);
  if (!a) return { ok: false, message: 'There is no automation with that id here.' };
  await setWebhookCredentials(orgId, id, null, null);
  return { ok: true, message: 'The webhook URL no longer accepts anything. Any sender still posting to it now gets a 404.' };
}

/**
 * Install one of the shipped examples, THROUGH mail-product's own writers.
 *
 * createAutomation() then saveAutomation() — the same two calls /mail/automations makes — so the row
 * is indistinguishable from one drawn by hand and there is still exactly one place that writes a
 * graph. Installed as a DRAFT, always: an example that switched itself on would begin mailing
 * candidates the moment somebody clicked it to see what it looked like.
 */
export async function installExample(store: AutomationStore, orgId: string, key: string, userId: string | null): Promise<{ ok: boolean; id: string | null; message: string }> {
  const ex = exampleByKey(key);
  if (!ex) return { ok: false, id: null, message: 'There is no example called "' + key + '".' };

  const { createAutomation, saveAutomation, listAutomations } = await import('@/lib/mail-product/automations');
  const already = (await listAutomations()).find((a: any) => String(a.name) === ex.name);
  if (already) return { ok: false, id: already.id, message: 'That example is already installed as "' + already.name + '". Open it rather than installing a second copy.' };

  const created = await createAutomation(ex.name, userId);
  if (!created.id) return { ok: false, id: null, message: 'It could not be created: ' + (created.error || 'unknown error') };

  const saved = await saveAutomation(created.id, { description: ex.description, graph: ex.graph, status: 'draft' });
  if (!saved.ok) return { ok: false, id: created.id, message: 'It was created but its steps were not saved: ' + (saved.error || 'unknown error') };

  await ensureSnapshot(store, orgId, created.id);
  return { ok: true, id: created.id, message: 'Installed as a draft. Choose a template on each send step, then switch it on.' };
}

export { listExamples };
export type { AutomationRecord };
