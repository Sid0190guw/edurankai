// src/lib/horizon/governance/retention-runtime.test.ts — the retention/erasure layer's own
// behaviour, exercised against a FAKE DATABASE that can be made to answer "the table does not
// exist" for one statement while answering normally for the next.
//
// WHY THIS FILE EXISTS. SCHEMA_BOOTSTRAP is off in production, so the four hgov_* tables exist on
// the live database only once db/horizon-governance-schema.sql has been run by hand. Every read in
// this module is supposed to tell "nobody has customised this yet" apart from "we could not read
// whether anybody has" — and three of them did not:
//
//   listRetentionPolicies()  caught the missing-table exception and fell straight through to the
//                            code defaults with NOTHING recorded — not even a log line — so an
//                            administrator's saved override and a table that has never existed
//                            produced the byte-identical RetentionPolicy object.
//   applyRetention()         called a private countDue() that caught the same exception and
//                            returned a bare 0, which every consuming branch then printed as
//                            "Held for a person to decide. Nothing is removed automatically from
//                            this class." or "Nothing was changed." — a sentence describing a
//                            deliberate no-op, not a database that could not be asked.
//   listErasureRequests()   caught the same exception and returned [], indistinguishable from "no
//                            erasure request has ever been opened."
//
// This is the state-A/state-D matrix input -> db-result -> application-behaviour, not a check that
// a string of source code contains a particular substring.
import { describe, it, expect, vi, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------------------------
// A FAKE DATABASE, KEYED BY TABLE NAME.
//
// `db.execute` receives a real drizzle-orm SQL object (sql`` and sql.raw`` are NOT mocked — only
// the driver call is), and this reads the rendered text out of it the same way
// src/lib/work-groups.test.ts already does, to decide which fake table the statement is querying.
// One helper, one convention, reused rather than re-invented.
// ---------------------------------------------------------------------------------------------
function sqlText(q: any): string {
  const flat = (x: any): string => {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.map(flat).join(' ');
    if (typeof x === 'object' && 'value' in x) return flat(x.value);
    if (typeof x === 'object' && 'sql' in x) return flat(x.sql);
    return '';
  };
  return flat(q?.queryChunks);
}

/** Tables this fake database does not have. Statements touching them throw. */
const missingTables = new Set<string>();
/** Canned rows for the tables that DO exist, keyed by table name. */
const tableRows = new Map<string, any[]>();

function resetFakeDb() {
  missingTables.clear();
  tableRows.clear();
}

const dbExecute = vi.fn(async (q: any) => {
  const text = sqlText(q);
  const hit = [...missingTables].find((t) => text.includes(t));
  if (hit) {
    const err: any = new Error('relation "' + hit + '" does not exist');
    err.cause = { message: 'relation "' + hit + '" does not exist' };
    throw err;
  }
  for (const [table, rows] of tableRows) {
    if (text.includes(table)) return rows;
  }
  // COUNT queries default to zero rather than an empty result set with no `n` column, matching
  // what a real "nothing past the cutoff yet" answer looks like.
  if (/COUNT\(\*\)/.test(text)) return [{ n: 0 }];
  return [];
});

vi.mock('@/lib/db', () => ({ db: { execute: dbExecute } }));
// SCHEMA_BOOTSTRAP is off in production: ensureGovernanceSchema() -> ensureBatch() is a documented
// no-op there, and this is that no-op. Simulating the DDL bootstrap itself is a different module's
// concern (schema.ts, schema-sync.test.ts); this file simulates what a page or an API route sees
// AFTER that no-op, which is the state every one of these functions actually runs in on the live
// site today.
vi.mock('@/lib/ensure-once', () => ({
  ensureBatch: vi.fn(async () => {}),
  ensureOnce: vi.fn(async (_k: string, fn: () => Promise<void>) => { try { await fn(); } catch { /* ignore */ } }),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => ({ ok: true })) }));

import {
  applyRetention, listErasureRequests, listRetentionPolicies, registerRetentionSweeper, retentionDue,
} from './retention';

const ACTOR = { id: '11111111-1111-1111-1111-111111111111', email: 'a@b.test', name: 'A' };

function policyRow(overrides: Record<string, any> = {}) {
  return {
    record_class: 'decision_log', owner_module: 'horizon.governance', data_class: 'operational',
    retain_days: 2555, action: 'review', basis: 'default', overridden_by: null,
    updated_at: '2026-01-01T00:00:00Z', ...overrides,
  };
}

