// GET /api/aquintutor/knowledge-path?target=<id>&mastered=<id,id,…>&nodeType=ConceptObject
// Block 02: prerequisite-ordered path to a target concept/unit, with already-mastered nodes
// removed. 400 if target missing or a cycle blocks the path; 404 if the target isn't in the graph.
import type { APIRoute } from 'astro';
import { loadPrerequisiteDag, loadNodeLabels, learningPath } from '@/lib/knowledge-graph';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const NODE_TYPES = new Set(['ConceptObject', 'KnowledgeObject']);

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);

  const url = new URL(request.url);
  const target = (url.searchParams.get('target') || '').trim();
  if (!target) return j({ ok: false, error: 'target required' }, 400);
  const nodeType = NODE_TYPES.has(url.searchParams.get('nodeType') || '') ? url.searchParams.get('nodeType')! : 'ConceptObject';
  const mastered = new Set((url.searchParams.get('mastered') || '').split(',').map((s) => s.trim()).filter(Boolean));

  const dag = await loadPrerequisiteDag({ nodeType });
  if (!dag.nodes.includes(target)) return j({ ok: false, error: 'target not in graph' }, 404);

  let path: string[];
  try { path = learningPath(dag, target, mastered); }
  catch (e: any) { return j({ ok: false, error: e?.message || 'cycle blocks the path' }, 400); }

  const labelMap = await loadNodeLabels(nodeType);
  const labels: Record<string, string> = {};
  for (const id of path) labels[id] = labelMap.get(id) ?? id;
  return j({ ok: true, target, path, labels });
};
