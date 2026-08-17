// src/lib/mailplatform/graph.ts — THE ADAPTER ONTO THE EXISTING AUTOMATION GRAPH. Pure.
//
// THERE IS ONE AUTOMATION SHAPE IN THIS CODEBASE AND IT IS NOT DEFINED HERE.
//
// src/lib/mail-product/automations.ts already owns it: `AutomationGraph` (nodes with a kind and a
// config, edges with a yes/no branch), `coerceGraph()`, `validateNode()` and `validateGraph()`. The
// canvas at /mail/automations draws against it and its Publish button asks that validator. This
// engine therefore READS that shape rather than inventing a second one — two definitions of "what a
// workflow is" would be two validators disagreeing about the same drawing, and the one the engine
// believed would be the one that mailed people.
//
// What is here is only what an EXECUTOR needs and a builder does not:
//   - which node comes next, given an answer
//   - a node's condition and delay translated into the evaluator's own language
//   - the checks that are about what this PLATFORM has (a template that exists, a channel that is
//     configured) rather than about the shape of the drawing
import type { AutomationGraph, AutomationNode, GraphProblem, NodeKind } from '@/lib/mail-product/automations';
import { NODE_CATALOGUE, coerceGraph, validateGraph } from '@/lib/mail-product/automations';
import type { ConditionNode, ConditionOperator } from './conditions';
import { CONDITION_OPERATORS } from './conditions';
import type { DelaySpec } from './delay';

export type { AutomationGraph, AutomationNode, GraphProblem, NodeKind };
export { coerceGraph, validateGraph, NODE_CATALOGUE };

/** The branch labels the existing canvas draws. Not true/false — yes/no, as its edges say. */
export type Branch = 'yes' | 'no';

/** Node kinds the engine treats as STRUCTURE. Everything else is an action with a handler. */
export const STRUCTURAL_KINDS: ReadonlySet<string> = new Set(['trigger', 'condition', 'delay', 'end']);

export function findNode(graph: AutomationGraph, id: string): AutomationNode | null {
  return (graph?.nodes || []).find((n) => n.id === id) || null;
}

export function triggerNode(graph: AutomationGraph): AutomationNode | null {
  return (graph?.nodes || []).find((n) => n.kind === 'trigger') || null;
}

/**
 * The next node id, following the edge that leaves `fromId`.
 *
 * `branch` is the answer a condition produced. validateGraph() refuses to activate a condition that
 * is missing either branch, so a null here on a live automation means the graph was edited after the
 * run started — which the engine reports rather than guessing at.
 */
export function nextNodeAfter(graph: AutomationGraph, fromId: string, branch?: Branch): string | null {
  const edges = (graph?.edges || []).filter((e) => e.from === fromId);
  if (branch === undefined) return edges.find((e) => !e.branch)?.to || edges[0]?.to || null;
  return edges.find((e) => e.branch === branch)?.to || null;
}

/**
 * Translate a condition node's config into the evaluator's language.
 *
 * The canvas offers five familiar fields (stage, tag, status, assessment completed, a custom field)
 * and compares them for equality. This maps each onto a real path into the run facts, and then adds
 * two things the specification asks for and the canvas does not yet offer, WITHOUT breaking it:
 *
 *   config.operator   any of the nine operators in conditions.ts. Absent means `equals`, which is
 *                     exactly what the canvas means today.
 *   config.condition  a whole AND/OR/NOT tree, used as-is. This is the escape hatch for a rule the
 *                     five fields cannot express; a canvas that grows a rule builder writes here.
 *
 * A node the canvas can already draw keeps behaving identically. That is the point.
 */
