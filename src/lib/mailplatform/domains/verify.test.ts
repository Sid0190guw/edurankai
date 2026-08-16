// src/lib/mailplatform/domains/verify.test.ts — the verification engine and the record builder.
// Every scenario in section 16 of the brief that can be reached without a database lives here.
// Run: npx vitest run src/lib/mailplatform/domains/verify.test.ts
import { describe, it, expect } from 'vitest';
import { staticResolver } from './dns';
import { resolveProfile, parseMxHosts, profileCapabilities } from '../profile';
import { requiredRecords, ownershipRecord, ptrExpectations, groupRecords } from './records';
import { verifyDomain, healthSummary, nextDmarcStep } from './verify';
import { ownershipValue, OWNERSHIP_HOST_PREFIX } from '../adapters/domain-dns';
import { generateDkimKeyPair } from './dkim';

const TOKEN = 'abc123def456';
const DOMAIN = 'edurankai.in';

const ENV = {
  MAIL_MX_HOSTS: '10 mx1.mail.example.net, 20 mx2.mail.example.net',
  MAIL_SPF_INCLUDE: '_spf.mail.example.net',
  MAIL_SENDING_IPS: '198.51.100.7',
  MAIL_PTR_HOSTNAME: 'out1.mail.example.net',
  MAIL_DMARC_RUA: 'mailto:dmarc@edurankai.in',
  MAIL_TRACKING_TARGET: 'track.mail.example.net',
};
const profile = resolveProfile(ENV);
const dkim = generateDkimKeyPair({ selector: 'era1', domain: DOMAIN });
const KEYS = [{ selector: 'era1', publicKey: dkim.publicKey, algorithm: 'rsa-sha256' as const, status: 'active' }];

/** A zone in which absolutely everything is correct. Each test breaks exactly one thing. */
function healthyZone() {
  return {
    txt: {
      [OWNERSHIP_HOST_PREFIX + '.' + DOMAIN]: [ownershipValue(TOKEN)],
      [DOMAIN]: ['v=spf1 include:_spf.mail.example.net ~all'],
      ['era1._domainkey.' + DOMAIN]: ['v=DKIM1; k=rsa; p=' + dkim.publicKey],
      ['_dmarc.' + DOMAIN]: ['v=DMARC1; p=none; rua=mailto:dmarc@edurankai.in'],
      ['_mta-sts.' + DOMAIN]: [],
      ['_smtp._tls.' + DOMAIN]: [],
    } as Record<string, string[] | null>,
    mx: { [DOMAIN]: [{ priority: 10, host: 'mx1.mail.example.net' }, { priority: 20, host: 'mx2.mail.example.net' }] } as Record<string, any>,
    a: { 'out1.mail.example.net': ['198.51.100.7'] } as Record<string, string[] | null>,
    ptr: { '198.51.100.7': ['out1.mail.example.net'] } as Record<string, string[] | null>,
  };
}

const run = (zone: ReturnType<typeof healthyZone>, over: Partial<Parameters<typeof verifyDomain>[0]> = {}) =>
  verifyDomain({
    domain: DOMAIN, verificationToken: TOKEN, profile, purpose: 'both',
    resolver: staticResolver(zone as any), dkim: KEYS, ...over,
  });

const check = (h: Awaited<ReturnType<typeof verifyDomain>>, type: string, ref: string | null = null) =>
  h.checks.find((c) => c.type === type && (ref === null || c.ref === ref));

