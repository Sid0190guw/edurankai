// Atelier credential-path API (vocational / lifelong tier).
//   GET  /api/aquintutor/atelier?track=web-dev  -> track state + evidence + progress
//   POST /api/aquintutor/atelier { action:'evidence', track, key, demonstrated, evidence }
import type { APIRoute } from 'astro';
import { getTrackState, saveEvidence, getProgressByTrack, TRACKS, TRACK_BY_ID } from '@/lib/aquintutor-atelier';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  const track = (url.searchParams.get('track') || 'web-dev').toString();
  if (!TRACK_BY_ID[track]) return json({ ok: false, error: 'unknown track' }, 400);
  try {
    const [state, progress] = await Promise.all([getTrackState(user.id, track), getProgressByTrack(user.id)]);
    return json({ ok: true, state, progress, tracks: TRACKS.map((t) => ({ id: t.id, name: t.name, field: t.field, blurb: t.blurb, total: t.competencies.length })) });
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'evidence') {
      const track = (b.track || '').toString();
      const key = (b.key || '').toString().slice(0, 80);
      if (!track || !key) return json({ ok: false, error: 'track + key required' }, 400);
      const ok = await saveEvidence(user.id, track, key, !!b.demonstrated, (b.evidence || '').toString());
      if (!ok) return json({ ok: false, error: 'unknown track/competency' }, 400);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};
