// POST /api/mail/draft - save or delete a draft.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deliverMessage, parseAddressList, getMailboxAddress } from '@/lib/mail';
import { describeLinkList } from '@/lib/mail-links';
import { denyMailApi } from '@/lib/auth/mail-access';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// e.message is only the failed SQL — the reason is on e.cause. Declared above the handler.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  // Same surface, same gate as send.ts: the only callers are the composers on /admin/mail and
  // /portal/employee/mail, and a draft is a message one click away from leaving the building.
  // Sign-in alone was not an answer, and neither is "may you open the admin console" — see
  // src/lib/auth/mail-access.ts.
  const denied = await denyMailApi(locals, { label: 'mail.draft' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  try {
    // THE SECOND DELETE USED TO NAME NO OWNER.
    //
    //     DELETE FROM mail_messages WHERE id = <draftId> AND is_draft = true
    //
    // The mail_box delete above it is scoped to `user_id = <caller>`; this one was not, and
    // mail_box.message_id REFERENCES mail_messages(id) ON DELETE CASCADE (src/lib/mail.ts), so the
    // unscoped statement destroyed the message row AND every mailbox row pointing at it. Any account
    // that clears denyMailApi() could therefore delete ANOTHER person's unsent draft by posting its
    // id — the mailbox delete would match nothing, and the message delete would still fire. Both
    // statements now name the same owner, so a draft id belonging to somebody else matches zero rows
    // in both and the request is a no-op rather than a deletion.
    //
    // from_user_id is what deliverMessage() writes as the author of a draft, and it is the same
    // column /api/mail/send's cleanup path is being narrowed against below.
    if (body.action === 'delete') {
      if (!body.draftId) return json({ ok: false, error: 'draftId required' }, 400);
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true AND from_user_id = ${user.id}`);
      return json({ ok: true });
    }

    // Replace existing draft (simplest: delete old, create new)
    if (body.draftId) {
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true AND from_user_id = ${user.id}`);
    }

    const fromEmail = await getMailboxAddress(user.id);
    const fromName = user.name || fromEmail;
    let bodyText = (body.bodyText ?? body.body ?? '').toString();
    let bodyHtml = (body.bodyHtml || '').toString();
    if (!bodyHtml) bodyHtml = '<div>' + escapeHtml(bodyText).replace(/\n/g, '<br/>') + '</div>';

    const result = await deliverMessage({
      fromUserId: user.id, fromEmail, fromName,
      to: parseAddressList(body.to), cc: parseAddressList(body.cc), bcc: parseAddressList(body.bcc),
      subject: (body.subject || '').toString().slice(0, 500),
      bodyHtml, bodyText,
      threadId: body.threadId || null,
      asDraft: true,
    });
    return json({ ok: true, draftId: result.messageId, threadId: result.threadId });
  } catch (e: any) {
    // reasonOf, not e.message: e.message is only the failed SQL and the composer prints this string.
    console.error('[api/mail/draft] draft failed:', reasonOf(e));
    return json({ ok: false, error: 'This draft was NOT saved: ' + reasonOf(e) }, 500);
  }
};
