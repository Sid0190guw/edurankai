// src/lib/mailplatform/domains/dns-policy.test.ts — the resolver contract, SPF and DMARC.
// Run: npx vitest run src/lib/mailplatform/domains/dns-policy.test.ts
import { describe, it, expect } from 'vitest';
import { joinTxtChunks, reverseName, expandIpv6, isValidDomain, normalizeDomain, staticResolver, dohResolver } from './dns';
import { parseSpf, auditSpf, recommendSpf, spfAuthorises, countLookups, selectSpfRecords, SPF_LOOKUP_LIMIT } from './spf';
import { parseDmarc, auditDmarc, recommendDmarc, policyChangeGuard, checkAlignment, organizationalDomain, dmarcHost } from './dmarc';

describe('resolver primitives', () => {
  it('concatenates split TXT chunks with nothing between them', () => {
    // A DKIM key arrives in 255-byte pieces. A space inserted here produces a record that parses
    // and never verifies.
    expect(joinTxtChunks('"v=DKIM1; k=rsa; p=AAAA" "BBBB"')).toBe('v=DKIM1; k=rsa; p=AAAABBBB');
    expect(joinTxtChunks('v=spf1 -all')).toBe('v=spf1 -all');
    expect(joinTxtChunks('"quoted"')).toBe('quoted');
  });

  it('builds reverse-DNS names', () => {
    expect(reverseName('192.0.2.15')).toBe('15.2.0.192.in-addr.arpa');
    expect(reverseName('999.0.0.1')).toBeNull();
    expect(reverseName('not-an-ip')).toBeNull();
    expect(expandIpv6('2001:db8::1')).toBe('20010db8000000000000000000000001');
    expect(reverseName('2001:db8::1')?.endsWith('.ip6.arpa')).toBe(true);
  });

  it('accepts subdomains as first-class domains and refuses nonsense', () => {
    expect(isValidDomain('edurankai.in')).toBe(true);
    expect(isValidDomain('careers.edurankai.in')).toBe(true);
    expect(isValidDomain('university.edu')).toBe(true);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('-bad.example.com')).toBe(false);
    expect(isValidDomain('user@example.com')).toBe(false);
    expect(isValidDomain('192.168.0.1')).toBe(false);
  });

  it('normalizes the forms a person types, so duplicate detection actually catches duplicates', () => {
    // The unique index is on lower(domain). These four must collapse to one key or "add domain"
    // silently creates a second row for the same domain.
    const forms = ['EduRankAI.IN', 'edurankai.in.', ' edurankai.in ', '*.edurankai.in'];
    expect(new Set(forms.map(normalizeDomain)).size).toBe(1);
  });

  it('THE CENTRAL RULE: a failed lookup is never an empty answer', async () => {
    const r = staticResolver({ txt: { 'broken.example': null, 'empty.example': [] } });
    const failed = await r.txt('broken.example');
    expect(failed.checked).toBe(false);
    expect(failed.values).toEqual([]);
    expect(failed.error).toBeTruthy();

    const absent = await r.txt('empty.example');
    expect(absent.checked).toBe(true);
    expect(absent.values).toEqual([]);
    expect(absent.error).toBeNull();
  });

  it('reports a resolver HTTP failure rather than an empty record set', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    const r = dohResolver({ fetchImpl, endpoints: [{ name: 'test', url: 'https://example.invalid/dns' }] });
    const out = await r.txt('example.com');
    expect(out.checked).toBe(false);
    expect(out.error).toContain('502');
  });

  it('falls back to the second resolver on failure but not on an empty NOERROR', async () => {
    let calls = 0;
    const fetchImpl = (async (url: any) => {
      calls++;
      if (String(url).includes('first')) return new Response('x', { status: 500 });
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = dohResolver({
      fetchImpl,
      endpoints: [{ name: 'first', url: 'https://first.invalid/d' }, { name: 'second', url: 'https://second.invalid/d' }],
    });
    const out = await r.txt('example.com');
    expect(calls).toBe(2);
    expect(out.resolver).toBe('second');
    expect(out.values).toEqual(['v=spf1 -all']);
  });

  it('treats NXDOMAIN as a checked answer, not a lookup failure', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 })) as unknown as typeof fetch;
    const r = dohResolver({ fetchImpl, endpoints: [{ name: 'test', url: 'https://example.invalid/dns' }] });
    const out = await r.txt('nothing.example.com');
    expect(out.checked).toBe(true);
    expect(out.nxdomain).toBe(true);
  });
});

