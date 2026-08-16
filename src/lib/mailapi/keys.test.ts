// src/lib/mailapi/keys.test.ts — API keys, scopes, environment separation, rate limiting, errors.
//
// Everything asserted here is a PURE function, which is the point: the send path's security
// decisions are decidable without a database, a mail server or a live key, so they can be tested at
// the boundary rather than inferred from an integration run that happened to pass.
import { describe, it, expect } from 'vitest';
import {
  hasScope, expandScopes, environmentFromKey, looksLikeKey, mintKeyString, keyPrefix, maskKey,
  hashKey, extractKey, isEnvironment, isScope, slugify, isUuid, ALL_SCOPES, DEFAULT_SCOPES,
} from './keys';
import {
  windowStartMs, resetInSec, bucketKey, decide, strictest, rateLimitHeaders, clientIp, DEFAULT_LIMITS,
} from './ratelimit';
import { statusFor, ApiError, readJsonBody, newRequestId } from './errors';

describe('scopes', () => {
  it('grants an exact match and nothing else', () => {
    expect(hasScope(['email.send'], 'email.send')).toBe(true);
    expect(hasScope(['email.send'], 'email.read')).toBe(false);
    expect(hasScope(['templates.read'], 'templates.write')).toBe(false);
  });

  it('honours a namespace wildcard but does not let it cross namespaces', () => {
    expect(hasScope(['email.*'], 'email.send')).toBe(true);
    expect(hasScope(['email.*'], 'email.read')).toBe(true);
    // The whole point of a prefix wildcard: "everything about email" is not "everything".
    expect(hasScope(['email.*'], 'templates.write')).toBe(false);
    expect(hasScope(['email.*'], 'domains.write')).toBe(false);
  });

  it('honours a full wildcard', () => {
    for (const s of ALL_SCOPES) expect(hasScope(['*'], s)).toBe(true);
  });

  it('refuses an empty or missing grant set', () => {
    expect(hasScope([], 'email.send')).toBe(false);
    expect(hasScope(null, 'email.send')).toBe(false);
    expect(hasScope(undefined, 'email.send')).toBe(false);
  });

  it('expands a wildcard to the concrete scopes it covers', () => {
    expect(expandScopes(['email.*'])).toEqual(['email.send', 'email.read']);
    expect(expandScopes(['*']).length).toBe(ALL_SCOPES.length);
  });

  it('the default scope set can send and read back, and cannot write templates or domains', () => {
    expect(hasScope(DEFAULT_SCOPES, 'email.send')).toBe(true);
    expect(hasScope(DEFAULT_SCOPES, 'email.read')).toBe(true);
    expect(hasScope(DEFAULT_SCOPES, 'events.read')).toBe(true);
    expect(hasScope(DEFAULT_SCOPES, 'templates.write')).toBe(false);
    expect(hasScope(DEFAULT_SCOPES, 'domains.write')).toBe(false);
  });

  it('validates scope and environment names', () => {
    expect(isScope('email.send')).toBe(true);
    expect(isScope('email.delete')).toBe(false);
    expect(isEnvironment('production')).toBe(true);
    expect(isEnvironment('prod')).toBe(false);
  });
});

describe('key format and environment separation', () => {
  it('a key declares its own environment', () => {
    expect(environmentFromKey(mintKeyString('development'))).toBe('development');
    expect(environmentFromKey(mintKeyString('staging'))).toBe('staging');
    expect(environmentFromKey(mintKeyString('production'))).toBe('production');
  });

  it('refuses anything that is not one of our keys', () => {
    expect(environmentFromKey('')).toBe(null);
    expect(environmentFromKey('erk_live_' + 'a'.repeat(48))).toBe(null);   // the partner-API key format
    expect(environmentFromKey('erm_prod_' + 'a'.repeat(64))).toBe(null);   // not a known environment token
    expect(environmentFromKey('erm_live_short')).toBe(null);
    expect(environmentFromKey('erm_live_' + 'z'.repeat(64))).toBe(null);   // not hex
    expect(looksLikeKey('Bearer erm_live_abc')).toBe(false);
  });

  it('two keys are never the same', () => {
    const a = mintKeyString('production');
    const b = mintKeyString('production');
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(70);
  });

  it('stores a hash, shows a prefix, and the prefix cannot reconstruct the key', () => {
    const key = mintKeyString('production');
    expect(hashKey(key)).toHaveLength(64);
    expect(hashKey(key)).not.toContain(key.slice(9, 20));
    expect(keyPrefix(key)).toBe(key.slice(0, 16));
    expect(maskKey(key).startsWith('erm_live_')).toBe(true);
    expect(maskKey(key)).not.toContain(key.slice(20, 40));
  });

  it('reads the key from either header, and never from the query string', () => {
    const key = mintKeyString('staging');
    expect(extractKey(new Request('https://x.test', { headers: { 'x-api-key': key } }))).toBe(key);
    expect(extractKey(new Request('https://x.test', { headers: { authorization: 'Bearer ' + key } }))).toBe(key);
    expect(extractKey(new Request('https://x.test', { headers: { authorization: 'bearer ' + key } }))).toBe(key);
    // A secret in a URL lands in access logs, proxies and browser history.
    expect(extractKey(new Request('https://x.test/?api_key=' + key))).toBe('');
  });
});

