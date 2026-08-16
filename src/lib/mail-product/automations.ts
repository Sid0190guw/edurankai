// src/lib/mail-product/automations.ts — the automation graph: its shape, its validation, and the
// step interpreter.
//
// WHAT AN AUTOMATION IS HERE. A directed graph of nodes with exactly one trigger. A contact ENTERS at
// the trigger and a run walks one node at a time; every step is a separate, resumable transition
// recorded on mail_automation_runs, so nothing depends on a long-lived process staying alive.
//
// VALIDATION IS THE FEATURE. A visual builder that lets somebody publish a graph with an unreachable
// branch, a condition with no NO edge, or a delay that loops back into itself has not helped them —
// it has moved the failure from build time to the moment it starts mailing people. validateGraph()
// below is what the Publish button asks, and it refuses with the node id so the canvas can highlight
// exactly which box is wrong.
//
// PURE, EXCEPT FOR THE FOUR EXPORTED DB FUNCTIONS AT THE BOTTOM. Everything above them is value in,
// value out, and is what automations.test.ts exercises.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailProductSchema } from './schema';
import { rowsOf, reasonOf, isUuid, str, clampInt } from './common';

export type NodeKind =
  | 'trigger' | 'condition' | 'delay' | 'send_email'
  | 'update_contact' | 'add_tag' | 'remove_tag' | 'webhook' | 'end';

export interface AutomationNode {
  id: string;
  kind: NodeKind;
  /** Canvas position. Not used by the interpreter — the graph is the edges, not the geometry. */
  x?: number;
  y?: number;
  /** Per-kind configuration; validated by validateNode(). */
  config?: Record<string, any>;
}

/** `branch` is 'yes' | 'no' out of a condition, and undefined everywhere else. */
export interface AutomationEdge { from: string; to: string; branch?: 'yes' | 'no'; }

export interface AutomationGraph { nodes: AutomationNode[]; edges: AutomationEdge[]; }

export const NODE_CATALOGUE: { kind: NodeKind; label: string; detail: string; terminal?: boolean }[] = [
  { kind: 'trigger', label: 'Trigger', detail: 'What makes a contact enter. Exactly one per automation.' },
  { kind: 'condition', label: 'Condition', detail: 'Splits the path in two. Both branches must go somewhere.' },
  { kind: 'delay', label: 'Delay', detail: 'Wait before the next step. Measured from when the contact reaches it.' },
  { kind: 'send_email', label: 'Send email', detail: 'Send a template to the contact in this run.' },
  { kind: 'update_contact', label: 'Update contact', detail: 'Set a field on the contact record.' },
  { kind: 'add_tag', label: 'Add tag', detail: 'Add one tag to the contact.' },
  { kind: 'remove_tag', label: 'Remove tag', detail: 'Remove one tag from the contact.' },
  { kind: 'webhook', label: 'Webhook', detail: 'POST the contact and run context to a URL.' },
  { kind: 'end', label: 'End', detail: 'The run finishes here.', terminal: true },
];

export const TRIGGER_EVENTS: { key: string; label: string }[] = [
  // THE ORIGINAL SIX. Their keys are unchanged and every automation already drawn against them keeps
  // working; src/lib/mailplatform/triggers.ts maps each to its canonical dotted event name.
  { key: 'application_stage_changed', label: 'Application stage changed' },
  { key: 'contact_created', label: 'Contact added' },
  { key: 'tag_added', label: 'Tag added to contact' },
  { key: 'list_joined', label: 'Contact joined a list' },
  { key: 'campaign_opened', label: 'Campaign opened' },
  { key: 'campaign_clicked', label: 'Campaign link clicked' },
  // ADDED WITH THE EXECUTION ENGINE. The runtime accepts any well-formed dotted event name, so this
  // list is what the CANVAS OFFERS, not what the engine can run. Names are dotted from here on
  // because that is what an event carries end to end — through the event log, the webhook door and
  // the API — and a second spelling would be a second, silently different trigger.
  { key: 'contact.updated', label: 'Contact updated' },
  { key: 'contact.tag.removed', label: 'Tag removed from contact' },
  { key: 'campaign.sent', label: 'Campaign sent' },
  { key: 'email.delivered', label: 'Email delivered' },
  { key: 'email.bounced', label: 'Email bounced' },
  { key: 'email.unsubscribed', label: 'Email unsubscribed' },
  { key: 'api.event', label: 'API event' },
  { key: 'webhook.event', label: 'Webhook event' },
  { key: 'schedule.date', label: 'On a date and time' },
  { key: 'application.submitted', label: 'Application submitted' },
  { key: 'assessment.assigned', label: 'Assessment assigned' },
  { key: 'assessment.completed', label: 'Assessment completed' },
  { key: 'interview.scheduled', label: 'Interview scheduled' },
  { key: 'internship.selected', label: 'Internship selected' },
  { key: 'internship.rejected', label: 'Internship rejected' },
];

