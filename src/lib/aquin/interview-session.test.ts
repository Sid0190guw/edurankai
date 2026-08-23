// The interview session binding, asserted on the thing that actually decides: cookieProvesSession.
//
// These run without a database and without Astro. What they protect is the property the five
// writers under /api/aquintutor/interview/ depend on — that a cookie proves ONE session and no
// other, that it cannot be forged without SESSION_SECRET, and that a missing secret refuses rather
// than waves everything through.

import { describe, it, expect, report } from '../test-shim';
import {
  cookieProvesSession,
  cookieValueFor,
  parseCookieValue,
  signSession,
  INTERVIEW_COOKIE,
  INTERVIEW_COOKIE_MAX_AGE_SECONDS,
} from './interview-session';

const KEY = 'a-test-secret-that-is-long-enough-to-be-real';
const OTHER_KEY = 'a-different-secret-entirely-not-the-same-one';
const SESSION = '3f0d9a52-8c41-4e77-9b1e-2a6c5d0f1188';
const OTHER = '9911aa22-bb33-4c44-8d55-ee66ff770011';

describe('the signature', () => {
  it('is stable for one session and different for another', () => {
    expect(signSession(SESSION, KEY)).toBe(signSession(SESSION, KEY));
    expect(signSession(SESSION, KEY) === signSession(OTHER, KEY)).toBe(false);
  });

  it('depends on the secret, so another deployment cannot mint one that verifies here', () => {
    expect(signSession(SESSION, KEY) === signSession(SESSION, OTHER_KEY)).toBe(false);
  });

  it('is long enough that guessing is not a strategy', () => {
    // 32 base64url characters is 192 bits.
    expect(signSession(SESSION, KEY).length).toBe(32);
  });

  it('is empty with no secret, so nothing can be minted unsigned', () => {
    expect(signSession(SESSION, '')).toBe('');
    expect(cookieValueFor(SESSION, '')).toBe('');
  });
});

describe('the cookie value', () => {
  it('carries the session it is for, so a cookie for another interview is visibly a different one', () => {
    const parsed = parseCookieValue(cookieValueFor(SESSION, KEY));
    expect(parsed?.sessionId).toBe(SESSION);
    expect(parsed?.signature).toBe(signSession(SESSION, KEY));
  });

  it('refuses shapes that are not "id.signature"', () => {
    expect(parseCookieValue('')).toBeNull();
    expect(parseCookieValue(null)).toBeNull();
    expect(parseCookieValue('no-dot-at-all')).toBeNull();
    expect(parseCookieValue('.leading')).toBeNull();
    expect(parseCookieValue('trailing.')).toBeNull();
  });
});

describe('what the writers ask', () => {
  it('accepts the cookie minted for that session', () => {
    expect(cookieProvesSession(cookieValueFor(SESSION, KEY), SESSION, KEY)).toBe(true);
  });

  it('REFUSES A GENUINE COOKIE POINTED AT SOMEBODY ELSE-S SESSION', () => {
    // The whole point. Holding one real cookie must not be a key to every other interview.
    expect(cookieProvesSession(cookieValueFor(SESSION, KEY), OTHER, KEY)).toBe(false);
  });

  it('refuses a cookie whose session half was edited to name another interview', () => {
    const forged = OTHER + '.' + signSession(SESSION, KEY);
    expect(cookieProvesSession(forged, OTHER, KEY)).toBe(false);
  });

  it('refuses a signature minted under a different secret', () => {
    expect(cookieProvesSession(cookieValueFor(SESSION, OTHER_KEY), SESSION, KEY)).toBe(false);
  });

  it('refuses an absent, empty or malformed cookie', () => {
    expect(cookieProvesSession(undefined, SESSION, KEY)).toBe(false);
    expect(cookieProvesSession('', SESSION, KEY)).toBe(false);
    expect(cookieProvesSession('garbage', SESSION, KEY)).toBe(false);
    expect(cookieProvesSession(SESSION, SESSION, KEY)).toBe(false); // id with no signature at all
  });

  it('refuses a truncated or lengthened signature rather than throwing on the comparison', () => {
    const good = signSession(SESSION, KEY);
    expect(cookieProvesSession(SESSION + '.' + good.slice(0, 20), SESSION, KEY)).toBe(false);
    expect(cookieProvesSession(SESSION + '.' + good + 'xx', SESSION, KEY)).toBe(false);
  });

  it('FAILS CLOSED WITH NO SECRET — an unconfigured deployment verifies nothing', () => {
    // If this ever answered true, every one of the five writers would be open again, and the
    // failure would look exactly like a working deployment.
    expect(cookieProvesSession(cookieValueFor(SESSION, KEY), SESSION, '')).toBe(false);
    expect(cookieProvesSession('anything.atall', SESSION, '')).toBe(false);
  });

  it('refuses an empty session id even with a cookie present', () => {
    expect(cookieProvesSession(cookieValueFor(SESSION, KEY), '', KEY)).toBe(false);
  });
});

describe('the cookie itself', () => {
  it('is named for this product and outlives an interview without outliving a day', () => {
    expect(INTERVIEW_COOKIE).toBe('era_interview');
    expect(INTERVIEW_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(60 * 60);
    expect(INTERVIEW_COOKIE_MAX_AGE_SECONDS).toBeLessThanOrEqual(12 * 60 * 60);
  });
});

report();
