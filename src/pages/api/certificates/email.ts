import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const body = await request.json();
    const { certificateNumber } = body;
    if (!certificateNumber) return new Response(JSON.stringify({ ok: false, error: 'Missing certificate number' }), { headers: { 'Content-Type': 'application/json' } });

    const r = await db.execute(sql`
      SELECT c.*, u.name as user_name, u.email as user_email,
        co.title as course_title, co.instructor_name
      FROM training_certificates c
      JOIN users u ON c.user_id = u.id
      JOIN training_courses co ON c.course_id = co.id
      WHERE c.certificate_number = ${certificateNumber} AND c.user_id = ${user.id}
      LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length === 0) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { headers: { 'Content-Type': 'application/json' } });

    const cert = rows[0] as any;

    // In-app notification always sent
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type)
      VALUES (${user.id}, 'Certificate Ready', ${'Your certificate for ' + cert.course_title + ' is ready. #' + certificateNumber}, 'system')
    `).catch(() => {});

    return new Response(JSON.stringify({ ok: true, email: cert.user_email }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
