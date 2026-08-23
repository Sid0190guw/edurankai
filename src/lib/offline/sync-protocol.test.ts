// Regression and adversarial tests for the offline-sync data-loss defect (P0).
//
// THE DEFECT. The server looped the batch with `catch (_) {}` per INSERT and returned
// `{ ok: true, synced: n }` whatever happened; the client checked `d.ok` and deleted the WHOLE
// queue. Ten records in, three failing, seven stored, ten deleted — three units of somebody's
// fieldwork gone from both places they existed.
//
// Two quieter variants existed alongside it and are covered here too: the `.slice(0, 200)` that
// discarded the tail of a large batch, and `ON CONFLICT DO NOTHING` treating another account's row
// as a successful no-op.
//
// THE INVARIANT UNDER TEST, restated because every case below is a way of attacking it:
//
//     A record may be deleted locally only if the server named THAT RECORD as persisted.
//
// The route tests drive the real handler with a scripted database, so what is proved is the
// production code path rather than a re-implementation of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MAX_BATCH,
  MAX_PAYLOAD_BYTES,
  acknowledgedIds,
  classifyPersistError,
  countByStatus,
  isBlocked,
  isPersisted,
  nextAttemptDelayMs,
  validateRecord,
  type SyncRecordResult,
} from '@/lib/offline/sync-protocol';

// ---------------------------------------------------------------------------
// The protocol itself
// ---------------------------------------------------------------------------

describe('acknowledgement rule', () => {
  const results: SyncRecordResult[] = [
    { index: 0, clientId: 'a', status: 'synced', detail: 'Stored.' },
    { index: 1, clientId: 'b', status: 'duplicate', detail: 'Already stored.' },
    { index: 2, clientId: 'c', status: 'retryable', detail: 'connection lost' },
    { index: 3, clientId: 'd', status: 'permanent_failure', detail: 'payload too large' },
  ];

  it('acknowledges only what was actually persisted', () => {
    expect(acknowledgedIds(results)).toEqual(['a', 'b']);
  });

  it('never acknowledges a failed record, however the caller asks', () => {
    for (const r of results) {
      const acked = acknowledgedIds([r]);
      if (r.status === 'retryable' || r.status === 'permanent_failure') expect(acked).toEqual([]);
    }
  });

  it('acknowledges nothing when there are no per-record results', () => {
    // This is the old-server / truncated-response / proxy-error-page case. The old client deleted
    // the whole batch here.
    expect(acknowledgedIds(null)).toEqual([]);
    expect(acknowledgedIds(undefined)).toEqual([]);
    expect(acknowledgedIds([])).toEqual([]);
    expect(acknowledgedIds({ ok: true, synced: 7 } as any)).toEqual([]);
  });

  it('ignores a result with no id — an unnameable record cannot be acknowledged', () => {
    expect(acknowledgedIds([{ index: 0, clientId: null, status: 'synced', detail: 'x' }])).toEqual([]);
  });

  it('isPersisted is true for exactly two statuses', () => {
    expect(isPersisted('synced')).toBe(true);
    expect(isPersisted('duplicate')).toBe(true);
    expect(isPersisted('retryable')).toBe(false);
    expect(isPersisted('permanent_failure')).toBe(false);
  });

  it('counts every status', () => {
    expect(countByStatus(results)).toEqual({ synced: 1, duplicate: 1, retryable: 1, permanent_failure: 1 });
  });
});

