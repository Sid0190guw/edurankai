// POST /api/plugins/[id]/generate-assessment — Block 09: run a plugin's deterministic
// assessment generator and persist an AssessmentObject (+ assesses edge) with its items.
import type { APIRoute } from 'astro';
import { requireCapability, ForbiddenError } from '@/lib/rbac';
import { pluginForConcept, resolveAssessmentGenerator } from '@/lib/plugins';
import { createAssessment } from '@/lib/assessment';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const id = String(params.id || '');

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const conceptDomain = String(b.conceptDomain || '');
  const koId = String(b.koId || '');
  if (!conceptDomain || !koId) return j({ ok: false, error: 'conceptDomain + koId required' }, 400);

  const owner = pluginForConcept(conceptDomain);
  if (!owner || owner.id !== id) return j({ ok: false, error: `plugin '${id}' does not own domain '${conceptDomain}'` }, 400);
  const gen = resolveAssessmentGenerator(conceptDomain);
  if (!gen) return j({ ok: false, error: 'no generator for that domain' }, 404);

  try { await requireCapability(user, 'create', { type: 'AssessmentObject' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }

  const count = Math.min(20, Math.max(1, Number(b.count) || 5));
  const seed = Number.isFinite(Number(b.seed)) ? Number(b.seed) : 1;
  const items = gen({ domain: conceptDomain, name: koId }, { count, seed });

  try {
    const assessmentId = await createAssessment(`Auto: ${conceptDomain}`, 'quiz', koId, user.id);
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.execute(sql`INSERT INTO edu_assessment_items (assessment_id, type, prompt, options, answer, points, sort)
        VALUES (${assessmentId}, ${it.type}, ${it.prompt}, ${JSON.stringify(it.options ?? [])}::jsonb, ${JSON.stringify(it.answer ?? {})}::jsonb, ${it.points}, ${i})`);
    }
    return j({ ok: true, assessmentId, itemCount: items.length });
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200);
  }
};
