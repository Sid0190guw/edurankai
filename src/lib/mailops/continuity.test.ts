// Tests for the continuity layer (Patch 16): failure model, recovery objectives, backup retention
// and verification, migration verification and gates, DNS cutover arithmetic, worker drain.
//
// Everything under test here is pure, which is deliberate — the parts of disaster recovery that can
// be proved on a laptop with no database, no Docker and no network are exactly the parts where a
// quiet mistake is invisible until the day it matters. The retention arithmetic that silently keeps
// nothing, the cutover gate that passes on missing data, the drain that exits with a delivery
// mid-DATA: none of those announce themselves in production.
//
// What is NOT proved here is stated in docs/mail/HA-DR.md section 18: a real restore, a real reboot
// and a real cutover are physical acts, and no unit test substitutes for having done one.
import { describe, it, expect } from 'vitest';

import {
  FAILURE_MODES,
  capabilityStatus,
  expandDown,
  overallState,
  suppressedClaims,
  worstLoss,
  type ComponentId,
} from '@/lib/mailops/failure-model';
import {
  DEFAULT_OBJECTIVES,
  formatDuration,
  objectiveClaim,
  objectiveStatus,
  posture,
  rpoFromBackupAge,
  type Measurement,
} from '@/lib/mailops/objectives';
import {
  BACKUP_SETS,
  applyRetention,
  artefactProblems,
  backupPosture,
  backupSet,
  verificationState,
  type BackupArtefact,
  type RestoreTest,
} from '@/lib/mailops/backup';
import { RUNBOOKS, decisionPoints, orderedSections, toMarkdown } from '@/lib/mailops/runbooks';
import {
  MIGRATION_PLANS,
  compareInventories,
  cutoverAllowed,
  decommissionAllowed,
  migrationPlan,
  type Inventory,
} from '@/lib/mailops/migration';
import { cutoverReady, planCutover } from '@/lib/mailops/dns-cutover';
import {
  DEFAULT_DRAIN_POLICY,
  acceptsNewWork,
  deployDecision,
  drainTick,
  initialState,
  live,
  ready,
  rollingOrder,
  transition,
  type NodeHealth,
  type WorkerState,
} from '@/lib/mailops/drain';

// ---------------------------------------------------------------------------
// Failure model
// ---------------------------------------------------------------------------

