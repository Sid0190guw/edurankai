// GET /api/aquintutor/knowledge-graph?nodeType=ConceptObject&mastered=<id,id,…>
// Block 02: returns the real prerequisite graph (nodes+labels, edges, topo order, cycle,
// and the ready-to-learn frontier for the mastered set) loaded per-request from Postgres.
import type { APIRoute } from 'astro';
import { loadPrerequisiteDag, loadNodeLabels, topoSort, readyFrontier } from '@/lib/knowledge-graph';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const NODE_TYPES = new Set(['ConceptObject', 'KnowledgeObject']);

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);

  const url = new URL(request.url);
  const nodeType = NODE_TYPES.has(url.searchParams.get('nodeType') || '') ? url.searchParams.get('nodeType')! : 'ConceptObject';
  const mastered = new Set((url.searchParams.get('mastered') || '').split(',').map((s) => s.trim()).filter(Boolean));

  const dag = await loadPrerequisiteDag({ nodeType });
  const { order, cycle } = topoSort(dag);
  const labels = await loadNodeLabels(nodeType);
  const nodes = dag.nodes.map((id) => ({ id, label: labels.get(id) ?? id }));
  const ready = mastered.size ? readyFrontier(dag, mastered) : [];

  return j({ ok: true, nodeType, nodes, edges: dag.edges, order, cycle, ready });
};
