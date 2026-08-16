// GET /api/mail/contacts-export — the contacts you can see, as a CSV file.
//
// EXPORTS WHAT THE SCREEN SHOWS. It takes the same query parameters as /admin/mail/contacts, so
// "export" always means "these contacts", never "some other set the export code decided on". A
// segment can be posted as JSON in `segment` for the filter that has not been saved yet.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { exportRows, exportColumns, isUuid, dbReason } from '@/lib/mail-contacts';
import { toCsv } from '@/lib/mail-csv';
import { segmentErrors, type SegmentNode } from '@/lib/mail-segments';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/** A hard ceiling so a mistyped filter cannot pull the whole book into one response. */
const CAP = 50000;

export const GET: APIRoute = async ({ url, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.contacts.export' });
  if (denied) return denied;

  let segment: SegmentNode | null = null;
  const raw = url.searchParams.get('segment');
  if (raw) {
    try {
      segment = JSON.parse(raw);
      const errs = segmentErrors(segment as SegmentNode);
      if (errs.length) return json({ ok: false, error: errs.join(' ') }, 400);
    } catch {
      return json({ ok: false, error: 'That segment could not be read.' }, 400);
    }
  }

  try {
    const rows = await exportRows({
      q: url.searchParams.get('q') || '',
      status: (url.searchParams.get('status') as any) || 'any',
      tag: url.searchParams.get('tag') || undefined,
      listId: isUuid(url.searchParams.get('list') || '') ? String(url.searchParams.get('list')) : undefined,
      segment,
    }, CAP);

    const csv = toCsv(rows, exportColumns(rows));
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="contacts-' + stamp + '.csv"',
        'cache-control': 'no-store',
        // Named so a truncated export is never mistaken for a complete one.
        'X-Export-Rows': String(rows.length),
        'X-Export-Truncated': rows.length >= CAP ? 'yes' : 'no',
      },
    });
  } catch (e: any) {
    console.error('[api/mail/contacts-export]', dbReason(e));
    return json({ ok: false, error: 'The export did not run: ' + dbReason(e) }, 500);
  }
};
