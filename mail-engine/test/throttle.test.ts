// Per-domain concurrency and rate limiting. The clock and the sleeper are injected, so a test of a
// per-minute limit takes microseconds instead of a minute.

import { describe, it, expect } from 'vitest';
import { Throttle } from '../src/smtp/throttle.js';

describe('Throttle — concurrency', () => {
  it('never exceeds the per-domain limit', async () => {
    const t = new Throttle({ perDomainConcurrency: 2, globalConcurrency: 100, perDomainRatePerMinute: 0 });
    let active = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 8 }, async () => {
      const release = await t.acquire('gmail.com');
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    }));

    expect(peak).toBe(2);
  });

  it('lets a second domain proceed while the first is saturated', async () => {
    // The whole point of a PER-DOMAIN limit: one slow provider must not stall every other one.
    const t = new Throttle({ perDomainConcurrency: 1, globalConcurrency: 100, perDomainRatePerMinute: 0 });
    const held = await t.acquire('slow.com');
    let otherRan = false;
    const other = t.acquire('fast.com').then((release) => { otherRan = true; release(); });
    await other;
    expect(otherRan).toBe(true);
    held();
  });

  it('applies a global ceiling across all domains', async () => {
    const t = new Throttle({ perDomainConcurrency: 10, globalConcurrency: 3, perDomainRatePerMinute: 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const release = await t.acquire(`d${i % 4}.com`);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
      release();
    }));
    expect(peak).toBe(3);
  });

  it('releases the slot exactly once even if the caller calls release twice', async () => {
    const t = new Throttle({ perDomainConcurrency: 1, globalConcurrency: 1, perDomainRatePerMinute: 0 });
    const release = await t.acquire('x.com');
    release();
    release();
    // A double release that leaked a permit would let two deliveries run against a limit of one.
    const second = await t.acquire('x.com');
    expect(t.snapshot().globalActive).toBe(1);
    second();
  });
});

describe('Throttle — rate limiting', () => {
  it('reports no delay until the window is full', () => {
    let clock = 0;
    const t = new Throttle({
      perDomainConcurrency: 10, globalConcurrency: 10, perDomainRatePerMinute: 3,
      now: () => clock, sleep: async () => { clock += 1; },
    });
    expect(t.rateDelayMs('example.com')).toBe(0);
  });

  it('makes the fourth send of a 3/minute limit wait for the window to slide', async () => {
    let clock = 1_000_000;
    const waits: number[] = [];
    const t = new Throttle({
      perDomainConcurrency: 10, globalConcurrency: 10, perDomainRatePerMinute: 3,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
    });

    for (let i = 0; i < 3; i++) (await t.acquire('example.com'))();
    expect(waits).toHaveLength(0);

    // The window holds three sends made at the same instant, so the fourth waits a full minute.
    (await t.acquire('example.com'))();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(60_001);
  });

  it('lets sends through again once the oldest leaves the window', async () => {
    let clock = 1_000_000;
    const t = new Throttle({
      perDomainConcurrency: 10, globalConcurrency: 10, perDomainRatePerMinute: 2,
      now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    (await t.acquire('example.com'))();
    clock += 30_000;
    (await t.acquire('example.com'))();
    clock += 31_000;                                  // the first send is now older than a minute
    expect(t.rateDelayMs('example.com')).toBe(0);
  });

  it('is disabled when the rate is zero', async () => {
    const t = new Throttle({ perDomainConcurrency: 10, globalConcurrency: 10, perDomainRatePerMinute: 0 });
    for (let i = 0; i < 50; i++) (await t.acquire('example.com'))();
    expect(t.rateDelayMs('example.com')).toBe(0);
  });

  it('reports what it is doing', async () => {
    const t = new Throttle({ perDomainConcurrency: 2, globalConcurrency: 4, perDomainRatePerMinute: 10 });
    const a = await t.acquire('gmail.com');
    await t.acquire('outlook.com');
    const snap = t.snapshot();
    expect(snap.globalActive).toBe(2);
    expect(snap.domains.map((d) => d.domain).sort()).toEqual(['gmail.com', 'outlook.com']);
    a();
  });
});
