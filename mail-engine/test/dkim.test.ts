// DKIM key handling. A signature is only worth anything if the public half is published correctly,
// so the DNS record is generated with the key and tested alongside it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createVerify, createSign } from 'node:crypto';
import { generateDkimKey, dnsRecordFor, pemToBase64, publicKeyFromPrivate, DkimKeyStore, nodemailerDkim, DKIM_HEADER_FIELDS } from '../src/dkim.js';
import { tempDir, removeDir } from './helpers/harness.js';

describe('generateDkimKey', () => {
  const pair = generateDkimKey('edurankai.in', 'era1');

  it('produces a usable 2048-bit key pair', () => {
    expect(pair.privateKey).toContain('BEGIN PRIVATE KEY');
    // 2048-bit SPKI in base64 is ~392 characters. 1024-bit would be ~216 — the assertion is here so
    // a "small key for speed" change fails a test instead of quietly weakening every signature.
    expect(pair.publicKeyB64.length).toBeGreaterThan(360);
  });

  it('the private key really signs what the public key verifies', () => {
    const data = Buffer.from('from:to:subject');
    const signature = createSign('sha256').update(data).sign(pair.privateKey);
    const publicPem = `-----BEGIN PUBLIC KEY-----\n${pair.publicKeyB64.replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`;
    expect(createVerify('sha256').update(data).verify(publicPem, signature)).toBe(true);
  });

  it('hands back the exact record to publish', () => {
    expect(pair.dnsName).toBe('era1._domainkey.edurankai.in');
    expect(pair.dnsValue).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
  });
});

describe('dnsRecordFor', () => {
  it('splits the value into quoted strings under the 255-character DNS limit', () => {
    const key = generateDkimKey('edurankai.in', 'era1');
    const record = dnsRecordFor(key);
    const chunks = record.quoted.split('" "');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.replace(/"/g, '').length).toBeLessThanOrEqual(255);
    // Reassembled, the split form has to be byte-identical to the single-string form.
    expect(record.quoted.replace(/" "/g, '').replace(/"/g, '')).toBe(record.value);
  });
});

describe('pemToBase64 / publicKeyFromPrivate', () => {
  it('round-trips a key through its armour', () => {
    const pair = generateDkimKey('test.invalid', 'era1');
    expect(publicKeyFromPrivate(pair.privateKey)).toBe(pair.publicKeyB64);
    expect(pemToBase64(pair.privateKey)).not.toContain('\n');
  });
});

describe('DkimKeyStore', () => {
  let dir: string;

  beforeEach(async () => { dir = await tempDir('keys'); });
  afterEach(async () => { await removeDir(dir); });

  it('writes a key and reads it back', async () => {
    const store = new DkimKeyStore(dir, 'era1');
    const pair = generateDkimKey('edurankai.in', 'era1');
    const file = await store.write(pair);
    expect(file).toContain('edurankai.in.private');

    const loaded = await store.get('EduRankAI.in');   // case-insensitive, as domains are
    expect(loaded?.privateKey).toBe(pair.privateKey);
    expect(loaded?.selector).toBe('era1');
  });

  it('returns null rather than throwing when a domain has no key', async () => {
    // The caller then sends unsigned AND SAYS SO. Throwing here would stop mail entirely for a
    // domain whose key has not been generated yet.
    expect(await new DkimKeyStore(dir, 'era1').get('unknown.example')).toBeNull();
  });

  it('reports which domains can be signed', async () => {
    const store = new DkimKeyStore(dir, 'era1');
    await store.write(generateDkimKey('edurankai.in', 'era1'));
    const status = await store.status(['edurankai.in', 'other.example']);
    expect(status).toEqual([
      { domain: 'edurankai.in', signed: true, selector: 'era1', dnsName: 'era1._domainkey.edurankai.in' },
      { domain: 'other.example', signed: false, selector: 'era1', dnsName: 'era1._domainkey.other.example' },
    ]);
  });

  it('ignores a file that is not a private key', async () => {
    const store = new DkimKeyStore(dir, 'era1');
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(store.keyPath('broken.example'), 'this is not a key', 'utf8');
    expect(await store.get('broken.example')).toBeNull();
  });
});

describe('nodemailerDkim', () => {
  it('signs the headers a receiver checks, and no more', () => {
    // Signing headers a sender does not control is how a signature breaks in transit: a list that
    // appends List-Id to a message that signed List-Id invalidates it.
    const opts = nodemailerDkim(generateDkimKey('edurankai.in', 'era1'));
    expect(opts?.headerFieldNames).toBe(DKIM_HEADER_FIELDS);
    expect(opts?.headerFieldNames).toContain('from');
    expect(opts?.headerFieldNames).toContain('subject');
    expect(opts?.headerFieldNames).not.toContain('list-id');
    expect(opts?.headerFieldNames).not.toContain('received');
  });

  it('is undefined with no key, so the caller can record an unsigned send', () => {
    expect(nodemailerDkim(null)).toBeUndefined();
  });
});
