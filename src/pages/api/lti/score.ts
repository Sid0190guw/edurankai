// POST /api/lti/score — called by the in-lab event bridge when a learner
// completes a lab that was launched via LTI. Sends the score (0..1) back to the
// LMS gradebook via LTI Basic Outcomes (replaceResult).
import type { APIRoute } from 'astro';
import { sendGrade } from '@/lib/lti';

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const token = (b.token || '').toString();
  if (!token) return new Response(JSON.stringify({ ok: false, error: 'token required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const r = await sendGrade(token, Number(b.score));
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
};