describe('SPF parsing and judgement', () => {
  it('parses mechanisms, qualifiers and lookup cost', () => {
    const p = parseSpf('v=spf1 include:_spf.example.com ip4:192.0.2.0/24 a mx ~all');
    expect(p.ok).toBe(true);
    expect(p.allQualifier).toBe('~');
    // include + a + mx = 3 lookups; ip4 costs none.
    expect(p.directLookups).toBe(3);
  });

  it('refuses a record that is not SPF and one that authorises the world', () => {
    expect(parseSpf('nonsense').ok).toBe(false);
    const plus = parseSpf('v=spf1 +all');
    expect(plus.ok).toBe(false);
    expect(plus.errors.join(' ')).toContain('every server on the internet');
  });

  it('warns about terms after all, and about ptr', () => {
    const p = parseSpf('v=spf1 -all include:late.example.com');
    expect(p.warnings.join(' ')).toContain('never be evaluated');
    expect(parseSpf('v=spf1 ptr ~all').warnings.join(' ')).toContain('deprecated');
  });

  it('flags malformed ip4 and a bare include', () => {
    expect(parseSpf('v=spf1 ip4:999.1.1.1 ~all').errors.join(' ')).toContain('not a valid IPv4');
    expect(parseSpf('v=spf1 include ~all').errors.length).toBeGreaterThan(0);
  });

  it('MULTIPLE SPF RECORDS is reported as the domain having none', () => {
    const audit = auditSpf(['v=spf1 include:a.example.com ~all', 'v=spf1 include:b.example.com ~all', 'unrelated=txt']);
    expect(audit.records).toHaveLength(2);
    expect(audit.healthy).toBe(false);
    expect(audit.errors.join(' ')).toContain('may publish only one');
    expect(audit.errors.join(' ')).toContain('EVERY message');
  });

  it('detects the lookup limit being exceeded within one record', () => {
    const many = 'v=spf1 ' + Array.from({ length: 11 }, (_, i) => 'include:s' + i + '.example.com').join(' ') + ' ~all';
    const p = parseSpf(many);
    expect(p.directLookups).toBe(11);
    expect(p.errors.join(' ')).toContain('permerror');
  });

  it('counts nested includes, and reports a partial tree as a floor rather than a total', async () => {
    const resolver = staticResolver({
      txt: {
        'a.example.com': ['v=spf1 include:b.example.com include:c.example.com ~all'],
        'b.example.com': ['v=spf1 ip4:192.0.2.0/24 ~all'],
        'c.example.com': null, // unreachable
      },
    });
    const count = await countLookups('v=spf1 include:a.example.com ~all', 'example.com', resolver);
    // include:a (1) + include:b (1) + include:c (1) = 3
    expect(count.total).toBe(3);
    expect(count.partial).toBe(true);
    expect(count.unresolved.join(' ')).toContain('c.example.com');
    expect(count.overLimit).toBe(false);
  });

  it('records an include that resolves to no SPF record as a void lookup', async () => {
    const resolver = staticResolver({ txt: { 'void.example.com': ['some-other-txt'] } });
    const count = await countLookups('v=spf1 include:void.example.com ~all', 'example.com', resolver);
    expect(count.voidLookups).toEqual(['void.example.com']);
  });

  it('does not hang on an include cycle', async () => {
    const resolver = staticResolver({
      txt: { 'a.example.com': ['v=spf1 include:b.example.com ~all'], 'b.example.com': ['v=spf1 include:a.example.com ~all'] },
    });
    const count = await countLookups('v=spf1 include:a.example.com ~all', 'example.com', resolver);
    expect(count.total).toBeGreaterThan(0);
    expect(count.total).toBeLessThan(SPF_LOOKUP_LIMIT + 5);
  });
});

