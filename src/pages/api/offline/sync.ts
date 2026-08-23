// POST /api/offline/sync  { records: [{ clientId, kind, data, createdAt }, ...] }
//
// Receives work captured offline and stores it so it appears in the admin panel.
//
// THIS ROUTE PREVIOUSLY LOST DATA, AND THE WAY IT DID IT IS WORTH KEEPING WRITTEN DOWN. It looped
// over the batch with `catch (_) {}` around each INSERT and returned `{ ok: true, synced: n }`
// regardless. The client read `ok` — not `synced` — and deleted the entire local queue. Ten records
// in, three inserts throwing, seven stored, ten deleted: three units of somebody's unpaid fieldwork
// gone from the only two places they existed.
//
// Two quieter versions of the same bug were alongside it:
//   - `records.slice(0, 200)` dropped everything past the two-hundredth record with no mention, and
//     those were deleted client-side too.
//   - `ON CONFLICT (client_id) DO NOTHING` counts a row belonging to a DIFFERENT user as a
//     successful no-op, so a colliding id silently discarded the sender's record.
//
// The route now answers PER RECORD, by id, and the client deletes only what is named as persisted.
// See src/lib/offline/sync-protocol.ts — `acknowledgedIds()` is the only sanctioned way to decide
// what may be dropped, and it ignores `ok` entirely.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  MAX_BATCH,
  classifyPersistError,
  countByStatus,
  validateRecord,
  type SyncRecordResult,
  type SyncResponse,
} from '@/lib/offline/sync-protocol';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ensured = false;
export async function ensureOfflineSchema() {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS offline_work (
    client_id text PRIMARY KEY,
    user_id uuid,
    kind text,
    payload jsonb,
    created_at timestamptz,
    synced_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS offline_work_user_idx ON offline_work(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS offline_work_kind_idx ON offline_work(kind)`);
  ensured = true;
}

function fail(response: Partial<SyncResponse> & { error: string }, status: number): Response {
  const results = response.results || [];
  return json({ ok: false, results, counts: countByStatus(results), error: response.error } satisfies SyncResponse, status);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return fail({ error: 'Sign in first' }, 401);

  let records: any[] = [];
  try {
    records = (await request.json())?.records || [];
  } catch {
    return fail({ error: 'Bad request' }, 400);
  }
  if (!Array.isArray(records)) return fail({ error: 'Bad request' }, 400);

  // Every input position gets a result. A caller must never have to infer the fate of a record from
  // a count, which is precisely how the old protocol lost things.
  const results: SyncRecordResult[] = new Array(records.length);

  try {
    await ensureOfflineSchema();
  } catch (e: any) {
    // The table could not be prepared, so nothing in this batch was even attempted. Say so for
    // every record rather than returning a bare 500 the client might read as terminal.
    const c = classifyPersistError(e);
    for (let i = 0; i < records.length; i++) {
      results[i] = { index: i, clientId: typeof records[i]?.clientId === 'string' ? records[i].clientId : null, status: 'retryable', detail: `Storage unavailable: ${c.detail}`, code: c.code };
    }
    return json({ ok: false, results, counts: countByStatus(results), error: 'Storage unavailable' } satisfies SyncResponse, 503);
  }

  // Once the connection has failed there is no point attempting the rest of the batch — and, more
  // importantly, each remaining record must still be answered so it stays queued.
  let connectionLost: { detail: string; code?: string } | null = null;

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const clientIdGuess = typeof raw?.clientId === 'string' ? raw.clientId : null;

    if (i >= MAX_BATCH) {
      // NOT dropped. The old code sliced these away and the client deleted them.
      results[i] = { index: i, clientId: clientIdGuess, status: 'retryable', detail: `Beyond the ${MAX_BATCH}-record batch limit. Send it in the next batch.` };
      continue;
    }

    const validated = validateRecord(raw);
    if (!validated.ok) {
      results[i] = { index: i, clientId: clientIdGuess, status: validated.status, detail: validated.detail };
      continue;
    }
    const { clientId, kind, payload, createdAt } = validated.value;

    if (connectionLost) {
      results[i] = { index: i, clientId, status: 'retryable', detail: `Not attempted: ${connectionLost.detail}`, code: connectionLost.code };
      continue;
    }

    try {
      // THE OWNERSHIP GUARD. `DO UPDATE ... WHERE offline_work.user_id = EXCLUDED.user_id` means a
      // row already held by somebody else matches no conflict action and RETURNS NOTHING — so a
      // colliding id is reported as a failure instead of being acknowledged as a duplicate.
      // `xmax = 0` distinguishes a fresh insert from a touched existing row.
      const r = await db.execute(sql`
        INSERT INTO offline_work (client_id, user_id, kind, payload, created_at)
        VALUES (${clientId}, ${user.id}, ${kind}, ${payload}::jsonb, ${createdAt})
        ON CONFLICT (client_id) DO UPDATE SET synced_at = offline_work.synced_at
          WHERE offline_work.user_id = EXCLUDED.user_id
        RETURNING client_id, (xmax = 0) AS inserted
      `);
      const row = rowsOf(r)[0];

      if (!row) {
        results[i] = {
          index: i,
          clientId,
          status: 'permanent_failure',
          detail: 'This clientId is already held by another account. The record was not stored; re-save it to get a new id.',
        };
        continue;
      }

      results[i] = {
        index: i,
        clientId,
        status: row.inserted === true || row.inserted === 't' ? 'synced' : 'duplicate',
        detail: row.inserted === true || row.inserted === 't' ? 'Stored.' : 'Already stored by an earlier sync.',
      };
    } catch (e: any) {
      const c = classifyPersistError(e);
      results[i] = { index: i, clientId, status: c.status, detail: c.detail, code: c.code };
      // A connection-class failure will repeat for every remaining record; stop hammering it and
      // answer the rest as not-attempted.
      if (c.status === 'retryable' && (!c.code || c.code.startsWith('08') || c.code.startsWith('57') || c.code.startsWith('53'))) {
        connectionLost = { detail: c.detail, code: c.code };
      }
    }
  }

  const counts = countByStatus(results);
  // `ok` describes whether the request was processed, not whether every record made it. The client
  // does not use it to decide what to delete — that is what the per-record results are for — but a
  // human reading a log should be able to see at a glance that something needs attention.
  const body: SyncResponse = { ok: counts.retryable === 0 && counts.permanent_failure === 0, results, counts };
  return json(body);
};
