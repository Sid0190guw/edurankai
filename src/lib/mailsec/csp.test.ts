// src/lib/mailsec/csp.test.ts — the refusals, and the two properties that make this policy worth
// having at all.
//
// The interesting assertions here are NOT "the header contains script-src". They are:
//
//   1. The report-uri refusals. That value is the only caller-supplied string that reaches a
//      response header from this module, so it is the only place a policy can be rewritten by
//      input. A semicolon in it appends a directive; a CR appends a header. Both are asserted.
//   2. The absences. script-src must NOT carry 'unsafe-inline' or 'unsafe-eval' — if a later edit
//      adds either to quieten the report, the policy stops being informative and this suite says
//      so. Those two tests are the ones guarding the intent of the file.
//   3. The default is report-only. An edit that flips the default takes production down; it should
//      have to delete a test that says so out loud.
import { describe, it, expect } from 'vitest';
import { mailCsp, reportUriRefusal, serializeCsp, DOCUMENT_CSP, API_CSP } from './csp';
import { secureHeaders, secureJson } from '@/lib/http-guard';

describe('report-uri refusals', () => {
  const REFUSED = [
    ['', 'empty'],
    ['/csp\r\nX-Injected: 1', 'contains a line break or control character'],
    ['/csp\nSet-Cookie: a=b', 'contains a line break or control character'],
    ['/csp\r', 'contains a line break or control character'],
    // Written as an escape, never as the byte itself: src/lib/mailsec/headers.ts records that
    // this file's sibling once shipped with LITERAL control bytes in the source, which are
    // invisible in a diff and survive review. A NUL is a control character, so it is refused by
    // the injection rule.
    ['/csp\u0000', 'contains a line break or control character'],
    // A plain space is NOT a control character (isBreakingCodePoint is c < 0x20), so it is
    // refused by the whitespace rule instead. Asserting the exact reason is what keeps 'this
    // would forge a header' and 'this would split a directive' distinguishable.
    ['/csp ', 'contains whitespace, which would split the directive'],
    ['/csp; script-src *', 'contains a semicolon, which would start a new directive'],
    ['/csp;', 'contains a semicolon, which would start a new directive'],
    ['/csp, default-src *', 'contains a comma, which would start a new policy'],
    ['/csp report', 'contains whitespace, which would split the directive'],
    ['//evil.example/collect', 'is protocol-relative, which points off-origin'],
    ['https://evil.example/collect', 'is an absolute URL, which points off-origin'],
    ['http://evil.example/collect', 'is an absolute URL, which points off-origin'],
    ['javascript:alert(1)', 'is an absolute URL, which points off-origin'],
    // A real data: URL always carries a comma, so the comma rule refuses it before the scheme rule
    // is reached. Both answers are correct and the value is refused either way; the expectation
    // records which rule actually fires so a reordering of the checks shows up here as a change.
    ['data:text/plain,x', 'contains a comma, which would start a new policy'],
    // The comma-free form proves the scheme rule catches data: on its own.
    ['data:x', 'is an absolute URL, which points off-origin'],
    ['csp-report', 'is not an absolute path'],
    ['../csp', 'is not an absolute path'],
  ] as const;

  for (const [value, why] of REFUSED) {
    it('refuses ' + JSON.stringify(value), () => expect(reportUriRefusal(value)).toBe(why));
  }

  it('accepts a same-origin absolute path', () => {
    for (const ok of ['/api/mail/csp-report', '/csp', '/a/b/c?x=1']) {
      expect(reportUriRefusal(ok), ok).toBeNull();
    }
  });

  it('refuses null and undefined rather than emitting the string "null"', () => {
    expect(reportUriRefusal(null)).toBe('empty');
    expect(reportUriRefusal(undefined)).toBe('empty');
  });
});

describe('a refused report-uri is reported, not silently dropped', () => {
  it('names the refusal and leaves report-uri out of the header', () => {
    const r = mailCsp({ reportUri: 'https://evil.example/collect' });
    expect(r.value).not.toContain('report-uri');
    expect(r.value).not.toContain('evil.example');
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]).toContain('report-uri');
    expect(r.refused[0]).toContain('off-origin');
  });

  it('cannot be talked into a second directive or a second header', () => {
    // The whole point: a caller-supplied value must never change the SHAPE of the policy.
    const clean = mailCsp({ profile: 'DOCUMENT' }).value;
    for (const payload of ['/csp; script-src *', '/csp\r\nX-Injected: 1', '/csp, default-src *']) {
      const r = mailCsp({ profile: 'DOCUMENT', reportUri: payload });
      expect(r.value, payload).toBe(clean);
      expect(r.refused, payload).toHaveLength(1);
    }
  });

  it('emits an accepted report-uri and refuses nothing', () => {
    const r = mailCsp({ reportUri: '/api/mail/csp-report' });
    expect(r.value).toContain('report-uri /api/mail/csp-report');
    expect(r.refused).toEqual([]);
  });
});

