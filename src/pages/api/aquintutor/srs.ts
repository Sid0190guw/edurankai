// Spaced-repetition API for the Tutor tier.
//   GET  /api/aquintutor/srs?deck=cs-core  -> seeds (idempotent) + returns due queue + stats
//   POST /api/aquintutor/srs { action:'grade', cardId, grade }  -> SM-2 reschedule
import type { APIRoute } from 'astro';
import { seedDeck, getDue, getStats, gradeCard, DECK_BY_ID, DECKS } from '@/lib/aquintutor-srs';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  const deck = (url.searchParams.get('deck') || 'cs-core').toString();
  if (!DECK_BY_ID[deck]) return json({ ok: false, error: 'unknown deck' }, 400);
  try {
    await seedDeck(user.id, deck);
    const [due, stats] = await Promise.all([getDue(user.id, deck), getStats(user.id, deck)]);
    return json({ ok: true, deck, decks: DECKS.map((d) => ({ id: d.id, name: d.name, blurb: d.blurb, count: d.cards.length })), due, stats });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'grade') {
      const cardId = (b.cardId || '').toString().slice(0, 80);
      const grade = Number(b.grade);
      if (!cardId) return json({ ok: false, error: 'cardId required' }, 400);
      if (![0, 3, 4, 5].includes(grade)) return json({ ok: false, error: 'grade must be 0|3|4|5' }, 400);
      const res = await gradeCard(user.id, cardId, grade);
      if (!res) return json({ ok: false, error: 'card not found' }, 404);
      return json({ ok: true, ...res });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500);
  }
};
