import { describe, it, expect } from 'vitest';
import {
  campaignTransition, canEditContent, recipientsFrozen, stateLabel, stateTone,
  preflight, requiresConfirmation, LARGE_CAMPAIGN_THRESHOLD,
  abErrors, hashBucket, assignVariants, pickWinner, MIN_VARIANT_SAMPLE, HOLDBACK,
  rate, formatRate, campaignRates, EMPTY_TOTALS,
  type AbConfig, type PreflightInput,
} from '@/lib/mail-campaign-state';

describe('the state machine', () => {
  it('walks the ordinary path', () => {
    expect(campaignTransition('draft', 'schedule').to).toBe('scheduled');
    expect(campaignTransition('scheduled', 'queue').to).toBe('queued');
    expect(campaignTransition('queued', 'start').to).toBe('sending');
    expect(campaignTransition('sending', 'complete').to).toBe('completed');
  });

  it('sends immediately from draft', () => {
    expect(campaignTransition('draft', 'queue').to).toBe('queued');
  });

  it('pauses and resumes', () => {
    expect(campaignTransition('sending', 'pause').to).toBe('paused');
    expect(campaignTransition('queued', 'pause').to).toBe('paused');
    expect(campaignTransition('paused', 'resume').to).toBe('sending');
  });

  it('cancels from anything still in flight', () => {
    for (const s of ['draft', 'scheduled', 'queued', 'sending', 'paused']) {
      expect(campaignTransition(s, 'cancel').to, s).toBe('cancelled');
    }
  });

  it('REFUSES to move a completed campaign — that is how a list gets mailed twice', () => {
    for (const a of ['queue', 'start', 'resume', 'schedule', 'pause']) {
      const r = campaignTransition('completed', a);
      expect(r.ok, a).toBe(false);
      expect(r.error).toContain('already finished');
    }
  });

  it('refuses to resume a cancelled campaign and says what to do instead', () => {
    const r = campaignTransition('cancelled', 'resume');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Reopen it as a draft');
  });

  it('lets a worker re-claim a campaign already marked sending', () => {
    expect(campaignTransition('sending', 'start')).toEqual({ ok: true, to: 'sending' });
  });

  it('reopens a failed or cancelled campaign as a draft', () => {
    expect(campaignTransition('failed', 'reopen').to).toBe('draft');
    expect(campaignTransition('cancelled', 'reopen').to).toBe('draft');
  });

  it('names both states in a refusal', () => {
    expect(campaignTransition('draft', 'resume').error).toContain('draft');
    expect(campaignTransition('nonsense', 'queue').error).toContain('Unknown campaign status');
  });

  it('freezes content and recipients at the right points', () => {
    expect(canEditContent('draft')).toBe(true);
    expect(canEditContent('failed')).toBe(true);
    expect(canEditContent('scheduled')).toBe(false);
    expect(canEditContent('sending')).toBe(false);
    expect(recipientsFrozen('queued')).toBe(true);
    expect(recipientsFrozen('draft')).toBe(false);
  });

  it('labels and tones every state', () => {
    expect(stateLabel('sending')).toBe('Sending');
    expect(stateTone('completed')).toBe('ok');
    expect(stateTone('failed')).toBe('bad');
    expect(stateTone('sending')).toBe('live');
  });
});