describe('record validation', () => {
  it('accepts a normal worklog record', () => {
    const out = validateRecord({ clientId: 'abc', kind: 'worklog', data: { hours: 6, site: 'north' }, createdAt: '2026-08-16T09:00:00Z' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.kind).toBe('worklog');
      expect(JSON.parse(out.value.payload)).toEqual({ hours: 6, site: 'north' });
      expect(out.value.createdAt.toISOString()).toBe('2026-08-16T09:00:00.000Z');
    }
  });

  it('refuses a record with no id, permanently — it cannot be acknowledged by name', () => {
    const out = validateRecord({ kind: 'worklog', data: {} });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe('permanent_failure');
      expect(out.detail).toMatch(/clientId/i);
    }
  });

  it('refuses an oversized payload permanently rather than retrying it forever', () => {
    const out = validateRecord({ clientId: 'x', data: { blob: 'z'.repeat(MAX_PAYLOAD_BYTES + 10) } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe('permanent_failure');
  });

  it('refuses a payload that cannot be serialised', () => {
    const circular: any = {}; circular.self = circular;
    const out = validateRecord({ clientId: 'x', data: circular });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toMatch(/serialis/i);
  });

  it('truncates a long kind instead of rejecting the work', () => {
    const out = validateRecord({ clientId: 'x', kind: 'k'.repeat(500), data: {} });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.kind).toHaveLength(80);
  });

  it('falls back to now on a bad clock rather than losing the record', () => {
    const out = validateRecord({ clientId: 'x', data: {}, createdAt: 'yesterday-ish' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Number.isFinite(out.value.createdAt.getTime())).toBe(true);
  });
});

describe('error classification', () => {
  it('treats connection and contention failures as retryable', () => {
    for (const code of ['08006', '40001', '40P01', '53300', '57P01', '55P03']) {
      expect(classifyPersistError({ cause: { code, message: 'x' } }).status, code).toBe('retryable');
    }
  });

  it('treats malformed data and schema mismatches as permanent', () => {
    for (const code of ['22P02', '23502', '23514', '42703', '22001']) {
      expect(classifyPersistError({ cause: { code, message: 'x' } }).status, code).toBe('permanent_failure');
    }
  });

  it('defaults an unrecognised error to retryable — losing work is worse than retrying', () => {
    expect(classifyPersistError(new Error('socket hang up')).status).toBe('retryable');
    expect(classifyPersistError({ cause: { code: '99999', message: 'who knows' } }).status).toBe('retryable');
  });

  it('reads the real reason off e.cause, not the failed SQL on e.message', () => {
    const e = { message: 'INSERT INTO offline_work ...', cause: { code: '23502', message: 'null value in column "user_id"' } };
    const c = classifyPersistError(e);
    expect(c.detail).toContain('null value in column');
    expect(c.detail).not.toContain('INSERT INTO');
  });
});

describe('retry scheduling', () => {
  it('backs off exponentially and caps', () => {
    expect(nextAttemptDelayMs(0)).toBe(5000);
    expect(nextAttemptDelayMs(1)).toBe(10000);
    expect(nextAttemptDelayMs(3)).toBe(40000);
    expect(nextAttemptDelayMs(50)).toBe(15 * 60000);
  });

  it('blocks a permanent failure immediately and a retryable one only at the ceiling', () => {
    expect(isBlocked(0, 'permanent_failure')).toBe(true);
    expect(isBlocked(0, 'retryable')).toBe(false);
    expect(isBlocked(9, 'retryable')).toBe(false);
    expect(isBlocked(10, 'retryable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route, driven against a scripted database
// ---------------------------------------------------------------------------

const USER = { id: '11111111-1111-4111-8111-111111111111' };

/**
 * Build a mock `db.execute`. The first three calls are the schema bootstrap; every call after that
 * is one INSERT, answered by `script[n]`. A script entry that is an Error is thrown.
 */
function scriptedDb(script: any[]) {
  let ddl = 0;
  let n = 0;
  const calls: number[] = [];
  const execute = vi.fn(async () => {
    if (ddl < 3) { ddl++; return []; }
    const i = n++;
    calls.push(i);
    const entry = script[i];
    if (entry instanceof Error || (entry && entry.__throw)) throw (entry.__throw ? entry : entry);
    return entry === undefined ? [{ client_id: 'auto', inserted: true }] : entry;
  });
  return { execute, inserts: () => n };
}

const inserted = (id: string) => [{ client_id: id, inserted: true }];
const existing = (id: string) => [{ client_id: id, inserted: false }];
const ownedByAnother = () => [];
const dbError = (code: string, message = 'boom') => ({ __throw: true, cause: { code, message } });

async function callRoute(dbMock: any, records: any[], locals: any = { user: USER }) {
  vi.resetModules();
  vi.doMock('@/lib/db', () => ({ db: dbMock }));
  const mod = await import('@/pages/api/offline/sync');
  const request = new Request('http://localhost/api/offline/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const res = await (mod.POST as any)({ request, locals });
  return { res, body: await res.json() };
}

const rec = (id: string, over: any = {}) => ({ clientId: id, kind: 'worklog', data: { hours: 4 }, createdAt: '2026-08-16T09:00:00Z', ...over });

describe('POST /api/offline/sync', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('1. all records succeed', async () => {
    const db = scriptedDb([inserted('a'), inserted('b'), inserted('c')]);
    const { body } = await callRoute(db, [rec('a'), rec('b'), rec('c')]);
    expect(body.ok).toBe(true);
    expect(body.counts.synced).toBe(3);
    expect(acknowledgedIds(body.results)).toEqual(['a', 'b', 'c']);
  });

  it('2. one record fails — the other two are acknowledged and the failure is not', async () => {
    const db = scriptedDb([inserted('a'), dbError('40001', 'serialization failure'), inserted('c')]);
    const { body } = await callRoute(db, [rec('a'), rec('b'), rec('c')]);

    expect(acknowledgedIds(body.results)).toEqual(['a', 'c']);
    const b = body.results.find((r: SyncRecordResult) => r.clientId === 'b');
    expect(b.status).toBe('retryable');
    // The old protocol answered ok:true here and the client deleted 'b'.
    expect(body.ok).toBe(false);
  });

  it('3. multiple records fail, and every one of them stays unacknowledged', async () => {
    const db = scriptedDb([
      dbError('40001'), inserted('b'), dbError('22P02', 'invalid input syntax'), inserted('d'), dbError('23514'),
    ]);
    const { body } = await callRoute(db, [rec('a'), rec('b'), rec('c'), rec('d'), rec('e')]);
    expect(acknowledgedIds(body.results).sort()).toEqual(['b', 'd']);
    expect(body.counts.retryable).toBe(1);
    expect(body.counts.permanent_failure).toBe(2);
  });

  it('4. a transient database failure stops the batch but answers every record', async () => {
    const db = scriptedDb([inserted('a'), dbError('08006', 'connection terminated')]);
    const { body } = await callRoute(db, [rec('a'), rec('b'), rec('c'), rec('d')]);

    expect(body.results).toHaveLength(4);
    expect(acknowledgedIds(body.results)).toEqual(['a']);
    // c and d were never attempted, and they are reported as such rather than omitted.
    expect(body.results[2].status).toBe('retryable');
    expect(body.results[3].status).toBe('retryable');
    expect(body.results[3].detail).toMatch(/not attempted/i);
    // Only two inserts were attempted; the route stopped hammering a dead connection.
    expect(db.inserts()).toBe(2);
  });

  it('5. a permanent validation failure never reaches the database and is never acknowledged', async () => {
    const db = scriptedDb([inserted('b')]);
    const { body } = await callRoute(db, [{ kind: 'worklog', data: { hours: 3 } }, rec('b')]);

    expect(body.results[0].status).toBe('permanent_failure');
    expect(body.results[0].clientId).toBeNull();
    expect(acknowledgedIds(body.results)).toEqual(['b']);
    expect(db.inserts()).toBe(1);
  });

  it('6. a duplicate submission is acknowledged without being stored twice', async () => {
    const db = scriptedDb([existing('a')]);
    const { body } = await callRoute(db, [rec('a')]);
    expect(body.results[0].status).toBe('duplicate');
    expect(acknowledgedIds(body.results)).toEqual(['a']);
    expect(body.ok).toBe(true);
  });

  it('7. retry after a partial success stores only what is left', async () => {
    const first = scriptedDb([inserted('a'), dbError('40001')]);
    const r1 = await callRoute(first, [rec('a'), rec('b')]);
    const acked = acknowledgedIds(r1.body.results);
    expect(acked).toEqual(['a']);

    // The client keeps 'b' and re-sends it alone.
    const remaining = [rec('a'), rec('b')].filter((r) => !acked.includes(r.clientId));
    expect(remaining.map((r) => r.clientId)).toEqual(['b']);

    const second = scriptedDb([inserted('b')]);
    const r2 = await callRoute(second, remaining);
    expect(acknowledgedIds(r2.body.results)).toEqual(['b']);
  });

  it('11. worklog and pay-record payloads round-trip', async () => {
    const db = scriptedDb([inserted('w1'), inserted('p1')]);
    const { body } = await callRoute(db, [
      rec('w1', { kind: 'worklog', data: { hours: 7.5, site: 'north gate', notes: 'rain' } }),
      rec('p1', { kind: 'pay-record', data: { amount: 1250, currency: 'INR', period: '2026-08' } }),
    ]);
    expect(body.counts.synced).toBe(2);
    expect(acknowledgedIds(body.results)).toEqual(['w1', 'p1']);
  });

  it('12. every submitted record gets a result, in order — no acknowledgement mismatch', async () => {
    const db = scriptedDb([inserted('a'), dbError('40001'), inserted('c')]);
    const submitted = [rec('a'), rec('b'), rec('c')];
    const { body } = await callRoute(db, submitted);

    expect(body.results).toHaveLength(submitted.length);
    body.results.forEach((r: SyncRecordResult, i: number) => {
      expect(r.index).toBe(i);
      expect(r.clientId).toBe(submitted[i].clientId);
    });
  });
});

describe('POST /api/offline/sync — adversarial', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('a clientId already held by another account is refused, not acknowledged as a duplicate', async () => {
    // ON CONFLICT DO NOTHING used to make this indistinguishable from a successful no-op, so the
    // sender's record was dropped and then deleted locally.
    const db = scriptedDb([ownedByAnother()]);
    const { body } = await callRoute(db, [rec('collision')]);
    expect(body.results[0].status).toBe('permanent_failure');
    expect(body.results[0].detail).toMatch(/another account/i);
    expect(acknowledgedIds(body.results)).toEqual([]);
  });

  it('records past the batch limit are queued for later, never discarded', async () => {
    const many = Array.from({ length: MAX_BATCH + 5 }, (_, i) => rec(`r${i}`));
    const db = scriptedDb(Array.from({ length: MAX_BATCH }, (_, i) => inserted(`r${i}`)));
    const { body } = await callRoute(db, many);

    expect(body.results).toHaveLength(MAX_BATCH + 5);
    expect(acknowledgedIds(body.results)).toHaveLength(MAX_BATCH);
    for (let i = MAX_BATCH; i < many.length; i++) {
      expect(body.results[i].status).toBe('retryable');
      expect(body.results[i].detail).toMatch(/batch limit/i);
    }
  });

  it('a failure to prepare storage answers every record retryable, not a bare 500', async () => {
    const execute = vi.fn(async () => { throw { cause: { code: '08006', message: 'no connection' } }; });
    const { res, body } = await callRoute({ execute }, [rec('a'), rec('b')]);
    expect(res.status).toBe(503);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: SyncRecordResult) => r.status === 'retryable')).toBe(true);
    expect(acknowledgedIds(body.results)).toEqual([]);
  });

  it('an unauthenticated call acknowledges nothing', async () => {
    const db = scriptedDb([]);
    const { res, body } = await callRoute(db, [rec('a')], {});
    expect(res.status).toBe(401);
    expect(acknowledgedIds(body.results)).toEqual([]);
  });

  it('a malformed body acknowledges nothing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: scriptedDb([]) }));
    const mod = await import('@/pages/api/offline/sync');
    const request = new Request('http://localhost/api/offline/sync', { method: 'POST', body: 'not json' });
    const res = await (mod.POST as any)({ request, locals: { user: USER } });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(acknowledgedIds(body.results)).toEqual([]);
  });

  it('9. a network interruption yields nothing to acknowledge (client keeps everything)', () => {
    // The client cannot parse a response it never received. This is the case the old code got
    // wrong in the other direction, by trusting a truthy `ok` from a cached or proxied body.
    expect(acknowledgedIds(undefined)).toEqual([]);
    expect(acknowledgedIds((null as any)?.results)).toEqual([]);
  });

  it('10. concurrent syncs of the same record both end acknowledged, stored once', async () => {
    // Two tabs flush simultaneously. One insert wins, the other sees the existing row — and because
    // the ownership guard confirmed it belongs to this user, both may safely be acknowledged.
    const a = scriptedDb([inserted('same')]);
    const b = scriptedDb([existing('same')]);
    const [r1, r2] = await Promise.all([callRoute(a, [rec('same')]), callRoute(b, [rec('same')])]);
    expect(acknowledgedIds(r1.body.results)).toEqual(['same']);
    expect(acknowledgedIds(r2.body.results)).toEqual(['same']);
  });

  it('the response never claims success while a record is unsaved', async () => {
    const db = scriptedDb([inserted('a'), dbError('23514', 'check constraint')]);
    const { body } = await callRoute(db, [rec('a'), rec('b')]);
    expect(body.ok).toBe(false);
    expect(body.counts.permanent_failure).toBe(1);
  });
});
