// POST /api/certificates/email — "email me my certificate".
//
// IT HAS NEVER SENT AN EMAIL. The whole body of this endpoint is one SELECT and one INSERT into
// `notifications`; nothing here touches src/lib/mail-transport.ts, src/lib/mail.ts or any transport
// at all. It then answered `{ ok: true, email: <the learner's address> }` — a shape whose only
// reasonable reading is "sent to that address". No page in the repository calls it, which is the
// only reason nobody has been told their certificate was emailed when it was not; the URL is live
// and answers anyone signed in. Rather than leave a promise sitting behind a route, the response now
// says exactly what happened: `emailed: false`, plus the in-app notification that WAS written.
//
// Two more defects went with it:
//
//  * THE ONE WRITE WAS SWALLOWED. `.catch(() => {})` on the INSERT, followed unconditionally by
//    ok:true — so the notification could fail and the caller was told the request had succeeded.
//    It is checked with RETURNING now, and a write that matched nothing is reported as a failure.
//  * THE FAILURE PATH LEAKED THE SQL AT HTTP 200. `catch (e) { ... error: e.message }` with no
//    status: on postgres-js e.message is the failed STATEMENT — table and column names handed to
//    the caller — while the database's real reason sits unread on e.cause, and every log, uptime
//    check and retry rule read a 200 and called it healthy.
//
// The SELECT is already narrowed to `c.user_id = <caller>`, so one learner can never ask about
// another's certificate; that is unchanged.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Declared above the handler that uses them — `const` is not hoisted, and a handler reaching a later
// declaration throws on its first line.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const certificateNumber = String(body?.certificateNumber || '').trim();
  if (!certificateNumber) return json({ ok: false, error: 'Missing certificate number' }, 400);

  try {
    const cert = rowsOf(await db.execute(sql`
      SELECT c.certificate_number, u.name AS user_name, u.email AS user_email,
             co.title AS course_title
        FROM training_certificates c
        JOIN users u ON c.user_id = u.id
        JOIN training_courses co ON c.course_id = co.id
       WHERE c.certificate_number = ${certificateNumber} AND c.user_id = ${user.id}
       LIMIT 1
    `))[0] as any;
    if (!cert) return json({ ok: false, error: 'No certificate of yours has that number.' }, 404);

    const written = rowsOf(await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type)
      VALUES (${user.id}, 'Certificate ready',
              ${'Your certificate for ' + (cert.course_title || 'your course') + ' is ready. #' + certificateNumber},
              'system')
      RETURNING id
    `));
    if (!written.length) {
      return json({ ok: false, emailed: false, error: 'The notification was not saved, so nothing has been sent.' }, 500);
    }

    return json({
      ok: true,
      emailed: false,
      notified: true,
      // Returned so a surface can say WHERE the certificate would go if emailing is ever built.
      // It is the caller's own address; this endpoint has no way to reach any other.
      address: cert.user_email || null,
      note: 'A notification is waiting in your portal. This does not email the certificate — nothing on the platform mails a certificate yet.',
    });
  } catch (e: any) {
    console.error('[api/certificates/email] failed for', certificateNumber, '-', reasonOf(e));
    return json({ ok: false, emailed: false, error: 'That could not be processed just now. Nothing has been sent.' }, 500);
  }
};
