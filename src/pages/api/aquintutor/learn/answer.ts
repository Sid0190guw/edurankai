// POST /api/aquintutor/learn/answer  { exerciseId, answer }
// Grades a single lesson exercise and returns correctness + model + explanation.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { awardXp } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }
function normTxt(s: any) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const exId = (body.exerciseId || '').toString();
  if (!exId) return json({ ok: false, error: 'exerciseId required' }, 400);

  const ex = rows(await db.execute(sql`SELECT * FROM lesson_exercises WHERE id = ${exId} LIMIT 1`))[0] as any;
  if (!ex) return json({ ok: false, error: 'exercise not found' }, 404);

  const ans = body.answer;
  let correct = false;
  let modelAnswer: any = ex.correct_answer;

  const cAns = ex.correct_answer;
  const payload = ex.payload || {};

  if (ex.exercise_type === 'choose_meaning' || ex.exercise_type === 'choose_script' || ex.exercise_type === 'true_false' || ex.exercise_type === 'image_choice') {
    correct = ans === cAns;
    const opts = (payload.options || []) as any[];
    const got = opts[cAns as number];
    modelAnswer = got ? (typeof got === 'object' ? (got.text || got.label || JSON.stringify(got)) : got) : cAns;
  } else if (ex.exercise_type === 'order_words') {
    const correctOrder = Array.isArray(cAns) ? cAns : (payload.order || []);
    correct = Array.isArray(ans) && ans.length === correctOrder.length && ans.every((v: any, i: number) => Number(v) === Number(correctOrder[i]));
    const bank = (payload.words || []) as any[];
    modelAnswer = correctOrder.map((i: any) => bank[Number(i)]).filter(Boolean).join(' ');
  } else if (ex.exercise_type === 'fill_blank' || ex.exercise_type === 'listen_type' || ex.exercise_type === 'speak_word') {
    const cand = normTxt(ans);
    const accepted: string[] = [];
    let raw: any = ex.accepted_answers;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
    if (Array.isArray(raw)) for (const a of raw) { const n = normTxt(a); if (n) accepted.push(n); }
    if (cAns != null) { const n = normTxt(cAns); if (n && !accepted.includes(n)) accepted.push(n); }
    correct = cand !== '' && accepted.includes(cand);
    modelAnswer = accepted[0] || '';
  } else if (ex.exercise_type === 'match_pairs') {
    // ans is expected to be an object {leftIndex: rightIndex, ...}
    const pairs = (payload.pairs || []) as any[];
    if (!ans || typeof ans !== 'object') correct = false;
    else {
      correct = true;
      for (let i = 0; i < pairs.length; i++) {
        if (Number(ans[i]) !== i) { correct = false; break; }
      }
    }
    modelAnswer = pairs.map((p: any) => p[0] + ' ↔ ' + p[1]).join(' · ');
  }

  let xpDelta = 0;
  if (user && correct) {
    xpDelta = ex.points || 5;
    try { await awardXp({ userId: user.id, source: 'lesson_exercise', refId: exId, delta: xpDelta, reason: 'Lesson exercise correct' }); } catch (_) {}
  }

  return json({ ok: true, correct, modelAnswer, explanation: ex.explanation, xpDelta });
};
