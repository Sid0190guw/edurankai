// POST /api/aquintutor/mind/predict — what the trained model says, right now.
//
// Two kinds:
//   kind: 'mastery'  probability the signed-in learner answers a given item correctly, with the
//                    inputs that moved it and what the platform's own estimator says alongside.
//   kind: 'intent'   which kind of help a message is asking for, model vs. deterministic rules.
//
// A learner may only ask about THEMSELVES. There is no userId parameter, deliberately: the identity
// comes from the session, so this endpoint cannot be turned into a way to read another person's
// learning by changing a number in a request.
//
// Advisory only. Nothing this returns grades anybody or blocks anybody.
import type { APIRoute } from 'astro';
import { predictSuccess, rankByLearningValue } from '@/lib/mind/serve';
import { classifyIntent } from '@/lib/mind/distill';
import type { MindSignals } from '@/lib/mind/features';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

function toSignals(o: any): MindSignals {
  return {
    itemKey: String(o?.itemKey || 'item'),
    conceptKey: String(o?.conceptKey || 'general'),
    itemType: o?.itemType ? String(o.itemType) : undefined,
    difficulty: typeof o?.difficulty === 'number' ? o.difficulty : undefined,
    marks: typeof o?.marks === 'number' ? o.marks : undefined,
    text: o?.text ? String(o.text).slice(0, 500) : undefined,
    atMs: Date.now(),
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const aquin = (locals as any)?.aquin;
  const userKey = user?.id || aquin?.userId || '';
  if (!userKey) return j({ ok: false, error: 'sign in required' }, 401);

  let b: any = {};
  try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const kind = String(b.kind || 'mastery');

  try {
    if (kind === 'intent') {
      const text = String(b.text || '').slice(0, 2000);
      if (!text.trim()) return j({ ok: false, error: 'text required' }, 400);
      return j({ ok: true, intent: await classifyIntent(text) });
    }
    if (Array.isArray(b.candidates) && b.candidates.length) {
      const ranked = await rankByLearningValue(userKey, b.candidates.map(toSignals), typeof b.target === 'number' ? b.target : 0.72);
      return j({ ok: true, ranked });
    }
    return j({ ok: true, prediction: await predictSuccess(userKey, toSignals(b)) });
  } catch (e: any) {
    console.error('[mind/predict] failed:', e?.cause?.message || e?.message);
    return j({ ok: false, error: 'prediction unavailable' }, 500);
  }
};
