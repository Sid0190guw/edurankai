// MX resolution. No network: the resolvers are injected, which is the only way to test the null-MX
// and NXDOMAIN paths reliably — you cannot rely on a domain on the real Internet staying broken.

import { describe, it, expect } from 'vitest';
import { MxResolver, MxLookupError, domainOf, groupByDomain } from '../src/smtp/mx.js';

describe('domainOf', () => {
  it('takes everything after the last @', () => {
    expect(domainOf('a@example.com')).toBe('example.com');
    expect(domainOf('weird@name@example.com')).toBe('example.com');
    expect(domainOf('Learner@Example.COM')).toBe('example.com');
    expect(domainOf('nonsense')).toBe('');
  });
});

describe('groupByDomain', () => {
  it('groups recipients so one conversation serves a whole domain', () => {
    const groups = groupByDomain(['a@x.com', 'b@y.com', 'c@x.com', 'bad']);
    expect([...groups.keys()]).toEqual(['x.com', 'y.com']);
    expect(groups.get('x.com')).toEqual(['a@x.com', 'c@x.com']);
  });
});

describe('MxResolver', () => {
  it('sorts hosts by preference', async () => {
    const mx = new MxResolver({
      resolveMx: async () => [
        { exchange: 'backup.example.com', priority: 20 },
        { exchange: 'primary.example.com', priority: 10 },
      ],
      shuffle: (i) => i,
    });
    const r = await mx.lookup('example.com');
    expect(r.hosts.map((h) => h.host)).toEqual(['primary.example.com', 'backup.example.com']);
    expect(r.implicit).toBe(false);
  });

  it('randomises within one preference level but keeps levels in order', async () => {
    // RFC 5321 asks for this, and it is how a provider's equal-preference hosts share load instead
    // of every sender in the world hammering whichever one sorts first.
    const mx = new MxResolver({
      resolveMx: async () => [
        { exchange: 'a.example.com', priority: 10 },
        { exchange: 'b.example.com', priority: 10 },
        { exchange: 'z.example.com', priority: 5 },
      ],
      shuffle: (items) => [...items].reverse(),
    });
    const r = await mx.lookup('example.com');
    expect(r.hosts.map((h) => h.host)).toEqual(['z.example.com', 'b.example.com', 'a.example.com']);
  });

  it('falls back to the implicit MX when a domain has an address but no MX', async () => {
    const mx = new MxResolver({
      resolveMx: async () => [],
      resolve4: async () => ['192.0.2.10'],
    });
    const r = await mx.lookup('bare.example');
    expect(r.hosts).toEqual([{ host: 'bare.example', priority: 0 }]);
    expect(r.implicit).toBe(true);
  });

  it('treats NXDOMAIN as permanent', async () => {
    const mx = new MxResolver({
      resolveMx: async () => { throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); },
      resolve4: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); },
      resolve6: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); },
    });
    await expect(mx.lookup('nosuch.invalid')).rejects.toThrow(MxLookupError);
    await expect(mx.lookup('nosuch.invalid')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('treats a DNS server failure as temporary, not as a bad domain', async () => {
    const mx = new MxResolver({
      resolveMx: async () => { throw Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' }); },
      resolve4: async () => { throw Object.assign(new Error('nope'), { code: 'ESERVFAIL' }); },
      resolve6: async () => { throw Object.assign(new Error('nope'), { code: 'ESERVFAIL' }); },
    });
    await expect(mx.lookup('flaky.example')).rejects.toMatchObject({ code: 'ESERVFAIL' });
  });

  it('honours a null MX as a permanent refusal', async () => {
    // RFC 7505: the domain is publishing that it accepts no mail. Retrying for a day would be
    // pointless, and treating "." as a hostname would produce a week of connection failures.
    const mx = new MxResolver({ resolveMx: async () => [{ exchange: '.', priority: 0 }] });
    await expect(mx.lookup('nomail.example')).rejects.toMatchObject({ code: 'ENULLMX' });
  });

  it('caches a positive answer instead of asking again per message', async () => {
    let calls = 0;
    const mx = new MxResolver({
      resolveMx: async () => { calls++; return [{ exchange: 'mx.example.com', priority: 10 }]; },
      now: () => 1000,
    });
    await mx.lookup('example.com');
    const second = await mx.lookup('example.com');
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  it('expires the cache so a fixed domain recovers', async () => {
    let calls = 0;
    let clock = 1000;
    const mx = new MxResolver({
      resolveMx: async () => { calls++; return [{ exchange: 'mx.example.com', priority: 10 }]; },
      now: () => clock,
    });
    await mx.lookup('example.com');
    clock += 10 * 60 * 1000;
    await mx.lookup('example.com');
    expect(calls).toBe(2);
  });
});