export const CONDITION_FIELDS: { key: string; label: string }[] = [
  { key: 'stage', label: 'Application stage' },
  { key: 'tag', label: 'Has tag' },
  { key: 'status', label: 'Subscription status' },
  { key: 'assessment_completed', label: 'Assessment completed' },
  { key: 'field', label: 'Custom field' },
];

const KINDS = new Set<NodeKind>(NODE_CATALOGUE.map((n) => n.kind));

/** Accept a graph out of jsonb or a POST body without ever throwing on junk. */
export function coerceGraph(raw: unknown): AutomationGraph {
  const o = (raw && typeof raw === 'object') ? raw as any : {};
  const nodes: AutomationNode[] = (Array.isArray(o.nodes) ? o.nodes : [])
    .filter((n: any) => n && typeof n.id === 'string' && KINDS.has(n.kind))
    .slice(0, 200)
    .map((n: any) => ({
      id: String(n.id).slice(0, 64),
      kind: n.kind,
      x: Number.isFinite(Number(n.x)) ? Number(n.x) : 0,
      y: Number.isFinite(Number(n.y)) ? Number(n.y) : 0,
      config: (n.config && typeof n.config === 'object') ? n.config : {},
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: AutomationEdge[] = (Array.isArray(o.edges) ? o.edges : [])
    .filter((e: any) => e && ids.has(String(e.from)) && ids.has(String(e.to)))
    .slice(0, 400)
    .map((e: any) => ({
      from: String(e.from), to: String(e.to),
      branch: e.branch === 'no' ? 'no' : e.branch === 'yes' ? 'yes' : undefined,
    }));
  return { nodes, edges };
}

export interface GraphProblem { nodeId: string | null; message: string; }

/** One node's own configuration. Returns the problems, never throws. */
export function validateNode(n: AutomationNode): GraphProblem[] {
  const p: GraphProblem[] = [];
  const c = n.config || {};
  switch (n.kind) {
    case 'trigger':
      if (!TRIGGER_EVENTS.some((t) => t.key === c.event)) p.push({ nodeId: n.id, message: 'Choose what makes a contact enter this automation.' });
      break;
    case 'condition':
      // A whole AND/OR/NOT tree in `condition` is the escape hatch for a rule the five canvas fields
      // cannot express. It has no single field and no single value, so neither check below applies
      // to it; src/lib/mailplatform/graph.ts is what reads it.
      if (c.condition && typeof c.condition === 'object') break;
      if (!CONDITION_FIELDS.some((f) => f.key === c.field)) p.push({ nodeId: n.id, message: 'Choose what this condition tests.' });
      // `exists` and `does_not_exist` compare against nothing by definition, so demanding a value
      // for them refuses a perfectly good condition.
      else if (c.operator !== 'exists' && c.operator !== 'does_not_exist'
               && (c.value === undefined || String(c.value).trim() === '')) {
        p.push({ nodeId: n.id, message: 'This condition has nothing to compare against.' });
      }
      break;
    case 'delay': {
      // THREE FORMS, and the engine resolves all three to one absolute instant before parking the
      // run in the database. `minutes` is what the canvas draws. The other two are what a fixed
      // number of minutes cannot say: an absolute date, and a date carried by the event itself
      // ("the deadline, minus 24 hours") which the author cannot know per candidate.
      if (c.until !== undefined && String(c.until).trim() !== '') {
        if (!Number.isFinite(Date.parse(String(c.until)))) p.push({ nodeId: n.id, message: 'That date could not be read. Use a full date and time.' });
        break;
      }
      if (c.untilField !== undefined && String(c.untilField).trim() !== '') {
        if (!Number.isFinite(Number(c.offsetMinutes || 0))) p.push({ nodeId: n.id, message: 'The offset must be a number of minutes.' });
        break;
      }
      const mins = Number(c.minutes);
      if (!Number.isFinite(mins) || mins <= 0) p.push({ nodeId: n.id, message: 'Set how long to wait. A delay of zero is not a delay.' });
      else if (mins > 60 * 24 * 365) p.push({ nodeId: n.id, message: 'A wait longer than a year is almost certainly a typo.' });
      break;
    }
    case 'send_email':
      if (!isUuid(String(c.templateId || ''))) p.push({ nodeId: n.id, message: 'Choose the template this step sends.' });
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!str(c.tag, 60)) p.push({ nodeId: n.id, message: 'Name the tag.' });
      break;
    case 'update_contact':
      if (!str(c.key, 60)) p.push({ nodeId: n.id, message: 'Choose the field to set.' });
      break;
    case 'webhook':
      if (!/^https:\/\//i.test(String(c.url || ''))) p.push({ nodeId: n.id, message: 'The webhook URL must start with https://.' });
      break;
  }
  return p;
}

/**
 * The whole graph. This is what Publish asks, and a failure here is a refusal to activate.
 *
 * The checks, and why each exists:
 *  - exactly one trigger        — two entry points is two automations sharing a canvas
 *  - every node reachable       — an orphaned branch looks published and never runs
 *  - no dead ends               — a non-terminal node with no outgoing edge silently drops the run
 *  - both condition branches    — a condition with only YES abandons everybody who answers no
 *  - no cycle without a delay   — a loop with no wait in it is an infinite send, at machine speed
 */
export function validateGraph(g: AutomationGraph): { ok: boolean; problems: GraphProblem[] } {
  const problems: GraphProblem[] = [];
  const nodes = g.nodes || [];
  const edges = g.edges || [];

  if (!nodes.length) return { ok: false, problems: [{ nodeId: null, message: 'This automation is empty. Add a trigger to start.' }] };

  const triggers = nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length === 0) problems.push({ nodeId: null, message: 'There is no trigger, so nothing can enter this automation.' });
  if (triggers.length > 1) problems.push({ nodeId: triggers[1].id, message: 'There is more than one trigger. An automation has exactly one way in.' });

  for (const n of nodes) problems.push(...validateNode(n));

  const out = new Map<string, AutomationEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }

  for (const n of nodes) {
    const o = out.get(n.id) || [];
    if (n.kind === 'end') {
      if (o.length) problems.push({ nodeId: n.id, message: 'An End step cannot lead anywhere.' });
      continue;
    }
    if (!o.length) {
      problems.push({ nodeId: n.id, message: `This ${labelFor(n.kind)} step leads nowhere. Connect it to the next step, or to an End.` });
      continue;
    }
    if (n.kind === 'condition') {
      const yes = o.some((e) => e.branch === 'yes');
      const no = o.some((e) => e.branch === 'no');
      if (!yes) problems.push({ nodeId: n.id, message: 'This condition has no YES branch.' });
      if (!no) problems.push({ nodeId: n.id, message: 'This condition has no NO branch, so anybody who answers no drops out silently.' });
    } else if (o.length > 1) {
      problems.push({ nodeId: n.id, message: `A ${labelFor(n.kind)} step can only lead to one place. Use a Condition to split the path.` });
    }
  }

  // Reachability from the trigger.
  if (triggers.length === 1) {
    const seen = new Set<string>([triggers[0].id]);
    const stack = [triggers[0].id];
    while (stack.length) {
      for (const e of out.get(stack.pop()!) || []) {
        if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
      }
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) problems.push({ nodeId: n.id, message: 'Nothing leads to this step, so it will never run.' });
    }
  }

  // A cycle with no delay on it. DFS with a colour map; the moment we re-enter a node still on the
  // stack we have a cycle, and we know whether a delay was passed on the way round.
  const colour = new Map<string, 0 | 1 | 2>();
  const walk = (id: string, delayedSinceEntry: boolean, path: Set<string>): void => {
    if (colour.get(id) === 2) return;
    if (path.has(id)) {
      if (!delayedSinceEntry) {
        problems.push({ nodeId: id, message: 'This step loops back on itself with no Delay in the loop, which would send without pausing. Add a Delay inside the loop.' });
      }
      return;
    }
    path.add(id);
    for (const e of out.get(id) || []) {
      const next = nodes.find((n) => n.id === e.to);
      walk(e.to, delayedSinceEntry || next?.kind === 'delay', path);
    }
    path.delete(id);
    colour.set(id, 2);
  };
  if (triggers.length === 1) walk(triggers[0].id, false, new Set());

  // De-duplicate: the same structural fault can be reported by two checks and reads as two faults.
  const seenMsg = new Set<string>();
  const unique = problems.filter((p) => {
    const k = `${p.nodeId}::${p.message}`;
    if (seenMsg.has(k)) return false;
    seenMsg.add(k);
    return true;
  });

  return { ok: unique.length === 0, problems: unique };
}