describe('listRetentionPolicies: the table missing and the table empty must not look the same', () => {
  it('STATE A — hgov_retention_policy does not exist: every class comes back marked unreadable', async () => {
    resetFakeDb();
    missingTables.add('hgov_retention_policy');

    const policies = await listRetentionPolicies();

    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) expect(p.readable, p.recordClass).toBe(false);
    // The code default itself is still returned — the screen has SOMETHING to show — but every row
    // says plainly that it did not come from a read.
    const decisionLog = policies.find((p) => p.recordClass === 'decision_log')!;
    expect(decisionLog.action).toBe('review');
    expect(decisionLog.overriddenBy).toBeNull();
  });

  it('STATE C — the table exists and answers: an administrator\'s override is reported, and marked readable', async () => {
    resetFakeDb();
    tableRows.set('hgov_retention_policy', [
      policyRow({ record_class: 'decision_log', action: 'delete', overridden_by: ACTOR.id, retain_days: 30 }),
    ]);

    const policies = await listRetentionPolicies();
    const decisionLog = policies.find((p) => p.recordClass === 'decision_log')!;

    expect(decisionLog.readable).toBe(true);
    expect(decisionLog.action).toBe('delete');
    expect(decisionLog.overriddenBy).toBe(ACTOR.id);
    expect(decisionLog.retainDays).toBe(30);
  });
});

describe('retentionDue: per-class isolation (state D, partial schema)', () => {
  it('one governed table missing does not take down the count for a sibling table that exists', async () => {
    resetFakeDb();
    // The policy table itself reads fine and holds the code defaults for every class.
    // access_log is owned by horizon.schema and lives in hzn_access_log; decision_log is owned
    // here and lives in hgov_decision_log. Only the second is made to fail.
    missingTables.add('hgov_decision_log');
    tableRows.set('hzn_access_log', [{ n: 7 }]);

    const due = await retentionDue();
    const decisionLog = due.find((d) => d.recordClass === 'decision_log')!;
    const accessLog = due.find((d) => d.recordClass === 'access_log')!;

    expect(decisionLog.readable).toBe(false);
    expect(decisionLog.dueCount).toBe(0);
    expect(accessLog.readable).toBe(true);
    expect(accessLog.dueCount).toBe(7);
  });
});

