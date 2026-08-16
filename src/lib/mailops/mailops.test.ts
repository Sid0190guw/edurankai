// Unit tests for the mail-platform infrastructure layer.
//
// These are the parts of Patch 4 that can be proved on a machine with no Docker, no database and no
// network — signature verification, CORS decisions, environment grouping, metric formatting. They
// run in CI on every commit. The parts that need a live stack (SMTP delivery, IMAP retrieval, queue
// drain) are in tests/integration and are gated on the stack being up; see docs/mail/TESTING.md for
// which guarantees come from which layer, and which are not yet proved at all.
import { describe, it, expect } from 'vitest';
import { checkEnv, envSummary, type VarSpec } from '@/lib/mailops/env';
import { sign, signedHeaders, verifyInbound, safeEqual, SIGNATURE_HEADER, TIMESTAMP_HEADER, ID_HEADER, LEGACY_SECRET_HEADER } from '@/lib/mailops/webhook';
import { parseOrigins, isAllowedOrigin, corsHeaders, preflightHeaders } from '@/lib/mailops/cors';
import { mintServiceToken, verifyServiceToken, canonicalRequest, bodyHash } from '@/lib/mailops/service-auth';

describe('env contract', () => {
  const specs: VarSpec[] = [
    { name: 'A', tier: 'live', sensitivity: 'public', required: true, note: 'a' },
    { name: 'G1', tier: 'live', sensitivity: 'public', group: 'grp', note: 'g1' },
    { name: 'G2', tier: 'live', sensitivity: 'secret', group: 'grp', note: 'g2' },
  ];

  it('reports a required variable that is absent', () => {
    const r = checkEnv({}, specs);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('A is required');
  });

  it('treats whitespace-only as absent', () => {
    expect(checkEnv({ A: '   ' }, specs).ok).toBe(false);
  });

  it('flags a partially-filled group — the silent-fallback case', () => {
    const r = checkEnv({ A: 'x', G1: 'set' }, specs);
    const grp = r.groups.find((g) => g.group === 'grp')!;
    expect(grp.partial).toBe(true);
    expect(grp.missing).toEqual(['G2']);
    expect(r.ok).toBe(true); // a partial group is a warning, not an outage
  });

  it('does not flag a group that is entirely absent', () => {
    const grp = checkEnv({ A: 'x' }, specs).groups.find((g) => g.group === 'grp')!;
    expect(grp.partial).toBe(false);
  });

  it('catches CRON_SECRET whitespace, which rejects every Vercel deploy', () => {
    const r = checkEnv({ DATABASE_URL: 'x', SESSION_SECRET: 'y', CRON_SECRET: 'abc ' });
    expect(r.errors.some((e) => e.includes('CRON_SECRET'))).toBe(true);
  });

  it('warns when DATABASE_URL uses the Supabase direct port on serverless', () => {
    const r = checkEnv({ DATABASE_URL: 'postgresql://u:p@aws-0-x.pooler.supabase.com:5432/postgres', SESSION_SECRET: 'y' });
    expect(r.warnings.some((w) => w.includes('6543'))).toBe(true);
  });

  it('catches the 587+implicit-TLS mismatch', () => {
    const r = checkEnv({ DATABASE_URL: 'x', SESSION_SECRET: 'y', SMTP_PORT: '587', SMTP_SECURE: 'true' });
    expect(r.warnings.some((w) => w.includes('STARTTLS'))).toBe(true);
  });

  it('never carries a value out of the module', () => {
    const secret = 'super-secret-value-9f3a';
    const r = checkEnv({ DATABASE_URL: secret, SESSION_SECRET: secret });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(envSummary({ DATABASE_URL: secret, SESSION_SECRET: secret }))).not.toContain(secret);
  });
});

