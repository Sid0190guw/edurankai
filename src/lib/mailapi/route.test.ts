// src/lib/mailapi/route.test.ts — what a REFUSED request costs.
//
// The funnel used to authenticate first and count second, so every request that failed to
// authenticate was free: an unknown, expired or revoked key moved no counter, hit no ceiling, and
// still ran a lookup against the keys table on every attempt. These tests are written against the
// refusals rather than the happy path, because the happy path was never the bug — the assertions
// that matter are "a request that never authenticates still costs something", "being throttled does
// not change what a refusal says", and "a caller with a working key is not made stricter".
//
// The database is a fake counter, not a connection. It answers the two statements this path issues
// (the rate-window upsert and the key lookup) and returns a PLAIN ARRAY, which is what postgres-js
// actually returns — a fake that returned `{ rows: [...] }` would let a `r.rows[0]` bug pass here
// and fail in production.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted above the imports so the limits are in the environment before route.ts evaluates its
// module-level constants. Small numbers keep the tests to a handful of requests instead of 300.
const state = vi.hoisted(() => {
  process.env.MAILAPI_LIMIT_PREAUTH_IP = '3';
  process.env.MAILAPI_LIMIT_AUTH_FAILURES = '2';
  process.env.MAILAPI_WINDOW_AUTH_FAILURES = '300';
  return {
    counts: new Map<string, number>(),
    statements: [] as string[],
    keyRow: null as any,
    rejectBucketPrefixes: [] as string[],
    rejectKeyLookup: false,
    sawWindowUpsert: false,
  };
});

vi.mock('@/lib/ensure-once', () => ({ ensureOnce: async () => {} }));

vi.mock('@/lib/db', () => {
  // Drizzle's sql`` builds an SQL object whose queryChunks alternate literal text — a StringChunk,
  // recognisable because its `value` is an array of strings — and the interpolated values, which
  // arrive as boxed primitives or Param objects. Splitting on that is enough to tell the two
  // statements apart and to read the bucket the limiter is charging.
  const isText = (c: any): boolean => Array.isArray(c?.value);
  const textOf = (q: any): string =>
    (q?.queryChunks || []).map((c: any) => (isText(c) ? c.value.join('') : ' ? ')).join('');
  const paramsOf = (q: any): any[] =>
    (q?.queryChunks || []).filter((c: any) => !isText(c))
      .map((c: any) => (c && typeof c === 'object' && c.value !== undefined ? c.value : String(c)));

  return {
    db: {
      execute: async (q: any) => {
        const text = textOf(q);
        state.statements.push(text);

        if (/mailapi_rate_windows/.test(text) && /INSERT/i.test(text)) {
          state.sawWindowUpsert = true;
          const [bucket, windowStart] = paramsOf(q);
          if (state.rejectBucketPrefixes.some((p) => String(bucket).startsWith(p))) {
            const e: any = new Error('INSERT INTO mailapi_rate_windows ...');
            e.cause = new Error('connection terminated unexpectedly');
            throw e;
          }
          const cell = String(bucket) + '|' + String(windowStart);
          const n = (state.counts.get(cell) || 0) + 1;
          state.counts.set(cell, n);
          return [{ count: n }];
        }

        if (/FROM mailapi_keys k/.test(text)) {
          if (state.rejectKeyLookup) {
            const e: any = new Error('SELECT k.id, k.org_id ...');
            e.cause = new Error('server closed the connection unexpectedly');
            throw e;
          }
          return state.keyRow ? [state.keyRow] : [];
        }

        return [];
      },
    },
  };
});

import { apiRoute, authFailureHeaders, isCredentialFailure, retryMessage } from './route';
import { ApiError } from './errors';

const GOOD_FORMAT_KEY = 'erm_live_' + 'a1b2c3d4'.repeat(4);

const ping = apiRoute({ endpoint: 'ping' }, async (ctx) => ctx.json({ ok: true }));

function call(ip: string, key?: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key) headers['x-api-key'] = key;
  const request = new Request('https://api.example.test/v1/ping', { method: 'GET', headers });
  return (ping as any)({ request, clientAddress: ip, params: {} });
}

/** Every bucket dimension charged so far, e.g. ['preauth_ip', 'ip', 'org']. */
function chargedDimensions(): string[] {
  return [...new Set([...state.counts.keys()].map((k) => k.split(':')[0]))].sort();
}

function countFor(dimension: string): number {
  let total = 0;
  for (const [cell, n] of state.counts) if (cell.split(':')[0] === dimension) total += n;
  return total;
}

function queriedKeysTable(): boolean {
  return state.statements.some((s) => /FROM mailapi_keys k/.test(s));
}

