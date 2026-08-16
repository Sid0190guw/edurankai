// mail-engine/src/smtp/throttle.ts — "Do NOT blindly send unlimited traffic" (brief, section 3).
//
// Two independent limits, because they protect against two different failures:
//
//   CONCURRENCY  — how many sockets may be open to one destination at once. Large providers count
//                  simultaneous connections and answer 421 when a sender opens too many; that is a
//                  reputation event, not just a deferral.
//   RATE         — how many messages per minute may be handed to one destination. A sliding window
//                  rather than a fixed one, so a sender cannot push a full minute of traffic at
//                  59 seconds and another full minute at 61.
//
// Both are per destination domain and both fail SOFT: acquire() waits, it does not reject. The
// backpressure the brief asks for is the waiting itself — the delivery worker's own concurrency is
// bounded, so a slow domain occupies a worker slot and the queue drains more slowly rather than the
// engine buffering an unbounded amount of work in memory.

export interface ThrottleOptions {
  perDomainConcurrency: number;
  globalConcurrency: number;
  perDomainRatePerMinute: number;
  /** Injectable clock and sleeper so the tests run in microseconds, not minutes. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called every time a caller has to wait, for the throttle-waits metric. */
  onWait?: (domain: string, reason: 'concurrency' | 'rate', waitMs: number) => void;
}

interface DomainState {
  active: number;
  /** Timestamps of recent sends, oldest first. Trimmed to the last minute on every check. */
  recent: number[];
  waiters: (() => void)[];
}

const MINUTE = 60_000;

export class Throttle {
  private readonly opts: Required<Omit<ThrottleOptions, 'onWait'>> & { onWait?: ThrottleOptions['onWait'] };
  private domains = new Map<string, DomainState>();
  private globalActive = 0;
  private globalWaiters: (() => void)[] = [];

  constructor(opts: ThrottleOptions) {
    this.opts = {
      perDomainConcurrency: Math.max(1, opts.perDomainConcurrency),
      globalConcurrency: Math.max(1, opts.globalConcurrency),
      perDomainRatePerMinute: Math.max(0, opts.perDomainRatePerMinute),
      now: opts.now || (() => Date.now()),
      sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
      onWait: opts.onWait,
    };
  }

  private state(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = { active: 0, recent: [], waiters: [] };
      this.domains.set(domain, s);
    }
    return s;
  }

  /**
   * How long the caller must wait before the rate window has room. 0 when it has room now.
   * Exposed because the worker prefers to re-queue a message rather than hold a slot for minutes.
   */
  rateDelayMs(domain: string): number {
    if (this.opts.perDomainRatePerMinute <= 0) return 0;
    const s = this.state(domain);
    const now = this.opts.now();
    s.recent = s.recent.filter((t) => now - t < MINUTE);
    if (s.recent.length < this.opts.perDomainRatePerMinute) return 0;
    // The oldest send in the window leaves it in (MINUTE - age) ms.
    return MINUTE - (now - s.recent[0]) + 1;
  }

  /**
   * Reserve a slot for one delivery to `domain`. Returns a release function that MUST be called —
   * the caller wraps it in try/finally, because a leaked slot permanently narrows the pipe.
   */
  async acquire(domain: string): Promise<() => void> {
    const d = domain.toLowerCase();
    const s = this.state(d);

    // Global concurrency first: it is the cheaper gate and it protects the host's file descriptors.
    while (this.globalActive >= this.opts.globalConcurrency) {
      this.opts.onWait?.(d, 'concurrency', 0);
      await new Promise<void>((resolve) => this.globalWaiters.push(resolve));
    }

    while (s.active >= this.opts.perDomainConcurrency) {
      this.opts.onWait?.(d, 'concurrency', 0);
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }

    let wait = this.rateDelayMs(d);
    while (wait > 0) {
      this.opts.onWait?.(d, 'rate', wait);
      await this.opts.sleep(wait);
      wait = this.rateDelayMs(d);
    }

    s.active += 1;
    this.globalActive += 1;
    s.recent.push(this.opts.now());

    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.active = Math.max(0, s.active - 1);
      this.globalActive = Math.max(0, this.globalActive - 1);
      const w = s.waiters.shift();
      if (w) w();
      const g = this.globalWaiters.shift();
      if (g) g();
    };
  }

  /** Current picture, for /stats and for the tests. */
  snapshot(): { globalActive: number; domains: { domain: string; active: number; lastMinute: number }[] } {
    const now = this.opts.now();
    const domains: { domain: string; active: number; lastMinute: number }[] = [];
    for (const [domain, s] of this.domains) {
      const lastMinute = s.recent.filter((t) => now - t < MINUTE).length;
      if (s.active || lastMinute) domains.push({ domain, active: s.active, lastMinute });
    }
    return { globalActive: this.globalActive, domains };
  }
}
