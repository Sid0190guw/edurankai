// POST /api/aquintutor/start-enrollment
// Body: { courseSlug }
// - If course is free: creates enrollment immediately, returns { ok, paid:false, redirect:'/portal/courses/<slug>' }
// - If course is paid: creates a Razorpay order, returns { ok, paid:true, orderId, keyId, amountPaise, currency }
//   Browser opens Razorpay checkout; on success calls /api/aquintutor/confirm-payment which enrolls.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';

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
    const c = await db.execute(sql`
      SELECT id, slug, title, is_paid_course, is_free, price_inr_paise, access_type
      FROM training_courses WHERE slug = ${courseSlug} AND is_published = true LIMIT 1
    `);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: false, error: 'Course not found' }, 404);
    const course = cRows[0] as any;

    // EXAMINED AND DELIBERATELY NOT CONVERTED — this is not a permission question at all.
    //
    // `isEmployee` is being decided from users.role: anyone who is not an applicant counts as an
    // employee, which sweeps in partner, teacher and technical_moderator (external AquinTutor scopes,
    // employees of nobody). Employment is a FACT ABOUT A PERSON held in hr_employees — the table
    // src/lib/auth/admin-access.ts already reads — not an ability a role grants, so no capability can
    // express it and converting this to can() would be a category error that also fixes nothing.
    //
    // Both arms are affected: an 'employees'-restricted course admits those three scopes today, and
    // an 'applicants'-restricted course excludes them. Resolving it properly means an active
    // hr_employees lookup, which changes who can enrol on restricted courses either way, so it is
    // reported for a human rather than done in a mechanism-only pass.
    //
    // Sibling src/pages/api/aquintutor/start-test-enrollment.ts:60 shows the converted pattern for
    // the paid-test override, which IS a capability question.
    const isEmployee = user.role && user.role !== 'applicant';
    const accessOk = course.access_type === 'public' || course.access_type === 'both' ||
      (course.access_type === 'employees' && isEmployee) ||
      (course.access_type === 'applicants' && !isEmployee);
    if (!accessOk) return json({ ok: false, error: 'You do not have access to this course' }, 403);

    // Already enrolled?
    const e = await db.execute(sql`SELECT id FROM training_enrollments WHERE course_id = ${course.id} AND user_id = ${user.id} LIMIT 1`);
    const eRows = Array.isArray(e) ? e : (e?.rows || []);
    if (eRows.length > 0) {
      return json({ ok: true, paid: false, alreadyEnrolled: true, redirect: '/portal/courses/' + course.slug });
    }

    const treatAsFree = course.is_free === true || !course.is_paid_course || (course.price_inr_paise || 0) < 100;

    if (treatAsFree) {
      // Create enrollment directly
      await db.execute(sql`
        INSERT INTO training_enrollments (course_id, user_id, progress_pct)
        VALUES (${course.id}, ${user.id}, 0)
        ON CONFLICT DO NOTHING
      `);
      await db.execute(sql`UPDATE training_courses SET enrolled_count = enrolled_count + 1 WHERE id = ${course.id}`).catch(() => {});
      return json({ ok: true, paid: false, redirect: '/portal/courses/' + course.slug });
    }

    // Paid: create a Razorpay order
    if (!isConfigured()) {
      return json({ ok: false, error: 'Payments not yet configured. Contact hr@edurankai.in to enrol.' }, 503);
    }

    const amountPaise = Math.max(100, parseInt(course.price_inr_paise || 100));

    // Same absurd-price guard as the two test-checkout paths. price_inr_paise is in PAISE, so a
    // course saved as 500 meaning "Rs 500" charges Rs 5. That units trap already took a real
    // Rs 1.20 payment for the Quantum Science & ASI bootcamp test, and this column is populated the
    // same way for courses. Refusing is strictly better than charging a nonsense amount: a failed
    // checkout is a support message, whereas a wrong charge is a refund, a reconciliation problem,
    // and a learner who believes they have paid and enrolled.
    if (amountPaise > 0 && amountPaise < 1000) {
      console.error('[start-enrollment] refusing absurd price', {
        courseSlug: course.slug, amountPaise, price_inr_paise: course.price_inr_paise,
      });
      return json({
        ok: false,
        error: 'This course is not correctly priced yet, so we have not taken any payment. Please write to hr@edurankai.in and we will sort it out.',
      }, 409);
    }

    const receipt = 'aq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const result = await createOrder({
      amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        purpose: 'course_enrollment',
        courseSlug: course.slug,
        userId: user.id,
        email: user.email || '',
      },
    });
    if (!result.ok) return json({ ok: false, error: result.error }, 502);

    // THE PAYMENTS ROW IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SWALLOWED.
    //
    // It ended in `.catch(() => {})` under the comment "so webhook can correlate" — which understates
    // it: this row is the ONLY thing that says which course was bought and by whom.
    // /api/aquintutor/confirm-payment looks the order up here and answers 'Payment record missing'
    // (404) when it is absent, so a failed insert meant the learner paid, was not enrolled, and was
    // told to email support — with no row for support to find, reconcile or refund against.
    //
    // Refusing costs an unused order at the gateway, which expires on its own and charges nobody.
    try {
      await db.execute(sql`
        INSERT INTO payments (
          order_id, amount_paise, currency, status, purpose,
          reference_type, reference_id, user_id, email, notes
        ) VALUES (
          ${result.order.id}, ${amountPaise}, 'INR', 'created', 'course_enrollment',
          'training_course', ${course.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'},
          ${sql.raw("'" + JSON.stringify({ receipt, courseSlug: course.slug }).replace(/'/g, "''") + "'::jsonb")}
        )
      `);
    } catch (e: any) {
      console.error('[aquintutor/start-enrollment] order', result.order.id, 'could not be recorded for user', user.id,
        'course', course.id, '-', e?.cause?.message || e?.message);
      return json({ ok: false, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' }, 500);
    }

    return json({
      ok: true,
      paid: true,
      orderId: result.order.id,
      keyId: getPublicKeyId(),
      amountPaise,
      currency: 'INR',
      courseTitle: course.title,
      courseSlug: course.slug,
      prefill: { name: user.name || '', email: user.email || '' },
    });
  } catch (e: any) {
    // `.message` on a drizzle/postgres-js error is only the SQL that failed — table and column names
    // handed to whoever posted — while the database's real reason sits unread on `.cause`. The reason
    // goes to the log; the learner gets a sentence.
    console.error('[aquintutor/start-enrollment]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not start that enrolment just now, so nothing was charged. Try again in a moment.' }, 500);
  }
};
