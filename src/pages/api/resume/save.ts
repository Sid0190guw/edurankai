// POST /api/resume/save
// Stores a resume builder submission. Works WITHOUT login (the resume tool is
// public) — we capture the data to improve template quality and for security/
// abuse review, attaching the user id when one is present. Best-effort: a
// storage failure never blocks the user from downloading their resume.
import type { APIRoute } from 'astro';
import { saveResume } from '@/lib/resume';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const data = body && body.data;
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'no data' }, 400);
  // Cap payload so the public endpoint can't be used to dump large blobs.
  const serialized = JSON.stringify(data);
  if (serialized.length > 60000) return json({ ok: false, error: 'too large' }, 413);

  const user = (locals as any).user;
  const email = (data.email || '').toString().slice(0, 200) || null;
  const fullName = (data.fullName || data.name || '').toString().slice(0, 200) || null;
  const template = (body.template || '').toString().slice(0, 40) || null;

  try {
    await saveResume({ userId: user?.id || null, email, fullName, template, data, ip: clientAddress || null });
  } catch (_) { /* never block the download */ }
  return json({ ok: true });
};
