// POST /api/aquintutor/discussion — create a thread, post/reply, or report (Prompt 20). A minor may
// participate only with guardian community consent (Prompt 14). Replies notify (Prompt 18). Audited.
//
// THE AGE LOOKUP USED TO FAIL OPEN, AND IT IS THE ONLY THING STANDING BETWEEN A CHILD AND A PUBLIC
// COMMUNITY. participationOk() read the learner's stage inside `try { ... } catch {}` with `minor`
// initialised to false, so ANY error on that statement — a dropped pooler connection, a missing
// rbac_user_roles table on a fresh database, a slow query aborted — resolved to "not a minor" and
// waved the post straight through. The guardian-consent gate below then never ran at all. A gate
// that opens when its lookup throws is not a gate; it is a gate-shaped comment.
//
// It now answers three states, not two: MAY POST, MAY NOT POST (a minor whose guardian has not
// consented), and CANNOT TELL. "Cannot tell" is refused with 503 and a sentence that says the
// account could not be checked rather than accusing the person of anything — an empty answer and a
// failed answer are different facts and this endpoint no longer confuses them.
//
// Reporting stays open in all three states: someone flagging harm must never be blocked by a
// database hiccup, and a report grants no reach into the community.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isMinorStage } from '@/lib/rbac/roles';
import { getProfile } from '@/lib/student-settings';
import { createThread, createPost, reportPost, canParticipate } from '@/lib/edu-community';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

type Participation = { ok: true } | { ok: false; error: string; status: number };

const CANNOT_TELL: Participation = {
  ok: false,
  status: 503,
  error: 'We could not check your account settings just now, so nothing was posted. Please try again in a moment.',
};
const NEEDS_CONSENT: Participation = {
  ok: false,
  status: 403,
  error: 'a guardian must enable community participation for your account',
};

async function participationOk(userId: string): Promise<Participation> {
  let minor: boolean;
  try {
    const stage = rows(await db.execute(sql`SELECT stage FROM rbac_user_roles WHERE user_id = ${userId} AND role_key = 'student' LIMIT 1`))[0]?.stage;
    minor = isMinorStage(stage);
  } catch (e: any) {
    // NOT `minor = false`. A failed read tells us nothing about this person's age band, and the one
    // wrong guess here puts a child in a public conversation their guardian never agreed to.
    logEvent('error', 'aquintutor.discussion.stage-lookup-failed', { userId: String(userId), message: reasonOf(e) });
    return CANNOT_TELL;
  }
  if (!minor) return { ok: true };
  let consented = false;
  try {
    const p = await getProfile(userId);
    consented = !!p?.consent?.community;
  } catch (e: any) {
    logEvent('error', 'aquintutor.discussion.consent-lookup-failed', { userId: String(userId), message: reasonOf(e) });
    return CANNOT_TELL;
  }
  return canParticipate(true, consented) ? { ok: true } : NEEDS_CONSENT;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  const { featureEnabled } = await import('@/lib/observability');
  if (!(await featureEnabled('community'))) return j({ ok: false, error: 'the discussion feature is currently disabled' }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  // report is allowed for everyone; posting/creating requires participation rights
  if (b.action !== 'report') {
    const part = await participationOk(user.id);
    if (!part.ok) return j({ ok: false, error: part.error }, part.status);
  }
  try {
    if (b.action === 'newThread') { if (!b.title) return j({ ok: false, error: 'title required' }, 400); const id = await createThread(b.scope === 'course' || b.scope === 'ko' ? b.scope : 'general', b.scopeId || null, String(b.title), user.id); if (b.body) await createPost(id, user.id, String(b.body), null); return j({ ok: true, id }); }
    if (b.action === 'post') { if (!b.threadId || !b.body) return j({ ok: false, error: 'threadId + body required' }, 400); const id = await createPost(String(b.threadId), user.id, String(b.body), b.parentId || null); return j({ ok: true, id }); }
    if (b.action === 'report') { if (!b.postId) return j({ ok: false, error: 'postId required' }, 400); await reportPost(String(b.postId), user.id, String(b.reason || '')); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    // It used to answer 200 with the raw Postgres message in `error`. Two faults in one line: a
    // failure that reports HTTP success is invisible to every log, monitor and retry rule that reads
    // the status, and the database's own words describe this schema to whoever asked — here, to a
    // student. The reason goes to the log; the caller gets a sentence and a status that is true.
    logEvent('error', 'aquintutor.discussion.failed', {
      userId: String(user.id), action: String(b?.action || ''), message: reasonOf(e),
    });
    return j({ ok: false, error: 'That could not be saved just now. Nothing has been lost — please try again.' }, 500);
  }
};
