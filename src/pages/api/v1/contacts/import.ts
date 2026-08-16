// POST /api/v1/contacts/import — CSV or JSON, over the API, with a dry run.
//
// Section 7 of the brief asks for CSV, JSON and API. Two of the three already existed: the CSV
// planner is src/lib/mail-csv.ts and the committer is src/lib/mail-contacts.ts, both reached from
// the admin screen at /admin/mail/contacts. What was missing is the third — a way for another
// system to do the same thing without a browser and a session cookie.
//
// SO NOTHING IS REIMPLEMENTED HERE. The same planner, the same commit, the same rules: an existing
// contact keeps every value it has and the import only fills blanks; a suppressed address is
// imported but NEVER re-subscribed, and is counted separately so the caller can see how many of
// their rows will not be mailed and why.
//
// JSON IS TURNED INTO CSV AND RUN THROUGH THE SAME PLANNER. A second validator for the JSON path
// would mean two answers to "is this a usable address", and the one that gets fixed is never the one
// that is running.
//
// `dry_run: true` IS THE DEFAULT FOR A REASON. There is no undo on a contact book. A caller that
// means it says so.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { planImport, toCsv } from '@/lib/mail-csv';
import { commitImport } from '@/lib/mail-contacts';

export const OPTIONS = PREFLIGHT;

/** Two megabytes of CSV is roughly 25,000 contacts; larger imports come in slices. */
const MAX_KB = 2048;

/** Flatten JSON records into the CSV the planner reads. Keys become headers, in first-seen order. */
export function recordsToCsv(records: any[]): string {
  const columns: string[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  }
  if (!columns.length) return '';
  const table = records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of columns) {
      const v = (r || {})[k];
      out[k] = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    }
    return out;
  });
  return toCsv(table, columns);
}

export const POST: APIRoute = apiRoute({ endpoint: 'contacts.import', scope: 'email.send' }, async (ctx) => {
  const body = await readJsonBody(ctx.request, MAX_KB * 1024);

  const csv = typeof body.csv === 'string' ? body.csv : (Array.isArray(body.contacts) ? recordsToCsv(body.contacts) : '');
  if (!csv.trim()) {
    throw new ApiError('invalid_request', 'Send either `csv` as a string or `contacts` as an array of objects.', { param: 'csv' });
  }

  let plan;
  try {
    plan = planImport(csv, Array.isArray(body.mapping) ? body.mapping : undefined);
  } catch (e: any) {
    throw new ApiError('invalid_request', 'The data could not be read: ' + String(e?.message || e).slice(0, 200));
  }

  const dryRun = body.dry_run !== false;
  const summary: Record<string, unknown> = {
    object: 'contact_import',
    dry_run: dryRun,
    environment: ctx.auth.environment,
    total_rows: plan.totalRows,
    valid: plan.valid.length,
    invalid: plan.invalid.map((r: any) => ({ line: r.line, errors: r.errors })),
    duplicates_in_file: plan.duplicatesInFile.length,
    // The column mapping is returned on the dry run so a caller can SEE what was matched to what
    // before anything is written, and correct it with `mapping` on the real call.
    mapping: plan.mapping,
    warnings: plan.warnings,
    ragged_rows: plan.ragged,
  };

  if (dryRun) {
    return ctx.json({ ...summary, note: 'Nothing was written. Send `dry_run: false` to commit this exact plan.' });
  }
  if (!plan.valid.length) {
    throw new ApiError('invalid_request', 'No valid rows to import. ' + plan.invalid.length + ' row(s) were rejected; see `invalid`.', { extra: { invalid: summary.invalid } });
  }

  const outcome = await commitImport(plan.valid, {
    listId: body.list_id ? String(body.list_id) : null,
    consentSource: String(body.consent_source || ('api:' + ctx.auth.orgSlug)),
    actor: { userId: null, name: 'API key ' + ctx.auth.keyId.slice(0, 8) },
  });

  return ctx.json({
    ...summary,
    created: outcome.created,
    updated: outcome.updated,
    // Named plainly rather than folded into "skipped": these people asked not to be mailed, and the
    // caller is entitled to know the number is not an error.
    skipped_suppressed: outcome.skippedSuppressed,
    failed: outcome.failed,
    list_id: outcome.listId,
  }, 201);
});