function labelFor(kind: NodeKind): string {
  return (NODE_CATALOGUE.find((n) => n.kind === kind)?.label || kind).toLowerCase();
}

/** A readable one-line description of a node, for the canvas and for the run log. */
export function describeNode(n: AutomationNode, lookup: { templates?: Record<string, string> } = {}): string {
  const c = n.config || {};
  switch (n.kind) {
    case 'trigger': return TRIGGER_EVENTS.find((t) => t.key === c.event)?.label || 'Trigger not set';
    case 'condition': {
      const f = CONDITION_FIELDS.find((x) => x.key === c.field)?.label || 'Field';
      return `${f} ${c.op === 'is_not' ? 'is not' : 'is'} ${str(c.value, 40) || '…'}`;
    }
    case 'delay': return humaniseMinutes(Number(c.minutes) || 0);
    case 'send_email': return lookup.templates?.[String(c.templateId)] || 'Template not chosen';
    case 'add_tag': return `Add "${str(c.tag, 40)}"`;
    case 'remove_tag': return `Remove "${str(c.tag, 40)}"`;
    case 'update_contact': return `Set ${str(c.key, 40)} to ${str(c.value, 30) || '(blank)'}`;
    case 'webhook': return str(c.url, 60) || 'URL not set';
    case 'end': return 'Run finishes';
    default: return '';
  }
}

