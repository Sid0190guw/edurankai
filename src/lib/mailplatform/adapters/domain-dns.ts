// src/lib/mailplatform/adapters/domain-dns.ts — DomainProvider over the system resolver.
//
// Domain verification is the one place where the platform must not believe its own records. What
// matters is what the world's resolvers actually return for a name, so every check here is a live
// lookup and the OBSERVED value is stored next to the EXPECTED one. A verification screen that says
// "failed" without showing what it saw is a screen that generates support tickets.
//
// `requiredRecords()` is pure: no network, no clock. That is what lets the "add a domain" screen
// show the exact DNS to paste before anything has been published, and what lets a test assert the
// records without a resolver.

import type { DnsLookupResult, DomainProvider, OperationResult, ProviderInfo } from '../interfaces';
import type { DkimKey, DnsCheckType, DnsRecord, Domain } from '../types';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The TXT name ownership is proven at. Prefixed so it cannot collide with a customer's own TXT. */
export const OWNERSHIP_HOST_PREFIX = '_edurankai';

/** Default DKIM selector when a domain has not been given one. */
export const DEFAULT_DKIM_SELECTOR = 'era1';

// ---------------------------------------------------------------------------
// Pure record construction and comparison
// ---------------------------------------------------------------------------

/** The TXT value that proves control of the domain. */
export function ownershipValue(token: string): string {
  return `edurankai-verification=${token}`;
}

/** The DKIM TXT value for a public key, in the form a resolver returns it. */
export function dkimTxtValue(publicKeyBase64: string, algorithm = 'rsa-sha256'): string {
  const k = algorithm.startsWith('ed25519') ? 'ed25519' : 'rsa';
  // p= carries the key with no whitespace; some DNS UIs insert line breaks and the value stops
  // validating, which is the single most common DKIM support question there is.
  return `v=DKIM1; k=${k}; p=${String(publicKeyBase64 || '').replace(/\s+/g, '')}`;
}

/**
 * Compare a published TXT value with what we expect.
 *
 * Whitespace-insensitive and quote-insensitive, because resolvers and registrar UIs disagree about
 * both: a 255-byte TXT string is returned as several chunks that must be concatenated, and some
 * registrars store the surrounding quotes literally. A strict string compare fails on a record that
 * is, in fact, correct — and then a user spends an afternoon re-pasting a key that was already right.
 */
