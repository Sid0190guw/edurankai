// POST /api/aquintutor/start-enrollment
// Body: { courseSlug }
// - Nothing to pay (free course, free for our team, or a full fee waiver): enrols now and returns
//   { ok, paid:false, redirect:'/portal/courses/<slug>' }.
// - A balance to pay: creates ONE Razorpay order and returns { ok, paid:true, orderId, keyId, ... }.
//   The browser opens checkout; /api/aquintutor/confirm-payment verifies the signature and enrols.
//
// =================================================================================================
// THE PRICE, THE WAIVER AND THE DUPLICATE CHECK ALL MOVED INTO src/lib/course-purchase.ts
// =================================================================================================
//
// This route used to read is_paid_course / is_free / price_inr_paise itself, decide the audience
// itself, and check "already enrolled" itself — while three other surfaces answered the same three
// questions in slightly different words. It is now a thin HTTP shell over startCoursePurchase(),
// which is the single answer to "what does this person owe for this course, and do they already have
// it". The gateway, the payments table and the reconcile backstop are all the existing ones.
//
// WHAT THIS ROUTE STILL OWES THE CALLER: a status code and a sentence. Everything else is decided
// server-side, and nothing the browser sends decides a price.
import type { APIRoute } from 'astro';
import { startCoursePurchase } from '@/lib/course-purchase';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in to enrol.', loginUrl: '/portal/login' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseSlug = (body?.courseSlug || '').toString().trim();
  if (!courseSlug) return json({ ok: false, error: 'courseSlug required' }, 400);

  try {
    const result = await startCoursePurchase(
      { id: user.id, role: user.role, email: user.email, name: user.name },
      courseSlug,
    );
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json(result);
  } catch (e: any) {
    // `.message` on a drizzle/postgres-js error is only the SQL that failed — table and column names
    // handed to whoever posted — while the database's real reason sits unread on `.cause`. The reason
    // goes to the log; the learner gets a sentence.
    console.error('[aquintutor/start-enrollment]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not start that enrolment just now, so nothing was charged. Try again in a moment.' }, 500);
  }
};
