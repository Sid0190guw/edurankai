// Tests for the offer clock.
//
// Every case here is a way the clock could tell somebody the wrong thing about a job. The two that
// matter most are at the top: a signed offer must never appear to expire, and a revoked one must
// never start counting down again.

import { describe, it, expect, report } from './test-shim';
import { offerClock, daysBetween, inDays, WARN_DAYS } from './offer-clock';

const TODAY = '2026-08-13';
const sent = (over: Record<string, any> = {}) => ({ status: 'sent', ...over });

describe('a terminal state beats the calendar', () => {
  it('a signed offer never expires, however old its expiry date', () => {
    // "Expires in 2 days" over an offer somebody already signed reads as the signature not counting.
    const c = offerClock({ status: 'signed', expiryDate: '2026-01-01', responseDeadline: '2026-01-01' }, TODAY);
    expect(c.state).toBe('signed');
    expect(c.live).toBe(false);
    expect(c.sentence.includes('does not expire')).toBe(true);
  });

  it('reads signedAt even when the status column disagrees', () => {
    // The row is written in two places; either one saying "signed" is enough to stop the clock.
    expect(offerClock({ status: 'sent', signedAt: new Date() } as any, TODAY).state).toBe('signed');
  });

  it('a revoked offer does not become overdue three days later', () => {
    const c = offerClock({ status: 'withdrawn', responseDeadline: '2026-08-01' }, TODAY);
    expect(c.state).toBe('withdrawn');
    expect(c.canRevoke).toBe(false);
  });

  it('says a corrected letter can still be issued after a revoke', () => {
    // Revoking must not read as a dead end, or nobody will use it when they should.
    expect(offerClock({ status: 'withdrawn' }, TODAY).sentence.includes('can still be issued')).toBe(true);
  });

  it('a declined offer is terminal too', () => {
    expect(offerClock({ status: 'declined', expiryDate: '2026-12-01' }, TODAY).state).toBe('declined');
  });
});

describe('revocation is offered exactly where it makes sense', () => {
  it('is offered on a live offer', () => {
    expect(offerClock(sent({ expiryDate: '2026-09-01' }), TODAY).canRevoke).toBe(true);
  });

  it('is offered on an EXPIRED offer, so the record can be made to say what happened', () => {
    expect(offerClock(sent({ expiryDate: '2026-07-01' }), TODAY).canRevoke).toBe(true);
  });

  it('is offered on a signed offer, but named as the different act it is', () => {
    const c = offerClock({ status: 'signed' }, TODAY);
    expect(c.canRevoke).toBe(true);
    expect(c.revokeIsRescission).toBe(true);
  });

  it('is NOT offered on a draft, because nothing has been sent to take back', () => {
    expect(offerClock({ status: 'draft' }, TODAY).canRevoke).toBe(false);
  });

  it('is not offered when there is no letter at all', () => {
    expect(offerClock(null, TODAY).canRevoke).toBe(false);
    expect(offerClock(undefined, TODAY).state).toBe('none');
  });
});

describe('the countdown', () => {
  it('counts to the nearer of the two dates', () => {
    const c = offerClock(sent({ responseDeadline: '2026-08-20', expiryDate: '2026-08-30' }), TODAY);
    expect(c.deadlineDays).toBe(7);
    expect(c.expiryDays).toBe(17);
    expect(c.state).toBe('open');
    expect(c.sentence.includes('A reply is due in 7 days')).toBe(true);
    // The further date is still mentioned; both matter and only one is in the headline.
    expect(c.sentence.includes('expires in 17 days')).toBe(true);
  });

  it('warns inside the warning window rather than only on the day', () => {
    const c = offerClock(sent({ expiryDate: '2026-08-15' }), TODAY);
    expect(c.state).toBe('due_soon');
    expect(c.expiryDays).toBeLessThanOrEqual(WARN_DAYS);
  });

  it('says "today" and "tomorrow" instead of 0 and 1 days', () => {
    expect(offerClock(sent({ expiryDate: TODAY }), TODAY).label).toBe('Due today');
    expect(inDays(1)).toBe('tomorrow');
    expect(inDays(-1)).toBe('yesterday');
    expect(inDays(0)).toBe('today');
  });

  it('separates "reply overdue" from "expired", because they need different actions', () => {
    // Past the reply date but still signable: chase them. Past expiry: reissue or revoke.
    const overdue = offerClock(sent({ responseDeadline: '2026-08-05', expiryDate: '2026-08-25' }), TODAY);
    expect(overdue.state).toBe('overdue');
    expect(overdue.live).toBe(true);

    const expired = offerClock(sent({ responseDeadline: '2026-08-05', expiryDate: '2026-08-10' }), TODAY);
    expect(expired.state).toBe('expired');
    expect(expired.live).toBe(false);
    expect(expired.sentence.includes('no longer sign')).toBe(true);
  });

  it('does not pretend to count down when nobody set a date', () => {
    // Silence here would read as "plenty of time". It says the offer stays open indefinitely.
    const c = offerClock(sent(), TODAY);
    expect(c.state).toBe('undated');
    expect(c.sentence.includes('nothing is counting down')).toBe(true);
    expect(c.live).toBe(true);
  });
});

describe('bad input never takes the screen down', () => {
  it('treats an unreadable date as absent instead of throwing', () => {
    const c = offerClock(sent({ expiryDate: 'soon', responseDeadline: '13-08-2026' }), TODAY);
    expect(c.state).toBe('undated');
    expect(c.expiryDays).toBe(null);
  });

  it('daysBetween refuses anything that is not YYYY-MM-DD', () => {
    expect(daysBetween('2026-08-13', 'tomorrow')).toBe(null);
    expect(daysBetween('', '2026-08-13')).toBe(null);
  });

  it('counts across a month and a year boundary correctly', () => {
    // Civil dates compared through UTC, so no zone can shift either end by a day.
    expect(daysBetween('2026-08-30', '2026-09-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

report();