describe('SPF recommendation — merge, never replace', () => {
  const source = { includes: ['_spf.edurankai.in'], ip4: [], ip6: [] };

  it('creates a first record with a soft fail', () => {
    const rec = recommendSpf([], source);
    expect(rec.action).toBe('create');
    expect(rec.record).toBe('v=spf1 include:_spf.edurankai.in ~all');
  });

  it('KEEPS EVERY EXISTING MECHANISM and the existing all qualifier', () => {
    // This is the test that matters: the customer's payroll and CRM senders must survive.
    const existing = ['v=spf1 include:payroll.example.net ip4:198.51.100.7 -all'];
    const rec = recommendSpf(existing, source);
    expect(rec.action).toBe('merge');
    expect(rec.record).toBe('v=spf1 include:payroll.example.net ip4:198.51.100.7 include:_spf.edurankai.in -all');
    expect(rec.record).toContain('payroll.example.net');
    expect(rec.record).toContain('198.51.100.7');
    // A hard fail stays a hard fail; we do not quietly relax somebody's policy.
    expect(rec.record.endsWith('-all')).toBe(true);
    expect(rec.additions).toEqual(['include:_spf.edurankai.in']);
  });

  it('inserts new terms BEFORE all, because terms after it are dead', () => {
    const rec = recommendSpf(['v=spf1 ~all'], source);
    const terms = rec.record.split(' ');
    expect(terms.indexOf('include:_spf.edurankai.in')).toBeLessThan(terms.indexOf('~all'));
  });

  it('reports no change when the include is already there', () => {
    const rec = recommendSpf(['v=spf1 include:_spf.edurankai.in ~all'], source);
    expect(rec.action).toBe('unchanged');
    expect(rec.additions).toEqual([]);
  });

  it('REFUSES to merge automatically when two records are published', () => {
    const rec = recommendSpf(['v=spf1 include:a.example.com ~all', 'v=spf1 include:b.example.com -all'], source);
    expect(rec.action).toBe('manual');
    expect(rec.record).toBe('');
    expect(rec.manualReason).toContain('by hand');
  });

  it('refuses to recommend anything when the deployment has no sending source configured', () => {
    const rec = recommendSpf(['v=spf1 ~all'], { includes: [], ip4: [], ip6: [] });
    expect(rec.action).toBe('manual');
    expect(rec.manualReason).toContain('MAIL_SPF_INCLUDE');
  });

  it('warns when the merged record approaches the lookup limit', () => {
    const existing = ['v=spf1 ' + Array.from({ length: 8 }, (_, i) => 'include:s' + i + '.example.com').join(' ') + ' ~all'];
    const rec = recommendSpf(existing, source);
    expect(rec.directLookups).toBe(9);
    expect(rec.warnings.join(' ')).toContain('DNS lookups');
  });

  it('spfAuthorises answers the question the verification engine asks', () => {
    expect(spfAuthorises(['v=spf1 include:_spf.edurankai.in ~all'], source).authorised).toBe(true);
    expect(spfAuthorises(['v=spf1 include:other.example.com ~all'], source).missing).toEqual(['include:_spf.edurankai.in']);
    // Two records means no valid SPF, so nothing is authorised however it reads.
    expect(spfAuthorises(['v=spf1 include:_spf.edurankai.in ~all', 'v=spf1 ~all'], source).authorised).toBe(false);
  });

  it('selectSpfRecords ignores TXT records that are not SPF', () => {
    expect(selectSpfRecords(['google-site-verification=abc', 'v=spf1 ~all'])).toEqual(['v=spf1 ~all']);
  });
});

