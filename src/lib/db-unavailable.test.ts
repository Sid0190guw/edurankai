// What the middleware's database-unavailable answer must and must not do.
//
// The behaviour under test exists because of a specific report: an admin whose /admin/applications
// page had rendered perfectly opened one more thing and was handed a dead "we cannot reach the
// database" page — while the database was answering every other request in about 130ms. The failure
// was one stalled connection handshake on one serverless instance, and it was over before the page
// finished painting.
//
// Two properties carry the whole fix and both are the kind a refactor quietly inverts:
//
//   1. A response nobody is looking at NEVER carries a body. A prefetch that paints an apology over
//      a working screen is worse than the failure it is reporting.
//   2. The automatic retry happens EXACTLY ONCE. A 503 that reloads itself without a marker is a
//      reload storm aimed at a database that is already struggling.
import { describe, it, expect } from 'vitest';
import {
  unavailableMode, unavailableBody, unavailableRetryAfter, factsFromRequest,
  DB_RETRY_COOKIE, DB_RETRY_COOKIE_MAX_AGE, DB_RETRY_DELAY_SECONDS,
  type UnavailableRequestFacts,
} from './db-unavailable';

const facts = (over: Partial<UnavailableRequestFacts> = {}): UnavailableRequestFacts => ({
  method: 'GET',
  fetchMode: 'navigate',
  fetchDest: 'document',
  purpose: null,
  accept: 'text/html,application/xhtml+xml',
  alreadyRetried: false,
  ...over,
});

describe('nothing is painted over a screen somebody is already reading', () => {
  it('answers a prefetch with no body at all', () => {
    // Chrome's speculation rules fetch pages nobody has navigated to. This is the exact route by
    // which a 503 body reaches a person who never asked for the page.
    expect(unavailableMode(facts({ purpose: 'prefetch' }))).toBe('silent');
    expect(unavailableMode(facts({ purpose: 'Prefetch;anonymous-client-ip' }))).toBe('silent');
    expect(unavailableBody('silent', 'session')).toBe('');
  });

  it('answers a fetch() or an XHR with no body', () => {
    expect(unavailableMode(facts({ fetchDest: 'empty', fetchMode: 'cors', accept: '*/*' }))).toBe('silent');
    expect(unavailableMode(facts({ fetchDest: 'script' }))).toBe('silent');
    expect(unavailableMode(facts({ fetchDest: 'image', accept: 'image/*' }))).toBe('silent');
  });

  it('never answers a POST with a page that would re-submit it on reload', () => {
    // The retry page reloads itself. Sending it to a POST is how one click becomes two writes.
    expect(unavailableMode(facts({ method: 'POST' }))).toBe('silent');
    expect(unavailableMode(facts({ method: 'PUT' }))).toBe('silent');
    expect(unavailableMode(facts({ method: 'DELETE' }))).toBe('silent');
  });

  it('still paints for a real navigation, including one inside a frame', () => {
    expect(unavailableMode(facts())).toBe('retry');
    expect(unavailableMode(facts({ fetchDest: 'iframe' }))).toBe('retry');
    expect(unavailableMode(facts({ method: 'HEAD' }))).toBe('retry');
  });

  it('falls back to Accept when Sec-Fetch-* is absent', () => {
    // Older browsers and curl. A navigation asks for text/html; almost nothing else does.
    expect(unavailableMode(facts({ fetchDest: null, fetchMode: null }))).toBe('retry');
    expect(unavailableMode(facts({ fetchDest: null, fetchMode: null, accept: 'application/json' }))).toBe('silent');
    expect(unavailableMode(facts({ fetchDest: null, fetchMode: null, accept: null }))).toBe('silent');
  });
});

