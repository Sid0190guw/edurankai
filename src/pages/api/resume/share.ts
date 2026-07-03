// POST /api/resume/share
// Creates a public share link for a built resume: /r/<slug>. Works without
// login like the rest of the builder. Uploaded data-URL photos are stripped
// (they blow the size cap and shouldn't be republished); URL photos stay.
import type { APIRoute } from 'astro';
import { createResumeShare } from '@/lib/resume';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const data = body && body.data;
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'no data' }, 400);
  if (data.photoUrl && String(data.photoUrl).indexOf('data:') === 0) data.photoUrl = '';
  const serialized = JSON.stringify(data);
  if (serialized.length > 60000) return json({ ok: false, error: 'too large' }, 413);
  if (!(data.fullName || '').toString().trim()) return json({ ok: false, error: 'Add your name before sharing' }, 400);

  const user = (locals as any).user;
  try {
    const slug = await createResumeShare({
      userId: user?.id || null,
      email: (data.email || '').toString().slice(0, 200) || null,
      fullName: (data.fullName || '').toString().slice(0, 200) || null,
      template: (body.template || '').toString().slice(0, 40) || null,
      data,
      days: Number(body.days) || 90,
    });
    if (!slug) return json({ ok: false, error: 'could not create link' }, 500);
    return json({ ok: true, url: 'https://edurankai.in/r/' + slug, slug });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500);
  }
};