describe('failure model', () => {
  it('covers every failure the brief names', () => {
    const components = new Set(FAILURE_MODES.map((m) => m.component));
    for (const c of ['zbook', 'power', 'disk', 'internet', 'dns', 'mta_out', 'mta_in', 'database', 'supabase', 'redis', 'engine_worker', 'storage', 'vercel', 'queue', 'spool'] as ComponentId[]) {
      expect(components.has(c), `no failure mode for ${c}`).toBe(true);
    }
  });

  it('gives every mode a claim it must not make', () => {
    for (const m of FAILURE_MODES) {
      expect(m.mustNotClaim.length, `${m.id} has no mustNotClaim`).toBeGreaterThan(10);
      expect(m.detection.length).toBeGreaterThan(5);
    }
  });

  it('a dead host takes its own services down with it', () => {
    const down = expandDown(['zbook']);
    expect(down.has('mta_in')).toBe(true);
    expect(down.has('mta_out')).toBe(true);
    expect(down.has('spool')).toBe(true);
    // ...but not things that are not on it
    expect(down.has('vercel')).toBe(false);
    expect(down.has('database')).toBe(false);
  });

  it('outbound sending survives a database outage, degraded', () => {
    const reports = capabilityStatus(['database']);
    const send = reports.find((r) => r.capability === 'outbound_send')!;
    expect(send.state).toBe('degraded');
    expect(send.because.join(' ')).toMatch(/no delivery events/i);

    // Reading a mailbox does not.
    expect(reports.find((r) => r.capability === 'mailbox_read')!.state).toBe('down');
  });

  it('inbound receive is degraded, not up, when the app cannot file it', () => {
    const reports = capabilityStatus(['vercel']);
    const inbound = reports.find((r) => r.capability === 'inbound_receive')!;
    expect(inbound.state).toBe('degraded');
    expect(inbound.because.join(' ')).toMatch(/4xx/);
  });

  it('reports every capability, including the healthy ones', () => {
    const reports = capabilityStatus([]);
    expect(reports.length).toBeGreaterThanOrEqual(9);
    expect(reports.every((r) => r.state === 'up')).toBe(true);
    expect(overallState(reports)).toBe('up');
  });

  it('suppresses the receipt claim when the MX is down', () => {
    const claims = suppressedClaims(['mta_in']);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.map((c) => c.claim).join(' ')).toMatch(/guaranteed receipt/i);
  });

  it('rates a disk failure as catastrophic and a reboot as in-flight only', () => {
    expect(worstLoss(['disk'])).toBe('catastrophic');
    expect(worstLoss(['engine_worker'])).toBe('in_flight');
    expect(worstLoss([])).toBe('none');
  });

  it('says plainly that Redis is not part of this system', () => {
    const redis = FAILURE_MODES.find((m) => m.component === 'redis')!;
    expect(redis.expected).toMatch(/no Redis/i);
    expect(capabilityStatus(['redis']).every((r) => r.state === 'up')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

describe('recovery objectives', () => {
  it('never presents an unmeasured target as a capability', () => {
    for (const o of DEFAULT_OBJECTIVES) {
      const claim = objectiveClaim(o, null);
      if (o.basis !== 'measured') {
        expect(claim, `${o.assetClass} claim reads like a guarantee`).toMatch(/not been demonstrated|aspiration|NOT what the system does/i);
      }
    }
  });

  it('marks a measurement stale after the validity window', () => {
    const objective = { ...DEFAULT_OBJECTIVES[0], basis: 'measured' as const };
    const old: Measurement = {
      assetClass: objective.assetClass,
      measuredRpoSeconds: 100,
      measuredRtoSeconds: 100,
      at: new Date('2026-01-01T00:00:00Z').toISOString(),
      source: 'restore-test',
    };
    const status = objectiveStatus(objective, old, new Date('2026-08-16T00:00:00Z'));
    expect(status.stale).toBe(true);
    expect(status.claim).toMatch(/unproven/i);
  });

  it('reports met and missed against the target', () => {
    const objective = DEFAULT_OBJECTIVES.find((o) => o.assetClass === 'database')!;
    const now = new Date('2026-08-16T00:00:00Z');
    const good = objectiveStatus(objective, {
      assetClass: 'database', measuredRpoSeconds: 3600, measuredRtoSeconds: 1800,
      at: now.toISOString(), source: 'restore-test',
    }, now);
    expect(good.rpoState).toBe('met');
    expect(good.rtoState).toBe('met');

    const bad = objectiveStatus(objective, {
      assetClass: 'database', measuredRpoSeconds: 3600, measuredRtoSeconds: 10 * 3600,
      at: now.toISOString(), source: 'restore-test',
    }, now);
    expect(bad.rtoState).toBe('missed');
  });

  it('treats an absent backup as unbounded RPO, not zero', () => {
    expect(rpoFromBackupAge(null)).toBeNull();
    expect(rpoFromBackupAge('not a date')).toBeNull();
    const now = new Date('2026-08-16T12:00:00Z');
    expect(rpoFromBackupAge('2026-08-16T10:00:00Z', now)).toBe(7200);
  });

  it('headlines the whole posture as unproven when nothing is measured', () => {
    const statuses = DEFAULT_OBJECTIVES.map((o) => objectiveStatus(o, null));
    const p = posture(statuses);
    expect(p.state).toBe('unproven');
    expect(p.headline).toMatch(/has ever been measured/i);
  });

  it('formats durations a human reads without converting', () => {
    expect(formatDuration(0)).toBe('zero');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(3600)).toBe('1 hours');
    expect(formatDuration(86_400)).toBe('1 days');
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function artefact(id: string, takenAt: string, over: Partial<BackupArtefact> = {}): BackupArtefact {
  return {
    id,
    assetClass: 'database',
    takenAt,
    sizeBytes: 1024,
    location: 's3://backups/db',
    encrypted: true,
    checksum: 'abc',
    offsite: true,
    ...over,
  };
}

describe('backup retention', () => {
  it('does not let dailies consume the weekly and monthly slots', () => {
    // Seven consecutive days in one week. A naive implementation fills daily AND weekly from these
    // and reports the policy satisfied while holding nothing older than a week.
    const week = Array.from({ length: 7 }, (_, i) => artefact(`d${i}`, `2026-08-${String(10 + i).padStart(2, '0')}T02:00:00Z`));
    const older = [
      artefact('w1', '2026-08-03T02:00:00Z'),
      artefact('w2', '2026-07-27T02:00:00Z'),
      artefact('m1', '2026-06-01T02:00:00Z'),
      artefact('y1', '2025-08-01T02:00:00Z'),
    ];
    const decisions = applyRetention([...week, ...older], { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1, offsiteCopies: 1 });
    const kept = decisions.filter((d) => d.keep).map((d) => d.artefact.id);

    expect(kept).toContain('w1');
    expect(kept).toContain('m1');
    expect(kept).toContain('y1');
    // and the reason recorded is the slot that actually earned it
    expect(decisions.find((d) => d.artefact.id === 'd0')!.reason).toBe('daily');
  });

  it('prunes what no slot claims', () => {
    const many = Array.from({ length: 40 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000);
      return artefact(`a${i}`, day.toISOString());
    });
    const decisions = applyRetention(many, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0, keepYearly: 0, offsiteCopies: 1 });
    expect(decisions.filter((d) => d.keep)).toHaveLength(3);
    expect(decisions.filter((d) => !d.keep).every((d) => d.reason === 'pruned')).toBe(true);
  });

  it('keeps nothing when the policy is empty, rather than everything', () => {
    const decisions = applyRetention([artefact('a', '2026-08-01T00:00:00Z')], { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0, offsiteCopies: 0 });
    expect(decisions[0].keep).toBe(false);
  });
});

describe('backup verification', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  const dbSet = backupSet('database')!;

  function test(over: Partial<RestoreTest> = {}): RestoreTest {
    return {
      id: 't1',
      assetClass: 'database',
      artefactId: 'a1',
      startedAt: '2026-08-15T00:00:00Z',
      finishedAt: '2026-08-15T01:00:00Z',
      ok: true,
      checks: [{ name: 'row counts', ok: true, detail: 'mail_messages 1200 = 1200' }],
      durationSeconds: 3600,
      artefactAgeSeconds: 7200,
      target: 'scratch',
      notes: null,
      ...over,
    };
  }

  it('a backup that has never been restored is not a backup', () => {
    const status = verificationState(dbSet, [], now);
    expect(status.state).toBe('never');
    expect(status.summary).toMatch(/does not count as one yet/i);
  });

  it('a passing test within the window is verified', () => {
    expect(verificationState(dbSet, [test()], now).state).toBe('verified');
  });

  it('verification expires', () => {
    const old = test({ finishedAt: '2026-01-01T00:00:00Z' });
    const status = verificationState(dbSet, [old], now);
    expect(status.state).toBe('stale');
    expect(status.summary).toMatch(/schema has since changed|Re-test/i);
  });

  it('a failed test is worse than none and says which check failed', () => {
    const failed = test({ ok: false, checks: [{ name: 'row counts', ok: false, detail: 'mail_messages 0 vs 1200' }] });
    const status = verificationState(dbSet, [failed], now);
    expect(status.state).toBe('failed');
    expect(status.summary).toMatch(/row counts/);
  });

  it('uses the most recent test, not the most flattering', () => {
    const good = test({ id: 'old', finishedAt: '2026-08-01T00:00:00Z', ok: true });
    const bad = test({ id: 'new', finishedAt: '2026-08-14T00:00:00Z', ok: false, checks: [{ name: 'x', ok: false, detail: 'no' }] });
    expect(verificationState(dbSet, [good, bad], now).state).toBe('failed');
  });

  it('summarises the whole posture honestly', () => {
    const statuses = BACKUP_SETS.map((s) => verificationState(s, [], now));
    const p = backupPosture(statuses);
    expect(p.state).toBe('unprotected');
    expect(p.never).toBe(BACKUP_SETS.length);
  });

  it('refuses to count an unencrypted, local, zero-byte artefact', () => {
    const problems = artefactProblems(dbSet, artefact('bad', '2026-08-15T00:00:00Z', {
      encrypted: false, offsite: false, checksum: null, sizeBytes: 0,
    }));
    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).toMatch(/not encrypted/i);
    expect(problems.join(' ')).toMatch(/Zero bytes/i);
  });
});

// ---------------------------------------------------------------------------
// Runbooks
// ---------------------------------------------------------------------------

describe('runbooks', () => {
  it('covers the nine incidents the brief lists', () => {
    const ids = RUNBOOKS.map((r) => r.id);
    for (const id of ['rb-zbook', 'rb-database', 'rb-mail-server', 'rb-dns', 'rb-credentials', 'rb-dkim', 'rb-api', 'rb-storage', 'rb-queue']) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it('every runbook has all six sections, with steps in each', () => {
    for (const rb of RUNBOOKS) {
      const sections = orderedSections(rb);
      expect(sections.map((s) => s.section)).toEqual(['detection', 'containment', 'recovery', 'verification', 'rollback', 'post_incident']);
      for (const s of sections) {
        expect(s.steps.length, `${rb.id}/${s.section} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('no runbook step tells anyone to open the production database', () => {
    for (const rb of RUNBOOKS) {
      for (const { steps } of orderedSections(rb)) {
        for (const step of steps) {
          const text = `${step.do} ${step.command || ''}`;
          expect(text, `${rb.id}: ${step.do}`).not.toMatch(/\bpsql\s+["']?postgres:\/\//i);
          expect(text).not.toMatch(/DATABASE_URL=.*postgres:\/\//i);
        }
      }
    }
  });

  it('marks the expensive decisions as founder decisions', () => {
    // The four irreversible mistakes available during these incidents.
    expect(decisionPoints(RUNBOOKS.find((r) => r.id === 'rb-zbook')!).map((d) => d.step.do).join(' ')).toMatch(/MX/);
    expect(decisionPoints(RUNBOOKS.find((r) => r.id === 'rb-dkim')!).length).toBeGreaterThan(0);
    expect(decisionPoints(RUNBOOKS.find((r) => r.id === 'rb-storage')!).length).toBeGreaterThan(0);
    expect(decisionPoints(RUNBOOKS.find((r) => r.id === 'rb-queue')!).length).toBeGreaterThan(0);
  });

  it('renders to markdown with the sections in order', () => {
    const md = toMarkdown(RUNBOOKS[0]);
    expect(md.indexOf('### Detection')).toBeLessThan(md.indexOf('### Recovery'));
    expect(md.indexOf('### Recovery')).toBeLessThan(md.indexOf('### Rollback'));
    expect(md).toContain('[FOUNDER DECISION]');
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function inv(label: string, counts: Inventory['counts'], over: Partial<Inventory> = {}): Inventory {
  return { label, takenAt: '2026-08-16T00:00:00Z', counts, ...over };
}

describe('migration verification', () => {
  it('covers the six migrations in the brief', () => {
    const ids = MIGRATION_PLANS.map((p) => p.id);
    for (const id of ['zbook-to-dedicated', 'single-to-multi-node', 'supabase-to-selfhosted-pg', 'supabase-storage-to-s3', 'local-mta-to-dedicated', 'single-mta-to-cluster']) {
      expect(ids).toContain(id);
    }
  });

  it('passes on an exact match', () => {
    const report = compareInventories(
      inv('old', { messages: 100, mailboxes: 5, folders: 30, flags: 400, attachments: 12 }),
      inv('new', { messages: 100, mailboxes: 5, folders: 30, flags: 400, attachments: 12 }),
    );
    expect(report.passed).toBe(true);
    expect(report.entities.every((e) => e.verdict === 'match')).toBe(true);
  });

  it('allows a small message shortfall on an online copy but never a missing mailbox', () => {
    const report = compareInventories(
      inv('old', { messages: 1000, mailboxes: 5 }),
      inv('new', { messages: 990, mailboxes: 4 }),
    );
    expect(report.entities.find((e) => e.entity === 'messages')!.verdict).toBe('within-tolerance');
    expect(report.entities.find((e) => e.entity === 'mailboxes')!.verdict).toBe('short');
    expect(report.passed).toBe(false);
  });

  it('flags a target with MORE than the source as a probable double import', () => {
    const report = compareInventories(inv('old', { messages: 100 }), inv('new', { messages: 200 }));
    const cmp = report.entities.find((e) => e.entity === 'messages')!;
    expect(cmp.verdict).toBe('excess');
    expect(cmp.note).toMatch(/duplicates/i);
  });

  it('treats an uncounted entity as unverified, not as fine', () => {
    const report = compareInventories(inv('old', { messages: 100, flags: 5 }), inv('new', { messages: 100 }));
    const flags = report.entities.find((e) => e.entity === 'flags')!;
    expect(flags.verdict).toBe('missing-data');
    expect(report.passed).toBe(false);
  });

  it('catches a per-mailbox loss that the global total hides', () => {
    const source = inv('old', { messages: 100 }, { perMailbox: { a: { messages: 60 }, b: { messages: 40 } } });
    const target = inv('new', { messages: 100 }, { perMailbox: { a: { messages: 100 }, b: { messages: 0 } } });
    const report = compareInventories(source, target);
    expect(report.entities.find((e) => e.entity === 'messages')!.verdict).toBe('match');
    expect(report.mailboxDiffs.length).toBe(2);
    expect(report.passed).toBe(false);
  });

  it('catches content that differs even when counts agree', () => {
    const report = compareInventories(
      inv('old', { objects: 3 }, { sampleChecksums: { 'k/1': 'aaa' } }),
      inv('new', { objects: 3 }, { sampleChecksums: { 'k/1': 'bbb' } }),
    );
    expect(report.checksumMismatches).toHaveLength(1);
    expect(report.passed).toBe(false);
  });
});

describe('migration gates', () => {
  const plan = migrationPlan('zbook-to-dedicated')!;

  it('blocks cutover when a gated entity is short', () => {
    const report = compareInventories(
      inv('old', { messages: 100, mailboxes: 5, folders: 30, flags: 400, attachments: 12 }),
      inv('new', { messages: 100, mailboxes: 5, folders: 25, flags: 400, attachments: 12 }),
      { migrationId: plan.id },
    );
    const decision = cutoverAllowed(plan, report);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/Folders/);
  });

  it('blocks cutover when a gated entity was never counted', () => {
    const report = compareInventories(inv('old', { messages: 1 }), inv('new', { messages: 1 }), { migrationId: plan.id });
    expect(cutoverAllowed(plan, report).allowed).toBe(false);
  });

  it('allows cutover when every gated entity agrees', () => {
    const counts = { messages: 100, mailboxes: 5, folders: 30, flags: 400, attachments: 12 };
    const report = compareInventories(inv('old', counts), inv('new', counts), { migrationId: plan.id });
    expect(cutoverAllowed(plan, report).allowed).toBe(true);
  });

  it('refuses to decommission without verification, soak and a typed confirmation', () => {
    const counts = { messages: 100, mailboxes: 5, folders: 30, flags: 400, attachments: 12 };
    const passing = compareInventories(inv('old', counts), inv('new', counts), { migrationId: plan.id });
    const now = new Date('2026-08-16T00:00:00Z');

    expect(decommissionAllowed({ plan, report: null, cutoverAt: '2026-01-01T00:00:00Z', confirmationPhrase: 'old-zbook', expectedPhrase: 'old-zbook', now }).allowed).toBe(false);

    const tooSoon = decommissionAllowed({ plan, report: passing, cutoverAt: '2026-08-14T00:00:00Z', confirmationPhrase: 'old-zbook', expectedPhrase: 'old-zbook', now });
    expect(tooSoon.allowed).toBe(false);
    expect(tooSoon.reasons.join(' ')).toMatch(/Soak period incomplete/);

    const wrongPhrase = decommissionAllowed({ plan, report: passing, cutoverAt: '2026-07-01T00:00:00Z', confirmationPhrase: 'yes', expectedPhrase: 'old-zbook', now });
    expect(wrongPhrase.allowed).toBe(false);

    const ok = decommissionAllowed({ plan, report: passing, cutoverAt: '2026-07-01T00:00:00Z', confirmationPhrase: 'old-zbook', expectedPhrase: 'old-zbook', now });
    expect(ok.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DNS cutover
// ---------------------------------------------------------------------------

describe('DNS cutover', () => {
  const reducedAt = new Date('2026-08-16T09:00:00Z');

  it('waits out the OLD TTL, not the new one', () => {
    const plan = planCutover({ domain: 'example.test', currentTtlSeconds: 3600, ttlReducedAt: reducedAt, safetyMarginSeconds: 900 });
    // 09:00 + 3600s + 900s = 10:15, not 09:05.
    expect(plan.lowTtlEffectiveAt.toISOString()).toBe('2026-08-16T10:15:00.000Z');
    const cutover = plan.stages.find((s) => s.stage === 'cutover')!;
    expect(cutover.notBefore!.getTime()).toBe(plan.lowTtlEffectiveAt.getTime());
  });

  it('warns about a long current TTL and a pointless reduction', () => {
    const long = planCutover({ domain: 'example.test', currentTtlSeconds: 86_400, ttlReducedAt: reducedAt });
    expect(long.warnings.join(' ')).toMatch(/24.0 hours|hours/);

    const pointless = planCutover({ domain: 'example.test', currentTtlSeconds: 300, targetTtlSeconds: 300, ttlReducedAt: reducedAt });
    expect(pointless.warnings.join(' ')).toMatch(/no faster rollback/i);
  });

  it('blocks cutover before the reduced TTL is in force', () => {
    const decision = cutoverReady({
      lowTtlEffectiveAt: new Date('2026-08-16T10:15:00Z'),
      now: new Date('2026-08-16T09:30:00Z'),
      observedTtlSeconds: 300, targetTtlSeconds: 300,
      targetAcceptsMail: true, forwardReverseMatch: true, spfIncludesTarget: true,
      dkimPublished: true, rollbackHostAvailable: true, mailboxDeltaVerified: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toMatch(/not in force everywhere yet/i);
  });

  it('blocks cutover when nobody actually queried the TTL', () => {
    const decision = cutoverReady({
      lowTtlEffectiveAt: new Date('2026-08-16T10:15:00Z'),
      now: new Date('2026-08-16T11:00:00Z'),
      observedTtlSeconds: null, targetTtlSeconds: 300,
      targetAcceptsMail: true, forwardReverseMatch: true, spfIncludesTarget: true,
      dkimPublished: true, rollbackHostAvailable: true, mailboxDeltaVerified: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toMatch(/different events/i);
  });

  it('allows cutover only when every precondition holds', () => {
    const base = {
      lowTtlEffectiveAt: new Date('2026-08-16T10:15:00Z'),
      now: new Date('2026-08-16T11:00:00Z'),
      observedTtlSeconds: 300, targetTtlSeconds: 300,
      targetAcceptsMail: true, forwardReverseMatch: true, spfIncludesTarget: true,
      dkimPublished: true, rollbackHostAvailable: true, mailboxDeltaVerified: true,
    };
    expect(cutoverReady(base).allowed).toBe(true);
    expect(cutoverReady({ ...base, spfIncludesTarget: false }).allowed).toBe(false);
    expect(cutoverReady({ ...base, forwardReverseMatch: false }).allowed).toBe(false);
    expect(cutoverReady({ ...base, mailboxDeltaVerified: false }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

describe('worker drain', () => {
  const t0 = 1_000_000;

  function running(inFlight: number, uninterruptible = 0): WorkerState {
    return { phase: 'accepting', inFlight, uninterruptible, drainStartedAt: null };
  }

  it('stops accepting immediately but stays alive while draining', () => {
    const s = transition(running(3), 'shutdown_requested', t0);
    expect(s.phase).toBe('draining');
    expect(acceptsNewWork(s)).toBe(false);
    expect(ready(s)).toBe(false);
    expect(live(s)).toBe(true); // the supervisor must NOT kill it here
  });

  it('an idle worker stops at once', () => {
    expect(transition(running(0), 'shutdown_requested', t0).phase).toBe('stopped');
  });

  it('stops when the last in-flight item completes', () => {
    let s = transition(running(2), 'shutdown_requested', t0);
    s = transition(s, 'work_complete', t0 + 1000);
    expect(s.phase).toBe('draining');
    s = transition(s, 'work_complete', t0 + 2000);
    expect(s.phase).toBe('stopped');
    expect(live(s)).toBe(false);
  });

  it('releases interruptible work at the grace mark and holds mid-delivery work', () => {
    let s = transition(running(5, 2), 'shutdown_requested', t0);
    const tick = drainTick(s, DEFAULT_DRAIN_POLICY, t0 + DEFAULT_DRAIN_POLICY.graceMs);
    expect(tick.signal).toBe('grace_expired');
    expect(tick.status).toMatch(/releasing 3 interruptible, holding 2/);

    s = transition(s, 'grace_expired', t0 + DEFAULT_DRAIN_POLICY.graceMs);
    expect(s.phase).toBe('finishing');
    expect(s.inFlight).toBe(2);
  });

  it('hard-stops and says how many duplicates to expect', () => {
    const s = transition(running(4, 4), 'shutdown_requested', t0);
    const tick = drainTick(s, DEFAULT_DRAIN_POLICY, t0 + DEFAULT_DRAIN_POLICY.hardStopMs + 1);
    expect(tick.signal).toBe('force');
    expect(tick.mayExit).toBe(true);
    expect(tick.status).toMatch(/up to 4 duplicate deliveries/);
  });

  it('grace expiry with nothing uninterruptible stops cleanly', () => {
    let s = transition(running(3, 0), 'shutdown_requested', t0);
    s = transition(s, 'grace_expired', t0 + DEFAULT_DRAIN_POLICY.graceMs);
    expect(s.phase).toBe('stopped');
    expect(s.inFlight).toBe(0);
  });

  it('starting is neither ready nor accepting', () => {
    const s = initialState();
    expect(ready(s)).toBe(false);
    expect(acceptsNewWork(s)).toBe(false);
    expect(live(s)).toBe(true);
  });
});

describe('blue/green promotion', () => {
  function node(id: string, over: Partial<NodeHealth> = {}): NodeHealth {
    return { id, ready: true, live: true, consecutiveReady: 5, version: 'v2', inFlight: 0, ...over };
  }

  it('promotes only after enough consecutive ready probes', () => {
    const current = [node('blue-1', { version: 'v1' })];
    expect(deployDecision(current, [node('green-1', { consecutiveReady: 1 })]).action).toBe('wait');
    expect(deployDecision(current, [node('green-1', { consecutiveReady: 3 })]).action).toBe('promote');
  });

  it('rolls back when the new build will not start', () => {
    const decision = deployDecision([node('blue-1')], [node('green-1', { live: false, ready: false })]);
    expect(decision.action).toBe('rollback');
    expect(decision.reason).toMatch(/does not start/i);
  });

  it('waits rather than promoting a node that is alive but not ready', () => {
    const decision = deployDecision([node('blue-1')], [node('green-1', { ready: false })]);
    expect(decision.action).toBe('wait');
  });

  it('holds when the current version is already below the minimum healthy count', () => {
    const decision = deployDecision([node('blue-1', { ready: false })], [node('green-1')]);
    expect(decision.action).toBe('hold');
    expect(decision.reason).toMatch(/minimum/i);
  });

  it('drains the least busy node first, deterministically', () => {
    const order = rollingOrder([node('c', { inFlight: 5 }), node('a', { inFlight: 1 }), node('b', { inFlight: 1 })]);
    expect(order.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
});
