// POST /api/mail/contacts-import — CSV import, in two halves.
//
// TWO HALVES ON PURPOSE. `mode: 'plan'` parses and validates and writes NOTHING; `mode: 'commit'`
// takes the same text and writes. An import that goes straight from a file picker to the database
// is the one operation in this system that can quietly ruin a contact book, and there is no undo —
// so the operator sees the column mapping, the invalid rows with their line numbers, the duplicates
// inside the file and the count of addresses that are suppressed, BEFORE anything happens.
//
// The plan is recomputed on commit rather than trusted from the client. The browser could otherwise
// post a plan that says "0 unsubscribed" over a file that is full of them.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { planImport, type ImportContact } from '@/lib/mail-csv';
import { commitImport, suppressedAmong, isUuid, dbReason, type Actor } from '@/lib/mail-contacts';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/** Two megabytes of CSV is roughly 25,000 contacts. Larger files import in slices from the screen. */
const MAX_BYTES = 2 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.contacts.import' });
  if (denied) return denied;
  const user = (locals as any).user;
  const actor: Actor = { userId: user?.id || null, name: user?.name || user?.email || 'admin' };

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const text = String(body.csv || '');
  if (!text.trim()) return json({ ok: false, error: 'The file was empty.' }, 400);
  if (text.length > MAX_BYTES) {
    return json({ ok: false, error: 'That file is larger than 2 MB. Split it and import the parts — nothing has been read.' }, 413);
  }

  const mapping = Array.isArray(body.mapping) && body.mapping.length ? body.mapping : undefined;

  try {
    const plan = planImport(text, mapping);
    // Which of the valid rows are already suppressed. Computed for the PLAN too, because "412 of
    // your 3,000 rows will not be mailable" is exactly the fact an operator needs before deciding.
    const suppressed = await suppressedAmong(plan.valid.map((v) => v.email));
    const suppressedRows = plan.valid.filter((v) => suppressed.has(v.email)).map((v) => v.email);

    if (body.mode !== 'commit') {
      return json({
        ok: true,
        mode: 'plan',
        headers: plan.headers,
        mapping: plan.mapping,
        totalRows: plan.totalRows,
        validCount: plan.valid.length,
        invalid: plan.invalid.slice(0, 200).map((i) => ({ line: i.line, errors: i.errors })),
        invalidCount: plan.invalid.length,
        duplicatesInFile: plan.duplicatesInFile.slice(0, 200),
        duplicateCount: plan.duplicatesInFile.length,
        warnings: plan.warnings.slice(0, 200),
        warningCount: plan.warnings.length,
        ragged: plan.ragged.slice(0, 50),
        suppressedCount: suppressedRows.length,
        suppressedSample: suppressedRows.slice(0, 20),
        sample: plan.valid.slice(0, 10),
      });
    }

    const listId = isUuid(body.listId) ? String(body.listId) : null;
    const outcome = await commitImport(plan.valid as ImportContact[], {
      listId,
      consentSource: String(body.consentSource || '').trim() || undefined,
      actor,
    });
    return json({
      ok: true,
      mode: 'commit',
      ...outcome,
      invalidCount: plan.invalid.length,
      duplicateCount: plan.duplicatesInFile.length,
      note: outcome.skippedSuppressed > 0
        ? outcome.skippedSuppressed + ' of these addresses are on the suppression list. They were stored, but they are not mailable and will not be counted into any campaign.'
        : undefined,
    });
  } catch (e: any) {
    console.error('[api/mail/contacts-import]', dbReason(e));
    return json({ ok: false, error: 'The import did not run: ' + dbReason(e) }, 500);
  }
};