describe('the deployment profile', () => {
  it('parses MX hosts with and without priorities', () => {
    expect(parseMxHosts('10 a.example.com, 20 b.example.com')).toEqual([
      { priority: 10, host: 'a.example.com' }, { priority: 20, host: 'b.example.com' },
    ]);
    expect(parseMxHosts('a.example.com,b.example.com')).toEqual([
      { priority: 10, host: 'a.example.com' }, { priority: 20, host: 'b.example.com' },
    ]);
  });

  it('accepts the singular MAIL_MX_HOST the rest of the codebase already uses', () => {
    expect(resolveProfile({ MAIL_MX_HOST: 'mx.example.net' }).mx).toEqual([{ priority: 10, host: 'mx.example.net' }]);
  });

  it('an unconfigured deployment claims nothing rather than inventing a hostname', () => {
    const empty = resolveProfile({});
    expect(empty.source).toBe('fallback');
    expect(empty.mx).toEqual([]);
    const caps = profileCapabilities(empty);
    expect(caps.canReceive).toBe(false);
    expect(caps.canAuthoriseSending).toBe(false);
    expect(caps.missing.join(' ')).toContain('MAIL_MX_HOSTS');
  });

  it('REQUIREMENT 17: the records follow the profile, so moving the MTA is a config change', () => {
    // Same domain, a different deployment. Nothing in the record builder is pinned to a machine.
    const multiRegion = resolveProfile({
      MAIL_MX_HOSTS: '10 in-mx.example.net, 10 eu-mx.example.net, 50 backup.example.net',
      MAIL_SPF_INCLUDE: 'spf.cluster.example.net',
    });
    const recs = requiredRecords({ domain: DOMAIN, profile: multiRegion, verificationToken: TOKEN, purpose: 'both' });
    const mx = recs.filter((r) => r.recordType === 'MX');
    expect(mx.map((m) => m.value)).toEqual(['in-mx.example.net', 'eu-mx.example.net', 'backup.example.net']);
    expect(recs.find((r) => r.purpose === 'spf')?.value).toBeUndefined(); // no spfValue passed in
    const all = JSON.stringify(recs);
    expect(all).not.toContain('mail.example.net'); // nothing leaked from the other profile
  });
});

describe('required records', () => {
  it('uses ONE definition of the ownership challenge, shared with the DomainProvider adapter', () => {
    const rec = ownershipRecord(DOMAIN, profile, TOKEN);
    expect(rec.value).toBe(ownershipValue(TOKEN));
    expect(rec.host).toBe(OWNERSHIP_HOST_PREFIX);
    expect(rec.fqdn).toBe(OWNERSHIP_HOST_PREFIX + '.' + DOMAIN);
  });

  it('publishes the challenge on its own name, never on the apex', () => {
    // An apex TXT sits next to the customer's SPF and other providers' verification strings, and
    // registrar panels that merge TXT values at the apex have broken SPF this way.
    expect(ownershipRecord(DOMAIN, profile, TOKEN).host).not.toBe('@');
  });

  it('omits the MX rows entirely when the deployment cannot receive', () => {
    const noMx = resolveProfile({ MAIL_SPF_INCLUDE: 'spf.example.net' });
    const recs = requiredRecords({ domain: DOMAIN, profile: noMx, verificationToken: TOKEN, purpose: 'both' });
    // A fabricated MX would have the customer publish a route to a machine nobody runs, and their
    // inbound mail would start bouncing. Absent is correct.
    expect(recs.filter((r) => r.recordType === 'MX')).toHaveLength(0);
  });

  it('a send-only domain is not asked for MX, and a receive-only one is not asked for DKIM', () => {
    const sending = requiredRecords({ domain: DOMAIN, profile, verificationToken: TOKEN, purpose: 'sending', dkim: KEYS, spfValue: 'v=spf1 ~all' });
    expect(sending.some((r) => r.purpose === 'mx')).toBe(false);
    expect(sending.some((r) => r.purpose === 'dkim')).toBe(true);

    const receiving = requiredRecords({ domain: DOMAIN, profile, verificationToken: TOKEN, purpose: 'receiving', dkim: KEYS, spfValue: 'v=spf1 ~all' });
    expect(receiving.some((r) => r.purpose === 'mx')).toBe(true);
    expect(receiving.some((r) => r.purpose === 'dkim')).toBe(false);
    expect(receiving.some((r) => r.purpose === 'spf')).toBe(false);
  });

  it('groups records so the wizard can show a few at a time', () => {
    const recs = requiredRecords({ domain: DOMAIN, profile, verificationToken: TOKEN, purpose: 'both', dkim: KEYS, spfValue: 'v=spf1 include:x ~all', dmarcValue: 'v=DMARC1; p=none' });
    const g = groupRecords(recs);
    expect(g.ownership).toHaveLength(1);
    expect(g.sending.map((r) => r.purpose).sort()).toEqual(['dkim', 'spf']);
    expect(g.receiving).toHaveLength(2);
    expect(g.optional.some((r) => r.purpose === 'dmarc')).toBe(true);
  });

  it('PTR is described and attributed, never offered as something we set', () => {
    const ptr = ptrExpectations(profile);
    expect(ptr).toHaveLength(1);
    expect(ptr[0].expected).toBe('out1.mail.example.net');
    expect(ptr[0].controlledBy).toContain('cannot be set from here');
  });
});

