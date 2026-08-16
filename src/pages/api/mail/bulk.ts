// POST /api/mail/bulk — one operation applied to a selection, on the server.
//
// THIS IS THE ENDPOINT THAT MAKES "SELECT ALL 8,412 RESULTS" POSSIBLE. /api/mail/action.ts takes
// thread ids and is right for a handful; this takes either ids OR THE QUERY ITSELF, so the browser
// never has to learn — or post — the ids of everything it is acting on. See src/lib/mail-bulk.ts.
//
// TWO MODES, ONE GATE. `preview` counts what a selection covers and changes nothing; the default
// applies the operation. Both run behind denyMailApi() on the first line, before the body is read.
//
// The response ALWAYS carries a sentence for the person. "142 conversations archived" is checkable;
// "ok: true" is not, and a bulk operation that silently did nothing is the failure this whole path
// was built to make impossible.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import { applyBulk, previewBulk, validateBulk, MAX_BULK_THREADS, type BulkRequest, type BulkSelection } from '@/lib/mail-bulk';

// Declared above the handler that reads them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function selectionFrom(body: any): BulkSelection | null {
  const sel = body?.selection;
  if (!sel) {
    // The short form the composer's checkboxes post.
    if (Array.isArray(body?.threadIds)) return { mode: 'ids', threadIds: body.threadIds.map(String) };
    return null;
  }
  if (sel.mode === 'ids') return { mode: 'ids', threadIds: (sel.threadIds || []).map(String) };
  if (sel.mode === 'query') {
    return {
      mode: 'query',
      query: String(sel.query || ''),
      scope: {
        folder: sel.scope?.folder ? String(sel.scope.folder) : null,
        label: sel.scope?.label ? String(sel.scope.label) : null,
        starred: !!sel.scope?.starred,
      },
      exclude: Array.isArray(sel.exclude) ? sel.exclude.map(String) : [],
    };
  }
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.bulk' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const selection = selectionFrom(body);
  if (!selection) return json({ ok: false, error: 'No selection was given.' }, 400);

  try {
    await ensureMailSchema();

    // ---- Count only. Nothing is written. -------------------------------------------------------
    if (body.preview) {
      const p = await previewBulk(user.id, selection);
      if (p.error) return json({ ok: false, error: p.error }, 500);
      return json({
        ok: true,
        threads: p.threads,
        capped: p.capped,
        cap: MAX_BULK_THREADS,
        describe: p.query?.describe || '',
        message: p.threads === 0
          ? 'Nothing matches that selection.'
          : (p.capped
            ? 'At least ' + MAX_BULK_THREADS.toLocaleString('en-IN') + ' conversations match. One operation applies to that many at a time.'
            : p.threads.toLocaleString('en-IN') + (p.threads === 1 ? ' conversation' : ' conversations') + ' match.'),
      });
    }

    // ---- Apply. ---------------------------------------------------------------------------------
    const req: BulkRequest = {
      op: String(body.op || '') as BulkRequest['op'],
      selection,
      folder: body.folder ? String(body.folder) : undefined,
      label: body.label ? String(body.label) : undefined,
      until: body.until ? String(body.until) : undefined,
    };
    const invalid = validateBulk(req);
    if (invalid) return json({ ok: false, error: invalid, message: invalid }, 400);

    const result = await applyBulk(user.id, req);
    return json(result, result.ok ? 200 : 500);
  } catch (e: any) {
    console.error('[api/mail/bulk] failed:', reasonOf(e));
    return json({ ok: false, message: 'That did not go through, and your mail is unchanged.', error: reasonOf(e) }, 500);
  }
};