export function humaniseMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return 'No wait';
  if (m < 60) return `Wait ${Math.round(m)} minute${m === 1 ? '' : 's'}`;
  if (m < 60 * 24) { const h = m / 60; return `Wait ${trim(h)} hour${h === 1 ? '' : 's'}`; }
  const d = m / (60 * 24);
  return `Wait ${trim(d)} day${d === 1 ? '' : 's'}`;
}
function trim(n: number): string { return String(Math.round(n * 10) / 10); }

/** The example from the brief, as a real starting graph. */
export function starterGraph(): AutomationGraph {
  return {
    nodes: [
      { id: 't1', kind: 'trigger', x: 40, y: 40, config: { event: 'application_stage_changed' } },
      { id: 'c1', kind: 'condition', x: 40, y: 170, config: { field: 'stage', op: 'is', value: '3' } },
      { id: 's1', kind: 'send_email', x: 40, y: 300, config: {} },
      { id: 'd1', kind: 'delay', x: 40, y: 430, config: { minutes: 1440 } },
      { id: 'c2', kind: 'condition', x: 40, y: 560, config: { field: 'assessment_completed', op: 'is', value: 'yes' } },
      { id: 's2', kind: 'send_email', x: 300, y: 690, config: {} },
      { id: 'e1', kind: 'end', x: 40, y: 690, config: {} },
      { id: 'e2', kind: 'end', x: 300, y: 820, config: {} },
    ],
    edges: [
      { from: 't1', to: 'c1' },
      { from: 'c1', to: 's1', branch: 'yes' },
      { from: 'c1', to: 'e1', branch: 'no' },
      { from: 's1', to: 'd1' },
      { from: 'd1', to: 'c2' },
      { from: 'c2', to: 'e1', branch: 'yes' },
      { from: 'c2', to: 's2', branch: 'no' },
      { from: 's2', to: 'e2' },
    ],
  };
}

