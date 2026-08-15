// /api/aquintutor/lms/xapi — the statement endpoint (L6).
//
// POST one statement, or an array of them, in xAPI shape. GET reads recent statements back.
//
// AUTHORISATION IS ONE OF TWO THINGS AND NEVER NOTHING:
//   - a signed-in session (a surface on this platform recording its own learner's activity), or
//   - an API key (an external tool), validated through src/lib/api-keys.ts.
// With neither, this returns 401. An open statement endpoint is an open write to the learning
// record of every person on the platform, so there is no unauthenticated path here at all.
//
// AN EXTERNAL STATEMENT CANNOT NAME AN ARBITRARY LEARNER. A key-authenticated caller may identify
// its actor by mbox, and the email is resolved to a local account here; if it resolves to nobody the
// statement is still stored, with actor_name and no actor_user_id, rather than being attached to
// somebody it might not be.
import type { APIRoute } from 'astro';
import { parseXapiStatement, recordStatement, listStatements } from '@/lib/lms/interop';
import { validateApiKey } from '@/lib/api-keys';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

async function resolveActor(mboxOrName: string | null): Promise<string | null> {
  const email = String(mboxOrName || '').replace(/^mailto:/, '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  try {
    const r = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
    const rowList = Array.isArray(r) ? r : ((r as any)?.rows || []);
    return rowList[0]?.id || null;
  } catch (e: any) {
    console.error('[lms/xapi] resolveActor:', e?.cause?.message || e?.message);
    return null;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const key = user?.id ? null : await validateApiKey(request);
  if (!user?.id && !key) return json({ ok: false, error: 'sign in or present an API key' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  const batch = Array.isArray(body) ? body : [body];
  if (batch.length > 100) return json({ ok: false, error: 'at most 100 statements per request' }, 413);

  const stored: string[] = [];
  const rejected: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < batch.length; i++) {
    const parsed = parseXapiStatement(batch[i]);
    if (!parsed.ok || !parsed.value) {
      rejected.push({ index: i, error: parsed.error || 'unreadable statement' });
      continue;
    }
    const value = parsed.value;

    // A signed-in caller records their OWN activity. Only a key-authenticated caller may name an
    // actor, and only by an email that resolves to an account here.
    value.actorUserId = user?.id
      ? user.id
      : await resolveActor(batch[i]?.actor?.mbox || batch[i]?.actor?.account?.name || null);
    value.source = user?.id ? 'internal' : 'external';

    const courseId = String(batch[i]?.context?.extensions?.courseId || batch[i]?.courseId || '');
    if (/^[0-9a-f-]{36}$/i.test(courseId)) value.courseId = courseId;

    const id = await recordStatement(value);
    if (id) stored.push(id);
    else rejected.push({ index: i, error: 'could not be stored' });
  }

  return json({ ok: rejected.length === 0, stored: stored.length, rejected }, rejected.length && !stored.length ? 400 : 200);
};

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'sign in required' }, 401);

  const courseId = String(url.searchParams.get('course') || '') || null;
  if (courseId) {
    // Reading a whole course's statements is a teaching act, not a learner one.
    const { teachClaim } = await import('@/lib/lms/access');
    const claim = await teachClaim(user, courseId);
    if (!claim.canGrade) return json({ ok: false, error: 'not permitted for this course' }, 403);
    return json({ ok: true, statements: await listStatements({ courseId, limit: Number(url.searchParams.get('limit') || 100) }) });
  }

  // With no course, a person reads only their own record.
  return json({ ok: true, statements: await listStatements({ userId: user.id, limit: Number(url.searchParams.get('limit') || 100) }) });
};
