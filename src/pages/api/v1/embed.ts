// GET /api/v1/embed?slug=vlsi — partner API: get a signed, login-free embed URL
// for a single lab to iframe inside your LMS. Auth: x-api-key.
import type { APIRoute } from 'astro';
import { validateApiKey, signEmbedToken, CORS } from '@/lib/api-keys';
import { LAB_CATALOGUE, LAB_LABELS } from '@/lib/aquintutor-authoring';
import { SITE } from '@/lib/site';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } }); }

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS });

export const GET: APIRoute = async ({ request, url }) => {
  const partner = await validateApiKey(request);
  if (!partner) return json({ ok: false, error: 'Invalid or missing API key.' }, 401);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug || LAB_CATALOGUE.indexOf(slug) === -1) return json({ ok: false, error: 'Unknown lab slug. Call /api/v1/labs for the list.' }, 404);
  const base = SITE.url.replace(/\/$/, '');
  const embed_url = base + '/aquintutor/labs/' + slug + '?embed_token=' + signEmbedToken(slug);
  return json({
    ok: true,
    slug,
    name: LAB_LABELS[slug] || slug,
    embed_url,
    iframe: '<iframe src="' + embed_url + '" style="width:100%;height:760px;border:0;" allow="fullscreen" loading="lazy"></iframe>',
  });
};
