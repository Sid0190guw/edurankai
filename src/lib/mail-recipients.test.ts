import { describe, it, expect } from 'vitest';
import { resolveRecipients, describeSkips, audienceIsEmpty, type Candidate } from '@/lib/mail-recipients';

const c = (email: string, extra: Partial<Candidate> = {}): Candidate => ({
  contactId: null, email, status: 'subscribed', ...extra,
});

describe('the recipient pipeline', () => {
  it('accepts a clean audience', () => {
    const r = resolveRecipients([c('a@x.com'), c('b@x.com')]);
    expect(r.accepted.map((x) => x.email)).toEqual(['a@x.com', 'b@x.com']);
    expect(r.skipped).toEqual([]);
    expect(r.counts.accepted).toBe(2);
    expect(r.counts.candidates).toBe(2);
  });

  it('DEDUPLICATES first, so a person on three lists counts once', () => {
    const r = resolveRecipients([c('a@x.com'), c('A@X.com'), c(' a@x.com ')]);
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.duplicate).toBe(2);
  });

  it('keeps the FIRST occurrence, with its merge fields', () => {
    const r = resolveRecipients([
      c('a@x.com', { first_name: 'Ananya', contactId: 'one' }),
      c('a@x.com', { first_name: null, contactId: 'two' }),
    ]);
    expect(r.accepted[0].first_name).toBe('Ananya');
    expect(r.accepted[0].contactId).toBe('one');
  });

  it('counts a duplicate of a suppressed address ONCE against suppression', () => {
    const r = resolveRecipients([c('a@x.com'), c('a@x.com')], { suppressed: new Set(['a@x.com']) });
    expect(r.counts.suppressed).toBe(1);
    expect(r.counts.duplicate).toBe(1);
    expect(r.counts.accepted).toBe(0);
  });

  it('removes suppressed addresses even when the contact record says subscribed', () => {
    const r = resolveRecipients([c('a@x.com', { status: 'subscribed' })], { suppressed: new Set(['a@x.com']) });
    expect(r.counts.accepted).toBe(0);
    expect(r.skipped[0].reason).toBe('suppressed');
  });

  it('removes every non-subscribed status with its own reason', () => {
    const r = resolveRecipients([
      c('u@x.com', { status: 'unsubscribed' }),
      c('b@x.com', { status: 'bounced' }),
      c('k@x.com', { status: 'complained' }),
      c('p@x.com', { status: 'pending' }),
    ]);
    expect(r.counts.accepted).toBe(0);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['bounced', 'complained', 'pending', 'unsubscribed']);
  });

  it('removes unusable addresses', () => {
    const r = resolveRecipients([c('a@x.com'), c('not-an-email'), c(''), c('a b@x.com')]);
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.invalid).toBe(3);
  });

  it('removes an explicitly excluded audience', () => {
    const r = resolveRecipients([c('a@x.com'), c('b@x.com')], { excluded: new Set(['b@x.com']) });
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.excluded).toBe(1);
  });

  it('applies exclusion BEFORE suppression, so the reason shown is the operator\'s own', () => {
    const r = resolveRecipients([c('a@x.com')], { excluded: new Set(['a@x.com']), suppressed: new Set(['a@x.com']) });
    expect(r.skipped[0].reason).toBe('excluded');
  });

  it('lets a transactional send widen the allowed statuses', () => {
    const r = resolveRecipients(
      [c('u@x.com', { status: 'unsubscribed' }), c('k@x.com', { status: 'complained' })],
      { allowStatuses: ['subscribed', 'unsubscribed'] },
    );
    expect(r.accepted.map((x) => x.email)).toEqual(['u@x.com']);
    expect(r.counts.complained).toBe(1);
  });

  it('only ignores suppression when a caller says so explicitly', () => {
    const supp = new Set(['a@x.com']);
    expect(resolveRecipients([c('a@x.com')], { suppressed: supp }).counts.accepted).toBe(0);
    expect(resolveRecipients([c('a@x.com')], { suppressed: supp, ignoreSuppression: true }).counts.accepted).toBe(1);
  });

  it('is pure — the same input gives the same output and the input is untouched', () => {
    const input = [c('a@x.com'), c('a@x.com'), c('bad')];
    const snapshot = JSON.stringify(input);
    const one = resolveRecipients(input);
    const two = resolveRecipients(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(one.counts).toEqual(two.counts);
  });

  it('handles a large audience without losing anybody', () => {
    const many: Candidate[] = [];
    for (let i = 0; i < 50000; i++) many.push(c('user' + i + '@example.org'));
    for (let i = 0; i < 5000; i++) many.push(c('user' + i + '@example.org'));   // duplicates
    for (let i = 0; i < 1000; i++) many.push(c('sup' + i + '@example.org'));
    const suppressed = new Set(Array.from({ length: 1000 }, (_, i) => 'sup' + i + '@example.org'));

    const r = resolveRecipients(many, { suppressed });
    expect(r.counts.candidates).toBe(56000);
    expect(r.counts.accepted).toBe(50000);
    expect(r.counts.duplicate).toBe(5000);
    expect(r.counts.suppressed).toBe(1000);
    expect(r.counts.accepted + r.skipped.length).toBe(56000);
    expect(new Set(r.accepted.map((x) => x.email)).size).toBe(50000);
  });

  it('every candidate ends up either accepted or skipped — nobody vanishes', () => {
    const r = resolveRecipients([
      c('a@x.com'), c('a@x.com'), c('u@x.com', { status: 'unsubscribed' }), c('bad'), c('s@x.com'),
    ], { suppressed: new Set(['s@x.com']) });
    expect(r.counts.accepted + r.skipped.length).toBe(r.counts.candidates);
  });
});

describe('skip descriptions', () => {
  it('says nothing when nothing was skipped', () => {
    expect(describeSkips(resolveRecipients([c('a@x.com')]).counts)).toEqual([]);
  });

  it('writes a line per non-zero bucket, singular and plural', () => {
    const r = resolveRecipients([c('a@x.com'), c('a@x.com'), c('bad'), c('worse')]);
    const lines = describeSkips(r.counts);
    expect(lines).toContain('1 duplicate address was removed');
    expect(lines).toContain('2 addresses are not usable');
  });
});

describe('audienceIsEmpty', () => {
  it('spots the empty shapes', () => {
    expect(audienceIsEmpty(null)).toBe(true);
    expect(audienceIsEmpty({})).toBe(true);
    expect(audienceIsEmpty({ listIds: [], segmentIds: [], contactIds: [] })).toBe(true);
    expect(audienceIsEmpty({ segment: { type: 'group', op: 'and', children: [] } })).toBe(true);
  });

  it('spots the populated ones', () => {
    expect(audienceIsEmpty({ listIds: ['x'] })).toBe(false);
    expect(audienceIsEmpty({ contactIds: ['x'] })).toBe(false);
    expect(audienceIsEmpty({ segment: { type: 'group', op: 'and', children: [{ type: 'cond', field: 'email', op: 'is_set' }] } })).toBe(false);
  });
});
