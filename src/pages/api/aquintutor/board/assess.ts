// POST /api/aquintutor/board/assess — Block 07: generate a live quiz from a running session's
// fired concepts + transcript. Faculty-gated (write AnimationObject, matching the board surface).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { generateLiveAssessment } from '@/lib/board-assess';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const decision = await can(user, 'write', { type: 'AnimationObject' });
  if (!decision.allow) return j({ ok: false, error: 'not permitted (faculty only)', reason: decision.reason }, 403);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const session = String(b.session || '');
  if (!session) return j({ ok: false, error: 'session required' }, 400);
  const koId = b.koId ? String(b.koId) : null;
  const window = Math.min(200, Math.max(1, Number(b.window) || 40));

  try {
    const { assessmentId, items, source } = await generateLiveAssessment(session, koId, user.id, window);
    return j({ ok: true, assessmentId, items, source });
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200);
  }
};
