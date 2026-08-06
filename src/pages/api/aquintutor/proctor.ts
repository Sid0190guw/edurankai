// POST /api/aquintutor/proctor — receive privacy-preserving TEXT proctoring events (Prompt 11).
// The server sanitizes to { type, at } only, so NO media bytes are ever stored even if a client
// tries to attach them. Advisory only: nothing here penalises anybody; a human decides.
//
// THE SESSION IS NOW CHECKED AGAINST THE CALLER. `sessionId` arrives in the request body, and this
// route used to hand it straight to recordEvents() — so any signed-in user could write fabricated
// events into ANOTHER candidate's proctoring session, and the advisory risk score a human reviewer
// reads at /admin/proctoring is computed purely from session_id. canWriteProctorSession() enforces
// first-claim-wins (see src/lib/proctor.ts) and fails closed.
import type { APIRoute } from 'astro';
import { recordEvents, canWriteProctorSession } from '@/lib/proctor';

export const prerender = false;

// Declared before the handler — `const` is not hoisted.
const j = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);

  let b: any = {};
  try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const sessionId = String(b.sessionId || '');
  if (!sessionId) return j({ ok: false, error: 'sessionId required' }, 400);

  // AUTHORISE BEFORE THE WRITE. Refusing after the insert would already have planted the evidence.
  if (!(await canWriteProctorSession(sessionId, String(user.id)))) {
    return j({ ok: false, error: 'That proctoring session does not belong to this account.' }, 403);
  }

  try {
    const n = await recordEvents(sessionId, user.id, Array.isArray(b.events) ? b.events : []);
    return j({ ok: true, recorded: n });
  } catch (e: any) {
    // Real Postgres reason is on e.cause; e.message is only the failed SQL. Status 200 is kept
    // deliberately: a proctoring beacon must never break the exam the candidate is sitting.
    console.error('[api/aquintutor/proctor]', e?.cause?.message || e?.message);
    return j({ ok: false, error: 'not recorded' }, 200);
  }
};
