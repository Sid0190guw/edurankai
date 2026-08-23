// src/lib/hire-reconcile.test.ts — the reconciliation check that has to agree with the door.
//
// WHY ONLY THIS ONE FUNCTION IS TESTED HERE. Every other check in hire-reconcile.ts is a SQL
// statement, and a test that re-states the SQL asserts nothing. classifyNoAccount() is different:
// it is the judgement, in JavaScript, about whether a person can reach their workspace, and it is
// only correct while it says the same thing src/lib/auth/workspace-access.ts says. That agreement
// is the thing worth pinning.
//
// THE DEFECT THESE CASES EXIST TO PREVENT. The check used to list every active employee with
// `user_id IS NULL` under the heading "cannot sign in". But lookupWorkspace() falls back to
// work_email / personal_email / email and backfills user_id on the first successful sign-in, so
// most of that list was people who were completely fine. HR learned the list was noise, and the one
// row in it that was true — a joiner whose sign-in address was on no HR record, who therefore got
// the applicant shell with no attendance anywhere on it — was never noticed until she emailed.
//
// So: a row is only `blocked` when a HUMAN has to do something.
import { describe, it, expect } from 'vitest';
import { classifyNoAccount } from './hire-reconcile';

/** One row as the query returns it. Only the fields the classifier reads. */
const row = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  full_name: 'Jiya Tyagi',
  employee_code: 'ERA-0042',
  joining_date: '2026-08-01',
  email: 'someone@example.com',
  never_linked: true,
  account_deleted: false,
  matching_accounts: 0,
  ...over,
});

describe('classifyNoAccount', () => {
  it('calls an employee stranded when no account answers to any address on the record', () => {
    const r = classifyNoAccount(row({ matching_accounts: 0 }));
    expect(r.state).toBe('no-address-matches');
    expect(r.blocked).toBe(true);
    // The sentence has to name the symptom the person actually reported, not the foreign key.
    expect(r.reason).toContain('applicant view');
    expect(r.reason).toContain('attendance');
  });

  it('does NOT block when exactly one account already answers to an address on file', () => {
    const r = classifyNoAccount(row({ matching_accounts: 1 }));
    expect(r.state).toBe('awaiting-first-signin');
    // The whole point. This person is not stuck, nobody has to act, and counting them as urgent is
    // what made the section unreadable.
    expect(r.blocked).toBe(false);
    expect(r.reason).toContain('nobody needs to do anything');
  });

  it('blocks when two accounts answer, because the gate refuses to guess', () => {
    const r = classifyNoAccount(row({ matching_accounts: 2 }));
    expect(r.state).toBe('two-accounts-match');
    expect(r.blocked).toBe(true);
  });

  it('reports a dangling link ahead of whatever the addresses would have matched', () => {
    // account_deleted outranks matching_accounts: the gate's primary lookup is the one that failed,
    // and reporting "they will be linked on first sign-in" to somebody whose account is gone would
    // be a lie about the record in front of the reader.
    const r = classifyNoAccount(row({ account_deleted: true, matching_accounts: 1 }));
    expect(r.state).toBe('account-deleted');
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('no longer exists');
  });

  it('treats a missing or unparseable match count as no match rather than as one', () => {
    // Fail closed. A null count from a query that changed shape must raise the flag, never lower it.
    expect(classifyNoAccount(row({ matching_accounts: null })).state).toBe('no-address-matches');
    expect(classifyNoAccount(row({ matching_accounts: undefined })).state).toBe('no-address-matches');
    expect(classifyNoAccount(row({ matching_accounts: 'not a number' })).state).toBe('no-address-matches');
  });

  it('carries the fields the screen prints, and never invents an address', () => {
    const r = classifyNoAccount(row({ email: null, employee_code: null }));
    expect(r.email).toBeNull();
    expect(r.employeeCode).toBeNull();
    expect(r.fullName).toBe('Jiya Tyagi');
    expect(r.employeeId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('gives every state a reason a person can act on', () => {
    const states = [
      classifyNoAccount(row({ matching_accounts: 0 })),
      classifyNoAccount(row({ matching_accounts: 1 })),
      classifyNoAccount(row({ matching_accounts: 2 })),
      classifyNoAccount(row({ account_deleted: true })),
    ];
    for (const s of states) {
      expect(s.reason.length).toBeGreaterThan(40);
      // No bare "access denied" phrasing anywhere in this module.
      expect(s.reason.toLowerCase()).not.toContain('access denied');
    }
    // All four states are distinct, so the page can group on them.
    expect(new Set(states.map((s) => s.state)).size).toBe(4);
  });
});
