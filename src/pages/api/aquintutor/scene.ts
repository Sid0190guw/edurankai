// GET /api/aquintutor/scene?id=solar-system — serve ONE authored teaching scene.
// The scene library is ~196 KB; inlining every spec into the board page would bloat each render,
// so the client fetches only the scene it is about to show. Validated + repaired before it leaves.
import type { APIRoute } from 'astro';
import { exampleScene, SCENE_EXAMPLE_IDS } from '@/lib/scene-examples';

export const GET: APIRoute = async ({ url }) => {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return new Response(JSON.stringify({ ok: true, ids: SCENE_EXAMPLE_IDS }), { headers: { 'Content-Type': 'application/json' } });
  const spec = exampleScene(id);
  if (!spec) return new Response(JSON.stringify({ ok: false, error: 'unknown scene' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true, spec }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });
};
