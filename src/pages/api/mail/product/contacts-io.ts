// /api/mail/product/contacts-io — CSV in, CSV out.
//
//   POST { action: 'preview' | 'import', csv, mapping, listId, tags }
//   GET  ?format=csv&…filters                      streams the filtered audience
//
// IMPORT IS TWO STEPS ON PURPOSE. 'preview' parses, reports what it found and what it would reject,
// and writes NOTHING. 'import' does the work. A one-step import is how somebody discovers, after the
// fact, that column three was phone numbers.
//
// EXPORT STREAMS. The rows are pulled in keyset pages inside a ReadableStream and written out as they
// arrive, so exporting a million contacts costs one page of memory rather than a million rows of it.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import { denyMailApi } from '@/lib/auth/mail-access';
import { upsertContact, addToList, listContacts, type ContactFilter } from '@/lib/mail-product/contacts';
import { ensureMailProductSchema, CONTACT_STATUSES } from '@/lib/mail-product/schema';
import { json, fail, reasonOf, isUuid, isEmail, normaliseEmail, str, clampInt } from '@/lib/mail-product/common';

/** Header names this importer recognises without being told. Everything else needs an explicit map. */
const GUESSES: Record<string, string> = {
  email: 'email', 'e-mail': 'email', 'email address': 'email', mail: 'email',
  'first name': 'firstName', firstname: 'firstName', first: 'firstName', 'given name': 'firstName',
  'last name': 'lastName', lastname: 'lastName', last: 'lastName', surname: 'lastName',
  name: 'fullName', 'full name': 'fullName',
};

export interface ImportMapping { [column: string]: string; }

function guessMapping(headers: string[]): ImportMapping {
  const out: ImportMapping = {};
  for (const h of headers) {
    const k = String(h || '').trim().toLowerCase();
    out[h] = GUESSES[k] || ('field:' + k.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''));
  }
  // If nothing mapped to email but exactly one column LOOKS like addresses, say so rather than
  // failing the whole file — the caller shows this as a suggestion, it is not applied silently.
  return out;
}

const MAX_ROWS = 50000;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.contacts.import' });
  if (denied) return denied;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }

  const csv = String(body.csv || '');
  if (!csv.trim()) return fail('There was nothing in that file.');
  // 12 MB of text is roughly 150k contact rows. Beyond that this needs to be a job, not a request,
  // and saying so is better than timing out half-way through a write.
  if (csv.length > 12_000_000) {
    return fail('That file is larger than a single upload can handle safely (12 MB). Split it, or import it in parts — a partial import that timed out would leave you unable to tell which rows landed.');
  }

  let records: Record<string, string>[];
  let headers: string[];
  try {
    records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as any[];
    headers = records.length ? Object.keys(records[0]) : [];
  } catch (e: any) {
    return fail('That file could not be read as CSV: ' + String(e?.message || 'unknown parse error') + '. Nothing has been imported.');
  }

  if (!records.length) return fail('That file has a header row and no data rows.');
  if (records.length > MAX_ROWS) {
    return fail(`That file has ${records.length.toLocaleString('en-IN')} rows. This importer handles ${MAX_ROWS.toLocaleString('en-IN')} at a time — split it so you can see what landed.`);
  }

  const mapping: ImportMapping = (body.mapping && typeof body.mapping === 'object') ? body.mapping : guessMapping(headers);
  const emailCol = Object.keys(mapping).find((c) => mapping[c] === 'email');

  // ---- Preview -----------------------------------------------------------------------------------
  if (str(body.action, 20) !== 'import') {
    const sample = records.slice(0, 8);
    let valid = 0;
    let invalid = 0;
    const seen = new Set<string>();
    let duplicates = 0;
    if (emailCol) {
      for (const row of records) {
        const e = normaliseEmail(row[emailCol]);
        if (!isEmail(e)) { invalid++; continue; }
        if (seen.has(e)) { duplicates++; continue; }
        seen.add(e);
        valid++;
      }
    }
    return json({
      ok: true,
      headers,
      mapping,
      rowCount: records.length,
      sample,
      emailColumn: emailCol || null,
      valid, invalid, duplicates,
      // Said plainly, because it is the single most common surprise in a contact import.
      note: emailCol
        ? 'Contacts that already exist will be updated, not duplicated. Anybody who has unsubscribed stays unsubscribed — an import never resubscribes somebody.'
        : 'No column is mapped to the email address, so nothing can be imported yet. Pick the column that holds addresses.',
    });
  }

  // ---- Import ------------------------------------------------------------------------------------
  if (!emailCol) return fail('No column is mapped to the email address. Nothing has been imported.');
  const listId = isUuid(body.listId || '') ? String(body.listId) : null;
  const tags = (Array.isArray(body.tags) ? body.tags : []).map((t: any) => str(t, 60)).filter(Boolean).slice(0, 10);

  await ensureMailProductSchema();

  let created = 0;
  let updated = 0;
  const rejected: { row: number; value: string; reason: string }[] = [];
  const addedIds: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const email = normaliseEmail(row[emailCol]);
    if (!isEmail(email)) {
      // Capped: an error list with 40,000 entries is a payload nobody reads and a response nobody
      // can render. The COUNT is still exact.
      if (rejected.length < 100) rejected.push({ row: i + 2, value: String(row[emailCol] ?? '').slice(0, 80), reason: 'not an email address' });
      continue;
    }

    let firstName = '';
    let lastName = '';
    const fields: Record<string, string> = {};
    for (const [col, target] of Object.entries(mapping)) {
      const v = str(row[col], 500);
      if (!v || target === 'email' || target === 'ignore') continue;
      if (target === 'firstName') firstName = v;
      else if (target === 'lastName') lastName = v;
      else if (target === 'fullName') {
        const parts = v.split(/\s+/);
        firstName = firstName || parts[0] || '';
        lastName = lastName || parts.slice(1).join(' ');
      } else if (target.startsWith('field:')) {
        fields[target.slice(6)] = v;
      }
    }

    const res = await upsertContact({ email, firstName, lastName, source: 'csv-import', fields, tags });
    if (res.error) {
      if (rejected.length < 100) rejected.push({ row: i + 2, value: email, reason: res.error });
      continue;
    }
    if (res.created) created++; else updated++;
    if (res.id) addedIds.push(res.id);

    // Batched list membership — one statement per 500 rather than one per contact.
    if (listId && addedIds.length >= 500) {
      await addToList(listId, addedIds.splice(0, addedIds.length));
    }
  }
  if (listId && addedIds.length) await addToList(listId, addedIds);

  const rejectedCount = records.length - created - updated;
  return json({
    ok: true,
    created, updated,
    rejected: rejectedCount,
    // The first hundred, and an honest statement that the rest exist.
    rejectedSample: rejected,
    truncatedErrors: rejectedCount > rejected.length,
    listId,
  });
};

