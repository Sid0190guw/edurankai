// POST /api/aquintutor/library/ill-request — request a book the library does not hold.
//
// =================================================================================================
// THE FORM THAT NEVER SUBMITTED
// =================================================================================================
//
// /aquintutor/campus/library-archives carried a nine-field inter-library loan form whose action
// pointed here, at a file that did not exist. It never got that far: the submit handler called
// preventDefault() unconditionally and then said
//
//     "Inter-library loan request received for <title>. A librarian will reply within two working
//      days."
//
// Nothing was stored, nothing was sent, and no librarian was going to reply — there was not even a
// field asking who was requesting it, so a reply was impossible in principle.
//
// This is an ordinary HTML form post with no JavaScript in the path, so the answer is a redirect
// back to the form with a message, not JSON. That also means it still works with scripting off.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { text, email, tooFast, logFail } from '@/lib/campus-intake';
import { ensureOnce } from '@/lib/ensure-once';

export const prerender = false;

const PAGE = '/aquintutor/campus/library-archives';

function back(kind: 'msg' | 'err', s: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: PAGE + '?' + kind + '=' + encodeURIComponent(s.slice(0, 300)) + '#ill' },
  });
}

// The page bootstraps its own tables for every other feature it has; this one had none, because
// nothing had ever been written.
async function ensureSchema(): Promise<void> {
  await ensureOnce('library_ill_requests', async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS library_ill_requests (
        id            BIGSERIAL PRIMARY KEY,
        title         TEXT NOT NULL,
        author        TEXT,
        year          TEXT,
        publisher     TEXT,
        ident         TEXT,
        format        TEXT NOT NULL DEFAULT 'any',
        needed_by     DATE,
        reason        TEXT,
        requester_email TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'received',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  });
}

const FORMATS = ['any', 'physical', 'scan'];

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return back('err', 'That form could not be read. Nothing was sent. Try again.');
  }

  const title = text(fd.get('title'), 300);
  const addr = email(fd.get('requester_email'));
  if (!title) return back('err', 'The title is needed before a librarian can look for it.');
  if (!addr) return back('err', 'An email address is needed, otherwise nobody can reply to you.');
  if (await tooFast('ill', clientAddress || addr)) return back('err', 'That went through several times just now. Give it a minute.');

  const fmtRaw = String(fd.get('format') || 'any');
  const format = FORMATS.includes(fmtRaw) ? fmtRaw : 'any';
  const neededRaw = text(fd.get('needed_by'), 12);
  const neededBy = neededRaw && /^\d{4}-\d{2}-\d{2}$/.test(neededRaw) ? neededRaw : null;

  try {
    await ensureSchema();
    await db.execute(sql`
      INSERT INTO library_ill_requests (title, author, year, publisher, ident, format, needed_by, reason, requester_email)
      VALUES (${title}, ${text(fd.get('author'), 200)}, ${text(fd.get('year'), 12)},
              ${text(fd.get('publisher'), 200)}, ${text(fd.get('ident'), 120)}, ${format},
              ${neededBy}::date, ${text(fd.get('reason'), 1200)}, ${addr})`);
    // Says what happened, and does not invent a turnaround this endpoint cannot keep.
    return back('msg', 'Request recorded for "' + title + '". A librarian picks these up from the request list; you will hear back at ' + addr + '.');
  } catch (e: any) {
    logFail('ill-request', e);
    return back('err', 'That could not be saved just now, so it has NOT been requested. Please try again shortly.');
  }
};
