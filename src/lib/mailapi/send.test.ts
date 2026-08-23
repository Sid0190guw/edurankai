// src/lib/mailapi/send.test.ts — the send path's REFUSALS, decided without a database.
//
// Everything asserted here is the answer to a question the send path used to have no answer for:
// may this organization send as this address, has it any allowance left today, and what is left of
// a body once the parts we will not sign are taken out. Each of those was a declared control that
// did not run, so the tests are written as refusals — a suite that only proved the happy path is
// exactly what let three dead controls look alive.
import { describe, it, expect } from 'vitest';
import {
  platformSendingDomains, verifiedSendingDomains, readDailyCap, utcDayResetSec, summarizeRemovals,
} from './send';
import { checkEnvelopeSender } from '@/lib/mailsec/headers';
import { sanitizeEmailHtml, ISOLATED } from '@/lib/mailsec/html';

describe('platform sending domains', () => {
  it('takes the domain of the configured mailbox, however it is written', () => {
    expect(platformSendingDomains('desk@example.test')).toContain('example.test');
    expect(platformSendingDomains('Support Desk <desk@example.test>')).toContain('example.test');
    expect(platformSendingDomains('DESK@Example.TEST')).toContain('example.test');
  });

  it('never produces an empty entry from a missing or malformed configuration', () => {
    for (const bad of [null, undefined, '', '   ', 'not-an-address']) {
      expect(platformSendingDomains(bad as any).every((d) => d.length > 0)).toBe(true);
    }
  });

  it('de-duplicates, so the same domain configured twice is one entry', () => {
    const list = platformSendingDomains('desk@example.test');
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('verified sending domains', () => {
  const rows = [
    { domain: 'verified.test', status: 'verified' },
    { domain: 'PENDING.test', status: 'pending' },
    { domain: 'unverified.test', status: 'unverified' },
    { domain: 'Mixed-Case.test', status: 'VERIFIED' },
    { domain: '', status: 'verified' },
    { status: 'verified' },
  ];

  it('accepts only rows the domains module actually marked verified', () => {
    expect(verifiedSendingDomains(rows)).toEqual(['verified.test', 'mixed-case.test']);
  });

  it('returns nothing for an organization with no rows at all', () => {
    expect(verifiedSendingDomains([])).toEqual([]);
    expect(verifiedSendingDomains(null as any)).toEqual([]);
  });

  // The evidence columns are deliberately NOT consulted: verifyDomain() writes null into spf_ok when
  // the lookup could not run, and leaves `status` alone, so a resolver timeout must not stop a
  // verified tenant's mail. This asserts that policy rather than leaving it to a comment.
  it('still accepts a verified domain whose spf_ok and dkim_ok are unknown', () => {
    expect(verifiedSendingDomains([{ domain: 'verified.test', status: 'verified', spf_ok: null, dkim_ok: null }]))
      .toEqual(['verified.test']);
  });
});

describe('envelope sender, composed the way the send path composes it', () => {
  // THE BYPASS A REVIEW FOUND, WRITTEN DOWN SO IT CANNOT COME BACK.
  //
  // The platform's own sending domains (the configured mailbox, MAILAPI_DEFAULT_FROM, noreply@ on
  // the site domain) were added to the allow list on EVERY send. So any organization holding any
  // live key could put `security@<our own domain>` in `from` and have us sign it — worse than
  // spoofing a third party, because mail from our own domain is the mail our own people trust.
  //
  // The rule now: the platform list counts only when WE chose the address (the caller supplied no
  // `from`). assertSenderIdentity() is module-private, so this asserts the arithmetic it delegates
  // to, in both of the two configurations it is called with.
  it('a tenant that NAMES an address on the platform domain is judged against its own verified list', () => {
    const platform = ['edurankai.in'];
    const tenantVerified: string[] = [];
    // caller supplied `from` -> platform list is not in play
    expect(checkEnvelopeSender('security@edurankai.in', tenantVerified).allowed).toBe(false);
    // we chose the address -> platform list is in play
    expect(checkEnvelopeSender('security@edurankai.in', [...platform, ...tenantVerified]).allowed).toBe(true);
  });

  it('a tenant sending from its OWN verified domain is unaffected either way', () => {
    const verified = ['tenant.example'];
    expect(checkEnvelopeSender('hello@tenant.example', verified).allowed).toBe(true);
    expect(checkEnvelopeSender('hello@tenant.example', ['edurankai.in', ...verified]).allowed).toBe(true);
  });
  const allowed = ['edurankai.in', 'verified.test'];

  it('refuses a domain that merely ENDS WITH one of ours', () => {
    expect(checkEnvelopeSender('billing@notedurankai.in', allowed).allowed).toBe(false);
    expect(checkEnvelopeSender('billing@evil-verified.test', allowed).allowed).toBe(false);
  });

  it('refuses an unrelated domain outright — this is the open-relay case', () => {
    const verdict = checkEnvelopeSender('security@somebody-elses-bank.test', allowed);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/somebody-elses-bank\.test/);
  });

  it('refuses everything when the organization has verified nothing and we know no domain', () => {
    expect(checkEnvelopeSender('anyone@edurankai.in', []).allowed).toBe(false);
  });

  it('refuses an address that is not an address, before any lookup can happen', () => {
    for (const bad of ['', 'nobody', 'a@b@c.test', 'a@b.test\nbcc: victim@elsewhere.test']) {
      expect(checkEnvelopeSender(bad, allowed).allowed).toBe(false);
    }
  });

  it('allows our own domain and a subdomain of it', () => {
    expect(checkEnvelopeSender('noreply@edurankai.in', allowed).allowed).toBe(true);
    expect(checkEnvelopeSender('noreply@mail.edurankai.in', allowed).allowed).toBe(true);
  });
});

describe('daily send cap', () => {
  it('treats null and absent as NO cap — existing behaviour that must not change', () => {
    expect(readDailyCap(null)).toEqual({ kind: 'none' });
    expect(readDailyCap(undefined)).toEqual({ kind: 'none' });
    expect(readDailyCap('')).toEqual({ kind: 'none' });
  });

  it('treats zero as zero, not as unlimited', () => {
    expect(readDailyCap(0)).toEqual({ kind: 'cap', limit: 0 });
  });

  it('reads a whole number, however the driver typed it', () => {
    expect(readDailyCap(500)).toEqual({ kind: 'cap', limit: 500 });
    expect(readDailyCap('500')).toEqual({ kind: 'cap', limit: 500 });
  });

  // A cap we cannot read is neither zero nor unlimited. Rounding it into a guess is how a control
  // becomes decorative, which is the defect this whole change exists to remove.
  it('refuses to guess at a value that is not a whole non-negative number', () => {
    for (const bad of [-1, 1.5, 'many', NaN, Infinity, {}]) {
      expect(readDailyCap(bad as any).kind).toBe('unreadable');
    }
  });

  it('never reports a reset of zero seconds, including at the boundary', () => {
    const day = 86_400_000;
    expect(utcDayResetSec(day * 10)).toBe(86_400);          // exactly UTC midnight
    expect(utcDayResetSec(day * 10 + 1_000)).toBe(86_399);
    expect(utcDayResetSec(day * 11 - 1)).toBe(1);           // the last millisecond of the day
    expect(utcDayResetSec(day * 11 - 1)).toBeGreaterThan(0);
  });
});

describe('what was removed is reported, not swallowed', () => {
  it('names each removal and counts repeats', () => {
    const summary = summarizeRemovals([
      { kind: 'element', name: 'script', reason: 'x' },
      { kind: 'element', name: 'script', reason: 'x' },
      { kind: 'attribute', name: 'onerror', reason: 'x' },
    ]);
    expect(summary).toContain('<script> x2');
    expect(summary).toContain('onerror=');
  });

  it('truncates a long list instead of returning an unreadable wall of text', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'element' as const, name: 'tag' + i, reason: 'x' }));
    expect(summarizeRemovals(many, 3)).toMatch(/, and 9 more$/);
  });

  it('says nothing when nothing was removed', () => {
    expect(summarizeRemovals([])).toBe('');
  });
});