describe('DMARC', () => {
  it('parses tags and defaults', () => {
    const p = parseDmarc('v=DMARC1; p=quarantine; rua=mailto:d@example.com; pct=50; adkim=s');
    expect(p.ok).toBe(true);
    expect(p.policy).toBe('quarantine');
    expect(p.pct).toBe(50);
    expect(p.adkim).toBe('s');
    expect(p.aspf).toBe('r');
    expect(p.rua).toEqual(['mailto:d@example.com']);
  });

  it('refuses a record that does not begin with v=DMARC1 and one with no policy', () => {
    expect(parseDmarc('p=reject; v=DMARC1').ok).toBe(false);
    expect(parseDmarc('v=DMARC1; rua=mailto:a@b.c').errors.join(' ')).toContain('required "p="');
  });

  it('warns when a strong policy has no reporting address', () => {
    const a = auditDmarc(['v=DMARC1; p=reject']);
    expect(a.warnings.join(' ')).toContain('no "rua="');
  });

  it('treats two DMARC records as no policy at all', () => {
    const a = auditDmarc(['v=DMARC1; p=none', 'v=DMARC1; p=reject']);
    expect(a.healthy).toBe(false);
    expect(a.errors.join(' ')).toContain('no DMARC policy at all');
  });

  it('builds the record name', () => {
    expect(dmarcHost('EduRankAI.in')).toBe('_dmarc.edurankai.in');
  });

  it('recommends p=none for a domain with no policy, without asking for confirmation', () => {
    const rec = recommendDmarc([], { rua: 'mailto:dmarc@edurankai.in' });
    expect(rec.policy).toBe('none');
    expect(rec.action).toBe('create');
    expect(rec.requiresConfirmation).toBe(false);
    expect(rec.record).toContain('p=none');
    expect(rec.record).toContain('rua=mailto:dmarc@edurankai.in');
  });

  it('THE GUARD: weakening a published policy requires explicit confirmation', () => {
    const guard = policyChangeGuard('reject', 'none');
    expect(guard.requiresConfirmation).toBe(true);
    expect(guard.direction).toBe('weaken');
    expect(guard.reason).toContain('impersonating');
  });

  it('THE GUARD: strengthening one requires it too', () => {
    const guard = policyChangeGuard('none', 'reject');
    expect(guard.requiresConfirmation).toBe(true);
    expect(guard.direction).toBe('strengthen');
    expect(guard.reason).toContain('rejecting');
  });

  it('a first policy and an unchanged policy need no confirmation', () => {
    expect(policyChangeGuard(null, 'none').requiresConfirmation).toBe(false);
    expect(policyChangeGuard('quarantine', 'quarantine').requiresConfirmation).toBe(false);
  });

  it('a recommendation that would change a live policy carries the confirmation flag', () => {
    const rec = recommendDmarc(['v=DMARC1; p=reject; rua=mailto:a@b.c'], { rua: 'mailto:a@b.c', desired: 'none' });
    expect(rec.requiresConfirmation).toBe(true);
    expect(rec.confirmationReason).toContain('weakens');
  });

  it('checks alignment in both relaxed and strict modes', () => {
    expect(checkAlignment({ fromDomain: 'edurankai.in', dkimDomain: 'mail.edurankai.in' }).dkimAligned).toBe(true);
    expect(checkAlignment({ fromDomain: 'edurankai.in', dkimDomain: 'mail.edurankai.in', adkim: 's' }).dkimAligned).toBe(false);
    expect(checkAlignment({ fromDomain: 'edurankai.in', spfDomain: 'bounce.edurankai.in' }).passes).toBe(true);
    const none = checkAlignment({ fromDomain: 'edurankai.in', dkimDomain: 'other.example.com' });
    expect(none.passes).toBe(false);
    expect(none.detail).toContain('Neither');
  });

  it('marks the organisational-domain guess as approximate, because it is', () => {
    expect(organizationalDomain('edurankai.in')).toEqual({ value: 'edurankai.in', approximate: false });
    expect(organizationalDomain('mail.edurankai.in').approximate).toBe(true);
    expect(organizationalDomain('a.example.co.uk').value).toBe('example.co.uk');
  });
});
