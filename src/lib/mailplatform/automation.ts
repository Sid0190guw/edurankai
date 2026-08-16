// src/lib/mailplatform/automation.ts — the automation graph, its rules, and its runner seam.
//
// SCOPE, STATED HONESTLY. This patch delivers the MODEL and the INVARIANTS of automation: the
// workflow/node/edge/run tables, a pure graph validator, and a step function that advances one run
// by one node through the existing queue. It does NOT deliver a visual builder, a segment engine or
// the full node library — those are product surface, and building them here without a UI to drive
// them would be code nobody can reach. What IS here is enough to define, validate, start and step a
// workflow, and it is the contract the builder will sit on.
//
// The graph is validated BEFORE activation, not at run time. A workflow that fails halfway through
// because two nodes point at each other has already sent half a sequence to real people.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import type { UUID, Workflow, WorkflowNode, WorkflowEdge, WorkflowNodeType } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// ---------------------------------------------------------------------------
// Graph validation (pure — no database, fully tested)
// ---------------------------------------------------------------------------

export interface GraphProblem {
  severity: 'error' | 'warning';
  nodeKey?: string;
  message: string;
}

/**
 * Validate a workflow graph.
 *
 * The rules, and what each one prevents:
 *
 *  - EXACTLY ONE TRIGGER. Two triggers means a contact can enter twice from different events and
 *    receive the sequence twice.
 *  - NO CYCLES. A cycle is an infinite send loop pointed at a real person's inbox. This is the
 *    single most damaging thing an automation system can do, so it is an error, never a warning.
 *  - EVERY NODE REACHABLE FROM THE TRIGGER. An unreachable node is either a mistake or a leftover;
 *    either way the author believes it runs.
 *  - EVERY NON-EXIT NODE HAS AN OUTGOING EDGE. A run that arrives at a dead end hangs in 'running'
 *    forever, holding the contact out of the workflow's re-entry guard.
 *  - A CONDITION NODE HAS BOTH BRANCHES. A condition with only a 'true' edge silently drops every
 *    contact that evaluates false.
 */
export function validateGraph(
  nodes: { key: string; nodeType: WorkflowNodeType; config?: Record<string, unknown> }[],
  edges: { from: string; to: string; branch?: string | null }[],
): { ok: boolean; problems: GraphProblem[] } {
  const problems: GraphProblem[] = [];
  const keys = new Set(nodes.map((n) => n.key));

  if (nodes.length === 0) {
    return { ok: false, problems: [{ severity: 'error', message: 'A workflow needs at least one node.' }] };
  }

  const triggers = nodes.filter((n) => n.nodeType === 'trigger');
  if (triggers.length === 0) problems.push({ severity: 'error', message: 'A workflow needs a trigger node.' });
  if (triggers.length > 1) {
    problems.push({
      severity: 'error',
      message: `This workflow has ${triggers.length} trigger nodes. It must have exactly one, or a contact can enter it more than once.`,
    });
  }

  for (const edge of edges) {
    if (!keys.has(edge.from)) problems.push({ severity: 'error', message: `An edge starts at "${edge.from}", which is not a node.` });
    if (!keys.has(edge.to)) problems.push({ severity: 'error', message: `An edge ends at "${edge.to}", which is not a node.` });
  }

  const outgoing = new Map<string, { to: string; branch: string | null }[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) || [];
    list.push({ to: edge.to, branch: edge.branch ?? null });
    outgoing.set(edge.from, list);
  }

  for (const node of nodes) {
    const out = outgoing.get(node.key) || [];
    if (node.nodeType === 'exit') {
      if (out.length) problems.push({ severity: 'error', nodeKey: node.key, message: `"${node.key}" is an exit node but has an outgoing step.` });
      continue;
    }
    if (out.length === 0) {
      problems.push({
        severity: 'error',
        nodeKey: node.key,
        message: `"${node.key}" has no next step. Add one, or make it an exit node — a run that reaches it would never finish.`,
      });
    }
    if (node.nodeType === 'condition') {
      const branches = new Set(out.map((o) => (o.branch || '').toLowerCase()));
      if (!branches.has('true') || !branches.has('false')) {
        problems.push({
          severity: 'error',
          nodeKey: node.key,
          message: `Condition "${node.key}" needs both a true and a false branch. Contacts on the missing branch would be dropped without a trace.`,
        });
      }
    }
    if (node.nodeType === 'send_email' && !node.config?.template) {
      problems.push({ severity: 'error', nodeKey: node.key, message: `Send step "${node.key}" has no template.` });
    }
    if (node.nodeType === 'delay') {
      const ms = Number(node.config?.delayMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        problems.push({ severity: 'error', nodeKey: node.key, message: `Delay "${node.key}" needs a positive delayMs.` });
      }
    }
  }

  // Cycle detection, iterative rather than recursive: a 10,000-node graph would blow the stack, and
  // "the workflow editor crashed the server" is a worse outcome than a slightly longer function.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(nodes.map((n) => [n.key, WHITE]));
  for (const start of nodes.map((n) => n.key)) {
    if (colour.get(start) !== WHITE) continue;
    const stack: { key: string; index: number }[] = [{ key: start, index: 0 }];
    colour.set(start, GREY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.key) || [];
      if (frame.index >= children.length) {
        colour.set(frame.key, BLACK);
        stack.pop();
        continue;
      }
      const child = children[frame.index++].to;
      const state = colour.get(child);
      if (state === GREY) {
        problems.push({
          severity: 'error',
          nodeKey: child,
          message: `This workflow loops back to "${child}". A loop would send the same sequence to the same person forever.`,
        });
        colour.set(child, BLACK);
        continue;
      }
      if (state === WHITE) {
        colour.set(child, GREY);
        stack.push({ key: child, index: 0 });
      }
    }
  }

  if (triggers.length === 1) {
    const reached = new Set<string>([triggers[0].key]);
    const queue = [triggers[0].key];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of outgoing.get(current) || []) {
        if (!reached.has(next.to)) {
          reached.add(next.to);
          queue.push(next.to);
        }
      }
    }
    for (const node of nodes) {
      if (!reached.has(node.key)) {
        problems.push({ severity: 'warning', nodeKey: node.key, message: `"${node.key}" cannot be reached from the trigger, so it will never run.` });
      }
    }
  }

  return { ok: !problems.some((p) => p.severity === 'error'), problems };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function toWorkflow(row: any): Workflow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config || {},
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