describe('a fully correct domain', () => {
  it('passes everything and reports all three capabilities', async () => {
    const h = await run(healthyZone());
    expect(h.ownershipVerified).toBe(true);
    expect(h.sendingReady).toBe(true);
    expect(h.receivingReady).toBe(true);
    expect(h.suggestedStatus).toBe('verified');
    expect(h.unchecked).toEqual([]);
    expect(check(h, 'spf')?.status).toBe('pass');
    expect(check(h, 'dkim', 'era1')?.status).toBe('pass');
    expect(check(h, 'mx')?.status).toBe('pass');
    expect(check(h, 'ptr', '198.51.100.7')?.status).toBe('pass');
    expect(healthSummary(h).level).toBe('warn'); // MTA-STS is absent, which is a warn, not a fault
  });
});

describe('THE CENTRAL RULE: an unchecked lookup is never a verdict', () => {
  it('a DNS outage reports unknown, never failed, and never verifies', async () => {
    const zone = healthyZone();
    zone.txt[OWNERSHIP_HOST_PREFIX + '.' + DOMAIN] = null;
    zone.txt[DOMAIN] = null;
    const h = await run(zone);

    expect(check(h, 'ownership')?.status).toBe('unknown');
    expect(check(h, 'ownership')?.checked).toBe(false);
    expect(h.ownershipVerified).toBe(false);
    // The domain must NOT be marked failed by an outage — that would stop a working domain's mail.
    expect(h.suggestedStatus).toBe('verifying');
    expect(h.unchecked.join(' ')).toContain('Ownership');
    expect(check(h, 'ownership')?.detail).toContain('not a statement about your DNS');
  });

  it('an unreachable SPF lookup does not become "no SPF record"', async () => {
    const zone = healthyZone();
    zone.txt[DOMAIN] = null;
    const h = await run(zone);
    const spf = check(h, 'spf');
    expect(spf?.status).toBe('unknown');
    expect(spf?.detail).not.toContain('No SPF record');
    expect(h.sendingReady).toBe(false);
  });

  it('a partial include tree is reported as a floor, not a total', async () => {
    const zone = healthyZone();
    zone.txt[DOMAIN] = ['v=spf1 include:_spf.mail.example.net include:unreachable.example.com ~all'];
    zone.txt['unreachable.example.com'] = null;
    const h = await run(zone);
    expect(h.spfLookups?.partial).toBe(true);
    const lookupCheck = h.checks.find((c) => c.ref === 'lookups');
    expect(lookupCheck?.status).toBe('unknown');
    expect(lookupCheck?.observed).toContain('at least');
  });
});

describe('ownership', () => {
  it('WRONG TXT: a stale token is distinguished from no record at all', async () => {
    const zone = healthyZone();
    zone.txt[OWNERSHIP_HOST_PREFIX + '.' + DOMAIN] = [ownershipValue('a-token-from-last-month')];
    zone.txt[DOMAIN] = ['v=spf1 include:_spf.mail.example.net ~all'];
    const h = await run(zone);
    const own = check(h, 'ownership');
    expect(own?.status).toBe('fail');
    expect(own?.detail).toContain('token does not match');
    expect(own?.detail).toContain('left over');
    expect(h.suggestedStatus).toBe('failed');
  });

  it('no record at all says so plainly', async () => {
    const zone = healthyZone();
    zone.txt[OWNERSHIP_HOST_PREFIX + '.' + DOMAIN] = [];
    zone.txt[DOMAIN] = [];
    const h = await run(zone);
    expect(check(h, 'ownership')?.detail).toContain('was not found');
  });

  it('accepts the challenge on the apex, because that is where people habitually put it', async () => {
    const zone = healthyZone();
    zone.txt[OWNERSHIP_HOST_PREFIX + '.' + DOMAIN] = [];
    zone.txt[DOMAIN] = ['v=spf1 include:_spf.mail.example.net ~all', ownershipValue(TOKEN)];
    const h = await run(zone);
    expect(h.ownershipVerified).toBe(true);
  });
});