describe('the profile this file signs bodies with', () => {
  const sanitize = (html: string) => sanitizeEmailHtml(html, ISOLATED);

  it('removes script, framing, event handlers and javascript: hrefs', () => {
    expect(sanitize('<p>hi</p><script>steal()</script>').html).not.toMatch(/script/i);
    expect(sanitize('<iframe src="https://elsewhere.test/"></iframe>').html).not.toMatch(/iframe/i);
    expect(sanitize('<img src="x" onerror="steal()">').html).not.toMatch(/onerror/i);
    expect(sanitize('<a href="javascript:steal()">click</a>').html).not.toMatch(/javascript:/i);
    expect(sanitize('<svg onload="steal()"></svg>').html).not.toMatch(/svg|onload/i);
  });

  it('reports the removal rather than returning a quietly rewritten body', () => {
    const r = sanitize('<p>hi</p><script>steal()</script>');
    expect(r.clean).toBe(false);
    expect(r.removed.length).toBeGreaterThan(0);
  });

  // ISOLATED rather than ORIGIN, because this body goes into an email: forbidding position and
  // z-index here would silently re-lay-out templates that have been sending correctly for months.
  it('keeps ordinary email layout intact', () => {
    const r = sanitize('<table><tr><td style="position:absolute;padding:8px">cell</td></tr></table>');
    expect(r.html).toMatch(/<table>/);
    expect(r.html).toMatch(/position:absolute/);
  });
});
