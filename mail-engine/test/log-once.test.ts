// Log throttling. This exists because of something a live run showed and no unit test would have:
// with no shared secret configured, the delivery worker's 2-second poll made the publisher write an
// identical warning forever — 43,000 lines a day about a condition that had not changed since boot.

import { describe, it, expect } from 'vitest';
import { WarnThrottle } from '../src/log-once.js';
import { HttpDeliveryEventPublisher } from '../src/publish/http.js';
import { makeEvent } from '../src/events.js';
import { testConfig, testLogger, tempDir, removeDir } from './helpers/harness.js';

describe('WarnThrottle', () => {
  it('always lets the first occurrence through', () => {
    const t = new WarnThrottle(60_000, () => 1000);
    expect(t.check('k').shouldLog).toBe(true);
  });

  it('suppresses repeats inside the window and counts them', () => {
    let clock = 1000;
    const t = new WarnThrottle(60_000, () => clock);
    expect(t.check('k').shouldLog).toBe(true);
    // 29 polls at the worker's 2-second interval is 58 seconds — still inside the window.
    for (let i = 0; i < 29; i++) {
      clock += 2000;
      expect(t.check('k').shouldLog, `poll ${i}`).toBe(false);
    }
    // The 30th crosses 60s: it speaks again, and says how many it swallowed.
    clock += 2000;
    const next = t.check('k');
    expect(next.shouldLog).toBe(true);
    expect(next.suppressed).toBe(29);
  });

  it('keeps separate keys separate', () => {
    const t = new WarnThrottle(60_000, () => 1000);
    expect(t.check('a').shouldLog).toBe(true);
    expect(t.check('b').shouldLog).toBe(true);
    expect(t.check('a').shouldLog).toBe(false);
  });

  it('speaks immediately again once the condition is cleared', () => {
    const t = new WarnThrottle(60_000, () => 1000);
    t.check('k');
    expect(t.check('k').shouldLog).toBe(false);
    t.clear('k');
    expect(t.check('k').shouldLog).toBe(true);
  });
});

describe('the publisher does not flood the log', () => {
  it('warns once per minute about a missing secret, not once per poll', async () => {
    const dir = await tempDir('logflood');
    try {
      let clock = 1_700_000_000_000;
      const { logger, lines } = testLogger();
      const publisher = new HttpDeliveryEventPublisher({
        config: testConfig({ MAIL_SPOOL_DIR: dir, MAIL_APP_SHARED_SECRET: '' }),
        logger,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => clock,
      });

      await publisher.publish([makeEvent({
        kind: 'delivered', stage: 'smtp', messageId: 'm1',
        from: 'noreply@edurankai.in', recipient: 'a@example.com',
      })]);

      // Five minutes of the worker polling every two seconds.
      for (let i = 0; i < 150; i++) {
        clock += 2000;
        await publisher.flush();
      }

      const warnings = lines.filter((l) => l.includes('MAIL_APP_SHARED_SECRET is not set'));
      // One at the start plus one per elapsed minute — not 151.
      expect(warnings.length).toBeLessThanOrEqual(7);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
      // And the suppressed count is carried, so the frequency is not lost.
      expect(warnings.some((l) => l.includes('similarSuppressed'))).toBe(true);
      // The events themselves are still all held. Quieter logging must not mean quieter durability.
      expect(await publisher.pending()).toBe(1);
    } finally {
      await removeDir(dir);
    }
  // The 5-second default is a statement about THIS MACHINE, not about the code. The throttling
  // itself runs on an injected clock and costs nothing; the wall-clock here is 151 real spool writes
  // into a temp directory, and on a loaded Windows box inside the full suite that crossed five
  // seconds and failed a test that passes every time on its own. A gate that goes red for being
  // busy is a gate people learn to re-run instead of read, so the budget is stated rather than
  // inherited. Nothing about what is asserted changes.
  }, 30_000);
});
