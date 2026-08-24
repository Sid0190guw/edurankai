// GET /api/aquintutor/board/inspect?session=SID — session roster + recent fires (Prompt A1b).
// Faculty-only (the driver): who joined, at which render tier, who is still online, what was fired.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { sessionInspector } from '@/lib/board-session';
// THE SIBLING OF stream.ts, AND POLLED HARDER THAN IT.
//
// board/stream.ts was bounded and had its tick halved; this file sits on the same teaching screen,
// is polled every four seconds by the faculty inspector panel, and had no bound on either of its two
// awaits. On this deployment an await with no bound does not fail — it hangs until the platform
// kills the invocation, holding a pooler connection for the whole time, and a four-second timer
// keeps starting new ones behind it.
//
// Bounded and NOT retried: the next tick is the retry, and asking twice inside one tick doubles the
// load exactly when the database is struggling.
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

export const prerender = false;

const j = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return new Response(JSON.stringify({ ok: false, error: 'sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  // FAILS CLOSED on a stall: no verdict means no access, which is the direction a gate must fail.
  let gate: Awaited<ReturnType<typeof can>>;
  try {
    gate = await withDbTimeout(can(user, 'write', { type: 'AnimationObject' }), 'board.inspect.gate', 3000);
  } catch (e: any) {
    console.error('[board/inspect] gate did not answer:', e?.cause?.message || e?.message);
    return j({ ok: false, error: 'Your access could not be checked just now. Nothing is being shown rather than something wrong.' }, 503);
  }
  if (!gate.allow) return j({ ok: false, error: 'faculty only' }, 403);
  const sessionId = (url.searchParams.get('session') || '').trim();
  if (!sessionId) return j({ ok: false, error: 'missing session' }, 400);
  try {
    const data = await withDbTimeout(sessionInspector(sessionId), 'board.inspect.read', 3000);
    return j({ ok: true, ...data });
  } catch (e: any) {
    // TWO THINGS THIS ANSWER GOT WRONG. It returned HTTP 200 for a failure, so every monitor and
    // every caller that checks the status code read an outage as a success; and it put the raw
    // Postgres reason in the body, which on a connection failure carries the pooler hostname and the
    // database role. The reason goes to the log, where operators are.
    const raw = e?.cause?.message || e?.message || 'unknown error';
    console.error('[board/inspect] session read failed:', raw);
    return j({
      ok: false,
      error: isDbUnavailable(e)
        ? 'The database did not answer, so the roster could not be read. This is not an empty room.'
        : 'The roster could not be read just now.',
    }, 503);
  }
};