// ---- Storage --------------------------------------------------------------------------------------

export async function listAutomations(): Promise<any[]> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`
    SELECT id, name, description, status, graph, entered_count, completed_count, created_at, updated_at
    FROM mail_automations ORDER BY updated_at DESC LIMIT 100`);
  return rowsOf(r);
}

export async function getAutomation(id: string): Promise<any | null> {
  if (!isUuid(id)) return null;
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT * FROM mail_automations WHERE id = ${id} LIMIT 1`);
  const row = rowsOf(r)[0];
  return row ? { ...row, graph: coerceGraph(row.graph) } : null;
}

export async function createAutomation(name: string, by: string | null): Promise<{ id: string | null; error?: string }> {
  await ensureMailProductSchema();
  try {
    const r = await db.execute(sql`
      INSERT INTO mail_automations (name, graph, created_by)
      VALUES (${str(name, 160) || 'Untitled automation'}, ${JSON.stringify(starterGraph())}::jsonb, ${isUuid(by || '') ? by : null})
      RETURNING id`);
    return { id: rowsOf(r)[0]?.id ?? null };
  } catch (e: any) {
    return { id: null, error: reasonOf(e) };
  }
}

export async function saveAutomation(
  id: string, patch: { name?: string; description?: string; graph?: unknown; status?: string },
): Promise<{ ok: boolean; error?: string; problems?: GraphProblem[] }> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown automation.' };
  await ensureMailProductSchema();

  const graph = patch.graph !== undefined ? coerceGraph(patch.graph) : null;

  // ACTIVATING IS THE GATE. A draft may be saved in any state — half-built is the normal state of a
  // thing being built. Going live is what has to be sound, because from that moment it mails people.
  if (patch.status === 'active') {
    const g = graph || (await getAutomation(id))?.graph;
    const v = validateGraph(coerceGraph(g));
    if (!v.ok) {
      return {
        ok: false,
        error: 'This automation was NOT switched on, and nothing has been sent. ' + v.problems.length + ' thing(s) need fixing first.',
        problems: v.problems,
      };
    }
  }

  const status = ['draft', 'active', 'paused'].includes(String(patch.status)) ? String(patch.status) : null;
  try {
    await db.execute(sql`
      UPDATE mail_automations SET
        name = COALESCE(${patch.name !== undefined ? str(patch.name, 160) : null}, name),
        description = COALESCE(${patch.description !== undefined ? str(patch.description, 500) : null}, description),
        graph = ${graph ? sql`${JSON.stringify(graph)}::jsonb` : sql`graph`},
        status = COALESCE(${status}, status),
        updated_at = now()
      WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    console.error('[mail-product] saveAutomation failed:', reasonOf(e));
    return { ok: false, error: 'This automation was NOT saved: ' + reasonOf(e) };
  }
}

export async function deleteAutomation(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const r = await db.execute(sql`DELETE FROM mail_automations WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

/** Live run counts for the list screen — grouped in Postgres, one row per state. */
export async function runCounts(automationId: string): Promise<Record<string, number>> {
  if (!isUuid(automationId)) return {};
  const r = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM mail_automation_runs WHERE automation_id = ${automationId} GROUP BY status`);
  const out: Record<string, number> = {};
  for (const row of rowsOf(r)) out[String(row.status)] = Number(row.n) || 0;
  return out;
}

export async function recentRuns(automationId: string, limit = 25): Promise<any[]> {
  if (!isUuid(automationId)) return [];
  const r = await db.execute(sql`
    SELECT r.id, r.node_id, r.status, r.wait_until, r.last_error, r.started_at, r.updated_at,
           c.email, c.first_name, c.last_name
    FROM mail_automation_runs r LEFT JOIN mail_contacts c ON c.id = r.contact_id
    WHERE r.automation_id = ${automationId}
    ORDER BY r.updated_at DESC LIMIT ${clampInt(limit, 1, 100, 25)}`);
  return rowsOf(r);
}
