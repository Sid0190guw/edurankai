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

    // Access gate
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

    // Insert pending payment row so webhook can correlate
    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, notes
      ) VALUES (
        ${result.order.id}, ${amountPaise}, 'INR', 'created', 'course_enrollment',
        'training_course', ${course.id}, ${user.id}, ${user.email || 'unknown@edurankai.in'},
        ${sql.raw("'" + JSON.stringify({ receipt, courseSlug: course.slug }).replace(/'/g, "''") + "'::jsonb")}
      )
    `).catch(() => {});

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
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
