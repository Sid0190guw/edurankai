// src/lib/mailplatform/domains/dkim.test.ts — key generation, the DNS form, and rotation.
// Run: npx vitest run src/lib/mailplatform/domains/dkim.test.ts
import { describe, it, expect } from 'vitest';
import { createPublicKey, createSign, createVerify, sign as edSign, verify as edVerify } from 'node:crypto';
import {
  generateDkimKeyPair, publicKeyToDkimP, dkimDnsValue, parseDkimRecord, verifyDkimPublished,
  isValidSelector, nextSelector, dkimHost, txtChunks, quotedTxt, planRotation,
} from './dkim';

describe('selectors', () => {
  it('accepts DNS-label selectors and refuses the rest', () => {
    expect(isValidSelector('era20260816')).toBe(true);
    expect(isValidSelector('s1')).toBe(true);
    expect(isValidSelector('-bad')).toBe(false);
    expect(isValidSelector('has space')).toBe(false);
    expect(isValidSelector('')).toBe(false);
    expect(isValidSelector('a'.repeat(64))).toBe(false);
  });

  it('mints a date-stamped selector and never reuses a live one', () => {
    const now = new Date(Date.UTC(2026, 7, 16));
    expect(nextSelector([], 'era', now)).toBe('era20260816');
    // A second rotation on the same day must not land on the selector that is still signing.
    expect(nextSelector(['era20260816'], 'era', now)).toBe('era20260816-2');
    expect(nextSelector(['era20260816', 'era20260816-2'], 'era', now)).toBe('era20260816-3');
  });

  it('builds the lookup name', () => {
    expect(dkimHost('era1', 'EduRankAI.in')).toBe('era1._domainkey.edurankai.in');
  });
});

