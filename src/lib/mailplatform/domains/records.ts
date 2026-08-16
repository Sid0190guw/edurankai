// src/lib/mailplatform/domains/records.ts — THE RECORDS A CUSTOMER MUST PUBLISH, BUILT FROM THE
// DEPLOYMENT PROFILE RATHER THAN FROM LITERALS.
//
// Pure. Given a domain, a profile and the keys we hold, this returns the exact list a person has to
// type into their DNS panel. It is the same list the verification engine checks, which is the point:
// two hand-maintained lists drift, and the failure mode is a customer publishing what the wizard
// showed and a checker looking for something else.
//
// Requirement 17 (ZBook MTA -> dedicated MTA -> cluster -> multi-region) is satisfied here by
// having NO hostname in this file. Every value comes from MtaProfile. Moving the MTA changes the
// environment, and the records this prints change with it.
//
// The three questions this file keeps apart — because a domain can be in any combination of them:
//   OWNERSHIP  do you control this domain?            (the challenge TXT)
//   SENDING    may our infrastructure send as it?     (SPF, DKIM, DMARC)
//   RECEIVING  should mail for it arrive here?        (MX)

import type { MtaProfile } from '../profile';
import { profileCapabilities } from '../profile';
import { dkimHost, dkimDnsValue, type DkimAlgorithm } from './dkim';
// The ownership challenge VALUE has exactly one definition, and it is not in this file. Two code
// paths check it — ../adapters/domain-dns.ts and ./verify.ts — and a wizard that prints one string
// while a checker looks for another produces a domain that can never be verified and a support
// conversation with no visible cause.
import { ownershipValue } from '../adapters/domain-dns';

/**
 * Wider than DnsCheckType in ../types.ts, which the shared schema constrains to the five checks it
 * persists. `tracking` and `ptr` are real records an operator sees; they are simply not things the
 * mp_domain_verifications CHECK constraint accepts, so they are never written there.
 */
export type RecordPurpose = 'ownership' | 'spf' | 'dkim' | 'dmarc' | 'mx' | 'tracking' | 'ptr';

export interface ManagedDnsRecord {
  recordType: 'TXT' | 'MX' | 'CNAME' | 'A';
  /** Host relative to the domain. `@` is the domain itself, which is how DNS panels label it. */
  host: string;
  /** Fully-qualified name, for the checker and for panels that want the whole thing. */
  fqdn: string;
  value: string;
  ttl: number;
  priority: number | null;
  purpose: RecordPurpose;
  isRequired: boolean;
  /** One sentence a non-technical person can act on. */
  explain: string;
  /** True when we cannot publish or verify it and the customer's provider owns it (PTR). */
  externallyControlled?: boolean;
}

export interface RequiredRecordsInput {
  domain: string;
  profile: MtaProfile;
  verificationToken: string;
  purpose: 'sending' | 'receiving' | 'both';
  dkim?: { selector: string; publicKey: string; algorithm: DkimAlgorithm; status?: string }[];
  /** Merged SPF value from recommendSpf(). Passed in so one merge decision serves both surfaces. */
  spfValue?: string | null;
  /** DMARC value from recommendDmarc(). */
  dmarcValue?: string | null;
  /** Tracking subdomain the customer chose, e.g. `link`. */
  trackingHost?: string | null;
  ttl?: number;
}

const DEFAULT_TTL = 3600;

function fq(host: string, domain: string): string {
  if (host === '@') return domain;
  if (host.endsWith('.' + domain) || host === domain) return host;
  return host + '.' + domain;
}

/** The TXT name and value that prove control of the domain. */
export function ownershipRecord(domain: string, profile: MtaProfile, token: string, ttl = DEFAULT_TTL): ManagedDnsRecord {
  const host = profile.verificationPrefix;
  return {
    recordType: 'TXT',
    host,
    fqdn: fq(host, domain),
    value: ownershipValue(token),
    ttl,
    priority: null,
    purpose: 'ownership',
    isRequired: true,
    explain: 'Proves you control this domain. It is published on its own name, not on the domain itself, so it cannot interfere with an existing SPF or verification record from another provider.',
  };
}

/**
 * Everything the domain needs, in the order a person should add it.
 *
 * A record is OMITTED rather than faked when this deployment cannot back it. If no MX host is
 * configured there is no MX row: printing one for a machine nobody runs would have the customer
 * publish an MX pointing at nothing, and inbound mail for their domain would start bouncing.
 */