beforeEach(() => {
  state.counts.clear();
  state.statements.length = 0;
  state.keyRow = null;
  state.rejectBucketPrefixes = [];
  state.rejectKeyLookup = false;
  state.sawWindowUpsert = false;
});

describe('isCredentialFailure', () => {
  it('counts every way a credential can be refused', () => {
    for (const code of ['missing_api_key', 'invalid_api_key', 'expired_api_key', 'revoked_api_key',
      'environment_mismatch', 'organization_inactive'] as const) {
      expect(isCredentialFailure(new ApiError(code, 'refused'))).toBe(true);
    }
  });

  it('refuses to bill our own faults to the caller', () => {
    // "We could not check" is not "the check said no". A database outage inside authenticate() must
    // not spend the caller's failure budget, or one of our incidents becomes a lockout of every
    // integration that happened to be calling during it.
    const dbFault: any = new Error('SELECT k.id ...');
    dbFault.cause = new Error('server closed the connection unexpectedly');
    expect(isCredentialFailure(dbFault)).toBe(false);
    expect(isCredentialFailure(new Error('boom'))).toBe(false);
    expect(isCredentialFailure(undefined)).toBe(false);
    expect(isCredentialFailure(null)).toBe(false);
  });

  it('does not count a caller who already has a working key', () => {
    // A scope refusal is a misconfigured integration, not a guess.
    expect(isCredentialFailure(new ApiError('insufficient_scope', 'no'))).toBe(false);
    expect(isCredentialFailure(new ApiError('invalid_request', 'no'))).toBe(false);
    expect(isCredentialFailure(new ApiError('rate_limit_exceeded', 'no'))).toBe(false);
    expect(isCredentialFailure(new ApiError('internal_error', 'no'))).toBe(false);
  });

  it('is not fooled by something merely shaped like an ApiError', () => {
    expect(isCredentialFailure({ code: 'invalid_api_key', message: 'refused' })).toBe(false);
  });
});

describe('authFailureHeaders', () => {
  it('says nothing at all while the failure budget is intact', () => {
    const h = authFailureHeaders('req_1', { allowed: true, limit: 10, remaining: 9, resetSec: 42 });
    expect(h['Retry-After']).toBeUndefined();
    expect(h['X-Request-Id']).toBe('req_1');
  });

  it('does not invent a throttle when there was no decision', () => {
    const h = authFailureHeaders('req_1', null);
    expect(h['Retry-After']).toBeUndefined();
  });

  it('asks for a retry once the budget is spent, and never leaks the countdown', () => {
    const h = authFailureHeaders('req_1', { allowed: false, limit: 10, remaining: 0, resetSec: 90 });
    expect(h['Retry-After']).toBe('90');
    // RateLimit-Remaining on a 401 is a count of the guesses left, which is a number worth having
    // only if you are guessing.
    expect(Object.keys(h)).toEqual(['X-Request-Id', 'Retry-After']);
  });

  it('never emits a Retry-After of zero', () => {
    const h = authFailureHeaders('req_1', { allowed: false, limit: 10, remaining: 0, resetSec: 0 });
    expect(h['Retry-After']).toBe('1');
  });
});

describe('retryMessage', () => {
  it('reads the same for both limiters, so a pre-auth 429 is not a new signal', () => {
    expect(retryMessage(1)).toBe('Too many requests. Retry in 1 second.');
    expect(retryMessage(30)).toBe('Too many requests. Retry in 30 seconds.');
  });
});