describe('sending checks', () => {
  it('MULTIPLE SPF RECORDS fails the domain and says why it is not "the second one is ignored"', async () => {
    const zone = healthyZone();
    zone.txt[DOMAIN] = ['v=spf1 include:_spf.mail.example.net ~all', 'v=spf1 include:other.example.com ~all'];
    const h = await run(zone);
    const spf = check(h, 'spf');
    expect(spf?.status).toBe('fail');
    expect(spf?.detail).toContain('2 SPF records');
    expect(spf?.advice.join(' ')).toContain('Do not simply delete one');
    expect(h.sendingReady).toBe(false);
  });

  it('an SPF record that does not authorise us names exactly what is missing', async () => {
    const zone = healthyZone();
    zone.txt[DOMAIN] = ['v=spf1 include:payroll.example.net -all'];
    const h = await run(zone);
    const spf = check(h, 'spf');
    expect(spf?.status).toBe('fail');
    expect(spf?.detail).toContain('include:_spf.mail.example.net');
    expect(spf?.advice.join(' ')).toContain('Do not replace the record');
  });

  it('WRONG DKIM KEY is reported as a mismatch with the right instruction', async () => {
    const zone = healthyZone();
    zone.txt['era1._domainkey.' + DOMAIN] = ['v=DKIM1; k=rsa; p=SOMEBODYELSESKEY'];
    const h = await run(zone);
    const d = check(h, 'dkim', 'era1');
    expect(d?.status).toBe('fail');
    expect(d?.detail).toContain('not the key held here');
    expect(h.sendingReady).toBe(false);
  });

  it('a missing DKIM record is a failure, and having no key generated yet is a different one', async () => {
    const zone = healthyZone();
    zone.txt['era1._domainkey.' + DOMAIN] = [];
    expect(check(await run(zone), 'dkim', 'era1')?.detail).toContain('No TXT record');

    const noKeys = await run(healthyZone(), { dkim: [] });
    expect(check(noKeys, 'dkim')?.detail).toContain('No signing key has been generated');
  });

  it('a domain being rotated passes while EITHER published key matches', async () => {
    const second = generateDkimKeyPair({ selector: 'era2', domain: DOMAIN });
    const zone = healthyZone();
    zone.txt['era2._domainkey.' + DOMAIN] = ['v=DKIM1; k=rsa; p=' + second.publicKey];
    const h = await run(zone, {
      dkim: [...KEYS, { selector: 'era2', publicKey: second.publicKey, algorithm: 'rsa-sha256', status: 'pending' }],
    });
    expect(check(h, 'dkim', 'era1')?.status).toBe('pass');
    expect(check(h, 'dkim', 'era2')?.status).toBe('pass');
    expect(h.sendingReady).toBe(true);
  });

  it('a retired key is not checked at all', async () => {
    const h = await run(healthyZone(), { dkim: [{ ...KEYS[0], status: 'retired' }] });
    expect(check(h, 'dkim')?.detail).toContain('No signing key has been generated');
  });
});

describe('DMARC is advisory, not a gate', () => {
  it('an absent DMARC record warns and does not block sending', async () => {
    const zone = healthyZone();
    zone.txt['_dmarc.' + DOMAIN] = [];
    const h = await run(zone);
    expect(check(h, 'dmarc')?.status).toBe('warn');
    expect(h.sendingReady).toBe(true);
  });

  it('a malformed DMARC record fails its own check', async () => {
    const zone = healthyZone();
    zone.txt['_dmarc.' + DOMAIN] = ['v=DMARC1; p=sometimes'];
    expect(check(await run(zone), 'dmarc')?.status).toBe('fail');
  });

  it('suggests the next policy step, one rung at a time', () => {
    expect(nextDmarcStep(null, true)?.policy).toBe('none');
    expect(nextDmarcStep('none', true)?.policy).toBe('quarantine');
    expect(nextDmarcStep('quarantine', true)?.policy).toBe('reject');
    expect(nextDmarcStep('reject', true)).toBeNull();
    // Nothing is suggested for a domain that cannot even send yet.
    expect(nextDmarcStep(null, false)).toBeNull();
  });
});

