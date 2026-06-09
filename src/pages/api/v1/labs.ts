// GET /api/v1/labs  — partner/university API: list embeddable virtual labs.
// Auth: x-api-key header (or Authorization: Bearer, or ?api_key=). Read-only, CORS-enabled.
import type { APIRoute } from 'astro';
import { validateApiKey, signEmbedToken, CORS } from '@/lib/api-keys';
import { LAB_CATALOGUE, LAB_LABELS } from '@/lib/aquintutor-authoring';
import { SITE } from '@/lib/site';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } }); }

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS });

export const GET: APIRoute = async ({ request }) => {
  const partner = await validateApiKey(request);
  if (!partner) return json({ ok: false, error: 'Invalid or missing API key. Send it as the x-api-key header.' }, 401);

  const base = SITE.url.replace(/\/$/, '');
  const labs = LAB_CATALOGUE.map((slug) => ({
    slug,
    name: LAB_LABELS[slug] || slug,
    // direct URL (requires the learner to be signed in on edurankai.in)
    url: base + '/aquintutor/labs/' + slug,
    // embeddable iframe URL for your LMS — carries a signed token so no login is needed
    embed_url: base + '/aquintutor/labs/' + slug + '?embed_token=' + signEmbedToken(slug),
  }));
  return json({ ok: true, count: labs.length, organization: partner.organization, labs });
};