export function conditionFromNode(node: AutomationNode): ConditionNode | null {
  const c = (node?.config || {}) as Record<string, unknown>;
  if (c.condition && typeof c.condition === 'object') return c.condition as ConditionNode;

  const raw = String(c.operator || 'equals');
  const operator: ConditionOperator = (CONDITION_OPERATORS.some((o) => o.id === raw) ? raw : 'equals') as ConditionOperator;
  const value = c.value === undefined || c.value === null ? '' : (c.value as string);

  switch (String(c.field || '')) {
    case 'stage':
      // NOT `contact.application_stage`, and this was wrong once. On an application.stage.changed
      // run the stage that matters is the one the EVENT carries — the value it just changed to —
      // and the contact row may not have been updated yet (often this very automation is what
      // updates it). Reading only the contact answered "" and sent every candidate down the no
      // branch. The bare `stage` fact is the event's when the event has one and the contact's
      // otherwise; engine.ts fills in that fallback. See runFacts().
      return { field: 'stage', operator, value };
    case 'tag':
      // A tag test is membership, whatever the operator says: "has tag shortlisted" is not an
      // equality against the whole list, and answering it as one would make every tagged contact
      // fail the moment they had a second tag.
      return { field: 'contact.tags', operator: operator === 'does_not_exist' ? 'does_not_exist' : 'contains', value };
    case 'status':
      return { field: 'contact.status', operator, value };
    case 'assessment_completed':
      return { field: 'contact.fields.assessment_completed', operator, value };
    case 'field': {
      const key = String(c.key || '').trim();
      if (!key) return null;
      return { field: 'contact.fields.' + key, operator, value };
    }
    default:
      return null;
  }
}

/**
 * Translate a delay node's config.
 *
 * `minutes` is what the canvas writes and stays the default. `until` and `untilField` are the two
 * forms the specification requires that a fixed number of minutes cannot express — "wait until
 * 20 August, 09:00" and "wait until this candidate's deadline minus 24 hours". The canvas cannot
 * draw them yet; an automation that uses them is still executed correctly, and
 * mail-product/automations.ts accepts them so Publish does not refuse.
 */
export function delayFromNode(node: AutomationNode): DelaySpec | null {
  const c = (node?.config || {}) as Record<string, unknown>;
  if (c.until) return { kind: 'until', at: String(c.until) };
  if (c.untilField) return { kind: 'until_field', field: String(c.untilField), offsetMinutes: Number(c.offsetMinutes || 0) };
  const minutes = Number(c.minutes);
  if (!Number.isFinite(minutes)) return null;
  return { kind: 'minutes', amount: minutes };
}

/**
 * The checks validateGraph() cannot make, because they are about what this INSTALLATION has rather
 * than about the shape of the drawing. Run alongside it, never instead of it.
 */
export function checkAgainstPlatform(graph: AutomationGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const kinds = new Set(NODE_CATALOGUE.map((n) => n.kind));
  for (const n of graph?.nodes || []) {
    if (!kinds.has(n.kind)) {
      problems.push({ nodeId: n.id, message: 'This step is a "' + String(n.kind) + '", which this platform cannot run.' });
      continue;
    }
    if (n.kind === 'condition' && !conditionFromNode(n)) {
      problems.push({ nodeId: n.id, message: 'This condition does not say what it tests, so the engine could not evaluate it.' });
    }
    if (n.kind === 'delay') {
      const d = delayFromNode(n);
      if (!d) problems.push({ nodeId: n.id, message: 'This delay has no duration the engine can resolve.' });
    }
  }
  return problems;
}

/**
 * The graph as a builder wants it: every node with its outgoing edges resolved, plus both
 * validations. One call, so a canvas never reimplements a rule and no page hard-codes a shape.
 */
export function describeForBuilder(graph: AutomationGraph) {
  const g = coerceGraph(graph);
  const structural = validateGraph(g);
  const platform = checkAgainstPlatform(g);
  return {
    nodes: g.nodes.map((n) => ({
      ...n,
      outgoing: g.edges.filter((e) => e.from === n.id).map((e) => ({ to: e.to, branch: e.branch || null })),
    })),
    edges: g.edges,
    valid: structural.ok && platform.length === 0,
    problems: [...structural.problems, ...platform],
    triggerNodeId: triggerNode(g)?.id || null,
  };
}