describe('receiving', () => {
  it('MISSING MX is a failure for receiving that does not touch sending', async () => {
    const zone = healthyZone();
    zone.mx[DOMAIN] = [];
    const h = await run(zone);
    expect(check(h, 'mx')?.status).toBe('fail');
    expect(check(h, 'mx')?.detail).toContain('cannot be delivered anywhere');
    expect(h.receivingReady).toBe(false);
    // The three states stay separate: this domain can still send.
    expect(h.sendingReady).toBe(true);
  });

  it('mail delivered somewhere else is named as such', async () => {
    const zone = healthyZone();
    zone.mx[DOMAIN] = [{ priority: 10, host: 'mx.someone-else.example' }];
    const h = await run(zone);
    expect(check(h, 'mx')?.detail).toContain('delivered elsewhere');
  });

  it('a foreign backup MX warns, because it is a common cause of "missing" mail', async () => {
    const zone = healthyZone();
    zone.mx[DOMAIN] = [
      { priority: 10, host: 'mx1.mail.example.net' },
      { priority: 20, host: 'mx2.mail.example.net' },
      { priority: 30, host: 'old.example.com' },
    ];
    const h = await run(zone);
    expect(check(h, 'mx')?.status).toBe('warn');
    expect(check(h, 'mx')?.detail).toContain('old.example.com');
    expect(h.receivingReady).toBe(true);
  });
});

describe('reverse DNS', () => {
  it('a wrong PTR is reported with the provider named as the one who must fix it', async () => {
    const zone = healthyZone();
    zone.ptr['198.51.100.7'] = ['some-generic-name.hosting.example'];
    const h = await run(zone);
    const ptr = check(h, 'ptr', '198.51.100.7');
    expect(ptr?.status).toBe('fail');
    expect(ptr?.advice.join(' ')).toContain('provider that owns this IP');
  });

  it('a PTR that does not forward-confirm warns rather than passing', async () => {
    const zone = healthyZone();
    zone.a['out1.mail.example.net'] = ['203.0.113.9'];
    const h = await run(zone);
    expect(check(h, 'ptr', '198.51.100.7')?.status).toBe('warn');
    expect(check(h, 'ptr', '198.51.100.7')?.detail).toContain('does not resolve back');
  });

  it('no PTR at all is a failure, because receivers refuse mail from an address without one', async () => {
    const zone = healthyZone();
    zone.ptr['198.51.100.7'] = [];
    expect(check(await run(zone), 'ptr', '198.51.100.7')?.status).toBe('fail');
  });
});

describe('TLS posture', () => {
  it('says out loud that STARTTLS itself was not probed', async () => {
    const h = await run(healthyZone());
    const tls = check(h, 'tls');
    expect(tls?.status).toBe('warn');
    expect(tls?.advice.join(' ')).toContain('not probed from here');
  });

  it('passes when an MTA-STS policy is published', async () => {
    const zone = healthyZone();
    zone.txt['_mta-sts.' + DOMAIN] = ['v=STSv1; id=20260816'];
    zone.txt['_smtp._tls.' + DOMAIN] = ['v=TLSRPTv1; rua=mailto:tls@edurankai.in'];
    expect(check(await run(zone), 'tls')?.status).toBe('pass');
  });
});

describe('an unconfigured deployment', () => {
  it('reports its own gaps as unknown rather than blaming the customer', async () => {
    const bare = resolveProfile({});
    const h = await verifyDomain({
      domain: DOMAIN, verificationToken: TOKEN, profile: bare, purpose: 'both',
      resolver: staticResolver(healthyZone() as any), dkim: KEYS,
    });
    expect(check(h, 'spf')?.status).toBe('unknown');
    expect(check(h, 'spf')?.advice.join(' ')).toContain('MAIL_SPF_INCLUDE');
    expect(check(h, 'mx')?.status).toBe('unknown');
    expect(check(h, 'mx')?.advice.join(' ')).toContain('MAIL_MX_HOSTS');
  });
});

describe('summary', () => {
  it('leads with the worst thing that is true', async () => {
    const zone = healthyZone();
    zone.txt[DOMAIN] = ['v=spf1 ~all'];
    const h = await run(zone);
    expect(healthSummary(h).level).toBe('fail');
    expect(healthSummary(h).text).toContain('to fix');
  });

  it('an unverifiable domain reads as unknown rather than failed', async () => {
    const zone = healthyZone();
    zone.txt[OWNERSHIP_HOST_PREFIX + '.' + DOMAIN] = null;
    zone.txt[DOMAIN] = null;
    expect(healthSummary(await run(zone)).level).toBe('unknown');
  });
});
