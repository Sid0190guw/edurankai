// src/lib/kernel/graph.ts — Block 01 graph primitives over relationship edges.
// Pure, no I/O: callers pass in the node ids and edges (repository reads them from the store).
// Used for prerequisite ordering (a lesson's prerequisites must form a DAG) and to reject an
// edge that would introduce a cycle before it is persisted.
import type { RelationshipEdge, RelationshipType } from './types';

export interface DagResult {
  /** Topologically ordered node ids (prerequisites before dependents). Empty of cycle nodes. */
  order: string[];
  /** The node ids left unresolved when a cycle exists, else null. */
  cycle: string[] | null;
}

/** Kahn topological sort over one edge type (default 'prerequisite_of').
 *  Edge direction from -> to means "from is a prerequisite of to", so `from` sorts first. */
export function topoOrder(nodeIds: string[], edges: RelationshipEdge[], relType: RelationshipType | string = 'prerequisite_of'): DagResult {
  const nodes = new Set(nodeIds);
  const adj = new Map<string, string[]>();               // fromId -> [toId]
  const indeg = new Map<string, number>();
  for (const n of nodeIds) { adj.set(n, []); indeg.set(n, 0); }

  for (const e of edges) {
    if (e.type !== relType || !nodes.has(e.fromId) || !nodes.has(e.toId)) continue;
    adj.get(e.fromId)!.push(e.toId);
    indeg.set(e.toId, (indeg.get(e.toId) ?? 0) + 1);
  }

  const queue = nodeIds.filter((n) => (indeg.get(n) ?? 0) === 0);   // no unmet prerequisites
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (order.length === nodeIds.length) return { order, cycle: null };
  const cycle = nodeIds.filter((n) => (indeg.get(n) ?? 0) > 0);     // residual = nodes stuck in a cycle
  return { order, cycle };
}

/** True iff adding from -> to (relType) would introduce a cycle among the existing edges. */
export function wouldCycle(fromId: string, toId: string, edges: RelationshipEdge[], relType: RelationshipType | string = 'prerequisite_of'): boolean {
  const candidate: RelationshipEdge = { id: '', fromId, toId, type: relType as RelationshipType, createdAt: '' };
  const nodeIds = [...new Set([fromId, toId, ...edges.flatMap((e) => [e.fromId, e.toId])])];
  return topoOrder(nodeIds, [...edges, candidate], relType).cycle !== null;
}

/** Thrown when persisting an edge would create a prerequisite cycle. */
export class CycleError extends Error {
  constructor(public fromId: string, public toId: string) {
    super(`adding ${fromId} -[prerequisite_of]-> ${toId} would create a prerequisite cycle`);
    this.name = 'CycleError';
  }
}