describe('RSA key generation', () => {
  const key = generateDkimKeyPair({ selector: 'era1', domain: 'edurankai.in', keySize: 2048 });

  it('produces a publishable record', () => {
    expect(key.algorithm).toBe('rsa-sha256');
    expect(key.keySize).toBe(2048);
    expect(key.dnsHost).toBe('era1._domainkey.edurankai.in');
    expect(key.dnsValue).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('the p= value is the SPKI DER of the private key, so signatures actually verify', () => {
    // The point of the whole subsystem: a receiver takes p=, and must be able to verify a signature
    // made with the private half. A record that merely LOOKS right is the failure mode that costs
    // days, so this test does the receiver's job.
    const message = Buffer.from('from:someone@edurankai.in\r\nsubject:hello\r\n');
    const signature = createSign('RSA-SHA256').update(message).sign({ key: key.privateKeyPem });
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(createVerify('RSA-SHA256').update(message).verify(publicKey, signature)).toBe(true);
  });

  it('refuses key sizes outside the offered range', () => {
    expect(() => generateDkimKeyPair({ selector: 'x', domain: 'e.in', keySize: 1024 })).toThrow(/2048/);
    expect(() => generateDkimKeyPair({ selector: 'x', domain: 'e.in', keySize: 8192 })).toThrow(/4096/);
  });

  it('refuses an invalid selector before generating anything', () => {
    expect(() => generateDkimKeyPair({ selector: 'not valid', domain: 'e.in' })).toThrow(/selector/);
  });
});

describe('Ed25519 key generation', () => {
  const key = generateDkimKeyPair({ selector: 'ed1', domain: 'edurankai.in', algorithm: 'ed25519-sha256' });

  it('publishes the RAW 32-byte key, not the SPKI wrapper (RFC 8463)', () => {
    expect(key.dnsValue).toContain('k=ed25519');
    const raw = Buffer.from(key.publicKey, 'base64');
    expect(raw.length).toBe(32);
  });

  it('signatures made with the private half verify against the published key', () => {
    const message = Buffer.from('test message');
    const signature = edSign(null, message, key.privateKeyPem);
    // Rebuild the SPKI wrapper a verifier needs from the raw published key.
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(key.publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    expect(edVerify(null, message, publicKey, signature)).toBe(true);
  });
});

describe('record parsing and comparison', () => {
  it('parses a well-formed record', () => {
    const p = parseDkimRecord('v=DKIM1; k=rsa; p=MIIBIjANBg');
    expect(p.ok).toBe(true);
    expect(p.keyType).toBe('rsa');
    expect(p.publicKey).toBe('MIIBIjANBg');
  });

  it('strips whitespace a DNS panel inserted into the key', () => {
    expect(parseDkimRecord('v=DKIM1; k=rsa; p=MIIB Ij ANBg').publicKey).toBe('MIIBIjANBg');
  });

  it('recognises an empty p= as a REVOCATION rather than a missing key', () => {
    const p = parseDkimRecord('v=DKIM1; k=rsa; p=');
    expect(p.revoked).toBe(true);
    expect(p.warnings.join(' ')).toContain('REVOKING');
  });

  it('reads the testing flag', () => {
    expect(parseDkimRecord('v=DKIM1; k=rsa; t=y; p=AAA').testing).toBe(true);
  });

  it('distinguishes absent, mismatched, revoked and malformed', () => {
    const expected = 'MIIBIjANBgkqhkiG9w0BAQ';
    expect(verifyDkimPublished([], expected).result).toBe('absent');
    expect(verifyDkimPublished(['v=DKIM1; k=rsa; p=' + expected], expected).result).toBe('match');

    // WRONG DKIM KEY: a record exists but holds somebody else's key. The instruction for this is
    // different from the instruction for "no record", which is why they are different results.
    const wrong = verifyDkimPublished(['v=DKIM1; k=rsa; p=SOMEOTHERKEY'], expected);
    expect(wrong.result).toBe('mismatch');
    expect(wrong.detail).toContain('previous mail provider');

    expect(verifyDkimPublished(['v=DKIM1; k=rsa; p='], expected).result).toBe('revoked');
    expect(verifyDkimPublished(['google-site-verification=xyz'], expected).result).toBe('malformed');
  });

  it('finds the right record when several TXT records share the name', () => {
    const expected = 'AAAA';
    const out = verifyDkimPublished(['unrelated=value', 'v=DKIM1; k=rsa; p=AAAA'], expected);
    expect(out.result).toBe('match');
  });

  it('reassembles a key split across chunks before comparing', () => {
    const long = 'A'.repeat(300);
    expect(verifyDkimPublished([dkimDnsValue({ publicKey: long, algorithm: 'rsa-sha256' })], long).result).toBe('match');
    expect(txtChunks(long).length).toBe(2);
    expect(quotedTxt(long).startsWith('"')).toBe(true);
    expect(txtChunks(long).join('')).toBe(long);
  });
});

describe('rotation', () => {
  it('never activates and retires in the same step', () => {
    const plan = planRotation([{ selector: 'era1', status: 'active' }], { now: new Date(Date.UTC(2026, 7, 16)) });
    expect(plan.newSelector).toBe('era20260816');
    // The outgoing key becomes `rotating`, NOT `retired`: mail signed with it is still in flight.
    expect(plan.transitions).toEqual([{ selector: 'era1', from: 'active', to: 'rotating' }]);
    expect(plan.steps[0]).toContain('Publish');
    expect(plan.steps.some((s) => /TTL/i.test(s))).toBe(true);
  });

  it('warns when a key that was already mid-rotation gets retired', () => {
    const plan = planRotation(
      [{ selector: 'era1', status: 'active' }, { selector: 'era0', status: 'rotating' }],
      { now: new Date(Date.UTC(2026, 7, 16)) },
    );
    expect(plan.transitions).toContainEqual({ selector: 'era0', from: 'rotating', to: 'retired' });
    expect(plan.warnings.join(' ')).toContain('still in flight');
  });
});

describe('public key extraction', () => {
  it('round-trips a PEM through the p= form', () => {
    const key = generateDkimKeyPair({ selector: 'era1', domain: 'e.in' });
    const pem = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' })
      .export({ type: 'spki', format: 'pem' }) as string;
    expect(publicKeyToDkimP(pem, 'rsa-sha256')).toBe(key.publicKey);
  });
});
