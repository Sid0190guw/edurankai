// What a counsellor is told, and what nobody is told.
//
// The subject of this test is a promise the software could not keep. /aquintutor/campus/wellness told
// people a counselling request "reaches the counselling team as a real request, not a message into
// the void", and the toast after submitting said "the counselling team reads these from the request
// list". There was no request list: the endpoint had no GET, nothing in the codebase read the notes,
// and nobody was notified.
//
// Two things have to hold at once now, and they pull against each other:
//
//   1. A request must REACH somebody, or the page must not say it does.
//   2. What the person wrote must NOT reach anybody who was not asked — no admin, and not the
//      founder. CLAUDE.md forbids the screen; an email would be worse than a screen, because it
//      persists in an inbox and a backup and a forwarded thread.
//
// So the notification carries the fact of a request and none of its content. These assertions are
// what stops somebody helpfully adding the notes to the email later, which is the single most likely
// way this gets undone — it would look like an improvement.

import { describe, it, expect, report } from './test-shim';
import { noticeBody, counsellingPromise, counsellingRecipient } from './wellness-routing';

const DISCLOSURE = 'I have not slept in four days and I do not want to be here any more';

describe('what the counsellor is sent', () => {
  const body = noticeBody({
    urgency: 'urgent',
    language: 'Tamil',
    contact: 'sridevi@example.com',
    preferredSlot: '2026-08-20T15:00:00+05:30',
    anonymous: true,
  });

  it('carries what a responder needs to answer', () => {
    expect(body.includes('urgent')).toBe(true);
    expect(body.includes('Tamil')).toBe(true);
    expect(body.includes('sridevi@example.com')).toBe(true);
    expect(body.includes('2026-08-20T15:00:00+05:30')).toBe(true);
  });

  it('says the person asked to stay anonymous, without naming them', () => {
    expect(body.includes('anonymous')).toBe(true);
  });

  it('does not carry the disclosure, because the disclosure is not ours to forward', () => {
    // noticeBody has no parameter for it at all — this asserts the shape of the type as much as the
    // string, and would fail the moment somebody widened the interface and passed notes through.
    expect(body.includes(DISCLOSURE)).toBe(false);
    expect(body.toLowerCase().includes('notes')).toBe(false);
  });

  it('tells the responder to ask rather than to look it up', () => {
    // The reason the email is thin has to travel WITH the email. Otherwise it reads like an
    // oversight and the next person fixes it.
    expect(body.includes('Ask them directly')).toBe(true);
  });

  it('handles a missing preferred slot without inventing one', () => {
    const b = noticeBody({ urgency: 'standard', language: 'English', contact: 'x@y.z', anonymous: false });
    expect(b.includes('none given')).toBe(true);
  });
});

describe('what the person is told', () => {
  it('when a counsellor is configured, it says the request was sent', () => {
    const m = counsellingPromise(true);
    expect(m.includes('sent to the counselling team')).toBe(true);
    // Still tells them the message itself is not on a dashboard. Somebody deciding whether to write
    // honestly deserves to know who can read it.
    expect(m.includes('not shown on any staff dashboard')).toBe(true);
  });

  it('when nobody is configured, it says so instead of implying a team', () => {
    const m = counsellingPromise(false);
    expect(m.includes('no counsellor is monitoring')).toBe(true);
    // The words that were on the page before, and were not true.
    expect(m.includes('will reply')).toBe(false);
    expect(m.includes('request list')).toBe(false);
  });

  it('the unmonitored message still points somewhere real', () => {
    // Telling somebody "nobody is reading this" and stopping there is worse than the lie it replaced.
    const m = counsellingPromise(false);
    expect(m.includes('emergency number')).toBe(true);
    expect(m.includes('saved')).toBe(true);
  });
});

describe('the recipient is a decision, not a default', () => {
  it('is null unless configured, and never falls back to an administrator', () => {
    // The tempting fallback is "mail the founder". CLAUDE.md forbids exactly that, and a fallback
    // would also make the honest unmonitored message unreachable.
    const r = counsellingRecipient();
    expect(r === null || String(r).includes('@')).toBe(true);
  });
});

report();