describe('applyRetention: a count that could not be read is a FAILURE, not a zero', () => {
  it('STATE A — a "review" class: reports FAILED, not "Held for a person to decide... 0"', async () => {
    resetFakeDb();
    missingTables.add('hzn_access_log'); // access_log's own table, default action review

    const report = await applyRetention(ACTOR, { dryRun: true });
    const row = report.find((r) => r.recordClass === 'access_log')!;

    expect(row.note.startsWith('FAILED:')).toBe(true);
    expect(row.note).not.toContain('Held for a person to decide');
    expect(row.affected).toBe(0);
  });

  it('STATE A — a "report only" class (owned elsewhere, no sweeper): reports FAILED, not "0 rows are past the period"', async () => {
    resetFakeDb();
    missingTables.add('hzn_computation'); // computation: owned by horizon.schema, default anonymise, no sweeper

    const report = await applyRetention(ACTOR, { dryRun: true });
    const row = report.find((r) => r.recordClass === 'computation')!;

    expect(row.note.startsWith('FAILED:')).toBe(true);
    expect(row.note).not.toContain('rows are past the period');
  });

  it('STATE D — owned-here class overridden to delete, its OWN table unreadable while siblings answer fine: dry-run reports FAILED, not "Nothing was changed."', async () => {
    resetFakeDb();
    // Both rows present: listRetentionPolicies() returns exactly what the table holds, with no
    // per-class merge against the code defaults, so a sibling class needs its own row here to be
    // part of the same run at all.
    tableRows.set('hgov_retention_policy', [
      policyRow({ record_class: 'decision_log', action: 'delete', overridden_by: ACTOR.id }),
      policyRow({ record_class: 'access_log', owner_module: 'horizon.schema', action: 'review' }),
    ]);
    missingTables.add('hgov_decision_log');       // the class actually being swept
    tableRows.set('hzn_access_log', [{ n: 3 }]);  // a sibling class, readable, to prove isolation

    const report = await applyRetention(ACTOR, { dryRun: true });
    const decisionLog = report.find((r) => r.recordClass === 'decision_log')!;
    const accessLog = report.find((r) => r.recordClass === 'access_log')!;

    expect(decisionLog.note.startsWith('FAILED:')).toBe(true);
    expect(decisionLog.note).not.toContain('Nothing was changed');
    // The sibling's dry run is entirely unaffected — one statement failing does not poison the rest,
    // because nothing in this module opens a shared transaction across these reads. access_log is a
    // 'review' class (owned elsewhere), so its own honest branch is "held for a person to decide",
    // with the real count — not a failure of any kind.
    expect(accessLog.note.startsWith('FAILED')).toBe(false);
    expect(accessLog.affected).toBe(3);
  });

  it('STATE C — the same overridden class with its table readable: dry run reports the real count, unchanged from before this fix', async () => {
    resetFakeDb();
    tableRows.set('hgov_retention_policy', [
      policyRow({ record_class: 'decision_log', action: 'delete', overridden_by: ACTOR.id }),
    ]);
    tableRows.set('hgov_decision_log', [{ n: 42 }]);

    const report = await applyRetention(ACTOR, { dryRun: true });
    const row = report.find((r) => r.recordClass === 'decision_log')!;

    expect(row.note).toBe('Nothing was changed.');
    expect(row.affected).toBe(42);
    expect(row.action).toContain('dry run');
  });

  describe('a registered sweeper\'s REAL run does not depend on the due-count query at all', () => {
    beforeAll(() => {
      registerRetentionSweeper({
        recordClass: 'feedback_contribution',
        sweep: vi.fn(async () => ({ affected: 5, note: 'Anonymised by the owning patch.' })),
      });
    });

    it('runs and reports success even though the due-count table for that class cannot be read', async () => {
      resetFakeDb();
      // If applyRetention still asked countDueReadable before calling a REGISTERED sweeper's real
      // sweep, this table failing would gate the whole action — which it must not, because the
      // sweeper computes its own count independently and this layer never touches that table.
      missingTables.add('hzn_feedback_contribution');

      const report = await applyRetention(ACTOR, { dryRun: false });
      const row = report.find((r) => r.recordClass === 'feedback_contribution')!;

      expect(row.action).toContain('by owner');
      expect(row.affected).toBe(5);
      expect(row.note).toBe('Anonymised by the owning patch.');
      expect(row.note.startsWith('FAILED')).toBe(false);
    });

    it('the DRY RUN preview for the same sweeper-owned class DOES depend on it, and fails honestly when it cannot be read', async () => {
      resetFakeDb();
      missingTables.add('hzn_feedback_contribution');

      const report = await applyRetention(ACTOR, { dryRun: true });
      const row = report.find((r) => r.recordClass === 'feedback_contribution')!;

      expect(row.note.startsWith('FAILED:')).toBe(true);
      expect(row.note).not.toContain('Nothing was changed');
    });
  });
});

describe('listErasureRequests: an unreadable table is not the same as an empty one', () => {
  it('STATE A — hgov_erasure_request does not exist: readable is false and the array is empty', async () => {
    resetFakeDb();
    missingTables.add('hgov_erasure_request');

    const { requests, readable } = await listErasureRequests(undefined, 50);

    expect(readable).toBe(false);
    expect(requests).toEqual([]);
  });

  it('STATE B — the table exists and genuinely holds nothing: readable is true, and the array is (still) empty', async () => {
    resetFakeDb();
    tableRows.set('hgov_erasure_request', []);

    const { requests, readable } = await listErasureRequests(undefined, 50);

    expect(readable).toBe(true);
    expect(requests).toEqual([]);
  });

  it('STATE C — real rows: readable is true and they are mapped through', async () => {
    resetFakeDb();
    tableRows.set('hgov_erasure_request', [{
      id: 'req-1', organisation_id: 'org_edurankai', subject_kind: 'employee', subject_id: 'e-1',
      subject_scheme: 'hr_employee', action: 'anonymise', scope: [], requested_by: ACTOR.id,
      reason: 'a long enough reason', status: 'requested', approved_by: null, approved_at: null,
      blockers: [], report: {}, created_at: '2026-01-01T00:00:00Z', completed_at: null,
    }]);

    const { requests, readable } = await listErasureRequests(undefined, 50);

    expect(readable).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe('req-1');
  });
});
