// The mail-stack signer and the app-side verifier must agree, forever.
//
// src/lib/mailops/webhook.ts (TypeScript, runs in the Astro app) VERIFIES what
// docker/mailops/sign.mjs (plain ESM, runs in a container with no build step) SIGNS. They are two
// implementations of one wire format, kept separate for a real reason — see the header of sign.mjs
// — and a divergence between them does not fail at build time, does not fail in any unit test of
// either file, and does not fail in a code review. It fails in production as "inbound mail stopped
// arriving", weeks after the change, with a 401 that names no cause.
//
// This test is the seam. It imports both and asserts the bytes match.
import { describe, it, expect } from 'vitest';
import { sign as tsSign, signingString as tsSigningString, verifyInbound, SIG_VERSION as TS_VERSION, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '@/lib/mailops/webhook';
import { sign as jsSign, signingString as jsSigningString, signedHeaders as jsSignedHeaders, SIG_VERSION as JS_VERSION } from '../../../docker/mailops/sign.mjs';

const SECRET = 'parity-secret';
const NOW = 1_770_000_000_000;

describe('signer parity: docker/mailops/sign.mjs vs src/lib/mailops/webhook.ts', () => {
  it('uses the same version prefix', () => {
    expect(JS_VERSION).toBe(TS_VERSION);
  });

  it('builds the same signing string', () => {
    expect(jsSigningString('v1', 1700, '{"a":1}')).toBe(tsSigningString('v1', 1700, '{"a":1}'));
  });

  it('produces byte-identical signatures', () => {
    for (const body of ['', '{}', '{"to":"a@b.c","subject":"Unicode check and \\"quotes\\""}', 'x'.repeat(10_000)]) {
      expect(jsSign(SECRET, body, 1700)).toBe(tsSign(SECRET, body, 1700));
    }
  });

  it('headers written by the container verify in the app', async () => {
    const body = JSON.stringify({ to: 'inbox@edurankai.in', subject: 'from the MTA' });
    const headers = jsSignedHeaders(SECRET, body, { now: NOW });
    const r = await verifyInbound(new Headers(headers), body, { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.scheme).toBe('hmac');
    expect(r.deliveryId).toBeTruthy();
  });

  it('a container signing with the wrong secret is rejected', async () => {
    const body = '{"x":1}';
    const headers = jsSignedHeaders('wrong-secret', body, { now: NOW });
    const r = await verifyInbound(new Headers(headers), body, { hmacSecret: SECRET, now: NOW });
    expect(r.ok).toBe(false);
  });

  it('the header names match on both sides', () => {
    const headers = jsSignedHeaders(SECRET, '{}', { now: NOW });
    expect(Object.keys(headers)).toContain(SIGNATURE_HEADER);
    expect(Object.keys(headers)).toContain(TIMESTAMP_HEADER);
  });
});