export function requiredRecords(input: RequiredRecordsInput): ManagedDnsRecord[] {
  const domain = String(input.domain || '').toLowerCase().replace(/\.$/, '');
  const ttl = input.ttl || DEFAULT_TTL;
  const caps = profileCapabilities(input.profile);
  const wantsSending = input.purpose === 'sending' || input.purpose === 'both';
  const wantsReceiving = input.purpose === 'receiving' || input.purpose === 'both';
  const out: ManagedDnsRecord[] = [ownershipRecord(domain, input.profile, input.verificationToken, ttl)];

  if (wantsSending && input.spfValue && caps.canAuthoriseSending) {
    out.push({
      recordType: 'TXT',
      host: '@',
      fqdn: domain,
      value: input.spfValue,
      ttl,
      priority: null,
      purpose: 'spf',
      isRequired: true,
      explain: 'Lists the servers allowed to send mail as this domain. If you already have an SPF record, REPLACE it with this merged value — do not add a second one; a domain with two SPF records has none.',
    });
  }

  if (wantsSending && caps.canSignDkim) {
    for (const key of input.dkim || []) {
      const host = key.selector + '._domainkey';
      out.push({
        recordType: 'TXT',
        host,
        fqdn: dkimHost(key.selector, domain),
        value: dkimDnsValue({ publicKey: key.publicKey, algorithm: key.algorithm }),
        ttl,
        priority: null,
        purpose: 'dkim',
        isRequired: key.status !== 'retired',
        explain: 'The public half of the signing key for selector "' + key.selector + '". It lets a receiver check that a message really was signed by us and was not altered on the way.',
      });
    }
  }

  if (wantsSending && input.dmarcValue) {
    out.push({
      recordType: 'TXT',
      host: '_dmarc',
      fqdn: '_dmarc.' + domain,
      value: input.dmarcValue,
      ttl,
      priority: null,
      purpose: 'dmarc',
      isRequired: false,
      explain: 'Tells receivers what to do with mail that fails the checks above, and where to send the daily reports. Starting at "p=none" changes nothing about delivery; it only turns the reports on.',
    });
  }

  if (wantsReceiving && caps.canReceive) {
    for (const mx of input.profile.mx) {
      out.push({
        recordType: 'MX',
        host: '@',
        fqdn: domain,
        value: mx.host,
        ttl,
        priority: mx.priority,
        purpose: 'mx',
        isRequired: true,
        explain: 'Sends mail addressed to this domain to our inbound servers. Adding this REPLACES wherever your mail currently arrives, so do it when you are ready to move.',
      });
    }
  }

  const tracking = (input.trackingHost || '').trim();
  if (wantsSending && tracking && input.profile.trackingTarget) {
    out.push({
      recordType: 'CNAME',
      host: tracking,
      fqdn: fq(tracking, domain),
      value: input.profile.trackingTarget,
      ttl,
      priority: null,
      purpose: 'tracking',
      isRequired: false,
      explain: 'Optional. Makes open and click links use your own domain instead of a shared one, which reads better to recipients and to spam filters.',
    });
  }

  return out;
}

/**
 * The PTR expectation, which we describe and never publish.
 *
 * Requirement 8 is explicit that PTR is controlled by whoever owns the IP address, and this is the
 * function that keeps that honest: it returns what reverse DNS SHOULD say and who has to set it.
 * Nothing in this codebase can change a PTR record, and no screen built on this may imply it can.
 */
export function ptrExpectations(profile: MtaProfile): {
  ip: string;
  expected: string | null;
  controlledBy: string;
}[] {
  return (profile.sendingIps || []).map((ip) => ({
    ip,
    expected: profile.ptrHostname,
    controlledBy: 'the provider that owns this IP address (the hosting or network provider). Reverse DNS is set in their control panel or by a support request; it cannot be set from DNS for the domain, and it cannot be set from here.',
  }));
}

/** Human grouping for the wizard, so a person is not handed twelve rows at once. */
export function groupRecords(records: ManagedDnsRecord[]): {
  ownership: ManagedDnsRecord[];
  sending: ManagedDnsRecord[];
  receiving: ManagedDnsRecord[];
  optional: ManagedDnsRecord[];
} {
  return {
    ownership: records.filter((r) => r.purpose === 'ownership'),
    sending: records.filter((r) => (r.purpose === 'spf' || r.purpose === 'dkim') && r.isRequired),
    receiving: records.filter((r) => r.purpose === 'mx'),
    optional: records.filter((r) => r.purpose === 'dmarc' || r.purpose === 'tracking' || (r.purpose === 'dkim' && !r.isRequired)),
  };
}