describe('small helpers', () => {
  it('slugify produces a stable organization slug', () => {
    expect(slugify('AquinTutor')).toBe('aquintutor');
    expect(slugify('EduRankAI  Careers!')).toBe('edurankai-careers');
    expect(slugify('---')).toBe('');
  });

  it('isUuid rejects the strings that would raise 22P02 in Postgres', () => {
    expect(isUuid('4f1c4a2e-0e1b-4a5d-9f3e-2b6c8d0a1e5f')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('rate limiting arithmetic', () => {
  it('a window starts on its own boundary', () => {
    const t = Date.parse('2026-08-16T10:00:37.500Z');
    expect(new Date(windowStartMs(t, 60)).toISOString()).toBe('2026-08-16T10:00:00.000Z');
    expect(new Date(windowStartMs(t, 3600)).toISOString()).toBe('2026-08-16T10:00:00.000Z');
  });

  it('reset is the time left in the window and is never zero', () => {
    const t = Date.parse('2026-08-16T10:00:37.500Z');
    expect(resetInSec(t, 60)).toBe(23);
    expect(resetInSec(Date.parse('2026-08-16T10:00:59.999Z'), 60)).toBe(1);
    expect(resetInSec(Date.parse('2026-08-16T10:00:00.000Z'), 60)).toBe(60);
  });

  it('the boundary case is exactly at the limit, not one past it', () => {
    expect(decide(299, 300, 10).allowed).toBe(true);
    expect(decide(300, 300, 10).allowed).toBe(true);
    expect(decide(301, 300, 10).allowed).toBe(false);
    expect(decide(300, 300, 10).remaining).toBe(0);
    expect(decide(250, 300, 10).remaining).toBe(50);
    expect(decide(400, 300, 10).remaining).toBe(0);
  });

  it('the binding decision is the blocked one, even when another has less headroom', () => {
    const blocked = { allowed: false, limit: 600, remaining: 0, resetSec: 12 };
    const tight = { allowed: true, limit: 10, remaining: 1, resetSec: 5 };
    expect(strictest([tight, blocked])).toBe(blocked);
    expect(strictest([tight, { allowed: true, limit: 300, remaining: 200, resetSec: 5 }])).toBe(tight);
    expect(strictest([]).allowed).toBe(true);
  });

  it('headers carry Retry-After only when blocked', () => {
    const ok = rateLimitHeaders(decide(1, 300, 42));
    expect(ok['RateLimit-Limit']).toBe('300');
    expect(ok['RateLimit-Remaining']).toBe('299');
    expect(ok['RateLimit-Reset']).toBe('42');
    expect(ok['Retry-After']).toBeUndefined();
    expect(rateLimitHeaders(decide(999, 300, 42))['Retry-After']).toBe('42');
  });

  it('buckets separate the dimensions they are meant to separate', () => {
    expect(bucketKey('org', 'A', 60)).not.toBe(bucketKey('key', 'A', 60));
    expect(bucketKey('org', 'A', 60)).not.toBe(bucketKey('org', 'B', 60));
    expect(bucketKey('org', 'A', 60)).toBe(bucketKey('org', 'A', 60));
  });

  it('every dimension has a positive default limit', () => {
    for (const [name, limit] of Object.entries(DEFAULT_LIMITS)) {
      expect(limit.limit, name).toBeGreaterThan(0);
      expect(limit.windowSec, name).toBeGreaterThan(0);
    }
  });

  it('takes the first forwarded IP and never lets it grow unbounded', () => {
    const r = new Request('https://x.test', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(clientIp(r)).toBe('203.0.113.7');
    expect(clientIp(new Request('https://x.test'), '198.51.100.4')).toBe('198.51.100.4');
    expect(clientIp(new Request('https://x.test'))).toBe('unknown');
    expect(clientIp(new Request('https://x.test', { headers: { 'x-forwarded-for': 'a'.repeat(200) } })).length).toBe(64);
  });
});

describe('error envelope', () => {
  it('each code maps to the status a client should branch on', () => {
    expect(statusFor('missing_api_key')).toBe(401);
    expect(statusFor('invalid_api_key')).toBe(401);
    expect(statusFor('expired_api_key')).toBe(401);
    expect(statusFor('revoked_api_key')).toBe(401);
    expect(statusFor('insufficient_scope')).toBe(403);
    expect(statusFor('environment_mismatch')).toBe(403);
    expect(statusFor('idempotency_key_reused')).toBe(409);
    expect(statusFor('template_not_published')).toBe(422);
    expect(statusFor('rate_limit_exceeded')).toBe(429);
    expect(statusFor('payload_too_large')).toBe(413);
    expect(statusFor('no_transport')).toBe(503);
  });

  it('carries its code, param and extras', () => {
    const e = new ApiError('insufficient_scope', 'nope', { param: 'scopes', extra: { required_scope: 'email.send' } });
    expect(e.code).toBe('insufficient_scope');
    expect(e.param).toBe('scopes');
    expect(e.extra).toEqual({ required_scope: 'email.send' });
    expect(e).toBeInstanceOf(Error);
  });

  it('request ids are unique and recognisable', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    expect(newRequestId().startsWith('req_')).toBe(true);
  });
});

describe('large payloads', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://x.test/api/v1/email/send', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

  it('refuses a body over the ceiling', async () => {
    const big = JSON.stringify({ html: 'x'.repeat(2000) });
    await expect(readJsonBody(post(big), 1000)).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('refuses a LIED-ABOUT content-length before reading it', async () => {
    // The header is a claim. It is checked, and so are the bytes that actually arrive.
    await expect(readJsonBody(post('{}', { 'content-length': '999999' }), 1000)).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('accepts a body inside the ceiling and parses it', async () => {
    await expect(readJsonBody(post('{"a":1}'), 1000)).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(post(''), 1000)).resolves.toEqual({});
  });

  it('reports malformed JSON as invalid_json, not as a 500', async () => {
    await expect(readJsonBody(post('{oops'), 1000)).rejects.toMatchObject({ code: 'invalid_json' });
  });
});