describe('inbound webhook verification', () => {
  const SECRET = 'hmac-key';
  const body = JSON.stringify({ to: 'a@edurankai.in', subject: 'hi' });
  const NOW = 1_770_000_000_000; // fixed clock: a time-dependent test fails at midnight, not on a bug

  const headersFor = (extra: Record<string, string>) => new Headers(extra);

  it('accepts a correctly signed request', async () => {
    const h = signedHeaders(SECRET, body, { now: NOW });
    const r = await verifyInbound(headersFor(h as any), body, { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.scheme).toBe('hmac');
  });

  it('rejects a body altered after signing', async () => {
    const h = signedHeaders(SECRET, body, { now: NOW });
    const r = await verifyInbound(headersFor(h as any), body.replace('hi', 'HI'), { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not match');
  });

  it('rejects a replayed request outside the window', async () => {
    const h = signedHeaders(SECRET, body, { now: NOW - 10 * 60 * 1000 });
    const r = await verifyInbound(headersFor(h as any), body, { hmacSecret: SECRET, now: NOW, toleranceSeconds: 300 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('window');
  });

  it('rejects a moved timestamp with the original signature', async () => {
    const h: any = signedHeaders(SECRET, body, { now: NOW });
    h[TIMESTAMP_HEADER] = String(Math.floor(NOW / 1000) + 60); // still inside the window
    const r = await verifyInbound(headersFor(h), body, { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(false); // the timestamp is inside the MAC, so moving it breaks the signature
  });

  it('rejects a duplicate delivery id inside the window', async () => {
    const h = signedHeaders(SECRET, body, { now: NOW, deliveryId: 'delivery-1' });
    const seen = (id: string) => id === 'delivery-1';
    const r = await verifyInbound(headersFor(h as any), body, { hmacSecret: SECRET, now: NOW, seen });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('replay');
  });

  it('still accepts the legacy shared secret, and says that it did', async () => {
    const r = await verifyInbound(headersFor({ [LEGACY_SECRET_HEADER]: 'legacy' }), body, { sharedSecret: 'legacy' });
    expect(r.ok).toBe(true);
    expect(r.scheme).toBe('shared-secret');
    expect(r.legacy).toBe(true);
  });

  it('refuses everything when no secret is configured', async () => {
    const r = await verifyInbound(headersFor({}), body, {});
    expect(r.ok).toBe(false);
    expect(r.scheme).toBe('none');
  });

  it('does not authenticate an empty presented secret against an empty configured one', async () => {
    const r = await verifyInbound(headersFor({ [LEGACY_SECRET_HEADER]: '' }), body, { sharedSecret: '' });
    expect(r.ok).toBe(false);
  });

  it('never echoes the presented signature in the failure reason', async () => {
    const r = await verifyInbound(headersFor({ [SIGNATURE_HEADER]: 'v1=deadbeef', [TIMESTAMP_HEADER]: String(Math.floor(NOW / 1000)) }), body, { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason || '').not.toContain('deadbeef');
  });

  it('signs deterministically for a fixed timestamp', () => {
    expect(sign(SECRET, body, 1700)).toBe(sign(SECRET, body, 1700));
    expect(sign(SECRET, body, 1700)).not.toBe(sign(SECRET, body, 1701));
  });

  it('safeEqual handles length mismatch without throwing', () => {
    expect(safeEqual('a', 'aa')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('emits a delivery id header so the receiver can deduplicate', () => {
    const h: any = signedHeaders(SECRET, body, { now: NOW });
    expect(h[ID_HEADER]).toBeTruthy();
  });
});

describe('CORS policy', () => {
  const allowlist = parseOrigins('https://www.edurankai.in, https://edurankai.in/');

  it('normalises trailing slash and case', () => {
    expect(allowlist).toEqual(['https://www.edurankai.in', 'https://edurankai.in']);
    expect(isAllowedOrigin('HTTPS://WWW.EduRankAI.in', allowlist)).toBe(true);
  });

  it('does not suffix-match', () => {
    expect(isAllowedOrigin('https://evil-edurankai.in.attacker.com', allowlist)).toBe(false);
    expect(isAllowedOrigin('https://sub.edurankai.in', allowlist)).toBe(false);
  });

  it('returns no headers at all for an unknown origin', () => {
    expect(corsHeaders('https://attacker.example', { allowlist, credentials: true })).toEqual({});
  });

  it('echoes exactly one origin and varies on it', () => {
    const h = corsHeaders('https://edurankai.in', { allowlist, credentials: true });
    expect(h['Access-Control-Allow-Origin']).toBe('https://edurankai.in');
    expect(h['Vary']).toBe('Origin');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('never emits a wildcard alongside credentials', () => {
    const h = preflightHeaders('https://edurankai.in', { allowlist, credentials: true });
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
  });

  it('a missing Origin header is not allowed', () => {
    expect(isAllowedOrigin(null, allowlist)).toBe(false);
  });
});

describe('service-to-service auth', () => {
  const KEY = 'service-key';
  const NOW = 1_770_000_000_000;

  it('accepts a token for the request it was minted for', async () => {
    const body = JSON.stringify({ to: 'x@y.z' });
    const t = mintServiceToken({ key: KEY, method: 'POST', path: '/v1/send', body, now: NOW });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'POST', path: '/v1/send', body, now: NOW });
    expect(r.ok).toBe(true);
  });

  it('rejects the same token against a different path', async () => {
    const t = mintServiceToken({ key: KEY, method: 'POST', path: '/v1/send', now: NOW });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'POST', path: '/v1/admin/purge', now: NOW });
    expect(r.ok).toBe(false);
  });

  it('rejects the same token against a different body', async () => {
    const t = mintServiceToken({ key: KEY, method: 'POST', path: '/v1/send', body: '{"to":"a"}', now: NOW });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'POST', path: '/v1/send', body: '{"to":"b"}', now: NOW });
    expect(r.ok).toBe(false);
  });

  it('rejects an expired token and names clock skew', async () => {
    const t = mintServiceToken({ key: KEY, method: 'GET', path: '/v1/health', ttlSeconds: 60, now: NOW });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'GET', path: '/v1/health', now: NOW + 120_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('skew');
  });

  it('refuses a self-minted long-lived token', async () => {
    const t = mintServiceToken({ key: KEY, method: 'GET', path: '/v1/health', ttlSeconds: 86_400, now: NOW });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'GET', path: '/v1/health', now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('long-lived');
  });

  it('rejects a reused nonce', async () => {
    const t = mintServiceToken({ key: KEY, method: 'GET', path: '/v1/health', now: NOW, nonce: 'n1' });
    const r = await verifyServiceToken(t.header, { key: KEY, method: 'GET', path: '/v1/health', now: NOW, seenNonce: (n) => n === 'n1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('replay');
  });

  it('refuses everything when no key is configured', async () => {
    const r = await verifyServiceToken('ERA-HMAC-SHA256 exp=1,nonce=n,sig=s', { key: '', method: 'GET', path: '/' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('refusing all calls');
  });

  it('rejects an unrecognised scheme, including a plain bearer token', async () => {
    const r = await verifyServiceToken('Bearer abcdef', { key: KEY, method: 'GET', path: '/' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('scheme');
  });

  it('the canonical string cannot be confused by path splitting', () => {
    expect(canonicalRequest('POST', '/a/b', 1, 'n')).not.toBe(canonicalRequest('POST', '/a', 1, 'n') + '/b');
  });

  it('hashes an absent body to a fixed known value', () => {
    expect(bodyHash(undefined)).toBe(bodyHash(''));
    expect(bodyHash(undefined)).toHaveLength(64);
  });
});