describe('the mode defaults to the one that cannot cause an outage', () => {
  it('is report-only when nothing is asked for', () => {
    expect(mailCsp().header).toBe('Content-Security-Policy-Report-Only');
    expect(mailCsp({}).header).toBe('Content-Security-Policy-Report-Only');
    expect(mailCsp({ reportOnly: true }).header).toBe('Content-Security-Policy-Report-Only');
  });

  it('enforces only when explicitly told to', () => {
    expect(mailCsp({ reportOnly: false }).header).toBe('Content-Security-Policy');
  });

  it('does not treat a missing option as a request to enforce', () => {
    expect(mailCsp({ reportOnly: undefined }).header).toBe('Content-Security-Policy-Report-Only');
  });
});

describe('the document policy stays informative', () => {
  const value = mailCsp({ profile: 'DOCUMENT' }).value;

  // If either of these ever passes, the report has stopped telling anybody anything about the 75
  // define:vars files or the five new Function sites, and enforcing later becomes guesswork.
  it('does not allow inline script', () => {
    expect(DOCUMENT_CSP['script-src']).not.toContain("'unsafe-inline'");
    expect(value).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('does not allow eval', () => {
    expect(DOCUMENT_CSP['script-src']).not.toContain("'unsafe-eval'");
    expect(value).not.toContain("'unsafe-eval'");
  });

  it('closes the directives that have no legitimate use here', () => {
    expect(DOCUMENT_CSP['object-src']).toEqual(["'none'"]);
    expect(DOCUMENT_CSP['base-uri']).toEqual(["'self'"]);
    expect(DOCUMENT_CSP['form-action']).toEqual(["'self'"]);
    expect(DOCUMENT_CSP['frame-ancestors']).toEqual(["'self'"]);
  });

  it('keeps outbound calls same-origin so anything phoning out is reported', () => {
    expect(DOCUMENT_CSP['connect-src']).toEqual(["'self'"]);
  });

  it('omits the directives that are silently ignored in report-only mode', () => {
    // Listing these would read as protection that is not there.
    expect(value).not.toContain('upgrade-insecure-requests');
    expect(value).not.toContain('sandbox');
  });
});

describe('the API policy allows nothing', () => {
  it('is default-src none', () => {
    const r = mailCsp({ profile: 'API' });
    expect(r.value).toContain("default-src 'none'");
    expect(API_CSP['frame-ancestors']).toEqual(["'none'"]);
  });

  it('is what an unspecified profile gets, because that is what secureHeaders decorates', () => {
    expect(mailCsp().value).toBe(mailCsp({ profile: 'API' }).value);
  });

  it('never carries a script origin', () => {
    expect(mailCsp({ profile: 'API' }).value).not.toContain('https://');
  });
});

// A policy that is correct but not attached to anything protects nothing, and "the module exists"
// has been mistaken for "the header ships" on this project before. These assertions look at the
// real Response object rather than at the policy builder.
describe('the header is actually attached to responses', () => {
  it('rides on secureHeaders() by default', () => {
    const h = secureHeaders();
    expect(h['Content-Security-Policy-Report-Only']).toContain("default-src 'none'");
    // Report-only, so the enforcing header must NOT also be present. Two CSP headers that disagree
    // is the failure mode this was explicitly built to avoid.
    expect(h['Content-Security-Policy']).toBeUndefined();
  });

  it('keeps the headers that were already there', () => {
    const h = secureHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toContain('max-age=63072000');
  });

  it('reaches a real Response built by secureJson', () => {
    const res = secureJson({ ok: true });
    const got = res.headers.get('content-security-policy-report-only');
    expect(got).toBeTruthy();
    expect(got).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('serves the document policy when a caller says it is returning a page', () => {
    const h = secureHeaders({ csp: 'DOCUMENT' });
    const v = h['Content-Security-Policy-Report-Only'];
    expect(v).toContain("script-src 'self' https://checkout.razorpay.com");
    expect(v).toContain('https://www.youtube-nocookie.com');
  });
});

describe('serialization', () => {
  it('joins directives with semicolons and values with spaces', () => {
    expect(serializeCsp({ 'default-src': ["'self'"], 'object-src': ["'none'"] }))
      .toBe("default-src 'self'; object-src 'none'");
  });

  it('emits a valueless directive bare', () => {
    expect(serializeCsp({ 'upgrade-insecure-requests': [] })).toBe('upgrade-insecure-requests');
  });

  it('produces a header value with no line break in it', () => {
    for (const profile of ['DOCUMENT', 'API'] as const) {
      expect(/[\r\n]/.test(mailCsp({ profile }).value), profile).toBe(false);
    }
  });
});