export function txtMatches(expected: string, observed: string): boolean {
  const norm = (s: string) => String(s || '').replace(/["\s]+/g, '').toLowerCase();
  return norm(observed) === norm(expected);
}

/** A published SPF record must INCLUDE our sender, not equal it — a domain has one SPF for all. */
export function spfIncludes(observed: string, include: string): boolean {
  const s = String(observed || '').toLowerCase();
  if (!s.startsWith('v=spf1')) return false;
  return s.includes('include:' + String(include || '').toLowerCase());
}

/** Parse a DMARC record enough to report its policy. Returns null when it is not a DMARC record. */
export function dmarcPolicy(observed: string): 'none' | 'quarantine' | 'reject' | null {
  const s = String(observed || '').toLowerCase().replace(/\s+/g, '');
  if (!s.startsWith('v=dmarc1')) return null;
  const m = /;p=(none|quarantine|reject)/.exec(s);
  return (m?.[1] as 'none' | 'quarantine' | 'reject') || null;
}

/**
 * The records a domain must publish.
 *
 * Pure and previewable. `mxHost` and `spfInclude` are supplied by configuration rather than
 * hardcoded, because they differ between the current setup (mail hosted elsewhere) and the future
 * one (EduRankAI's own MTA) and this function must be correct in both.
 */
export function requiredRecordsFor(
  domain: Domain,
  dkim?: DkimKey | null,
  opts: { mxHost?: string; spfInclude?: string; dmarcReportTo?: string } = {},
): DnsRecord[] {
  const name = String(domain?.domain || '').toLowerCase();
  const records: DnsRecord[] = [];

  records.push({
    recordType: 'TXT',
    host: `${OWNERSHIP_HOST_PREFIX}.${name}`,
    value: ownershipValue(domain.verificationToken),
    ttl: 3600,
    priority: null,
    purpose: 'ownership',
    isRequired: true,
  });

  const sends = domain.purpose === 'sending' || domain.purpose === 'both';
  const receives = domain.purpose === 'receiving' || domain.purpose === 'both';

  if (sends) {
    const include = opts.spfInclude || process.env.MAIL_SPF_INCLUDE || '';
    if (include) {
      records.push({
        recordType: 'TXT',
        host: name,
        // `~all` (softfail), not `-all`. A hard fail on a domain that still has another sender
        // nobody remembered — a payroll system, a helpdesk — silently destroys their mail. Move to
        // `-all` deliberately, after the reports are clean.
        value: `v=spf1 include:${include} ~all`,
        ttl: 3600,
        priority: null,
        purpose: 'spf',
        isRequired: true,
      });
    }

    const selector = dkim?.selector || domain.dkimSelector || DEFAULT_DKIM_SELECTOR;
    if (dkim?.publicKey) {
      records.push({
        recordType: 'TXT',
        host: `${selector}._domainkey.${name}`,
        value: dkimTxtValue(dkim.publicKey, dkim.algorithm),
        ttl: 3600,
        priority: null,
        purpose: 'dkim',
        isRequired: true,
      });
    }

    records.push({
      recordType: 'TXT',
      host: `_dmarc.${name}`,
      // p=none to start. Publishing quarantine or reject before SPF and DKIM verify is how a domain
      // spam-folders its own mail — which has happened on edurankai.in and is written up in
      // MAIL-SETUP.md. Tighten it after the first clean report, not before.
      value: `v=DMARC1; p=none; rua=mailto:${opts.dmarcReportTo || `dmarc@${name}`}`,
      ttl: 3600,
      priority: null,
      purpose: 'dmarc',
      isRequired: false,
    });
  }

  if (receives) {
    const mx = opts.mxHost || process.env.MAIL_MX_HOST || '';
    if (mx) {
      records.push({
        recordType: 'MX',
        host: name,
        value: mx,
        ttl: 3600,
        priority: 10,
        purpose: 'mx',
        isRequired: true,
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The verification pass, factored out so it takes its lookups as an argument.
 *
 * It was a method that called `provider.lookupTxt` through the closure. That made the stub provider
 * used in tests a lie: overriding `lookupTxt` on the returned object changed nothing, because
 * verify() still reached the system resolver through the captured `provider`. A test suite that
 * silently performs live DNS is worse than no test — it passes on the developer's machine and
 * fails in CI for reasons nobody can reproduce.
 */
export async function runVerification(
  domain: Domain,
  checks: DnsCheckType[] | undefined,
  lookups: { txt: (host: string) => Promise<DnsLookupResult>; mx: (host: string) => Promise<DnsLookupResult> },
): Promise<VerificationOutcome[]> {
    const wanted: DnsCheckType[] = checks?.length ? checks : ['ownership', 'spf', 'dkim', 'dmarc', 'mx'];
    const name = String(domain.domain || '').toLowerCase();
    const out: { checkType: DnsCheckType; status: 'pass' | 'fail'; expected: string | null; observed: string | null; detail: string }[] = [];

    for (const checkType of wanted) {
      if (checkType === 'ownership') {
        const expected = ownershipValue(domain.verificationToken);
        const r = await lookups.txt(`${OWNERSHIP_HOST_PREFIX}.${name}`);
        const hit = r.records.find((v) => txtMatches(expected, v));
        out.push({
          checkType,
          status: hit ? 'pass' : 'fail',
          expected,
          observed: r.records.join(' | ') || null,
          detail: hit
            ? 'Ownership TXT found.'
            : r.ok
              ? `No TXT at ${OWNERSHIP_HOST_PREFIX}.${name} matches the verification token. DNS changes can take up to an hour to publish.`
              : `Could not read TXT for ${OWNERSHIP_HOST_PREFIX}.${name}: ${r.error}`,
        });
        continue;
      }

      if (checkType === 'spf') {
        const include = process.env.MAIL_SPF_INCLUDE || '';
        if (!include) {
          out.push({
            checkType,
            status: 'fail',
            expected: null,
            observed: null,
            detail: 'MAIL_SPF_INCLUDE is not configured on this deployment, so there is nothing to check for.',
          });
          continue;
        }
        const r = await lookups.txt(name);
        const spfRecords = r.records.filter((v) => v.toLowerCase().startsWith('v=spf1'));
        const hit = spfRecords.find((v) => spfIncludes(v, include));
        // More than one SPF record makes SPF fail outright (RFC 7208 §3.2) — worth naming, because
        // the usual cause is adding a second one rather than merging into the first.
        const multiple = spfRecords.length > 1;
        out.push({
          checkType,
          status: hit && !multiple ? 'pass' : 'fail',
          expected: `v=spf1 include:${include} ~all`,
          observed: spfRecords.join(' | ') || null,
          detail: multiple
            ? `This domain publishes ${spfRecords.length} SPF records. A domain may have only one — merge them into a single v=spf1 line, or SPF fails for every sender.`
            : hit
              ? 'SPF includes our sender.'
              : `No SPF record on ${name} includes ${include}.`,
        });
        continue;
      }

      if (checkType === 'dkim') {
        const selector = domain.dkimSelector || DEFAULT_DKIM_SELECTOR;
        const r = await lookups.txt(`${selector}._domainkey.${name}`);
        const hit = r.records.find((v) => v.toLowerCase().includes('v=dkim1') && /p=[A-Za-z0-9+/=]{40,}/.test(v));
        out.push({
          checkType,
          status: hit ? 'pass' : 'fail',
          expected: `v=DKIM1; k=rsa; p=… at ${selector}._domainkey.${name}`,
          observed: r.records.join(' | ') || null,
          detail: hit
            ? 'DKIM public key published.'
            : r.ok
              ? `No DKIM key found at ${selector}._domainkey.${name}. Check the record was pasted without line breaks — some DNS panels wrap long values and that alone breaks it.`
              : `Could not read DKIM TXT: ${r.error}`,
        });
        continue;
      }

      if (checkType === 'dmarc') {
        const r = await lookups.txt(`_dmarc.${name}`);
        const record = r.records.find((v) => v.toLowerCase().replace(/\s+/g, '').startsWith('v=dmarc1'));
        const policy = record ? dmarcPolicy(record) : null;
        out.push({
          checkType,
          // DMARC is reported but NOT required to pass: a domain can send perfectly well without
          // it, and demanding it before SPF and DKIM verify is what causes the quarantine trap.
          status: record ? 'pass' : 'fail',
          expected: 'v=DMARC1; p=none; rua=mailto:…',
          observed: record || null,
          detail: record
            ? `DMARC published with p=${policy || 'unspecified'}.` +
              (policy && policy !== 'none'
                ? ' Note: a policy stricter than p=none while SPF or DKIM is still failing will spam-folder your own mail.'
                : '')
            : 'No DMARC record. Not required to send, but recommended once SPF and DKIM pass.',
        });
        continue;
      }

      if (checkType === 'mx') {
        const expectedMx = process.env.MAIL_MX_HOST || '';
        const r = await lookups.mx(name);
        const hit = expectedMx
          ? r.records.some((v) => v.toLowerCase().includes(expectedMx.toLowerCase()))
          : r.records.length > 0;
        out.push({
          checkType,
          status: hit ? 'pass' : 'fail',
          expected: expectedMx || '(any MX)',
          observed: r.records.join(' | ') || null,
          detail: hit
            ? 'MX resolves.'
            : r.ok
              ? `MX for ${name} does not point at ${expectedMx || 'any host'}. Inbound mail will not reach the platform.`
              : `Could not read MX for ${name}: ${r.error}`,
        });
      }
    }

    return out;
}

export interface VerificationOutcome {
  checkType: DnsCheckType;
  status: 'pass' | 'fail';
  expected: string | null;
  observed: string | null;
  detail: string;
}

export function systemDnsProvider(): DomainProvider {
  async function resolver() {
    const dns = await import('node:dns/promises');
    return dns;
  }

  const provider: DomainProvider = {
    info(): ProviderInfo {
      const mx = process.env.MAIL_MX_HOST || '';
      const spf = process.env.MAIL_SPF_INCLUDE || '';
      const missing: string[] = [];
      if (!mx) missing.push('MAIL_MX_HOST');
      if (!spf) missing.push('MAIL_SPF_INCLUDE');
      return {
        kind: 'system-dns',
        enabled: true,
        detail: missing.length
          ? `DNS lookups work, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unset, so the ${missing.includes('MAIL_MX_HOST') ? 'MX' : ''}${missing.length > 1 ? ' and SPF' : missing.includes('MAIL_SPF_INCLUDE') ? 'SPF' : ''} record cannot be generated and is omitted from the required list.`
          : 'System resolver. Records are generated from MAIL_MX_HOST and MAIL_SPF_INCLUDE.',
      };
    },

    async lookupTxt(host: string): Promise<DnsLookupResult> {
      try {
        const dns = await resolver();
        // resolveTxt returns string[][] — a record split into chunks. Joining is REQUIRED: a DKIM
        // public key is longer than 255 bytes and always arrives in pieces.
        const chunks = await dns.resolveTxt(host);
        return { ok: true, records: chunks.map((parts) => parts.join('')) };
      } catch (e: any) {
        return { ok: false, records: [], error: dnsReason(e) };
      }
    },

    async lookupMx(host: string): Promise<DnsLookupResult> {
      try {
        const dns = await resolver();
        const mx = await dns.resolveMx(host);
        return {
          ok: true,
          records: mx
            .sort((a, b) => a.priority - b.priority)
            .map((r) => `${r.priority} ${r.exchange.replace(/\.$/, '')}`),
        };
      } catch (e: any) {
        return { ok: false, records: [], error: dnsReason(e) };
      }
    },

    async lookupCname(host: string): Promise<DnsLookupResult> {
      try {
        const dns = await resolver();
        const cn = await dns.resolveCname(host);
        return { ok: true, records: cn.map((c) => c.replace(/\.$/, '')) };
      } catch (e: any) {
        return { ok: false, records: [], error: dnsReason(e) };
      }
    },

    requiredRecords(domain, dkim, opts) {
      return requiredRecordsFor(domain, dkim, opts);
    },

    async verify(domain: Domain, checks?: DnsCheckType[]) {
      return runVerification(domain, checks, { txt: provider.lookupTxt, mx: provider.lookupMx });
    },

    async applyRecord(): Promise<OperationResult> {
      // Honest refusal rather than a silent no-op. This deployment configures DNS at a registrar by
      // hand; a provider-API adapter can implement this later without touching verification.
      return {
        ok: false,
        error: 'This deployment does not automate DNS. Publish the record at your DNS host, then run verification.',
        code: 'unsupported',
      };
    },
  };

  return provider;
}

/** Turn a resolver error code into a sentence an operator can act on. */
function dnsReason(e: any): string {
  const code = String(e?.code || '');
  if (code === 'ENOTFOUND' || code === 'ENODATA') return 'no such record published (or not yet propagated)';
  if (code === 'ESERVFAIL') return 'the domain\'s nameservers returned a failure';
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return 'the lookup timed out';
  return causeOf(e);
}

/** Fixed-answer provider for tests. No network — verify() reads the same fixed answers. */
export function stubDnsProvider(answers: Record<string, string[]>): DomainProvider {
  const lookup = async (host: string): Promise<DnsLookupResult> => ({
    ok: host in answers,
    records: answers[host] || [],
    error: host in answers ? undefined : 'no such record published (or not yet propagated)',
  });
  return {
    info: () => ({ kind: 'stub-dns', enabled: true, detail: 'Fixed answers for tests.' }),
    lookupTxt: lookup,
    lookupMx: lookup,
    lookupCname: lookup,
    requiredRecords: (domain, dkim, opts) => requiredRecordsFor(domain, dkim, opts),
    verify: (domain, checks) => runVerification(domain, checks, { txt: lookup, mx: lookup }),
  };
}
