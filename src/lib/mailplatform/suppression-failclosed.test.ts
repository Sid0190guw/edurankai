// src/lib/mailplatform/suppression-failclosed.test.ts — the suppression check must REFUSE, not allow.
//
// This suite exists for one regression and asserts almost nothing else: when mp_suppression_entries
// cannot be read, the old code returned a map in which every address was `suppressed: false`, which
// is byte-for-byte what a clean read of an empty list returns. Every caller then sent. One pooler
// blip therefore mailed every hard bounce, unsubscribe and spam complainant on the list, with no
// counter and no durable record — and re-mailing a complainant cannot be undone.
//
// So the cases below are the REFUSALS. "Nobody is suppressed" is tested too, but only to prove it is
// still distinguishable from "we could not find out".
//
// NO DATABASE IS TOUCHED. `@/lib/db` is replaced with a mock before the module under test loads, so
// the real client is never even evaluated, let alone connected.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));

const { checkSuppressed, checkSuppressedResult, isSuppressed, SuppressionUnavailableError } = await import('./suppression');
const { TemporaryFailure, classifyError } = await import('./errors');

const ORG = '00000000-0000-0000-0000-0000000000aa';

/** How a drizzle/postgres-js failure actually arrives: e.message is the SQL, e.cause has the reason. */
function pgFailure(reason: string): Error {
  const e = new Error('failed query: SELECT lower(address) AS addr, reason ... FROM mp_suppression_entries');
  (e as any).cause = new Error(reason);
  return e;
}

beforeEach(() => {
  mocks.execute.mockReset();
});

describe('the read failed — we could not find out', () => {
  it('throws instead of returning a map full of suppressed:false', async () => {
    mocks.execute.mockRejectedValue(pgFailure('remaining connection slots are reserved'));

    await expect(checkSuppressed(ORG, ['bounced@example.com', 'complained@example.com'])).rejects.toBeInstanceOf(
      SuppressionUnavailableError,
    );
  });

  it('carries the real Postgres reason from e.cause, not the failed SQL', async () => {
    mocks.execute.mockRejectedValue(pgFailure('terminating connection due to administrator command'));

    const err = await checkSuppressed(ORG, ['a@example.com']).catch((e) => e);
    expect(err.reason).toBe('terminating connection due to administrator command');
    expect(err.message).toContain('terminating connection due to administrator command');
    // The SQL is noise in an operator's face and is NOT the reason anything failed.
    expect(err.message).not.toContain('SELECT lower(address)');
    // It says what was refused, so nobody reads it as "one address was on the list".
    expect(err.message).toContain('could not be read');
    expect(err.addressCount).toBe(1);
  });

  it('is a TEMPORARY failure, so the engine retries the step instead of dead-lettering or sending', async () => {
    mocks.execute.mockRejectedValue(pgFailure('deadlock detected'));

    const err = await checkSuppressed(ORG, ['a@example.com']).catch((e) => e);
    expect(err).toBeInstanceOf(TemporaryFailure);
    expect(classifyError(err)).toBe('temporary');
  });

  it('the result form answers ok:false with a null map — never an empty one', async () => {
    mocks.execute.mockRejectedValue(pgFailure('connection terminated unexpectedly'));

    const result = await checkSuppressedResult(ORG, ['bounced@example.com']);
    expect(result.ok).toBe(false);
    // A caller cannot accidentally iterate this and conclude nobody is suppressed.
    expect(result.checks).toBeNull();
    expect(result.error).toBe('connection terminated unexpectedly');
  });

  it('isSuppressed refuses too — a gate that opens when it cannot see is not a gate', async () => {
    mocks.execute.mockRejectedValue(pgFailure('too many connections for role'));

    await expect(isSuppressed(ORG, 'complained@example.com')).rejects.toBeInstanceOf(SuppressionUnavailableError);
  });

  it('refuses when there is no organization to scope the lookup to, without querying', async () => {
    const result = await checkSuppressedResult('' as any, ['a@example.com']);
    expect(result.ok).toBe(false);
    expect(result.checks).toBeNull();
    expect(result.error).toContain('No organization');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('the read succeeded — a real answer', () => {
  it('an empty list is ok:true and still readable as "nobody here is suppressed"', async () => {
    mocks.execute.mockResolvedValue([]); // postgres-js hands back a plain array, not { rows }

    const result = await checkSuppressedResult(ORG, ['fine@example.com']);
    expect(result.ok).toBe(true);
    expect(result.checks?.get('fine@example.com')?.suppressed).toBe(false);
  });

  it('a hard bounce comes back suppressed, with a sentence an operator can act on', async () => {
    mocks.execute.mockResolvedValue([
      { addr: 'bounced@example.com', reason: 'hard_bounce', scope: 'org', scope_ref: null, created_at: new Date('2026-08-01T00:00:00Z'), expires_at: null },
    ]);

    const checks = await checkSuppressed(ORG, ['bounced@example.com', 'fine@example.com']);
    expect(checks.get('bounced@example.com')?.suppressed).toBe(true);
    expect(checks.get('bounced@example.com')?.detail).toContain('rejected mail permanently');
    expect(checks.get('fine@example.com')?.suppressed).toBe(false);
  });

  // addressKey() only trims and lowercases — it does not validate — so "no address" here means an
  // empty or blank one, which is what buildRecipients has already rejected upstream.
  it('no address to check is not a refusal — there is nothing here that could be mailed', async () => {
    const result = await checkSuppressedResult(ORG, ['', '   ']);
    expect(result.ok).toBe(true);
    expect(result.checks?.size).toBe(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
