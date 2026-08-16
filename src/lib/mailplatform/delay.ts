// src/lib/mailplatform/delay.ts — WHEN A WAITING RUN WAKES UP. Pure arithmetic, no timers.
//
// THERE IS NO setTimeout IN THIS ENGINE, ANYWHERE, AND THAT IS THE WHOLE POINT OF THIS FILE.
// A delay is resolved ONCE into an absolute instant, that instant is written to
// mail_workflow_runs.wait_until, and the run is set WAITING. Waking up is a query — "give me the
// waiting runs whose wait_until has passed" — so a delay survives a worker restart, a deploy, a
// database failover and a serverless function that lived for 300ms, because nothing about the delay
// was ever held in a process. On Vercel this matters twice over: the process that started the wait
// is guaranteed to be gone long before a 24-hour delay expires.
//
// THE INSTANT IS COMPUTED AT THE MOMENT THE RUN REACHES THE DELAY, not when the workflow was
// authored. "Wait 24 hours" means 24 hours from this contact's arrival at that node.
export type DelaySpec =
  | { kind: 'minutes' | 'hours' | 'days'; amount: number }
  /** An absolute instant: "wait until 2026-08-20T09:00:00+05:30". */
  | { kind: 'until'; at: string }
  /**
   * An instant taken from the run's own facts, optionally offset. This is how "wait until the
   * deadline minus 24 hours" is expressed without the author knowing any candidate's deadline:
   *   { kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 }
   */
  | { kind: 'until_field'; field: string; offsetMinutes?: number };

/** A year. A delay longer than this is far more likely to be a units mistake (90000 minutes typed
 *  as 90000 days) than an intention, and a run parked until 2189 is one nobody will ever notice. */
export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export type DelayResolution =
  | { ok: true; at: Date; /** True when the target was already in the past — see below. */ immediate: boolean }
  | { ok: false; error: string };

const MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/**
 * Turn a delay spec into the absolute instant the run should wake.
 *
 * A TARGET ALREADY IN THE PAST RESOLVES TO NOW, and does not fail. A workflow triggered two days
 * after the date it waits for is the normal case for a backfill or a replayed event; treating it as
 * an error would dead-letter runs for doing nothing wrong, and treating it as "never" would strand
 * them in WAITING for ever. Firing immediately is the only behaviour that finishes the run.
 *
 * `resolveField` is passed in rather than imported so this file stays pure arithmetic and the tests
 * do not have to build a facts object shaped like the whole engine.
 */
export function resolveDelay(
  spec: DelaySpec | null | undefined,
  now: Date,
  readField?: (path: string) => unknown,
): DelayResolution {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'The delay node has no duration.' };
  const nowMs = now.getTime();

  if (spec.kind === 'minutes' || spec.kind === 'hours' || spec.kind === 'days') {
    const amount = Number((spec as any).amount);
    if (!Number.isFinite(amount)) return { ok: false, error: 'The delay amount is not a number.' };
    if (amount < 0) return { ok: false, error: 'A delay cannot be negative.' };
    const ms = amount * MS[spec.kind];
    if (ms > MAX_DELAY_MS) return { ok: false, error: 'That delay is longer than a year (' + amount + ' ' + spec.kind + '). Check the units.' };
    return { ok: true, at: new Date(nowMs + ms), immediate: ms === 0 };
  }

  if (spec.kind === 'until') {
    const t = Date.parse(String(spec.at || ''));
    if (!Number.isFinite(t)) return { ok: false, error: 'The date to wait until could not be read: "' + String(spec.at) + '".' };
    if (t - nowMs > MAX_DELAY_MS) return { ok: false, error: 'That date is more than a year away. Check the year.' };
    return t <= nowMs ? { ok: true, at: new Date(nowMs), immediate: true } : { ok: true, at: new Date(t), immediate: false };
  }

  if (spec.kind === 'until_field') {
    if (!spec.field) return { ok: false, error: 'The delay does not say which field holds the date.' };
    if (!readField) return { ok: false, error: 'This delay reads a date from the run, and no run facts were supplied.' };
    const raw = readField(spec.field);
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      // A BUSINESS-RULE FAILURE, not a bug: the event that started this run carried no deadline.
      // The engine records it and stops that run; it does not retry, because retrying reads the
      // same absent field again, and it does not guess a date, because guessing a deadline sends a
      // "your deadline is tomorrow" mail to somebody who has no deadline.
      return { ok: false, error: 'This run has no value for "' + spec.field + '", so there is no date to wait for.' };
    }
    const base = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    if (!Number.isFinite(base)) return { ok: false, error: '"' + spec.field + '" is not a date: "' + String(raw) + '".' };
    const offset = Number(spec.offsetMinutes || 0) * 60_000;
    if (!Number.isFinite(offset)) return { ok: false, error: 'The delay offset is not a number of minutes.' };
    const t = base + offset;
    if (t - nowMs > MAX_DELAY_MS) return { ok: false, error: 'That works out more than a year away. Check the date in "' + spec.field + '".' };
    return t <= nowMs ? { ok: true, at: new Date(nowMs), immediate: true } : { ok: true, at: new Date(t), immediate: false };
  }

  return { ok: false, error: 'Unknown delay kind "' + String((spec as any).kind) + '".' };
}

/** A one-line human summary, for the builder and the run log. */
export function describeDelay(spec: DelaySpec | null | undefined): string {
  if (!spec || typeof spec !== 'object') return 'no delay';
  if (spec.kind === 'minutes' || spec.kind === 'hours' || spec.kind === 'days') {
    const n = Number((spec as any).amount);
    const unit = n === 1 ? spec.kind.replace(/s$/, '') : spec.kind;
    return 'wait ' + n + ' ' + unit;
  }
  if (spec.kind === 'until') return 'wait until ' + String(spec.at);
  if (spec.kind === 'until_field') {
    const off = Number(spec.offsetMinutes || 0);
    if (!off) return 'wait until ' + spec.field;
    const hours = Math.abs(off) / 60;
    const amount = Number.isInteger(hours) ? hours + (hours === 1 ? ' hour' : ' hours') : Math.abs(off) + ' minutes';
    return 'wait until ' + spec.field + (off < 0 ? ' minus ' : ' plus ') + amount;
  }
  return 'unknown delay';
}
