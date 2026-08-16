// src/lib/mailsec/net.test.ts — the addresses a mail probe must refuse.
//
// The arithmetic is pure, so every range is asserted directly rather than through a network call.
// The lookup-dependent paths get the two cases that do not need one: a literal address, and a
// hostname shape that is refused before any resolver is asked.
import { describe, it, expect } from 'vitest';
import {
  ipv4Refusal, ipv6Refusal, addressRefusal, isPublicAddress, isPlausibleHostname,
  assertSafeMailTarget, assertSafeOutboundUrl, MAIL_PORTS,
} from './net';

describe('IPv4 ranges', () => {
  const BLOCKED = [
    ['0.0.0.0', 'the unspecified block'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['10.0.0.1', 'a private network'],
    ['10.255.255.254', 'a private network'],
    ['172.16.0.1', 'a private network'],
    ['172.31.255.254', 'a private network'],
    ['192.168.1.1', 'a private network'],
    ['169.254.169.254', 'link-local, where cloud metadata lives'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'a reserved block'],
    ['198.18.0.1', 'a benchmarking block'],
    ['192.0.2.1', 'a documentation block'],
  ] as const;

  for (const [ip, why] of BLOCKED) {
    it('refuses ' + ip, () => expect(ipv4Refusal(ip)).toBe(why));
  }

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '52.95.110.1', '172.32.0.1', '172.15.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1']) {
      expect(ipv4Refusal(ip), ip).toBeNull();
    }
  });

  it('does not mistake a near-miss for a private range', () => {
    // 172.16/12 ends at 172.31.255.255; 172.32 is public. Off-by-one here would block real hosts.
    expect(ipv4Refusal('172.32.0.0')).toBeNull();
    expect(ipv4Refusal('172.15.255.255')).toBeNull();
    expect(ipv4Refusal('9.255.255.255')).toBeNull();
    expect(ipv4Refusal('11.0.0.0')).toBeNull();
  });

  it('refuses malformed input rather than guessing', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'a.b.c.d', '01.02.03.04.05']) {
      expect(ipv4Refusal(bad), bad).not.toBeNull();
    }
  });
});

describe('IPv6 ranges', () => {
  it('refuses loopback, link-local, unique-local and multicast', () => {
    expect(ipv6Refusal('::1')).toBe('loopback');
    expect(ipv6Refusal('fe80::1')).toBe('link-local');
    expect(ipv6Refusal('fd00::1')).toBe('a private network');
    expect(ipv6Refusal('fc00::1')).toBe('a private network');
    expect(ipv6Refusal('ff02::1')).toBe('multicast');
    expect(ipv6Refusal('::')).toBe('the unspecified address');
    expect(ipv6Refusal('2001:db8::1')).toBe('a documentation block');
  });

  it('sees through IPv4-mapped notation, which is the same destination in different clothes', () => {
    expect(ipv6Refusal('::ffff:127.0.0.1')).toBe('loopback');
    expect(ipv6Refusal('::ffff:169.254.169.254')).toBe('link-local, where cloud metadata lives');
    expect(ipv6Refusal('::ffff:10.0.0.1')).toBe('a private network');
    expect(ipv6Refusal('::ffff:8.8.8.8')).toBeNull();
  });

  it('ignores a zone suffix and brackets', () => {
    expect(ipv6Refusal('[fe80::1%eth0]')).toBe('link-local');
  });

  it('allows a public v6 address', () => {
    expect(ipv6Refusal('2606:4700:4700::1111')).toBeNull();
  });
});

describe('addressRefusal / isPublicAddress', () => {
  it('routes each family to the right rules', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('2606:4700::1')).toBe(true);
    expect(isPublicAddress('::1')).toBe(false);
    expect(addressRefusal('not-an-address')).not.toBeNull();
  });
});

describe('isPlausibleHostname', () => {
  it('accepts a real mail host', () => {
    for (const h of ['mail.edurankai.in', 'smtp.office365.com', 'a.b.c.d.example.com', 'xn--80ak6aa92e.com', 'example.com.']) {
      expect(isPlausibleHostname(h), h).toBe(true);
    }
  });

  it('refuses a single label, which is only ever a machine on the local network', () => {
    for (const h of ['localhost', 'mailserver', 'db']) expect(isPlausibleHostname(h), h).toBe(false);
  });

  it('refuses a URL pasted into a host field', () => {
    for (const h of [
      'https://mail.example.com', 'mail.example.com/path', 'mail.example.com:587',
      'user@mail.example.com', 'mail example.com', 'mail.example.com\nX-Injected: 1', '-lead.example.com',
    ]) {
      expect(isPlausibleHostname(h), h).toBe(false);
    }
  });
});

describe('assertSafeMailTarget', () => {
  it('refuses a port that is not a mail port', async () => {
    for (const port of [22, 80, 443, 3306, 5432, 6379, 8080, 9200, 11211, 27017]) {
      const v = await assertSafeMailTarget('mail.example.com', port);
      expect(v.allowed, String(port)).toBe(false);
      expect(v.code).toBe('bad-port');
    }
  });

  it('accepts every port a mail probe legitimately uses', () => {
    for (const p of [25, 110, 143, 465, 587, 993, 995, 2525]) expect(MAIL_PORTS.has(p)).toBe(true);
  });

  it('refuses a literal private address without touching DNS', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.0.1', '::1', '::ffff:127.0.0.1']) {
      const v = await assertSafeMailTarget(ip, 587);
      expect(v.allowed, ip).toBe(false);
      expect(v.code).toBe('private-address');
    }
  });

  it('does not echo the blocked address back to the caller', async () => {
    const v = await assertSafeMailTarget('169.254.169.254', 587);
    expect(v.reason).not.toContain('169.254');
  });

  it('accepts a literal public address', async () => {
    const v = await assertSafeMailTarget('8.8.8.8', 587);
    expect(v.allowed).toBe(true);
    expect(v.addresses).toEqual(['8.8.8.8']);
    expect(v.family).toBe(4);
  });

  it('refuses an empty host with a sentence, not a code', async () => {
    const v = await assertSafeMailTarget('', 587);
    expect(v.code).toBe('empty-host');
    expect(v.reason.length).toBeGreaterThan(10);
  });

  it('refuses a host that is really a URL before it resolves anything', async () => {
    const v = await assertSafeMailTarget('http://mail.example.com/x', 587);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('bad-host');
  });

  it('honours the private escape hatch when it is explicitly passed', async () => {
    const v = await assertSafeMailTarget('10.0.0.5', 587, { allowPrivate: true });
    expect(v.allowed).toBe(true);
  });
});

describe('assertSafeOutboundUrl', () => {
  it('refuses a non-http scheme', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://x.example', 'ftp://x.example']) {
      expect((await assertSafeOutboundUrl(u)).allowed, u).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', async () => {
    const v = await assertSafeOutboundUrl('https://user:pass@example.com/hook');
    expect(v.allowed).toBe(false);
  });

  it('refuses a loopback URL', async () => {
    expect((await assertSafeOutboundUrl('http://127.0.0.1:80/x')).allowed).toBe(false);
    expect((await assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).allowed).toBe(false);
  });

  it('refuses something that is not a URL at all', async () => {
    expect((await assertSafeOutboundUrl('not a url')).allowed).toBe(false);
  });
});
