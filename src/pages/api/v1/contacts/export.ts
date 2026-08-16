// GET /api/v1/contacts/export?format=csv|json — the contact book, over the API.
//
// The third leg of section 7, and the one that did not exist: the admin screen can already export a
// CSV, and this is the same rows through the same filter for a caller with an API key instead of a
// session.
//
// FORMAT IS THE ONLY DIFFERENCE BETWEEN THE TWO OUTPUTS. Both come from exportRows() with the same
// query, so a CSV and a JSON export of the same filter contain the same contacts with the same
// values — which is not true the moment somebody writes a second query for the JSON path.
//
// Scope: `email.read`. A contact book is a list of people who can be mailed; reading it is a
// meaningful power and it is not bundled into the publish scope.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { exportColumns, exportRows } from '@/lib/mail-contacts';
import { toCsv } from '@/lib/mail-csv';

export const OPTIONS = PREFLIGHT;

/** A ceiling, so a mistyped filter cannot pull the whole book into one response. */
const CAP = 50_000;

export const GET: APIRoute = apiRoute({ endpoint: 'contacts.export', scope: 'email.read' }, async (ctx) => {
  const q = ctx.url.searchParams;
  const format = (q.get('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    throw new ApiError('invalid_request', '`format` must be csv or json.', { param: 'format' });
  }
  const limit = Math.max(1, Math.min(CAP, Number(q.get('limit')) || CAP));

  const rowsOut = await exportRows(
    {
      q: q.get('q') || undefined,
      status: (q.get('status') as any) || undefined,
      tag: q.get('tag') || undefined,
      listId: q.get('list_id') || undefined,
      orderBy: 'created_at',
      direction: 'desc',
    },
    limit,
  );

  if (format === 'json') {
    return ctx.json({
      object: 'list',
      count: rowsOut.length,
      truncated: rowsOut.length >= limit,
      data: rowsOut,
    });
  }

  const csv = toCsv(rowsOut, exportColumns(rowsOut));
  // Not ctx.json(): the rate-limit headers still ride along, but the body is a file the caller can
  // pipe straight into a spreadsheet or another system's importer.
  return new Response(csv, {
    status: 200,
    headers: {
      ...ctx.headers,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="contacts-' + new Date().toISOString().slice(0, 10) + '.csv"',
      'Cache-Control': 'no-store',
      // Stated in a header as well as in the JSON shape, because a CSV has nowhere else to say it.
      'X-Contact-Count': String(rowsOut.length),
    },
  });
});