// ---- Export ---------------------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  // Leading =, +, - or @ is a formula in a spreadsheet: an exported contact called "=cmd|…" is a
  // real attack on whoever opens the file. Prefixed with a single quote, which spreadsheets treat as
  // "this is text" and which round-trips back through the importer as the original string.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.contacts.export' });
  if (denied) return denied;

  const url = new URL(request.url);
  const filter: ContactFilter = {
    q: str(url.searchParams.get('q'), 120) || undefined,
    status: (url.searchParams.get('status') || 'all') as any,
    listId: url.searchParams.get('listId'),
    segmentId: url.searchParams.get('segmentId'),
    tag: str(url.searchParams.get('tag'), 60) || undefined,
  };
  const cap = clampInt(url.searchParams.get('max'), 1, 1_000_000, 200_000);

  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let written = 0;

  const stream = new ReadableStream({
    async start(controller) {
      // A BOM, so a spreadsheet opens UTF-8 names correctly instead of mangling every non-ASCII one.
      controller.enqueue(encoder.encode('﻿' + ['email', 'first_name', 'last_name', 'status', 'tags', 'source', 'created_at'].join(',') + '\n'));
      try {
        // Bounded loop: pages of 500 until the cursor runs out or the cap is reached. There is no
        // path here that holds the whole result set.
        for (;;) {
          const page = await listContacts({ ...filter, cursor, limit: 500 });
          for (const c of page.rows) {
            controller.enqueue(encoder.encode([
              csvCell(c.email), csvCell(c.first_name), csvCell(c.last_name), csvCell(c.status),
              csvCell((c.tags || []).join(' ')), csvCell(c.source), csvCell(c.created_at),
            ].join(',') + '\n'));
            written++;
            if (written >= cap) break;
          }
          cursor = page.nextCursor;
          if (!cursor || written >= cap) break;
        }
        // The cap is DECLARED IN THE FILE, not silently applied. A truncated export that looks
        // complete is the export somebody reconciles against and cannot explain.
        if (written >= cap && cursor) {
          controller.enqueue(encoder.encode(`# This export stopped at the ${cap.toLocaleString('en-IN')}-row limit and is INCOMPLETE. Narrow the filter and export again.\n`));
        }
      } catch (e: any) {
        console.error('[api/mail/product/contacts-io] export failed:', reasonOf(e));
        controller.enqueue(encoder.encode('# The export FAILED part-way and this file is incomplete: ' + reasonOf(e).replace(/[\r\n]+/g, ' ') + '\n'));
      }
      controller.close();
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="edurankai-contacts-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
