// src/lib/mailplatform/domains/verify.ts — THE VERIFICATION ENGINE.
//
// It takes a resolver rather than making its own, so every branch below is exercised by tests
// against a literal zone with no network involved. That is not a convenience: the branches that
// matter here are the ones that only happen when DNS is broken, and those are exactly the ones you
// cannot reach by pointing a checker at a real domain.
//
// THE RULE, RESTATED BECAUSE THIS IS WHERE IT PAYS OFF: a lookup that did not happen produces
// `unknown`, never `fail`. Three consequences, all deliberate:
//   - a resolver outage cannot flip a working domain to FAILED and stop its mail,
//   - a resolver outage cannot mark an unverified domain VERIFIED either, because pass requires a
//     positive observation, and
//   - the reasons travel back in `unchecked` so a screen can say "we could not check", which is a
//     different sentence from "your DNS is wrong" and leads a person somewhere different.
//
// The three states this engine keeps apart, per requirement 7:
//   ownership  — do you control the domain (the challenge TXT)
//   sending    — may we send as it (SPF authorises us, and a DKIM key we hold is published)
//   receiving  — should mail for it arrive here (MX points at us)
// A domain can be verified and unable to send; it can send and not receive. Collapsing these into
// one boolean is how a domain ends up "verified" on a screen while its mail bounces.

import type { DnsResolver } from './dns';
import { normalizeDomain } from './dns';
import type { MtaProfile } from '../profile';
import { profileCapabilities } from '../profile';
import { auditSpf, spfAuthorises, countLookups, type SpfLookupCount } from './spf';
import { auditDmarc, dmarcHost, type DmarcPolicy } from './dmarc';
import { dkimHost, verifyDkimPublished, type DkimAlgorithm } from './dkim';
import { ownershipRecord } from './records';
import { ownershipValue } from '../adapters/domain-dns';

/** Everything before the token in the ownership TXT value, derived rather than repeated. */
const OWNERSHIP_VALUE_PREFIX = ownershipValue('').replace(/=$/, '');

export type CheckType = 'ownership' | 'spf' | 'dkim' | 'dmarc' | 'mx' | 'ptr' | 'tls';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

export interface CheckResult {
  type: CheckType;
  /** Sub-identity, e.g. the DKIM selector or the IP address, when a check runs several times. */
  ref: string | null;
  label: string;
  status: CheckStatus;
  /** What we told the customer to publish. Null when there is nothing to compare against. */
  expected: string | null;
  /** What is actually published, as observed. */
  observed: string | null;
  detail: string;
  advice: string[];
  /** False means the lookup did not complete. `status` is then always `unknown`. */
  checked: boolean;
  /**
   * Every value observed at the name, not just the one shown.
   *
   * Carried so the recommendation layer can re-derive a merge from what is actually published
   * without asking DNS a second time — and, more importantly, so it can SEE that there are two SPF
   * records. `observed` holds one string; a merge decision made from one string when two are
   * published would propose replacing a record whose twin it never saw.
   */
  raw?: string[];
}

export interface DomainHealth {
  domain: string;
  checkedAt: string;
  checks: CheckResult[];
  ownershipVerified: boolean;
  sendingReady: boolean;
  receivingReady: boolean;
  /** Every reason a question could not be answered. Rendered as "could not check", not as a fault. */
  unchecked: string[];
  /** SPF lookup-limit arithmetic, when it could be done. */
  spfLookups: SpfLookupCount | null;
  /** What the domain's stored status should become. Never `verified` on an unchecked ownership. */
  suggestedStatus: 'pending' | 'verifying' | 'verified' | 'failed';
}

