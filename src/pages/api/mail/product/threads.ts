// GET /api/mail/product/threads — one page of the mailbox, for the /mail product surface.
//
// WHY A SEPARATE ENDPOINT AND NOT A CHANGE TO AN EXISTING ONE. /api/mail/{send,draft,action} are the
// three WRITE endpoints the composer calls and they are shared with /admin/mail. This is a READ, it
// is new, and it lives under /product/ so the mail infrastructure work happening in parallel on the
// existing routes and this product surface cannot collide in the same file.
//
// SAME GATE AS ITS SIBLINGS. denyMailApi() — "may you use the company mailbox" — asked on the first
// line, before the query string is read and before any statement runs. A query that ran for an
// unauthorised principal has already happened whatever the response says.
import type { APIRoute } from 'astro';
import { listFolder, getFolderCounts, getUserLabels, getMailboxAddress, type Folder } from '@/lib/mail';
import { denyMailApi } from '@/lib/auth/mail-access';
import { json, fail, reasonOf, clampInt } from '@/lib/mail-product/common';

const FOLDERS = new Set<string>(['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam']);

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.threads' });
  if (denied) return denied;
  const user = (locals as any).user;

  const url = new URL(request.url);
  const raw = url.searchParams.get('folder') || 'inbox';
  const starred = raw === 'starred';
  const folder = (starred || !FOLDERS.has(raw) ? 'inbox' : raw) as Folder;
  const q = (url.searchParams.get('q') || '').slice(0, 300);
  const label = url.searchParams.get('label');
  const before = url.searchParams.get('before');
  const limit = clampInt(url.searchParams.get('limit'), 10, 100, 40);

  try {
    const listing = await listFolder(user.id, { folder, starred, label, query: q, limit: limit + 1, before });
    const rows = listing.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    // The cursor is the last row's timestamp. A page that came back full is assumed to have more —
    // the next request returning zero rows is how "the end" is discovered, which costs one empty
    // request and never shows a "load more" that silently does nothing.
    const nextBefore = listing.rows.length > limit && last ? new Date(last.created_at).toISOString() : null;

    // Counts and labels are only sent on the FIRST page. Re-sending them on every scroll is three
    // extra aggregates per page for data the client already has.
    const first = !before;
    return json({
      ok: true,
      rows,
      nextBefore,
      scopeLabel: listing.scopeLabel,
      filtered: listing.filtered,
      queryNote: listing.query?.active ? listing.query.describe : '',
      counts: first ? await getFolderCounts(user.id).catch(() => ({})) : undefined,
      labels: first ? await getUserLabels(user.id).catch(() => []) : undefined,
      address: first ? await getMailboxAddress(user.id).catch(() => '') : undefined,
    });
  } catch (e: any) {
    // The reason is on e.cause; e.message is only the failed SQL. Logged in full, and the caller is
    // told the list could not be READ — which is not the same statement as "you have no mail".
    console.error('[api/mail/product/threads] listing failed:', reasonOf(e));
    return fail('Your mail could not be loaded just now, so this list is empty for a reason that is not "no messages". Nothing has changed in your mailbox.', 500);
  }
};