describe('it retries once and then stops', () => {
  it('retries a first failure and refuses to retry a second', () => {
    expect(unavailableMode(facts({ alreadyRetried: false }))).toBe('retry');
    expect(unavailableMode(facts({ alreadyRetried: true }))).toBe('manual');
  });

  it('puts a refresh in the retry page and none in the manual one', () => {
    const retry = unavailableBody('retry', 'session');
    const manual = unavailableBody('manual', 'session');
    expect(retry).toContain('http-equiv="refresh"');
    expect(retry).toContain('content="' + DB_RETRY_DELAY_SECONDS + '"');
    // THE ONE ASSERTION THAT PREVENTS A RELOAD STORM. If the page shown after a failed retry can
    // refresh itself, the marker cookie stops nothing.
    expect(manual).not.toContain('http-equiv="refresh"');
    expect(manual).not.toContain('refresh');
  });

  it('names the gate on the page that has stopped retrying, so a report is diagnosable', () => {
    expect(unavailableBody('manual', 'face-2fa')).toContain('face-2fa');
    // And not on the first one, where the person is being told to wait rather than to report.
    expect(unavailableBody('retry', 'face-2fa')).not.toContain('face-2fa');
  });

  it('escapes the gate name rather than trusting it', () => {
    const html = unavailableBody('manual', '<script>x</script>');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the copy tells the truth about which situation this is', () => {
  it('does not claim the sign-in is being retried when nothing is reloading', () => {
    expect(unavailableBody('retry', 'session')).toContain('trying again by itself');
    expect(unavailableBody('manual', 'session')).toContain('stopped reloading itself');
  });

  it('says in both that the account is not the problem', () => {
    // The failure is a connection handshake. Anything that reads as "your sign-in is wrong" sends
    // somebody to reset a password that was never the issue.
    expect(unavailableBody('retry', 'session')).toContain('Nothing about your account');
    expect(unavailableBody('manual', 'session')).toContain('not a problem with your account');
  });
});

describe('Retry-After describes the failure it is actually reporting', () => {
  it('is a couple of seconds for the blip and longer once it has not cleared', () => {
    // It was 15 for everything. The measured recovery is ~130ms: the next request reuses a warm
    // connection. Telling a crawler or an uptime monitor to stay away for fifteen seconds after a
    // one-second stall turns a hiccup into a reported outage.
    expect(unavailableRetryAfter('retry')).toBe(DB_RETRY_DELAY_SECONDS);
    expect(unavailableRetryAfter('silent')).toBe(DB_RETRY_DELAY_SECONDS);
    expect(unavailableRetryAfter('manual')).toBe(15);
  });
});

describe('the facts are read off a real Request', () => {
  it('reads every header the decision depends on', () => {
    const req = new Request('https://example.test/admin/applications', {
      method: 'GET',
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        accept: 'text/html',
      },
    });
    const f = factsFromRequest(req, false);
    expect(f.method).toBe('GET');
    expect(f.fetchMode).toBe('navigate');
    expect(f.fetchDest).toBe('document');
    expect(f.alreadyRetried).toBe(false);
    expect(unavailableMode(f)).toBe('retry');
  });

  it('finds the prefetch marker under either header name', () => {
    const secPurpose = new Request('https://example.test/admin', { headers: { 'sec-purpose': 'prefetch' } });
    const purpose = new Request('https://example.test/admin', { headers: { purpose: 'prefetch' } });
    expect(unavailableMode(factsFromRequest(secPurpose, false))).toBe('silent');
    expect(unavailableMode(factsFromRequest(purpose, false))).toBe('silent');
  });

  it('carries the retry marker through', () => {
    const req = new Request('https://example.test/admin', { headers: { accept: 'text/html' } });
    expect(unavailableMode(factsFromRequest(req, true))).toBe('manual');
  });
});

describe('the marker cookie cannot outlive the incident', () => {
  it('expires on its own, in seconds, so nothing has to clear it on the success path', () => {
    // A query parameter would have to be stripped by a redirect on the path that runs when
    // everything is fine. Ten seconds of cookie costs nothing and touches no working code.
    expect(DB_RETRY_COOKIE_MAX_AGE).toBeGreaterThan(DB_RETRY_DELAY_SECONDS);
    expect(DB_RETRY_COOKIE_MAX_AGE).toBeLessThanOrEqual(30);
    expect(DB_RETRY_COOKIE).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
