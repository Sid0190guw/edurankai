// Does a DNS check result carry a VERDICT, or did the lookup simply never answer?
//
// Every case below is a refusal case: the interesting outcomes here are the ones where the honest
// answer is "we could not check", because that is the one this module used to get wrong. It turned
// a four-second resolver timeout into `status = 'failed'` on mp_domains, and the screen that renders
// that status tells the operator to ADD a DNS record — so a transient outage could talk somebody
// into publishing a second SPF record and breaking SPF for their whole domain.
//
// The detail strings asserted against are the literal sentences adapters/domain-dns.ts produces, not
// invented ones. That is the point: classifyCheck reads them because DomainProvider.verify() types
// its status as 'pass' | 'fail' and has nowhere else to put "the lookup did not run", so if those
// sentences change this suite is what notices.

import { describe, it, expect } from 'vitest';
import { classifyCheck, uncheckedReason } from './domains';

describe('classifyCheck — a lookup that did not run is not a verdict', () => {
  it('treats a timed-out lookup as unchecked, not as a failing record', () => {
    expect(classifyCheck({
      status: 'fail',
      detail: 'Could not read TXT for _edurankai.example.org: the lookup timed out',
    })).toBe('unchecked');
  });

  it('treats SERVFAIL from the domain nameservers as unchecked', () => {
    expect(classifyCheck({
      status: 'fail',
      detail: "Could not read MX for example.org: the domain's nameservers returned a failure",
    })).toBe('unchecked');
  });

  it('treats an unnamed resolver error code as unchecked rather than guessing', () => {
    expect(classifyCheck({ status: 'fail', detail: 'Could not read DKIM TXT: EAI_AGAIN' })).toBe('unchecked');
    expect(classifyCheck({ status: 'fail', detail: 'Could not read DKIM TXT: getaddrinfo ECONNREFUSED' })).toBe('unchecked');
  });

  it('treats a check we could not run for a reason on OUR side as unchecked', () => {
    // No MAIL_SPF_INCLUDE means the adapter has nothing to look for. That is a gap in this
    // deployment and must never be reported as a fault in the customer's DNS.
    expect(classifyCheck({
      status: 'fail',
      detail: 'MAIL_SPF_INCLUDE is not configured on this deployment, so there is nothing to check for.',
    })).toBe('unchecked');
  });

  it('believes an explicit checked:false over the status beside it', () => {
    expect(classifyCheck({ status: 'fail', detail: 'anything at all', checked: false })).toBe('unchecked');
  });

  it('refuses to read a verdict out of a status it does not recognise', () => {
    expect(classifyCheck({ status: 'unknown', detail: 'not checked' })).toBe('unchecked');
    expect(classifyCheck({ status: 'pending', detail: '' })).toBe('unchecked');
    expect(classifyCheck({ detail: 'no status field at all' })).toBe('unchecked');
    expect(classifyCheck({})).toBe('unchecked');
  });
});

describe('classifyCheck — a real answer is still reported as one', () => {
  it('keeps NXDOMAIN a failure: the resolver answered, and nothing is published', () => {
    expect(classifyCheck({
      status: 'fail',
      detail: 'Could not read TXT for _edurankai.example.org: no such record published (or not yet propagated)',
    })).toBe('fail');
  });

  it('keeps a published-but-wrong record a failure', () => {
    expect(classifyCheck({
      status: 'fail',
      detail: 'No TXT at _edurankai.example.org matches the verification token. DNS changes can take up to an hour to publish.',
    })).toBe('fail');
    expect(classifyCheck({
      status: 'fail',
      detail: 'This domain publishes 2 SPF records. A domain may have only one — merge them into a single v=spf1 line, or SPF fails for every sender.',
    })).toBe('fail');
    expect(classifyCheck({
      status: 'fail',
      detail: 'MX for example.org does not point at mx.example.net. Inbound mail will not reach the platform.',
    })).toBe('fail');
  });

  it('passes a pass, and counts warn as published (the mapping domains/store.ts already uses)', () => {
    expect(classifyCheck({ status: 'pass', detail: 'Ownership TXT found.' })).toBe('pass');
    expect(classifyCheck({ status: 'warn', detail: 'Published, with something worth reading.' })).toBe('pass');
  });
});

describe('uncheckedReason — phrased as our failure, never as theirs', () => {
  it('names the check and carries the resolver reason', () => {
    expect(uncheckedReason({
      checkType: 'spf',
      detail: 'Could not read TXT for example.org: the lookup timed out',
    })).toBe('SPF: Could not read TXT for example.org: the lookup timed out');
    expect(uncheckedReason({ checkType: 'ownership', detail: 'x' })).toBe('Ownership: x');
  });

  it('says the lookup did not complete rather than inventing a reason it does not have', () => {
    expect(uncheckedReason({ checkType: 'mx' })).toBe('MX: the DNS lookup did not complete');
    expect(uncheckedReason({})).toBe('A check: the DNS lookup did not complete');
  });

  it('falls back to an error field when there is no detail', () => {
    expect(uncheckedReason({ checkType: 'dkim', error: 'the lookup timed out' })).toBe('DKIM: the lookup timed out');
  });
});
