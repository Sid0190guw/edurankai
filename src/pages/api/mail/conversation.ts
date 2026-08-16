// GET /api/mail/conversation?thread=<id> — one conversation, threaded, with quoting split out.
//
// WHAT THE READING PANE GETS FROM THIS THAT IT COULD NOT GET BEFORE:
//
//   - THE TREE. getThreadMessages() returns a flat list in date order. A reply-all to an older
//     message in a long exchange belongs UNDER that message, not at the bottom, and
//     assembleConversation() (src/lib/mail-threading.ts) works that out from In-Reply-To and
//     References.
//   - WHAT IS NEW AND WHAT IS A REPEAT. splitQuoted() separates the sentence somebody wrote from
//     the three screens of history their client stapled underneath it, so "show quoted text" can
//     exist at all.
//   - WHICH MESSAGES START OPEN. summarizeConversation() decides once — latest, unread, drafts —
//     rather than every surface inventing its own rule.
//   - ATTACHMENT HANDLING PER FILE, from src/lib/mail-attachments.ts, so the client never decides
//     for itself whether something is safe to render.
//
// It reads through getThreadMessages(), which is already scoped to `mail_box.user_id = <caller>`:
// a thread id belonging to somebody else's mailbox returns nothing rather than somebody else's mail.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { getThreadMessages, markThreadRead, ensureMailSchema } from '@/lib/mail';
import {
  assembleConversation, flattenConversation, summarizeConversation, splitQuoted,
  participantLine, ensureThreadingSchema,
} from '@/lib/mail-threading';
import { classifyAttachment } from '@/lib/mail-attachments';

// Declared above the handler that reads them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripTags(s: string): string {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.conversation' });
  if (denied) return denied;
  const user = (locals as any).user;

  const url = new URL(request.url);
  const threadId = String(url.searchParams.get('thread') || '');
  if (!UUID_RE.test(threadId)) return json({ ok: false, error: 'thread must be a conversation id' }, 400);
  const markRead = url.searchParams.get('read') !== '0';
  const selfHost = url.hostname;

  try {
    await ensureMailSchema();
    await ensureThreadingSchema();
    const messages = await getThreadMessages(user.id, threadId);
    if (!messages.length) {
      // An empty conversation and an unreadable one are different answers and must not render the
      // same. This one is genuinely empty for this mailbox.
      return json({ ok: true, empty: true, messages: [], summary: null, message: 'There is nothing in this conversation in your mailbox.' });
    }

    const roots = assembleConversation(messages as any[]);
    const ordered = flattenConversation(roots);
    const summary = summarizeConversation(messages as any[]);

    const payload = ordered.map((node) => {
      const m: any = node.message;
      const text = m.body_text || stripTags(m.body_html);
      const split = splitQuoted(text);
      return {
        id: m.id,
        depth: node.depth,
        via: node.via,
        subject: m.subject || '',
        fromName: m.from_name || '',
        fromEmail: m.from_email || '',
        fromUserId: m.from_user_id || null,
        createdAt: new Date(m.created_at).toISOString(),
        isRead: !!m.is_read,
        isDraft: !!m.is_draft,
        folder: m.folder,
        labels: m.labels || [],
        recipients: m.recipients || [],
        // The three parts of a message body, separated once here so no client has to guess.
        visible: split.visible,
        quoted: split.quoted,
        quotedMarker: split.marker,
        signature: split.signature,
        hasQuoted: !!split.quoted,
        attachments: (m.attachments || []).map((a: any) => {
          const v = classifyAttachment(
            { filename: a.filename, url: a.url, mime: a.mime, sizeBytes: a.size_bytes },
            selfHost,
          );
          return {
            name: v.safeName, originalName: v.originalName, url: a.url,
            kind: v.kind, preview: v.preview, mime: v.effectiveMime,
            size: v.displaySize, warning: v.warning, reason: v.reason,
          };
        }),
        reads: m.reads || [],
        delivery: m.delivery || null,
        expanded: summary.expandedIds.includes(m.id),
      };
    });

    // Marking read happens AFTER the read succeeded. Doing it first would clear the unread flag on a
    // conversation the person was never shown.
    if (markRead) {
      try { await markThreadRead(user.id, threadId); } catch (e: any) {
        console.error('[api/mail/conversation] mark-read failed:', reasonOf(e));
      }
    }

    return json({
      ok: true,
      empty: false,
      threadId,
      messages: payload,
      summary: {
        subject: summary.subject,
        messageCount: summary.messageCount,
        unreadCount: summary.unreadCount,
        draftCount: summary.draftCount,
        attachmentCount: summary.attachmentCount,
        latestActivity: summary.latestActivity,
        participants: summary.participants,
        participantLine: participantLine(summary.participants),
        expandedIds: summary.expandedIds,
      },
    });
  } catch (e: any) {
    // NOT rendered as an empty conversation. e.cause carries the real Postgres reason.
    console.error('[api/mail/conversation] failed:', reasonOf(e));
    return json({ ok: false, error: 'This conversation could not be read: ' + reasonOf(e) }, 500);
  }
};