export async function listWorkflows(orgId: UUID): Promise<Workflow[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_workflows WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`));
    return r.map(toWorkflow);
  } catch (e: any) {
    console.error('[mailplatform/automation] list failed -', causeOf(e));
    return [];
  }
}

export async function getWorkflowGraph(
  orgId: UUID,
  workflowId: UUID,
): Promise<{ workflow: Workflow; nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null> {
  try {
    const w = rows(await db.execute(sql`
      SELECT * FROM mp_workflows WHERE org_id = ${orgId} AND id = ${workflowId} AND deleted_at IS NULL LIMIT 1`));
    if (!w.length) return null;
    const n = rows(await db.execute(sql`SELECT * FROM mp_workflow_nodes WHERE workflow_id = ${workflowId} ORDER BY created_at`));
    const e = rows(await db.execute(sql`SELECT * FROM mp_workflow_edges WHERE workflow_id = ${workflowId}`));
    return {
      workflow: toWorkflow(w[0]),
      nodes: n.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        workflowId: row.workflow_id,
        key: row.key,
        nodeType: row.node_type,
        config: row.config || {},
        position: row.position ?? null,
      })),
      edges: e.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        workflowId: row.workflow_id,
        fromNodeId: row.from_node_id,
        toNodeId: row.to_node_id,
        branch: row.branch ?? null,
        condition: row.condition ?? null,
      })),
    };
  } catch (e: any) {
    console.error('[mailplatform/automation] getWorkflowGraph failed -', causeOf(e));
    return null;
  }
}

/**
 * Activate a workflow, but only if its graph validates.
 *
 * This is the gate the whole module exists for. Activation is the moment a graph starts touching
 * real inboxes; validating at run time instead would mean discovering the loop after it had run.
 */
export async function activateWorkflow(
  orgId: UUID,
  workflowId: UUID,
): Promise<{ ok: boolean; problems?: GraphProblem[]; error?: string }> {
  const graph = await getWorkflowGraph(orgId, workflowId);
  if (!graph) return { ok: false, error: 'No such workflow.' };

  const byId = new Map(graph.nodes.map((n) => [n.id, n.key]));
  const validation = validateGraph(
    graph.nodes.map((n) => ({ key: n.key, nodeType: n.nodeType, config: n.config })),
    graph.edges.map((e) => ({ from: byId.get(e.fromNodeId) || '', to: byId.get(e.toNodeId) || '', branch: e.branch })),
  );
  if (!validation.ok) return { ok: false, problems: validation.problems, error: 'This workflow cannot be activated yet.' };

  try {
    await db.execute(sql`UPDATE mp_workflows SET status = 'active', updated_at = NOW() WHERE id = ${workflowId} AND org_id = ${orgId}`);
    return { ok: true, problems: validation.problems };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

export async function pauseWorkflow(orgId: UUID, workflowId: UUID): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_workflows SET status = 'paused', updated_at = NOW()
      WHERE id = ${workflowId} AND org_id = ${orgId} AND status = 'active' RETURNING id`));
    return r.length ? { ok: true } : { ok: false, error: 'That workflow is not active.' };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/**
 * Enter a contact into a workflow.
 *
 * The partial unique index `mp_wfr_active_uk` means a contact cannot have two open runs of the same
 * workflow, so a trigger that fires twice does not start the sequence twice. The conflict is caught
 * and reported as `alreadyRunning` rather than as an error — firing twice is normal, and a caller
 * should not have to treat it as a failure.
 */
