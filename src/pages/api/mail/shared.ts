// GET/POST /api/mail/shared — the team workflow API for a shared mailbox.
//
// GET  ?mailbox=&queue=&limit=&offset=   one queue, with counts for the rail
// GET  ?mailbox=&thread=                 one conversation's state, notes and activity
// POST {action:'assign'|'status'|'note'|'member'|'create'}
//
// EVERY ARM CHECKS MEMBERSHIP INSIDE src/lib/mail-shared.ts, not here. That is deliberate: a guard
// written in the route is a guard the next route forgets. requireSharedAccess() runs at the top of
// every function this file calls, so a second caller of those functions cannot skip it.
//
// denyMailApi() still runs first, because holding a company mailbox at all is the precondition —
// membership of a shared mailbox is the second question, not the first.
//
// INTERNAL NOTES ARE READ AND WRITTEN HERE AND GO NOWHERE ELSE. There is no arm on this route that
// sends anything; /api/mail/send is a different endpoint that does not import mail-shared.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import {
  listMySharedMailboxes, listSharedQueue, queueCounts, requireSharedAccess,
  assignThread, setThreadStatus, addNote, listNotes, threadActivity,
  createSharedMailbox, setMember, listMembers, getThreadState,
  SHARED_QUEUES, type SharedQueue, type SharedStatus, type SharedRole,
} from '@/lib/mail-shared';

// Declared above the handlers that read them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const QUEUE_KEYS = SHARED_QUEUES.map((q) => q.key);

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.shared' });
  if (denied) return denied;
  const user = (locals as any).user;
  const url = new URL(request.url);
  const mailboxId = url.searchParams.get('mailbox');

  try {
    await ensureMailSchema();

    // No mailbox named: the rail. Which shared mailboxes may this person open at all.
    if (!mailboxId) {
      return json({ ok: true, mailboxes: await listMySharedMailboxes(user.id), queues: SHARED_QUEUES });
    }

    const access = await requireSharedAccess(user.id, mailboxId);
    if (!access.allowed || !access.mailbox) return json({ ok: false, error: access.denial }, 403);

    // One conversation's overlay: state, notes, activity.
    const threadId = url.searchParams.get('thread');
    if (threadId) {
      const [state, notes, activity] = await Promise.all([
        getThreadState(mailboxId, threadId),
        listNotes(user.id, mailboxId, threadId),
        threadActivity(user.id, mailboxId, threadId),
      ]);
      return json({
        ok: true,
        role: access.role,
        state: state || { mailboxId, threadId, status: 'unassigned', assigneeUserId: null, assigneeName: null, resolution: null, resolvedAt: null, resolvedByUserId: null, noteCount: 0, updatedAt: new Date().toISOString() },
        notes: notes.notes,
        notesError: notes.error || null,
        activity,
        members: await listMembers(user.id, mailboxId),
      });
    }

    const queueParam = String(url.searchParams.get('queue') || 'unassigned');
    const queue = (QUEUE_KEYS.includes(queueParam as SharedQueue) ? queueParam : 'unassigned') as SharedQueue;
    const [listing, counts] = await Promise.all([
      listSharedQueue({
        userId: user.id, mailboxId, queue,
        limit: Number(url.searchParams.get('limit')) || 50,
        offset: Number(url.searchParams.get('offset')) || 0,
        search: url.searchParams.get('q') || '',
      }),
      queueCounts(mailboxId, access.mailbox.ownerUserId, user.id),
    ]);
    if (listing.error) return json({ ok: false, error: listing.error }, 500);
    return json({
      ok: true,
      mailbox: access.mailbox,
      role: access.role,
      queue,
      queues: SHARED_QUEUES,
      counts,
      rows: listing.rows,
      total: listing.total,
    });
  } catch (e: any) {
    console.error('[api/mail/shared] read failed:', reasonOf(e));
    return json({ ok: false, error: 'That could not be read: ' + reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.shared.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action || '');
  const mailboxId = String(body.mailboxId || '');

  try {
    await ensureMailSchema();
    switch (action) {
      case 'create': {
        // Creating a shared mailbox is an administrative act over the whole company mailbox, so it
        // asks the capability rather than membership — there is no membership to check yet.
        const { holdsCapability } = await import('@/lib/auth/capability');
        if (!holdsCapability(user, 'mail.manage')) {
          return json({ ok: false, error: 'Creating a shared mailbox needs mail permissions.' }, 403);
        }
        const r = await createSharedMailbox({ actorUserId: user.id, address: String(body.address || ''), name: String(body.name || '') });
        return json(r, r.ok ? 200 : 400);
      }
      case 'assign': {
        const r = await assignThread({
          userId: user.id, mailboxId,
          threadId: String(body.threadId || ''),
          assigneeUserId: body.assigneeUserId === null || body.assigneeUserId === '' ? null : String(body.assigneeUserId),
        });
        return json(r, r.ok ? 200 : 400);
      }
      case 'claim': {
        // The one-click "I will take this". Same path as assign, so there is one rule about what
        // taking work does to a pending or resolved conversation.
        const r = await assignThread({ userId: user.id, mailboxId, threadId: String(body.threadId || ''), assigneeUserId: user.id });
        return json(r, r.ok ? 200 : 400);
      }
      case 'status': {
        const r = await setThreadStatus({
          userId: user.id, mailboxId,
          threadId: String(body.threadId || ''),
          status: String(body.status || '') as SharedStatus,
          resolution: String(body.resolution || ''),
        });
        return json(r, r.ok ? 200 : 400);
      }
      case 'note': {
        const r = await addNote({ userId: user.id, mailboxId, threadId: String(body.threadId || ''), body: String(body.body || '') });
        return json(r, r.ok ? 200 : 400);
      }
      case 'member': {
        const r = await setMember({
          actorUserId: user.id, mailboxId,
          userId: String(body.userId || ''),
          role: String(body.role || '') as SharedRole | 'remove',
        });
        return json(r, r.ok ? 200 : 400);
      }
      default:
        return json({ ok: false, error: 'That is not something this endpoint does.' }, 400);
    }
  } catch (e: any) {
    console.error('[api/mail/shared] ' + action + ' failed:', reasonOf(e));
    return json({ ok: false, message: 'That did not go through, and nothing was changed.', error: reasonOf(e) }, 500);
  }
};