describe('an unauthenticated request is metered', () => {
  it('charges the pre-auth bucket for a request that carries no key at all', async () => {
    const res = await call('10.0.0.1');
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe('missing_api_key');
    // The whole point: this request never reached authenticate() successfully and used to cost
    // nothing. It is now on two counters.
    expect(chargedDimensions()).toEqual(['authfail_ip', 'preauth_ip']);
  });

  it('STOPS ANSWERING once the failure budget is spent, rather than advising a wait it cannot enforce', async () => {
    const first = await call('10.0.0.2', GOOD_FORMAT_KEY);
    const second = await call('10.0.0.2', GOOD_FORMAT_KEY);
    const third = await call('10.0.0.2', GOOD_FORMAT_KEY);

    // The first version of this test asserted that all three answered an identical 401, on the
    // reasoning that a throttled answer differing from a fresh one is itself an oracle. That
    // reasoning is right about WHICH KEY EXISTS and wrong about the control: a budget whose only
    // consequence is a Retry-After header is a budget nothing enforces, because an attacker
    // guessing keys does not read headers. The counter moved and the guessing stayed free.
    //
    // So: identical 401 while there is budget, and a 429 once there is not. The 429 tells the
    // caller only how often THEY have failed, which they already know. What must stay
    // indistinguishable — unknown key versus revoked key versus expired key — still is.
    for (const res of [first, second]) {
      expect(res.status).toBe(401);
      expect((await res.clone().json()).error.type).toBe('invalid_api_key');
    }
    expect(first.headers.get('Retry-After')).toBeNull();
    expect(second.headers.get('Retry-After')).toBeNull();

    expect(third.status).toBe(429);
    expect((await third.clone().json()).error.type).toBe('rate_limit_exceeded');
    // Whatever is left of the five-minute window, never zero and never longer than the window.
    const wait = Number(third.headers.get('Retry-After'));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(300);

    // THE ORACLE PROPERTY, ASSERTED WHERE IT ACTUALLY LIVES: two refusals made WITHIN budget must be
    // byte-identical apart from the correlation id, whatever the reason the credential was rejected.
    // That is what stops a caller distinguishing an unknown key from a revoked one. The throttled
    // answer is allowed to differ, because it describes the caller's own rate and nothing else.
    const a = (await first.json()).error;
    const b = (await second.json()).error;
    expect(b.type).toBe(a.type);
    expect(b.message).toBe(a.message);
    expect(b.request_id).not.toBe(a.request_id);
  });

  it('stops querying the keys table once the pre-auth ceiling is reached', async () => {
    for (let i = 0; i < 3; i++) await call('10.0.0.3', GOOD_FORMAT_KEY);
    expect(queriedKeysTable()).toBe(true);

    state.statements.length = 0;
    const blocked = await call('10.0.0.3', GOOD_FORMAT_KEY);

    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.type).toBe('rate_limit_exceeded');
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    // The half of the fix that is about our database and not about their guessing: a refused
    // request must stop costing us a lookup.
    expect(queriedKeysTable()).toBe(false);
  });
});

describe('a working key is not made stricter', () => {
  beforeEach(() => {
    state.keyRow = {
      id: 'key-1', org_id: 'org-1', environment: 'production', scopes: ['email.send'],
      expires_at: null, revoked_at: null, rate_limit_per_minute: null,
      org_slug: 'aquintutor', org_name: 'AquinTutor', is_active: true, daily_send_cap: null, mp_org_id: null,
    };
  });

  it('still runs the five-dimension check, charges the pre-auth budget exactly once, and answers 200', async () => {
    const res = await call('10.0.0.4', GOOD_FORMAT_KEY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('RateLimit-Limit')).toBeTruthy();
    expect(res.headers.get('Retry-After')).toBeNull();

    // The existing dimensions are all still charged, where they were charged before.
    expect(chargedDimensions()).toEqual(['endpoint', 'ip', 'key', 'org', 'preauth_ip']);
    // One request, one unit — the pre-auth budget is the same size as `ip`, so a caller that never
    // fails authentication is refused on exactly the request that used to refuse it.
    expect(countFor('preauth_ip')).toBe(1);
    expect(countFor('ip')).toBe(1);
    // A success must never touch the tight bucket; that is what makes throttling refusals safe.
    expect(countFor('authfail_ip')).toBe(0);
  });
});

describe('when the limiter itself is broken', () => {
  it('fails OPEN on the pre-auth bucket, because refusing everyone is the larger incident', async () => {
    state.rejectBucketPrefixes = ['preauth_ip'];
    const res = await call('10.0.0.5', GOOD_FORMAT_KEY);
    // Not a 429: an unreadable counter must not become a total API outage. The request proceeded and
    // got the answer it would have got anyway.
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe('invalid_api_key');
  });

  it('fails CLOSED on the failure bucket, because that request has already been refused', async () => {
    state.rejectBucketPrefixes = ['authfail_ip'];
    const res = await call('10.0.0.6', GOOD_FORMAT_KEY);
    // An unreadable failure counter is treated as a spent one. The caller was getting a refusal
    // either way — they presented a key that does not authenticate — so the only thing failing
    // closed costs them is being asked to wait. Failing OPEN here would hand back the unmetered
    // guessing oracle at precisely the moment we cannot see it happening.
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe('rate_limit_exceeded');
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('does not bill our own database fault to the caller as a credential failure', async () => {
    state.rejectKeyLookup = true;
    const res = await call('10.0.0.7', GOOD_FORMAT_KEY);
    expect(res.status).toBe(500);
    expect((await res.json()).error.type).toBe('internal_error');
    expect(countFor('preauth_ip')).toBe(1);
    expect(countFor('authfail_ip')).toBe(0);
  });
});

describe('the fake actually exercised the limiter', () => {
  it('observed a rate-window upsert, so a shape change breaks loudly instead of passing silently', async () => {
    await call('10.0.0.8');
    expect(state.sawWindowUpsert).toBe(true);
  });
});