export async function startRun(input: {
  orgId: UUID;
  workflowId: UUID;
  contactId: UUID;
  context?: Record<string, unknown>;
}): Promise<{ ok: boolean; runId?: UUID; alreadyRunning?: boolean; error?: string }> {
  try {
    const w = rows(await db.execute(sql`
      SELECT status FROM mp_workflows WHERE id = ${input.workflowId} AND org_id = ${input.orgId} AND deleted_at IS NULL LIMIT 1`));
    if (!w.length) return { ok: false, error: 'No such workflow.' };
    if (w[0].status !== 'active') return { ok: false, error: `That workflow is ${w[0].status}, not active.` };

    const trigger = rows(await db.execute(sql`
      SELECT id FROM mp_workflow_nodes WHERE workflow_id = ${input.workflowId} AND node_type = 'trigger' LIMIT 1`));
    if (!trigger.length) return { ok: false, error: 'That workflow has no trigger node.' };

    const r = rows(await db.execute(sql`
      INSERT INTO mp_workflow_runs (org_id, workflow_id, contact_id, status, current_node_id, context, next_run_at)
      VALUES (${input.orgId}, ${input.workflowId}, ${input.contactId}, 'running', ${trigger[0].id},
              ${JSON.stringify(input.context || {})}::jsonb, NOW())
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!r.length) return { ok: true, alreadyRunning: true };

    await providers().queue.enqueue(
      'mp.workflow_step',
      { runId: r[0].id, orgId: input.orgId },
      { dedupKey: `mp.wf:${r[0].id}:0` },
    );
    await providers().events.publish({
      orgId: input.orgId,
      eventType: EVENT_TYPES.workflowStarted,
      entityType: 'workflow',
      entityId: input.workflowId,
      actorType: 'system',
      actorId: null,
      payload: { runId: r[0].id, contactId: input.contactId },
      occurredAt: new Date().toISOString(),
    });
    return { ok: true, runId: r[0].id };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/**
 * Which node comes next.
 *
 * Pure, so the routing rules are tested without a database or a queue. Returns null when the run
 * should finish. `branch` is compared case-insensitively because a builder UI and a hand-written
 * API call will not agree on capitalisation, and a run silently ending because of a capital T is
 * the kind of bug that takes a day to find.
 */
export function nextNode(
  currentKey: string,
  edges: { from: string; to: string; branch?: string | null }[],
  branchTaken?: string | null,
): string | null {
  const candidates = edges.filter((e) => e.from === currentKey);
  if (candidates.length === 0) return null;
  if (branchTaken) {
    const wanted = String(branchTaken).toLowerCase();
    const match = candidates.find((e) => (e.branch || '').toLowerCase() === wanted);
    return match ? match.to : null;
  }
  const unbranched = candidates.find((e) => !e.branch);
  return (unbranched || candidates[0]).to;
}

/** Record a run event. Runs are long-lived; without this trail a stuck run cannot be explained. */
export async function logRunEvent(input: {
  orgId: UUID;
  workflowId: UUID;
  runId: UUID;
  nodeId?: UUID | null;
  eventType: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mp_workflow_events (org_id, workflow_id, run_id, node_id, event_type, meta)
      VALUES (${input.orgId}, ${input.workflowId}, ${input.runId}, ${input.nodeId || null}, ${input.eventType},
              ${JSON.stringify(input.meta || {})}::jsonb)`);
  } catch (e: any) {
    console.error('[mailplatform/automation] logRunEvent failed -', causeOf(e));
  }
}
