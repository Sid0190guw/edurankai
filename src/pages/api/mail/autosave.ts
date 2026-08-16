// POST /api/mail/autosave — the versioned draft save the composer calls while somebody types.
//
// WHY THIS IS NOT /api/mail/draft. That endpoint saves by DELETE-then-INSERT, which has a window in
// it where the draft does not exist; if anything fails in that window the message is gone, and the
// window is widest exactly when the person has written the most. It is left in place because other
// things call it, and this is the path the advanced composer uses. See src/lib/mail-drafts.ts.
//
// EVERY SAVE CARRIES THE VERSION IT WAS BASED ON. A save built on a version that has since moved is
// REFUSED and comes back as a conflict WITH THE SERVER'S COPY attached, so the composer can show
// both. Nothing is merged: two people's sentences interleaved by a machine is a draft neither of
// them wrote.
//
// ACTIONS
//   (default)                save; returns { draft, unchanged } or { conflict, server }
//   {action:'get'}           load one draft
//   {action:'list'}          unsent drafts — crash recovery
//   {action:'revisions'}     the kept history of one draft
//   {action:'restore'}       put a revision back as a NEW version
//   {action:'discard'}       throw it away
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import {
  saveDraft, getDraft, listRecoverableDrafts, listRevisions, restoreRevision, discardDraft,
  ensureDraftSchema, type SaveDraftInput,
} from '@/lib/mail-drafts';
import { validateOutgoingAttachment } from '@/lib/mail-attachments';

// Declared above the handler that reads them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  // The same gate as its two siblings: a draft is one click away from leaving the building.
  const denied = await denyMailApi(locals, { label: 'mail.autosave' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  try {
    await ensureMailSchema();
    await ensureDraftSchema();

    switch (String(body.action || 'save')) {
      case 'get': {
        const d = await getDraft(user.id, String(body.draftId || ''));
        return d ? json({ ok: true, draft: d }) : json({ ok: false, error: 'That draft is no longer here.' }, 404);
      }
      case 'list': {
        const drafts = await listRecoverableDrafts(user.id);
        return json({
          ok: true,
          // An empty draft is listed separately so the recovery prompt does not offer to restore a
          // blank composer somebody opened and closed.
          drafts: drafts.filter((d) => !d.isEmpty),
          empties: drafts.filter((d) => d.isEmpty).length,
        });
      }
      case 'revisions':
        return json({ ok: true, revisions: await listRevisions(user.id, String(body.draftId || '')) });
      case 'restore': {
        const r = await restoreRevision(user.id, String(body.draftId || ''), Number(body.version));
        return json(r, r.ok ? 200 : 400);
      }
      case 'discard': {
        const r = await discardDraft(user.id, String(body.draftId || ''));
        return json(r, r.ok ? 200 : 400);
      }
      case 'save':
      default: {
        // Attachments are checked HERE rather than at send time as well as at send time: a draft
        // that quietly holds a link this mailbox will refuse to send is a message somebody writes
        // and then cannot post.
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        for (const a of attachments) {
          const v = validateOutgoingAttachment({ filename: a?.filename, url: a?.url, sizeBytes: a?.size });
          if (!v.ok) return json({ ok: false, error: v.error }, 400);
        }

        const input: SaveDraftInput = {
          draftId: body.draftId || null,
          baseVersion: body.version == null ? null : Number(body.version),
          threadId: body.threadId || null,
          inReplyTo: body.inReplyTo || null,
          to: String(body.to || ''),
          cc: String(body.cc || ''),
          bcc: String(body.bcc || ''),
          subject: String(body.subject || ''),
          bodyText: String(body.bodyText ?? body.body ?? ''),
          bodyHtml: String(body.bodyHtml || ''),
          attachments,
          clientId: body.clientId || null,
        };
        const r = await saveDraft(user.id, input);
        if (r.ok) return json({ ok: true, draft: r.draft, unchanged: r.unchanged, savedAt: r.draft.updatedAt });
        if (r.conflict) return json({ ok: false, conflict: true, server: r.server, message: r.message }, 409);
        return json({ ok: false, conflict: false, message: r.message, error: r.message }, 400);
      }
    }
  } catch (e: any) {
    // The composer prints this string, so it says the reason and it says the draft was not saved.
    console.error('[api/mail/autosave] failed:', reasonOf(e));
    return json({ ok: false, message: 'This draft was NOT saved: ' + reasonOf(e), error: reasonOf(e) }, 500);
  }
};
