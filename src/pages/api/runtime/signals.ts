// POST /api/runtime/signals — Block 04: ingest client-reported environment signals
// (device/network/accessibility/language) + server Accept-Language; return the LearnerState.
import type { APIRoute } from 'astro';
import { createPgKernel } from '@/lib/kernel';
import { applySignals } from '@/lib/runtime/estimators';
import { signalsBodySchema } from '@/lib/runtime/estimators/schema';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let body: unknown; try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = signalsBodySchema.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: 'invalid body', issues: parsed.error.issues.map((i) => i.message) }, 400);

  const kernel = createPgKernel();
  const obj = await kernel.getObject(parsed.data.studentObjectId);
  if (!obj || obj.type !== 'StudentObject') return j({ ok: false, error: 'not a StudentObject' }, 404);
  if (obj.owner !== user.id) return j({ ok: false, error: 'not your learner record' }, 403);

  const learnerState = await applySignals(kernel, parsed.data.studentObjectId, {
    acceptLanguage: request.headers.get('accept-language') ?? undefined,
    device: parsed.data.device, network: parsed.data.network,
    accessibility: parsed.data.accessibility, languagePrefs: parsed.data.languagePrefs,
  });
  return j({ ok: true, learnerState });
};
