// /api/discuss/thread - POST creates a new thread on a course.
// Body: { course_id, title, body, kind?, lesson_id? }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const KINDS = new Set(['question', 'discussion', 'announcement']);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseId = String(body?.course_id || '').trim();
  const lessonId = body?.lesson_id ? String(body.lesson_id).trim() : null;
  const title = String(body?.title || '').trim();
  const txt = String(body?.body || '').trim();
  const kind = KINDS.has(String(body?.kind || '')) ? String(body.kind) : 'question';
  // EXAMINED AND DELIBERATELY NOT CONVERTED — announcement rights.
  //
  // TODAY: every non-applicant built-in role may post an ANNOUNCEMENT; an applicant's announcement is
  // silently downgraded to a question. No capability in the union matches that population for this
  // power. content.edit is {super_admin, hr, marketing, editor}, so swapping to it would strip
  // announcement rights from recruiter, reviewer, department_head, partner, teacher and
  // technical_moderator — a policy narrowing, which this sprint reports rather than ships. The six
  // internal-role keys that DO have this population (mail.manage, lessons.author, lessons.publish,
  // interviews.author, jobs.run, research.restricted.view) all name unrelated powers; borrowing one
  // to gate announcements would make the vocabulary lie.
  //
  // WHAT IS NEEDED: an `announcements.publish` key granted to the same ten non-applicant roles, then
  // this becomes can(user, 'announcements.publish') with nobody added or removed.
  //
  // ALSO REPORTED, and NOT changed here because it is a product decision: the downgrade is SILENT.
  // Someone who asks for an announcement and is not entitled to one gets a question posted under
  // their name and is told ok:true. Telling them would be better; changing the response shape is not
  // an authorization fix and does not belong in a mechanism-only commit.
  const isStaff = user.role && user.role !== 'applicant';
  const finalKind = (kind === 'announcement' && !isStaff) ? 'question' : kind;

  if (!courseId) return json({ ok: false, error: 'course_id required' }, 400);
  if (!title || title.length < 5) return json({ ok: false, error: 'title required (5+ chars)' }, 400);
  if (title.length > 300) return json({ ok: false, error: 'title too long (max 300)' }, 400);
  if (!txt || txt.length < 10) return json({ ok: false, error: 'body required (10+ chars)' }, 400);
  if (txt.length > 20000) return json({ ok: false, error: 'body too long (max 20k)' }, 400);

  try {
    const r = await db.execute(sql`
      INSERT INTO course_discussions (course_id, lesson_id, user_id, title, body, kind)
      VALUES (${courseId}, ${lessonId}, ${user.id}, ${title}, ${txt}, ${finalKind})
      RETURNING id
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return json({ ok: true, id: (rows[0] as any)?.id });
  } catch (e: any) {
    // e.message on a drizzle/postgres-js error is the failed SQL STATEMENT — table and column names
    // handed straight to whoever posted — while the database's actual complaint sits unread on
    // e.cause. A thread that was never created also left nothing behind for anyone investigating.
    console.error('[api/discuss/thread] insert failed for course', courseId, '-', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'Your post was not saved. Nothing has been published; try again.' }, 500);
  }
};