export interface VerifyInput {
  domain: string;
  verificationToken: string;
  profile: MtaProfile;
  purpose: 'sending' | 'receiving' | 'both';
  resolver: DnsResolver;
  dkim?: { selector: string; publicKey: string; algorithm: DkimAlgorithm; status: string }[];
  /** Restrict the run. Defaults to everything the purpose implies. */
  checks?: CheckType[];
  /** Injected for the MTA-STS policy fetch. Omit and the HTTPS half is simply not attempted. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

const ok = (
  type: CheckType, ref: string | null, label: string, status: CheckStatus,
  detail: string, expected: string | null, observed: string | null, advice: string[] = [], checked = true,
): CheckResult => ({ type, ref, label, status, expected, observed, detail, advice, checked });

const unknownCheck = (type: CheckType, ref: string | null, label: string, reason: string): CheckResult =>
  ok(type, ref, label, 'unknown', 'This could not be checked: ' + reason + '. This is not a statement about your DNS.', null, null, [], false);

/** Run every applicable check. Never throws: a checker that dies takes a health page with it. */
export async function verifyDomain(input: VerifyInput): Promise<DomainHealth> {
  const domain = normalizeDomain(input.domain);
  const caps = profileCapabilities(input.profile);
  const wantsSending = input.purpose === 'sending' || input.purpose === 'both';
  const wantsReceiving = input.purpose === 'receiving' || input.purpose === 'both';
  const selected = (t: CheckType) => !input.checks || input.checks.includes(t);

  const checks: CheckResult[] = [];
  const unchecked: string[] = [];
  let spfLookups: SpfLookupCount | null = null;

  // --- ownership ----------------------------------------------------------
  let ownershipVerified = false;
  let ownershipChecked = false;
  if (selected('ownership')) {
    const expectedRecord = ownershipRecord(domain, input.profile, input.verificationToken);
    const expectedValue = expectedRecord.value;
    // Both names are accepted. The dedicated name is what we ASK for, but a great many people put a
    // verification string on the apex out of habit, and refusing a domain whose owner has in fact
    // proved control — just at the other name — would be pedantry with a support ticket attached.
    const dedicated = await input.resolver.txt(expectedRecord.fqdn);
    const apex = dedicated.checked && dedicated.values.some((v) => v.trim() === expectedValue)
      ? null
      : await input.resolver.txt(domain);

    const anyChecked = dedicated.checked || (apex ? apex.checked : false);
    const observedValues = [...(dedicated.values || []), ...((apex && apex.values) || [])];
    const hit = observedValues.find((v) => v.trim() === expectedValue);

    if (!anyChecked) {
      const reason = dedicated.error || apex?.error || 'the DNS lookup did not complete';
      unchecked.push('Ownership: ' + reason);
      checks.push(unknownCheck('ownership', null, 'Domain ownership', reason));
    } else {
      ownershipChecked = true;
      ownershipVerified = !!hit;
      // A token that does not match, on a record that is obviously ours, is a DIFFERENT problem
      // from no record at all — it is nearly always a leftover from an earlier attempt, and saying
      // so saves the customer from adding a second one alongside it.
      const near = observedValues.find((v) => v.startsWith(OWNERSHIP_VALUE_PREFIX));
      checks.push(ok(
        'ownership', null, 'Domain ownership',
        ownershipVerified ? 'pass' : 'fail',
        ownershipVerified
          ? 'The verification record is published and matches.'
          : near
            ? 'A verification record is published but its token does not match the one issued for this domain. It is probably left over from an earlier attempt — replace it with the value below.'
            : 'The verification record was not found at ' + expectedRecord.fqdn + ' or on the domain itself.',
        expectedValue,
        near || observedValues[0] || null,
        ownershipVerified ? [] : ['Add a TXT record at "' + expectedRecord.host + '" with exactly the value shown. DNS changes can take up to an hour to become visible.'],
      ));
    }
  }

  // --- SPF ----------------------------------------------------------------
  if (wantsSending && selected('spf')) {
    const txt = await input.resolver.txt(domain);
    if (!txt.checked) {
      unchecked.push('SPF: ' + (txt.error || 'the DNS lookup did not complete'));
      checks.push(unknownCheck('spf', null, 'SPF (which servers may send as you)', txt.error || 'the DNS lookup did not complete'));
    } else {
      const audit = auditSpf(txt.values);
      const source = { includes: input.profile.spfIncludes, ip4: input.profile.spfIp4, ip6: input.profile.spfIp6 };
      const auth = spfAuthorises(txt.values, source);
      let status: CheckStatus = 'fail';
      let detail: string;
      const advice: string[] = [];

      if (!caps.canAuthoriseSending) {
        status = 'unknown';
        detail = 'This deployment has no SPF include or sending IP configured, so there is nothing to look for in your SPF record yet.';
        advice.push('An operator must set MAIL_SPF_INCLUDE or MAIL_SPF_IP4 before sending can be verified.');
      } else if (audit.records.length === 0) {
        detail = 'No SPF record is published, so no server is authorised to send as this domain.';
        advice.push('Publish the SPF record shown below.');
      } else if (audit.records.length > 1) {
        detail = 'There are ' + audit.records.length + ' SPF records on this domain. Receivers treat that as an error and SPF fails for every message.';
        advice.push('Merge them into exactly one record. Do not simply delete one — the mechanisms in both are authorising real senders.');
      } else if (!audit.parse?.ok) {
        detail = audit.errors[0] || 'The SPF record is malformed.';
        advice.push(...audit.errors.slice(1));
      } else if (!auth.authorised) {
        detail = 'The SPF record is valid but does not authorise this platform. Missing: ' + auth.missing.join(', ') + '.';
        advice.push('Add the missing term(s) to your existing record. Do not replace the record.');
      } else {
        status = audit.warnings.length > 0 ? 'warn' : 'pass';
        detail = audit.warnings.length > 0
          ? 'SPF authorises this platform. There are warnings worth reading.'
          : 'SPF is published, valid, and authorises this platform.';
        advice.push(...audit.warnings);
      }

      checks.push({
        ...ok('spf', null, 'SPF (which servers may send as you)', status, detail,
          auth.missing.length ? auth.missing.join(' ') : null, audit.effective, advice),
        raw: txt.values,
      });

      // The lookup-limit arithmetic needs the include tree, so it is done only when there is a
      // record to walk. `partial` travels with it: a floor is reported as a floor.
      if (audit.effective) {
        try {
          spfLookups = await countLookups(audit.effective, domain, input.resolver);
          if (spfLookups.overLimit) {
            checks.push(ok('spf', 'lookups', 'SPF DNS lookup limit', 'fail',
              'Evaluating this record costs ' + spfLookups.total + ' DNS lookups; RFC 7208 allows ' + 10 + '. Receivers stop and return permerror, so SPF fails for every message.',
              'at most 10 lookups', String(spfLookups.total) + ' lookups',
              ['Replace one or more "include:" terms with the "ip4:" ranges behind them.', ...(spfLookups.voidLookups.length ? ['These includes resolve to no SPF record at all and are pure waste: ' + spfLookups.voidLookups.join(', ')] : [])]));
          } else if (spfLookups.partial) {
            checks.push(ok('spf', 'lookups', 'SPF DNS lookup limit', 'unknown',
              'At least ' + spfLookups.total + ' of the 10 permitted DNS lookups are used. Part of the include tree could not be resolved, so this is a floor rather than a total.',
              'at most 10 lookups', 'at least ' + spfLookups.total, spfLookups.unresolved.map((u) => 'Could not follow: ' + u), false));
          } else if (spfLookups.total >= 8) {
            checks.push(ok('spf', 'lookups', 'SPF DNS lookup limit', 'warn',
              'This record uses ' + spfLookups.total + ' of the 10 permitted DNS lookups. Adding one more sender may break SPF entirely.',
              'at most 10 lookups', String(spfLookups.total) + ' lookups', []));
          }
        } catch {
          // The counter is diagnostics. Its failure must not remove the SPF verdict above.
        }
      }
    }
  }

  // --- DKIM ---------------------------------------------------------------
  const dkimKeys = (input.dkim || []).filter((k) => k.status !== 'retired');
  if (wantsSending && selected('dkim')) {
    if (!caps.canSignDkim) {
      checks.push(ok('dkim', null, 'DKIM (message signing)', 'unknown',
        'DKIM signing is switched off for this deployment, so there is no key to look for.', null, null,
        ['An operator has set MAIL_DKIM_SIGNING=off. Mail will rely on SPF alignment alone.'], false));
    } else if (dkimKeys.length === 0) {
      checks.push(ok('dkim', null, 'DKIM (message signing)', 'fail',
        'No signing key has been generated for this domain yet.', null, null,
        ['Generate a DKIM key on this page, then publish the record it produces.']));
    } else {
      for (const key of dkimKeys) {
        const host = dkimHost(key.selector, domain);
        const txt = await input.resolver.txt(host);
        if (!txt.checked) {
          unchecked.push('DKIM ' + key.selector + ': ' + (txt.error || 'the DNS lookup did not complete'));
          checks.push(unknownCheck('dkim', key.selector, 'DKIM key "' + key.selector + '"', txt.error || 'the DNS lookup did not complete'));
          continue;
        }
        const v = verifyDkimPublished(txt.values, key.publicKey);
        const status: CheckStatus = v.result === 'match' ? 'pass' : v.result === 'revoked' ? 'warn' : 'fail';
        checks.push(ok('dkim', key.selector, 'DKIM key "' + key.selector + '"', status, v.detail,
          key.publicKey.slice(0, 24) + '...', v.observed,
          v.result === 'match' ? [] : ['Publish a TXT record at "' + key.selector + '._domainkey" with the value shown for this key.']));
      }
    }
  }

  // --- DMARC --------------------------------------------------------------
  if (wantsSending && selected('dmarc')) {
    const txt = await input.resolver.txt(dmarcHost(domain));
    if (!txt.checked) {
      unchecked.push('DMARC: ' + (txt.error || 'the DNS lookup did not complete'));
      checks.push(unknownCheck('dmarc', null, 'DMARC (what receivers do on failure)', txt.error || 'the DNS lookup did not complete'));
    } else {
      const audit = auditDmarc(txt.values);
      // DMARC is not required in order to send, so an absent record is a WARN. Calling it a failure
      // would put a red mark against a correctly configured domain and train people to ignore red.
      const status: CheckStatus = audit.records.length === 0 ? 'warn' : audit.healthy ? (audit.warnings.length ? 'warn' : 'pass') : 'fail';
      checks.push({ ...ok('dmarc', null, 'DMARC (what receivers do on failure)', status,
        audit.records.length === 0
          ? 'No DMARC record is published. Mail still sends; nobody is telling receivers what to do with forgeries, and no reports are being generated.'
          : audit.healthy
            ? 'A valid DMARC record is published with policy "' + (audit.parse?.policy || 'none') + '".'
            : (audit.errors[0] || 'The DMARC record is malformed.'),
        null, audit.effective, [...audit.errors.slice(1), ...audit.warnings, ...audit.advice]), raw: txt.values });
    }
  }

  // --- MX -----------------------------------------------------------------
  let receivingReady = false;
  if (wantsReceiving && selected('mx')) {
    if (!caps.canReceive) {
      checks.push(ok('mx', null, 'MX (where your mail arrives)', 'unknown',
        'This deployment has no inbound host configured, so there is no MX record to check against.', null, null,
        ['An operator must set MAIL_MX_HOSTS before receiving can be offered on a customer domain.'], false));
    } else {
      const mx = await input.resolver.mx(domain);
      if (!mx.checked) {
        unchecked.push('MX: ' + (mx.error || 'the DNS lookup did not complete'));
        checks.push(unknownCheck('mx', null, 'MX (where your mail arrives)', mx.error || 'the DNS lookup did not complete'));
      } else {
        const ourHosts = input.profile.mx.map((m) => m.host.toLowerCase());
        const observedHosts = mx.values.map((m) => m.host.toLowerCase());
        const present = ourHosts.filter((h) => observedHosts.includes(h));
        const foreign = observedHosts.filter((h) => !ourHosts.includes(h));
        const expected = input.profile.mx.map((m) => m.priority + ' ' + m.host).join(', ');
        const observed = mx.values.map((m) => m.priority + ' ' + m.host).join(', ') || null;

        let status: CheckStatus;
        let detail: string;
        const advice: string[] = [];
        if (present.length === 0) {
          status = 'fail';
          detail = observedHosts.length
            ? 'Mail for this domain is delivered elsewhere. None of our inbound hosts appear in its MX records.'
            : 'No MX record is published, so mail to this domain cannot be delivered anywhere.';
          advice.push('Add the MX record(s) shown below when you are ready to move inbound mail. Until then this domain can still SEND without receiving.');
        } else if (present.length < ourHosts.length || foreign.length > 0) {
          status = 'warn';
          detail = foreign.length
            ? 'Our inbound host is listed, and so are others (' + foreign.join(', ') + '). Mail will go to whichever has the lowest priority number, and a backup MX that accepts mail we never see is a common cause of "missing" messages.'
            : 'Only some of our inbound hosts are published. Mail arrives, but the backup path is not in place.';
          advice.push('Publish every MX row shown, at the priorities shown, and remove hosts that no longer receive mail for you.');
        } else {
          status = 'pass';
          detail = 'MX records point at this platform.';
        }
        receivingReady = status === 'pass' || status === 'warn';
        checks.push(ok('mx', null, 'MX (where your mail arrives)', status, detail, expected, observed, advice));
      }
    }
  }

  // --- PTR / reverse DNS --------------------------------------------------
  // Displayed, never configured. The record lives in the reverse zone of whoever owns the address.
  if (wantsSending && selected('ptr') && caps.canShowPtr) {
    for (const ip of input.profile.sendingIps) {
      const ptr = await input.resolver.ptr(ip);
      if (!ptr.checked) {
        unchecked.push('PTR ' + ip + ': ' + (ptr.error || 'the DNS lookup did not complete'));
        checks.push(unknownCheck('ptr', ip, 'Reverse DNS for ' + ip, ptr.error || 'the DNS lookup did not complete'));
        continue;
      }
      const observed = ptr.values[0] || null;
      const expected = input.profile.ptrHostname;
      const advice = ['Reverse DNS is set by the provider that owns this IP address, not in the DNS for your domain and not from this application. If it is wrong, ask them to change it.'];
      let status: CheckStatus;
      let detail: string;
      if (!observed) {
        status = 'fail';
        detail = 'This sending address has no reverse DNS name. Several large receivers refuse mail from an address with no PTR record.';
      } else if (!expected) {
        status = 'warn';
        detail = 'Reverse DNS resolves to "' + observed + '". No expected hostname is configured for this deployment, so it cannot be compared.';
      } else if (observed === expected.toLowerCase()) {
        // Forward-confirmed reverse DNS: the name PTR gives must resolve back to the same address.
        const fwd = await input.resolver.a(observed);
        if (!fwd.checked) {
          status = 'warn';
          detail = 'Reverse DNS is correct. The forward lookup that confirms it could not be completed.';
        } else if (fwd.values.includes(ip)) {
          status = 'pass';
          detail = 'Reverse DNS is correct and forward-confirmed.';
        } else {
          status = 'warn';
          detail = 'Reverse DNS says "' + observed + '", but that name does not resolve back to ' + ip + '. Receivers that require forward-confirmed reverse DNS will treat this as a mismatch.';
        }
      } else {
        status = 'fail';
        detail = 'Reverse DNS says "' + observed + '" but should say "' + expected + '".';
      }
      checks.push(ok('ptr', ip, 'Reverse DNS for ' + ip, status, detail, expected, observed, advice));
    }
  }

  // --- TLS ----------------------------------------------------------------
  // What is honestly observable from this runtime is the PUBLISHED TLS POSTURE: an MTA-STS policy
  // and a TLS-RPT reporting address. Whether the MX actually negotiates STARTTLS needs an SMTP
  // socket, which serverless functions here do not have, and the check says so rather than implying
  // the connection was tested.
  if (selected('tls')) {
    const stsTxt = await input.resolver.txt('_mta-sts.' + domain);
    const rptTxt = await input.resolver.txt('_smtp._tls.' + domain);
    if (!stsTxt.checked && !rptTxt.checked) {
      unchecked.push('TLS: ' + (stsTxt.error || rptTxt.error || 'the DNS lookup did not complete'));
      checks.push(unknownCheck('tls', null, 'Transport security posture', stsTxt.error || rptTxt.error || 'the DNS lookup did not complete'));
    } else {
      const sts = stsTxt.values.find((v) => /^v=STSv1/i.test(v.trim())) || null;
      const rpt = rptTxt.values.find((v) => /^v=TLSRPTv1/i.test(v.trim())) || null;
      const advice: string[] = [
        'This check reads what is published in DNS. Whether a given connection actually negotiates STARTTLS is not probed from here — that needs an SMTP connection, which this runtime cannot open.',
      ];
      if (!sts) advice.push('An MTA-STS policy tells senders to refuse to deliver to this domain over an unencrypted connection. It is optional and takes an HTTPS-hosted policy file as well as the DNS record.');
      if (!rpt) advice.push('A TLS-RPT record ("_smtp._tls") asks senders to report failed TLS connections to you. It changes nothing about delivery.');
      checks.push(ok('tls', null, 'Transport security posture',
        sts ? 'pass' : 'warn',
        sts ? 'An MTA-STS policy is published' + (rpt ? ' along with TLS reporting.' : '; TLS reporting is not.') : 'No MTA-STS policy is published. This is common and is not a fault; mail is still delivered over TLS opportunistically.',
        null, [sts, rpt].filter(Boolean).join(' | ') || null, advice));
    }
  }

  // --- roll-up ------------------------------------------------------------
  const byType = (t: CheckType) => checks.filter((c) => c.type === t);
  const spfOk = byType('spf').filter((c) => c.ref === null).every((c) => c.status === 'pass' || c.status === 'warn') && byType('spf').some((c) => c.ref === null && c.checked);
  const dkimChecks = byType('dkim');
  const dkimOk = dkimChecks.length > 0 && dkimChecks.some((c) => c.status === 'pass');
  const sendingReady = wantsSending && ownershipVerified && spfOk && (caps.canSignDkim ? dkimOk : spfOk);

  const suggestedStatus: DomainHealth['suggestedStatus'] = !ownershipChecked
    ? 'verifying'
    : ownershipVerified
      ? 'verified'
      : 'failed';

  return {
    domain,
    checkedAt: (input.now || new Date()).toISOString(),
    checks,
    ownershipVerified,
    sendingReady,
    receivingReady,
    unchecked,
    spfLookups,
    suggestedStatus,
  };
}

/** A single headline for a list row: the worst thing that is true. */
export function healthSummary(health: DomainHealth): { level: CheckStatus; text: string } {
  if (!health.ownershipVerified) {
    const own = health.checks.find((c) => c.type === 'ownership');
    if (own && !own.checked) return { level: 'unknown', text: 'Ownership could not be checked' };
    return { level: 'fail', text: 'Ownership not verified' };
  }
  const failures = health.checks.filter((c) => c.status === 'fail');
  if (failures.length > 0) return { level: 'fail', text: failures.length + ' problem' + (failures.length === 1 ? '' : 's') + ' to fix' };
  const warns = health.checks.filter((c) => c.status === 'warn');
  if (warns.length > 0) return { level: 'warn', text: warns.length + ' thing' + (warns.length === 1 ? '' : 's') + ' worth reading' };
  if (health.unchecked.length > 0) return { level: 'unknown', text: 'Some checks did not complete' };
  return { level: 'pass', text: 'Healthy' };
}

/** The DMARC policy the health page should offer next, given what is published. Never a jump. */
export function nextDmarcStep(current: DmarcPolicy | null, sendingReady: boolean): { policy: DmarcPolicy; why: string } | null {
  if (!sendingReady) return null;
  if (current === null) return { policy: 'none', why: 'Start with "p=none". It changes nothing about delivery and turns on the reports that show you who is sending as this domain.' };
  if (current === 'none') return { policy: 'quarantine', why: 'Once the reports show your own mail passing, "p=quarantine" sends forgeries to spam instead of the inbox.' };
  if (current === 'quarantine') return { policy: 'reject', why: 'When quarantine has run for a few weeks with no legitimate mail caught, "p=reject" refuses forgeries outright.' };
  return null;
}
