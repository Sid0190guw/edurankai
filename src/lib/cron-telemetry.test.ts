// Tests for the canonical cron telemetry (Phase 4 of the remediation).
//
// THE DEFECT. `recordCronRun()` existed, was documented, and had ZERO CALLERS — sixteen scheduled
// jobs, none of them instrumented. /admin/ops honestly reported "not instrumented" for every one of
// them, which is truthful and useless: an operator could not tell a job that ran last night from a
// job that has never run in its life, and neither could anybody else.
//
// The second defect is subtler and is what the state model below exists for: the only outcomes were
// `ok` and `error`. A job that processed 98 of 100 records exits zero and reports ok. So does a job
// that processed 0 because there was nothing to do. So does a job that could not run at all for
// want of a secret. Three completely different situations, one green tick.
//
// These tests are pure — no database — because the part that is invisible when it is wrong is the
// state derivation, not the INSERT.
import { describe, it, expect } from 'vitest';
import {
  CONFIGURED_CRONS,
  cronHealth,
  cronIntervalHours,
  cronNeedsAttention,
  cronRunState,
  deriveCronStatus,
} from '@/lib/observability-health';

const DAILY = '0 3 * * *';
const WEEKLY = '0 1 * * 1';
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-16T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

describe('deriveCronStatus', () => {
  it('is success when work was done and nothing failed', () => {
    expect(deriveCronStatus({ processed: 10, failed: 0 })).toBe('success');
    expect(deriveCronStatus({ processed: 10, succeeded: 10, failed: 0 })).toBe('success');
  });

  it('is PARTIAL when some records failed — the state that used to be reported as success', () => {
    expect(deriveCronStatus({ processed: 100, succeeded: 98, failed: 2 })).toBe('partial');
    expect(deriveCronStatus({ processed: 100, failed: 2 })).toBe('partial');
  });

  it('is failed when everything failed', () => {
    expect(deriveCronStatus({ processed: 5, succeeded: 0, failed: 5 })).toBe('failed');
  });

  it('is skipped — not success — when there was nothing to do', () => {
    // A nightly job with an empty queue is healthy, and it is NOT the same as one that did work.
    // Collapsing them hides the day the queue stopped being filled.
    expect(deriveCronStatus({ processed: 0, failed: 0 })).toBe('skipped');
    expect(deriveCronStatus({})).toBe('skipped');
    expect(deriveCronStatus(null)).toBe('skipped');
  });

  it('an explicit status always wins over the counts', () => {
    expect(deriveCronStatus({ status: 'misconfigured', processed: 0 })).toBe('misconfigured');
    expect(deriveCronStatus({ status: 'failed', processed: 10, failed: 0 })).toBe('failed');
  });
});

describe('cronHealth', () => {
  it('never_run is its own state and is not dressed up as healthy', () => {
    expect(cronHealth(DAILY, null, NOW)).toBe('never_run');
    expect(cronHealth(DAILY, {}, NOW)).toBe('never_run');
    expect(cronHealth(DAILY, { lastRunAt: null, status: null }, NOW)).toBe('never_run');
  });

  it('reports the recorded outcome for a fresh run', () => {
    for (const status of ['success', 'partial', 'failed', 'skipped', 'misconfigured'] as const) {
      expect(cronHealth(DAILY, { lastRunAt: ago(2), status }, NOW)).toBe(status);
    }
  });

  it('OVERDUE BEATS A STALE SUCCESS — the "never run appears healthy" failure, generalised', () => {
    // A job whose last run succeeded three weeks ago is not healthy. Rendering the green from that
    // last success is exactly the class of bug this whole phase exists to remove.
    expect(cronHealth(DAILY, { lastRunAt: ago(24 * 21), status: 'success' }, NOW)).toBe('overdue');
    expect(cronHealth(DAILY, { lastRunAt: ago(40), status: 'success' }, NOW)).toBe('overdue');
    // Inside the grace window it is still fine.
    expect(cronHealth(DAILY, { lastRunAt: ago(30), status: 'success' }, NOW)).toBe('success');
  });

  it('respects a weekly schedule rather than assuming daily', () => {
    expect(cronHealth(WEEKLY, { lastRunAt: ago(24 * 5), status: 'success' }, NOW)).toBe('success');
    expect(cronHealth(WEEKLY, { lastRunAt: ago(24 * 12), status: 'success' }, NOW)).toBe('overdue');
  });

  it('running is reported while the window is open', () => {
    expect(cronHealth(DAILY, { lastStartedAt: ago(0.1), status: 'running' }, NOW)).toBe('running');
  });

  it('a run stuck in running past two intervals is a TIMEOUT, not perpetual activity', () => {
    // The process died mid-run and nothing wrote a terminal state. Reporting "running" forever is
    // how a dead job looks busy.
    expect(cronHealth(DAILY, { lastStartedAt: ago(72), status: 'running' }, NOW)).toBe('timeout');
  });

  it('falls back to success only for a fresh run with no recorded status', () => {
    // Two crons are observable via a module's own last-run timestamp and carry no status.
    expect(cronHealth(DAILY, { lastRunAt: ago(1), status: null }, NOW)).toBe('success');
    expect(cronHealth(DAILY, { lastRunAt: ago(100), status: null }, NOW)).toBe('overdue');
  });

  it('an unparseable timestamp is never_run, not a silent pass', () => {
    expect(cronHealth(DAILY, { lastRunAt: 'not a date', status: 'success' }, NOW)).toBe('never_run');
  });
});

describe('cronNeedsAttention', () => {
  it('flags exactly the states a human has to act on', () => {
    expect(cronNeedsAttention('failed')).toBe(true);
    expect(cronNeedsAttention('timeout')).toBe(true);
    expect(cronNeedsAttention('overdue')).toBe(true);
    expect(cronNeedsAttention('misconfigured')).toBe(true);

    // never_run is a gap in instrumentation, shown separately: it is not an incident.
    expect(cronNeedsAttention('never_run')).toBe(false);
    expect(cronNeedsAttention('success')).toBe(false);
    expect(cronNeedsAttention('skipped')).toBe(false);
    expect(cronNeedsAttention('running')).toBe(false);
    // Partial is deliberately not an alarm on its own — it is visible, and a job that always drops
    // a couple of records would otherwise train people to ignore the alarm entirely.
    expect(cronNeedsAttention('partial')).toBe(false);
  });
});

describe('the old state helper still behaves (existing consumers)', () => {
  it('cronRunState is unchanged', () => {
    expect(cronRunState(DAILY, null, NOW)).toBe('never');
    expect(cronRunState(DAILY, ago(2), NOW)).toBe('ok');
    expect(cronRunState(DAILY, ago(40), NOW)).toBe('overdue');
  });

  it('cronIntervalHours reads the expression', () => {
    expect(cronIntervalHours(DAILY)).toBe(24);
    expect(cronIntervalHours(WEEKLY)).toBe(168);
    expect(cronIntervalHours('*/5 * * * *')).toBe(1);
    expect(cronIntervalHours('nonsense')).toBe(24);
  });
});

describe('instrumentation coverage', () => {
  it('every configured cron has a schedule that parses to a real interval', () => {
    expect(CONFIGURED_CRONS.length).toBeGreaterThan(0);
    for (const c of CONFIGURED_CRONS) {
      expect(cronIntervalHours(c.schedule), c.path).toBeGreaterThan(0);
    }
  });

  it('no configured cron is listed twice', () => {
    const paths = CONFIGURED_CRONS.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
