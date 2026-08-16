// GET/POST /api/mail/snooze — put a conversation away until a time, and bring it back.
//
// THREE JOBS, ONE ROUTE:
//   GET                      the preset menu (computed server-side, in the mailbox's own zone) and
//                            the list of what is currently snoozed.
//   POST {threadIds, until}  snooze, through the same bulk path as every other mailbox operation.
//   POST {action:'wake'}     the server sweep, for cron. CRON_SECRET or an authorised session.
//
// THE SWEEP IS NOT THE BROWSER'S JOB, and that is the reason this endpoint has a cron arm at all. A
// snooze that only ends when somebody happens to have the tab open is a promise the product cannot
// keep — see the note at the top of src/lib/mail-snooze.ts.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import { snoozePresets, validateSnoozeTime, listSnoozed, wakeDueSnoozed } from '@/lib/mail-snooze';
import { applyBulk } from '@/lib/mail-bulk';
import { cronAuth } from '@/lib/auth/cron-auth';

// Declared above the handlers that read them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.snooze' });
  if (denied) return denied;
  const user = (locals as any).user;
  try {
    await ensureMailSchema();
    return json({
      ok: true,
      presets: snoozePresets().map((p) => ({ key: p.key, label: p.label, when: p.when, at: p.at ? p.at.toISOString() : null })),
      snoozed: await listSnoozed(user.id),
    });
  } catch (e: any) {
    console.error('[api/mail/snooze] read failed:', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }

  // ---- The cron arm. Checked BEFORE the session gate so a scheduler with no cookie gets in, and
  //      only for this one action — nothing else on this route is reachable with a secret.
  if (body?.action === 'wake' || new URL(request.url).searchParams.get('action') === 'wake') {
    // cronAuth() is SYNCHRONOUS and returns a verdict object, not a boolean — `await cronAuth(...)`
    // on an object is truthy whatever it says, which would have admitted every anonymous caller.
    const cron = cronAuth(request, new URL(request.url));
    const denied = cron.allowed ? null : await denyMailApi(locals, { label: 'mail.snooze.wake' });
    if (denied) return denied;
    const res = await wakeDueSnoozed(Number(body?.limit) || 500);
    if (res.error) return json({ ok: false, ...res }, 500);
    return json({
      ok: true, ...res,
      message: res.woken === 0
        ? 'Nothing was due.'
        : res.woken + ' snoozed ' + (res.woken === 1 ? 'message' : 'messages') + ' came back to the inbox.'
          + (res.more ? ' There are more; the next run will continue.' : ''),
    });
  }

  const denied = await denyMailApi(locals, { label: 'mail.snooze' });
  if (denied) return denied;
  const user = (locals as any).user;

  const threadIds: string[] = ([] as string[])
    .concat(body.threadId ? [String(body.threadId)] : [])
    .concat(Array.isArray(body.threadIds) ? body.threadIds.map(String) : []);
  if (!threadIds.length) return json({ ok: false, error: 'No conversation was given.' }, 400);

  try {
    await ensureMailSchema();

    if (body.action === 'unsnooze') {
      const r = await applyBulk(user.id, { op: 'unsnooze', selection: { mode: 'ids', threadIds } });
      return json(r, r.ok ? 200 : 500);
    }

    // A preset key resolves on the SERVER. Letting the browser compute "tomorrow at 8" means a
    // machine with the wrong clock or the wrong zone silently snoozes to the wrong instant.
    let until = String(body.until || '');
    if (body.preset) {
      const p = snoozePresets().find((x) => x.key === body.preset);
      if (!p || !p.at) return json({ ok: false, error: 'That is not a snooze option right now.' }, 400);
      until = p.at.toISOString();
    }
    const check = validateSnoozeTime(until);
    if (!check.ok) return json({ ok: false, error: check.error }, 400);

    const r = await applyBulk(user.id, { op: 'snooze', selection: { mode: 'ids', threadIds }, until: check.at.toISOString() });
    if (!r.ok) return json(r, 500);
    return json({
      ...r,
      until: check.at.toISOString(),
      message: r.threads + (r.threads === 1 ? ' conversation' : ' conversations') + ' snoozed until '
        + check.at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        + '. It will come back to your inbox marked unread.',
    });
  } catch (e: any) {
    console.error('[api/mail/snooze] failed:', reasonOf(e));
    return json({ ok: false, error: 'That did not go through, and your mail is unchanged.' }, 500);
  }
};
