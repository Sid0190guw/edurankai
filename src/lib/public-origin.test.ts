// src/lib/public-origin.test.ts — the loopback rule is the point of this module, so it is what is
// tested. Production shipped https://localhost/... in real invitation and password-reset emails.
import { describe, it, expect, afterEach } from 'vitest';
import { publicOrigin, publicUrl } from '@/lib/public-origin';

const KEYS = ['PUBLIC_SITE_URL', 'SITE_URL', 'NODE_ENV'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function env(v: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, val] of Object.entries(v)) if (val !== undefined) process.env[k] = val;
}

describe('publicOrigin', () => {
  it('falls back to the site constant when nothing is configured', () => {
    env({});
    expect(publicOrigin()).toBe('https://edurankai.in');
  });

  it('prefers PUBLIC_SITE_URL, then SITE_URL', () => {
    env({ PUBLIC_SITE_URL: 'https://a.example', SITE_URL: 'https://b.example' });
    expect(publicOrigin()).toBe('https://a.example');
    env({ SITE_URL: 'https://b.example' });
    expect(publicOrigin()).toBe('https://b.example');
  });

  it('strips a trailing slash so joining never doubles it', () => {
    env({ PUBLIC_SITE_URL: 'https://a.example/' });
    expect(publicOrigin()).toBe('https://a.example');
    expect(publicUrl('/invite/tok')).toBe('https://a.example/invite/tok');
    expect(publicUrl('invite/tok')).toBe('https://a.example/invite/tok');
  });

  // THE BUG THIS MODULE EXISTS FOR. A link in an email that resolves to the recipient's own machine
  // is not a degraded link, it is a dead one — and nothing errors, so nothing is logged.
  it('refuses a loopback host in production, whatever is configured', () => {
    for (const bad of ['http://localhost:4321', 'http://127.0.0.1:3000', 'http://0.0.0.0:8080']) {
      env({ PUBLIC_SITE_URL: bad, NODE_ENV: 'production' });
      expect(publicOrigin()).toBe('https://edurankai.in');
    }
  });

  // Strict by DEFAULT, not only when NODE_ENV says production. An unset or unexpected value must
  // land on the safe side: this is the check that decides whether a locked-out person gets a link
  // they can open.
  it('still refuses loopback when NODE_ENV is unset or unrecognised', () => {
    env({ PUBLIC_SITE_URL: 'http://localhost:4321' });
    expect(publicOrigin()).toBe('https://edurankai.in');
    env({ PUBLIC_SITE_URL: 'http://localhost:4321', NODE_ENV: 'staging' });
    expect(publicOrigin()).toBe('https://edurankai.in');
  });

  it('honours a loopback host in development, where that is the whole point', () => {
    env({ PUBLIC_SITE_URL: 'http://localhost:4321', NODE_ENV: 'development' });
    expect(publicOrigin()).toBe('http://localhost:4321');
  });

  it('falls back rather than emitting a malformed setting as a link', () => {
    env({ PUBLIC_SITE_URL: 'not a url at all' });
    expect(publicOrigin()).toBe('https://edurankai.in');
  });
});