describe('preflight', () => {
  const ok: PreflightInput = {
    state: 'draft',
    subject: 'Stage 3 progression',
    bodyHtml: '<p>Hi {{first_name | default:"there"}}</p><a href="{{unsubscribe_url}}">unsubscribe</a>',
    fromAddress: 'campaigns@edurankai.in',
    recipientCount: 120,
    audienceDescribed: true,
    hasUnsubscribeLink: true,
    transportReady: true,
  };

  it('passes a sound campaign', () => {
    const r = preflight(ok);
    expect(r.ok).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.needsConfirmation).toBe(false);
  });

  it('BLOCKS an empty audience, empty copy, no from address and no transport', () => {
    expect(preflight({ ...ok, recipientCount: 0 }).blockers.join(' ')).toContain('zero recipients');
    expect(preflight({ ...ok, subject: '' }).blockers.join(' ')).toContain('subject line is empty');
    expect(preflight({ ...ok, bodyHtml: '' }).blockers.join(' ')).toContain('body is empty');
    expect(preflight({ ...ok, fromAddress: '' }).blockers.join(' ')).toContain('sending address');
    expect(preflight({ ...ok, audienceDescribed: false }).blockers.join(' ')).toContain('No audience');
    expect(preflight({ ...ok, transportReady: false }).blockers.join(' ')).toContain('No outbound mail server');
  });

  it('BLOCKS a bulk send with no unsubscribe link', () => {
    const r = preflight({ ...ok, hasUnsubscribeLink: false });
    expect(r.ok).toBe(false);
    expect(r.blockers.join(' ')).toContain('unsubscribe link');
  });

  it('BLOCKS on a broken segment, quoting it', () => {
    expect(preflight({ ...ok, segmentErrors: ['Choose a list.'] }).blockers.join(' ')).toContain('Choose a list.');
  });

  it('BLOCKS a large send until the exact count is typed back', () => {
    const big = { ...ok, recipientCount: LARGE_CAMPAIGN_THRESHOLD };
    expect(preflight(big).ok).toBe(false);
    expect(preflight(big).needsConfirmation).toBe(true);
    expect(preflight({ ...big, confirmedCount: LARGE_CAMPAIGN_THRESHOLD - 1 }).ok).toBe(false);
    expect(preflight({ ...big, confirmedCount: LARGE_CAMPAIGN_THRESHOLD }).ok).toBe(true);
  });

  it('does not demand confirmation below the threshold', () => {
    expect(requiresConfirmation(LARGE_CAMPAIGN_THRESHOLD - 1)).toBe(false);
    expect(requiresConfirmation(LARGE_CAMPAIGN_THRESHOLD)).toBe(true);
    expect(requiresConfirmation(10, 5)).toBe(true);
  });

  it('WARNS — but does not block — on match-everyone, undefaulted variables and a recent twin', () => {
    const r = preflight({
      ...ok,
      matchesEveryone: true,
      variablesWithoutFallback: ['first_name'],
      recentDuplicate: { id: 'x', name: 'Stage 3 progression', hoursAgo: 2 },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('no restriction at all');
    expect(r.warnings.join(' ')).toContain('first_name');
    expect(r.warnings.join(' ')).toContain('2 hours ago');
  });

  it('warns when more addresses were removed than remain', () => {
    const r = preflight({ ...ok, recipientCount: 10, skipped: { suppressed: 40 } });
    expect(r.warnings.join(' ')).toContain('more than are left');
  });

  it('refuses to send from a state that cannot be queued', () => {
    expect(preflight({ ...ok, state: 'completed' }).blockers.join(' ')).toContain('already finished');
  });
});

describe('A/B configuration', () => {
  const ab: AbConfig = {
    enabled: true, dimension: 'subject', testPercent: 20, winnerMetric: 'open',
    variants: [{ key: 'a', subject: 'One' }, { key: 'b', subject: 'Two' }],
  };

  it('accepts a sound test', () => {
    expect(abErrors(ab)).toEqual([]);
    expect(abErrors(null)).toEqual([]);
    expect(abErrors({ ...ab, enabled: false })).toEqual([]);
  });

  it('rejects the mistakes that matter', () => {
    expect(abErrors({ ...ab, variants: [{ key: 'a', subject: 'One' }] })[0]).toContain('at least two');
    expect(abErrors({ ...ab, variants: [{ key: 'a', subject: 'x' }, { key: 'a', subject: 'y' }] }).join(' ')).toContain('same key');
    expect(abErrors({ ...ab, testPercent: 0 })[0]).toContain('between 1 and 100');
    expect(abErrors({ ...ab, variants: [{ key: 'a', subject: 'x' }, { key: 'b' }] }).join(' ')).toContain('own subject');
    expect(abErrors({ ...ab, dimension: 'content', variants: [{ key: 'a', bodyHtml: 'x' }, { key: 'b' }] }).join(' ')).toContain('own body');
  });
});

describe('variant assignment', () => {
  const emails = Array.from({ length: 2000 }, (_, i) => 'user' + i + '@example.org');
  const ab: AbConfig = {
    enabled: true, dimension: 'subject', testPercent: 100, winnerMetric: 'open',
    variants: [{ key: 'a', subject: '1' }, { key: 'b', subject: '2' }],
  };

  it('is STABLE — re-resolving puts everybody back where they were', () => {
    const first = assignVariants(emails, ab, 'campaign-1');
    const second = assignVariants(emails, ab, 'campaign-1');
    expect(second).toEqual(first);
  });

  it('is salted, so the same person is not in the same arm of every test', () => {
    const one = assignVariants(emails, ab, 'campaign-1');
    const two = assignVariants(emails, ab, 'campaign-2');
    expect(one).not.toEqual(two);
  });

  it('splits roughly evenly', () => {
    const counts = { a: 0, b: 0 } as Record<string, number>;
    for (const v of assignVariants(emails, ab, 'c')) counts[v.variant]++;
    expect(counts.a + counts.b).toBe(2000);
    expect(Math.abs(counts.a - counts.b)).toBeLessThan(200);
  });

  it('holds back the untested share when testPercent is below 100', () => {
    const assigned = assignVariants(emails, { ...ab, testPercent: 20 }, 'c');
    const held = assigned.filter((v) => v.variant === HOLDBACK).length;
    expect(held).toBeGreaterThan(1400);
    expect(held).toBeLessThan(1800);
  });

  it('sends the hold-back the winner once one is promoted', () => {
    const assigned = assignVariants(emails, { ...ab, testPercent: 20, winnerKey: 'b' }, 'c');
    expect(assigned.some((v) => v.variant === HOLDBACK)).toBe(false);
    expect(assigned.filter((v) => v.variant === 'b').length).toBeGreaterThan(1400);
  });

  it('gives everyone variant a when no test is running', () => {
    expect(assignVariants(['x@y.com'], null).every((v) => v.variant === 'a')).toBe(true);
    expect(assignVariants(['x@y.com'], { ...ab, enabled: false }).every((v) => v.variant === 'a')).toBe(true);
  });

  it('hashBucket stays in range and is deterministic', () => {
    for (let i = 0; i < 100; i++) {
      const b = hashBucket('seed' + i, 7);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(7);
    }
    expect(hashBucket('abc', 100)).toBe(hashBucket('abc', 100));
  });
});

describe('picking a winner', () => {
  it('names the leader', () => {
    const w = pickWinner([
      { key: 'a', sent: 1000, opened: 300, clicked: 0, converted: 0 },
      { key: 'b', sent: 1000, opened: 200, clicked: 0, converted: 0 },
    ], 'open')!;
    expect(w.key).toBe('a');
    expect(w.runnerUpKey).toBe('b');
    expect(w.confident).toBe(true);
  });

  it('is NOT confident on a small sample, however big the gap looks', () => {
    const w = pickWinner([
      { key: 'a', sent: 10, opened: 6, clicked: 0, converted: 0 },
      { key: 'b', sent: 10, opened: 1, clicked: 0, converted: 0 },
    ], 'open')!;
    expect(w.key).toBe('a');
    expect(w.confident).toBe(false);
    expect(w.reason).toContain(String(MIN_VARIANT_SAMPLE));
  });

  it('is NOT confident when the difference sits inside the margin of error', () => {
    const w = pickWinner([
      { key: 'a', sent: 200, opened: 62, clicked: 0, converted: 0 },
      { key: 'b', sent: 200, opened: 58, clicked: 0, converted: 0 },
    ], 'open')!;
    expect(w.confident).toBe(false);
    expect(w.reason).toContain('margin of error');
  });

  it('reads the metric it was asked for', () => {
    const stats = [
      { key: 'a', sent: 1000, opened: 500, clicked: 50, converted: 0 },
      { key: 'b', sent: 1000, opened: 100, clicked: 200, converted: 0 },
    ];
    expect(pickWinner(stats, 'open')!.key).toBe('a');
    expect(pickWinner(stats, 'click')!.key).toBe('b');
  });

  it('returns null when there is nothing to compare', () => {
    expect(pickWinner([], 'open')).toBeNull();
    expect(pickWinner([{ key: 'a', sent: 10, opened: 1, clicked: 0, converted: 0 }], 'open')).toBeNull();
    expect(pickWinner([
      { key: 'a', sent: 0, opened: 0, clicked: 0, converted: 0 },
      { key: 'b', sent: 0, opened: 0, clicked: 0, converted: 0 },
    ], 'open')).toBeNull();
  });
});

describe('rates', () => {
  it('is NULL, not zero, when nothing has been sent', () => {
    expect(rate(0, 0)).toBeNull();
    expect(formatRate(null)).toBe('—');
    expect(formatRate(rate(25, 100))).toBe('25.0%');
  });

  it('takes open and click over DELIVERED, and says so', () => {
    const rows = campaignRates({ ...EMPTY_TOTALS, recipients: 100, sent: 100, delivered: 90, opened: 45, clicked: 9, bounced: 10 });
    const open = rows.find((r) => r.label === 'Opens')!;
    expect(open.rate).toBeCloseTo(50);
    expect(open.over).toContain('delivered');
    const bounce = rows.find((r) => r.label === 'Bounces')!;
    expect(bounce.rate).toBeCloseTo(10);
    expect(bounce.over).toContain('sent');
  });

  it('draws a dash across the board for a campaign that has not sent', () => {
    const rows = campaignRates({ ...EMPTY_TOTALS, recipients: 40 });
    expect(rows.filter((r) => r.label !== 'Recipients').every((r) => r.rate === null)).toBe(true);
  });
});
