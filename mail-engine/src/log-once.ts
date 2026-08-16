// mail-engine/src/log-once.ts — say it now, say it again later, do not say it every two seconds.
//
// FOUND BY RUNNING THE THING. With no MAIL_APP_SHARED_SECRET set, the delivery worker's poll loop
// called publisher.flush() every 2 seconds, each call found the same 21 undeliverable events, and
// each one wrote:
//
//   {"level":"warn","msg":"not publishing: MAIL_APP_SHARED_SECRET is not set","pending":21}
//
// Forever. That is 43,000 identical lines a day about a condition that has not changed since boot.
// The cost is not disk — it is that the one line which matters, the one describing something NEW,
// arrives buried under thousands of copies of something already known. A log nobody can read is a
// log nobody reads.
//
// The condition is still reported, and still reported repeatedly — a persistent misconfiguration
// should keep nagging — just at a human interval, with a count of how many times it was suppressed
// so the frequency is not lost either.

export interface ThrottledWarning {
  /** True when the caller should emit; false when this occurrence is being suppressed. */
  shouldLog: boolean;
  /** How many occurrences were suppressed since the last emitted one. 0 on the first. */
  suppressed: number;
}

/**
 * Rate-limits by key. Not a class, so a caller can hold one per component without ceremony, and the
 * clock is injectable because a test for a one-per-minute rule should not take a minute.
 */
export class WarnThrottle {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private state = new Map<string, { lastAt: number; suppressed: number }>();

  constructor(intervalMs = 60_000, now: () => number = () => Date.now()) {
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /** Ask whether to log `key` right now. The first call for a key always says yes. */
  check(key: string): ThrottledWarning {
    const at = this.now();
    const prev = this.state.get(key);
    if (!prev || at - prev.lastAt >= this.intervalMs) {
      const suppressed = prev ? prev.suppressed : 0;
      this.state.set(key, { lastAt: at, suppressed: 0 });
      return { shouldLog: true, suppressed };
    }
    prev.suppressed += 1;
    return { shouldLog: false, suppressed: prev.suppressed };
  }

  /** Forget a key, so the next occurrence logs immediately. Call when the condition clears. */
  clear(key: string): void {
    this.state.delete(key);
  }
}
