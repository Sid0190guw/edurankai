// src/lib/horizon/horizon.test.ts — THE GATES THAT MUST NOT QUIETLY OPEN.
//
// These exercise pure functions only: no database, no viewer, no Astro. Everything asserted here is
// a property the engine claims about itself in its own header comments, and each one is a claim that
// would be easy to break by accident in a later edit.

import { describe, it, expect } from 'vitest';
import {
  HORIZONS, HORIZON_SPECS, VERSIONED_HORIZONS, LIVE_HORIZONS,
  confidenceFor, confidenceBand, claimsCertainty, hedged,
  lookbackWindow, forwardWindow, daysBetween, shiftDays,
  LAYER_DECISION_WEIGHT, EMPTY_SHAPE,
  type EvidenceShape,
} from '@/lib/horizon/temporal/time';
import {
  computeCycles, birthGateFailures, currentBirthGate, birthCycleProvider, tenureCycleProvider,
  engagementPhase, isRefusal, CLOSED_GATE, BIRTH_CYCLE_PRECONDITIONS,
} from '@/lib/horizon/temporal/cycles';
import { trendOf, buildAll, OUTPUT_KEYS, ENGINE_VERSION } from '@/lib/horizon/temporal/engine';
import { shapeWithin, SOURCES, type TemporalEvidence } from '@/lib/horizon/temporal/evidence';

// -------------------------------------------------------------------------------------------------

const RICH: EvidenceShape = {
  rowCount: 5000,
  sourceCount: 12,
  spanDays: 9000,
  staleDays: 0,
  verifiedRowCount: 5000,
};

describe('horizons', () => {
  it('has exactly the seven the patch specifies, in order', () => {
    expect([...HORIZONS]).toEqual([
      'recent', 'week', 'month', 'year', 'five_year', 'ten_year', 'twenty_year',
    ]);
  });

  it('splits live from versioned the way the storage rule requires', () => {
    expect([...LIVE_HORIZONS]).toEqual(['recent', 'week', 'month']);
    expect([...VERSIONED_HORIZONS]).toEqual(['year', 'five_year', 'ten_year', 'twenty_year']);
  });

  it('gives every versioned horizon a recompute cadence and every live horizon none', () => {
    for (const h of VERSIONED_HORIZONS) expect(HORIZON_SPECS[h].recomputeEveryDays).toBeGreaterThan(0);
    for (const h of LIVE_HORIZONS) expect(HORIZON_SPECS[h].recomputeEveryDays).toBeNull();
  });
});

describe('confidence', () => {
  it('never exceeds the ceiling, even on absurdly rich evidence', () => {
    for (const h of HORIZONS) {
      const c = confidenceFor(h, RICH);
      expect(c.value).toBeLessThanOrEqual(HORIZON_SPECS[h].confidenceCeiling);
    }
  });

  it('caps a twenty-year reading at a tenth however good the record is', () => {
    const c = confidenceFor('twenty_year', RICH);
    expect(c.value).toBeLessThanOrEqual(0.1);
  });

  it('falls monotonically as the horizon lengthens, for identical evidence', () => {
    const values = HORIZONS.map((h) => confidenceFor(h, RICH).value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
  });

  it('collapses when the record is far shorter than the horizon', () => {
    // Eight months of dense, verified, diverse, fresh evidence against a twenty-year question.
    const eightMonths: EvidenceShape = {
      rowCount: 400, sourceCount: 6, spanDays: 240, staleDays: 0, verifiedRowCount: 400,
    };
    const c = confidenceFor('twenty_year', eightMonths);
    expect(c.underspanned).toBe(true);
    // 240 days against 7305 is about three per cent of the question, and that is what it earns.
    // Asserted against the CEILING rather than a bare number, because the property that matters is
    // that a dense short record cannot approach the ceiling of a horizon it does not span.
    expect(c.value).toBeLessThan(HORIZON_SPECS.twenty_year.confidenceCeiling / 2);
    expect(c.value).toBeLessThan(0.05);
  });

  it('reports no confidence and says so when there is no evidence', () => {
    const c = confidenceFor('month', EMPTY_SHAPE);
    expect(c.value).toBe(0);
    expect(c.sentence).toContain('no evidence');
    expect(confidenceBand(c.value)).toBe('none');
  });

  it('cannot be rescued by volume alone when it is stale', () => {
    const stale: EvidenceShape = {
      rowCount: 5000, sourceCount: 12, spanDays: 365, staleDays: 400, verifiedRowCount: 5000,
    };
    // Recency reaches zero at six months, and the terms multiply, so the product is zero.
    expect(confidenceFor('year', stale).value).toBe(0);
  });

  it('shows every term, so the number can be argued with', () => {
    const c = confidenceFor('year', RICH);
    const names = c.terms.map((t) => t.name);
    expect(names).toContain('span coverage');
    expect(names).toContain('volume');
    expect(names).toContain('source diversity');
    expect(names).toContain('recency');
    expect(names).toContain('human verification');
  });
});

describe('projections never claim certainty', () => {
  const CERTAIN_INPUTS = [
    'This person will become a team lead within two years.',
    'They are on track to be promoted.',
    'Growth is guaranteed at this rate.',
    'They will certainly outgrow the current role.',
    'This is expected to lead to wider responsibility.',
    'Their trajectory is destined to reach senior engineering.',
    'Progress is inevitable given the proven record.',
    'They shall take on more scope.',
  ];

  it('detects certainty in all of them before hedging', () => {
    for (const s of CERTAIN_INPUTS) expect(claimsCertainty(s)).toBe(true);
  });

  // THE LOAD-BEARING TEST OF THIS PATCH. If this ever fails, the engine is emitting statements about
  // a person's future as fact, which is the single thing the brief forbids outright.
  it('removes the certainty from all of them', () => {
    for (const s of CERTAIN_INPUTS) {
      const h = hedged(s);
      expect(claimsCertainty(h), 'still certain: ' + h).toBe(false);
    }
  });

  it('prefixes an explicit conditional', () => {
    expect(hedged('They will lead a team.')).toMatch(/^On the current record,/);
  });

  it('leaves an already-conditional sentence alone at the front', () => {
    expect(hedged('If the work continues, scope could widen.')).toMatch(/^If the work continues/);
  });

  it('does not double-prefix', () => {
    const once = hedged('They will lead.');
    const twice = hedged(once);
    expect(twice.match(/On the current record/g)?.length).toBe(1);
  });

  it('gives the projected and foundational layers no decision weight at all', () => {
    expect(LAYER_DECISION_WEIGHT.projected).toBe('none');
    expect(LAYER_DECISION_WEIGHT.foundational).toBe('none');
    expect(LAYER_DECISION_WEIGHT.observed).toBe('primary');
    expect(LAYER_DECISION_WEIGHT.current).toBe('primary');
  });
});

describe('windows', () => {
  it('bounds an open-ended lookback by the start of the record', () => {
    const w = lookbackWindow('twenty_year', '2026-08-23', '2026-01-10');
    expect(w.fromDay).toBe('2026-01-10');
    expect(w.days).toBe(daysBetween('2026-01-10', '2026-08-23'));
  });

  it('does not let a late joining date produce a window that runs backwards', () => {
    const w = lookbackWindow('year', '2026-08-23', '2027-01-01');
    expect(w.fromDay).toBe('2026-08-23');
    expect(w.days).toBe(0);
  });

  it('projects forward by the horizon length', () => {
    expect(forwardWindow('five_year', '2026-08-23').toDay).toBe(shiftDays('2026-08-23', 1826));
  });
});

describe('trend arithmetic', () => {
  it('refuses to call a direction from fewer than three months', () => {
    const t = trendOf([{ bucket: '2026-01-01', rowCount: 1, metricAvg: 1 }, { bucket: '2026-02-01', rowCount: 9, metricAvg: 9 }], 'count');
    expect(t.direction).toBe('insufficient');
    expect(t.sentence).toContain('not enough');
  });

  it('finds a rise', () => {
    const pts = [1, 3, 5, 7, 9].map((n, i) => ({ bucket: '2026-0' + (i + 1) + '-01', rowCount: n, metricAvg: n }));
    expect(trendOf(pts, 'count').direction).toBe('rising');
  });

  it('finds a fall', () => {
    const pts = [9, 7, 5, 3, 1].map((n, i) => ({ bucket: '2026-0' + (i + 1) + '-01', rowCount: n, metricAvg: n }));
    expect(trendOf(pts, 'count').direction).toBe('falling');
  });

  it('calls a flat series steady rather than inventing a direction', () => {
    const pts = [5, 5, 5, 5].map((n, i) => ({ bucket: '2026-0' + (i + 1) + '-01', rowCount: n, metricAvg: n }));
    expect(trendOf(pts, 'count').direction).toBe('steady');
  });

  it('scales the threshold to the level, so a rating and a row count are judged alike', () => {
    // A 0.1/month drift on a 4.0 rating is noise; the same absolute drift on a count of 1 is not.
    const rating = [4.0, 4.05, 4.1, 4.15].map((n, i) => ({ bucket: '2026-0' + (i + 1) + '-01', rowCount: 1, metricAvg: n }));
    expect(trendOf(rating, 'metric').direction).toBe('steady');
  });

  it('skips null metrics rather than treating them as zero', () => {
    const pts = [
      { bucket: '2026-01-01', rowCount: 3, metricAvg: null },
      { bucket: '2026-02-01', rowCount: 3, metricAvg: null },
      { bucket: '2026-03-01', rowCount: 3, metricAvg: 4 },
    ];
    expect(trendOf(pts, 'metric').direction).toBe('insufficient');
  });
});

describe('engagement phase', () => {
  const base = {
    today: '2026-08-23',
    joiningDay: '2026-01-01',
    probationEndDay: '2026-07-01',
    confirmationDay: null,
    reviewCadenceDays: null,
    lastReviewDay: null,
  };

  it('returns nothing without a joining date, rather than guessing one', () => {
    expect(engagementPhase({ ...base, joiningDay: null })).toBeNull();
  });

  it('calls the first month joining', () => {
    expect(engagementPhase({ ...base, today: '2026-01-15' })!.phase).toBe('joining');
  });

  it('calls it probation inside the window', () => {
    expect(engagementPhase({ ...base, today: '2026-04-01' })!.phase).toBe('probation');
  });

  it('names a missing confirmation date as a paperwork gap, not a verdict', () => {
    const p = engagementPhase(base)!;
    expect(p.phase).toBe('confirmation pending');
  });

  it('calls it confirmed once a confirmation date has passed', () => {
    expect(engagementPhase({ ...base, confirmationDay: '2026-07-05' })!.phase).toBe('confirmed');
  });

  it('calls it established two years past confirmation', () => {
    expect(engagementPhase({ ...base, joiningDay: '2020-01-01', confirmationDay: '2021-01-01' })!.phase)
      .toBe('established');
  });
});

describe('the date-of-birth cycle provider is gated shut', () => {
  const input = {
    today: '2026-08-23',
    joiningDay: '2024-01-01',
    probationEndDay: null,
    confirmationDay: '2024-07-01',
    reviewCadenceDays: null,
    lastReviewDay: null,
    birthDay: '1995-04-11',
  };

  it('ships with a fully closed gate', () => {
    expect(currentBirthGate()).toEqual(CLOSED_GATE);
  });

  it('names every unmet precondition rather than failing silently', () => {
    const missing = birthGateFailures({ ...CLOSED_GATE, birthDayAvailable: true });
    expect(missing).toHaveLength(3);
    expect(missing.join(' ')).toContain('consent');
    expect(missing.join(' ')).toContain('deployment');
  });

  it('refuses to compute even when a birth date is handed to it directly', () => {
    const r = birthCycleProvider.compute(input);
    expect(isRefusal(r)).toBe(true);
    if (isRefusal(r)) {
      expect(r.because).toContain('protected characteristic');
      expect(r.missing.length).toBeGreaterThan(0);
    }
  });

  it('is not enabled by default and requires consent by declaration', () => {
    expect(birthCycleProvider.enabledByDefault).toBe(false);
    expect(birthCycleProvider.requiresConsent).toBe(true);
  });

  it('documents what enabling it would actually cost', () => {
    expect(BIRTH_CYCLE_PRECONDITIONS.length).toBeGreaterThanOrEqual(4);
    for (const p of BIRTH_CYCLE_PRECONDITIONS) {
      expect(p.requirement.length).toBeGreaterThan(20);
      expect(p.why.length).toBeGreaterThan(20);
    }
  });

  it('is reported as disabled by computeCycles, not omitted', () => {
    const layer = computeCycles(input);
    const off = layer.disabled.find((d) => d.id === 'birth_cycle');
    expect(off).toBeTruthy();
    expect(off!.because).toContain('protected characteristic');
  });
});

describe('the tenure cycle provider', () => {
  it('computes from organisational records and nothing else', () => {
    expect(tenureCycleProvider.basis).toBe('organisational_record');
    expect(tenureCycleProvider.requiresConsent).toBe(false);
    expect(tenureCycleProvider.enabledByDefault).toBe(true);
  });

  it('refuses when there is no joining date instead of inventing a cycle', () => {
    const r = tenureCycleProvider.compute({
      today: '2026-08-23', joiningDay: null, probationEndDay: null,
      confirmationDay: null, reviewCadenceDays: null, lastReviewDay: null,
    });
    expect(isRefusal(r)).toBe(true);
    if (isRefusal(r)) expect(r.missing).toContain('hr_employees.joining_date');
  });

  it('gives every reading zero decision weight and names its inputs', () => {
    const layer = computeCycles({
      today: '2026-08-23', joiningDay: '2024-01-01', probationEndDay: '2024-07-01',
      confirmationDay: '2024-07-02', reviewCadenceDays: 180, lastReviewDay: '2026-06-30',
    });
    expect(layer.readings.length).toBeGreaterThan(0);
    for (const r of layer.readings) {
      expect(r.decisionWeight).toBe('none');
      expect(r.inputs.length).toBeGreaterThan(0);
      expect(r.notScientific).toContain('not a scientific finding');
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The engine, driven from a hand-built evidence bundle so no database is involved.
// -------------------------------------------------------------------------------------------------

function bundle(over: Partial<TemporalEvidence> = {}): TemporalEvidence {
  return {
    employeeId: '11111111-1111-4111-8111-111111111111',
    today: '2026-08-23',
    anchors: {
      employeeId: '11111111-1111-4111-8111-111111111111',
      joiningDay: '2024-01-01',
      probationEndDay: '2024-07-01',
      confirmationDay: '2024-07-02',
      designation: 'Software Engineer',
      departmentId: null,
      readable: true,
    },
    recordStartDay: '2024-01-01',
    sources: SOURCES.map((s) => ({
      table: s.table,
      owner: s.owner,
      label: s.label,
      evidences: s.evidences,
      rowCount: 40,
      earliestDay: '2024-01-01',
      latestDay: '2026-08-20',
      verifiedRowCount: 20,
      metricAvg: 4,
      unreadable: false,
      because: 'test bundle',
    })),
    series: {},
    absentTables: [],
    unreadable: [],
    blind: false,
    ...over,
  };
}

describe('the composed reading', () => {
  const at = '2026-08-23T00:00:00.000Z';

  it('builds all seven horizons with all six output sections each', () => {
    const set = buildAll(bundle(), at);
    for (const h of HORIZONS) {
      const r = set.readings[h];
      expect(r).toBeTruthy();
      expect(r.sections.map((s) => s.key)).toEqual([...OUTPUT_KEYS]);
      expect(r.engineVersion).toBe(ENGINE_VERSION);
    }
  });

  it('never emits a projected signal that claims certainty, across every horizon', () => {
    const set = buildAll(bundle(), at);
    for (const h of HORIZONS) {
      for (const sec of set.readings[h].sections) {
        for (const s of sec.signals) {
          if (s.layer !== 'projected') continue;
          expect(claimsCertainty(s.statement), h + '/' + sec.key + ': ' + s.statement).toBe(false);
          expect(s.assertion).toBe('predicted');
          expect(s.decisionWeight).toBe('none');
        }
      }
    }
  });

  it('gives every signal the full explainability chain', () => {
    const set = buildAll(bundle(), at);
    for (const h of HORIZONS) {
      for (const sec of set.readings[h].sections) {
        for (const s of sec.signals) {
          expect(s.inputs.length).toBeGreaterThan(0);
          expect(s.processing.length).toBeGreaterThan(0);
          expect(s.computedAt).toBe(at);
          expect(typeof s.confidence).toBe('number');
        }
      }
    }
  });

  it('distinguishes an unreadable source from an empty one', () => {
    const broken = bundle({
      sources: SOURCES.map((s) => ({
        table: s.table, owner: s.owner, label: s.label, evidences: s.evidences,
        rowCount: 0, earliestDay: null, latestDay: null, verifiedRowCount: 0, metricAvg: null,
        unreadable: true, because: 'the query failed',
      })),
      blind: true,
    });
    const set = buildAll(broken, at);
    expect(set.blind).toBe(true);
    expect(set.blindSentence).toContain('not a finding about their work');

    const empty = bundle({
      sources: SOURCES.map((s) => ({
        table: s.table, owner: s.owner, label: s.label, evidences: s.evidences,
        rowCount: 0, earliestDay: null, latestDay: null, verifiedRowCount: 0, metricAvg: null,
        unreadable: false, because: 'readable and empty',
      })),
    });
    const emptySet = buildAll(empty, at);
    expect(emptySet.blind).toBe(false);
    const silences = emptySet.readings.month.sections.map((s) => s.silence).filter(Boolean).join(' ');
    expect(silences).toContain('fact about the record');
    expect(silences).not.toContain('UNREADABLE');
  });

  it('says leadership is unrecorded rather than leaving the section blank', () => {
    const noLeadership = bundle({
      sources: SOURCES.map((s) => ({
        table: s.table, owner: s.owner, label: s.label, evidences: s.evidences,
        rowCount: ['hr_employee_goals', 'hr_performance_reviews'].indexOf(s.table) >= 0 ? 0 : 40,
        earliestDay: '2024-01-01', latestDay: '2026-08-20',
        verifiedRowCount: 0, metricAvg: null, unreadable: false, because: 'test',
      })),
    });
    const set = buildAll(noLeadership, at);
    const lead = set.readings.year.sections.find((s) => s.key === 'leadershipTrajectory')!;
    expect(lead.signals.length).toBeGreaterThan(0);
    expect(lead.signals[0].statement).toContain('not a statement about whether they could lead');
  });

  it('carries the health disclaimer on the sustainability section', () => {
    const set = buildAll(bundle(), at);
    const sus = set.readings.month.sections.find((s) => s.key === 'sustainability')!;
    expect(sus.note).toContain('NOT AN ASSESSMENT OF HEALTH');
  });

  it('carries the projection disclaimer on every horizon', () => {
    const set = buildAll(bundle(), at);
    for (const h of HORIZONS) {
      expect(set.readings[h].projectionDisclaimer).toContain('not a prediction and not a plan');
    }
  });

  it('emits no composite score anywhere on a reading', () => {
    const set = buildAll(bundle(), at);
    const json = JSON.stringify(set.readings.year);
    // The engine deliberately holds no overall/total/rating/score field for a PERSON. `confidence`
    // is a property of the reading and is named as such.
    expect(json).not.toMatch(/"overallScore"|"totalScore"|"rating":\s*\d|"personScore"/);
  });
});

describe('evidence shaping', () => {
  it('excludes unreadable sources from every term, including diversity', () => {
    const ev = bundle({
      sources: SOURCES.map((s, i) => ({
        table: s.table, owner: s.owner, label: s.label, evidences: s.evidences,
        rowCount: 10, earliestDay: '2026-01-01', latestDay: '2026-08-01',
        verifiedRowCount: 5, metricAvg: 1,
        unreadable: i < 3, because: i < 3 ? 'failed' : 'ok',
      })),
    });
    const shape = shapeWithin(ev, '2026-01-01', '2026-08-23');
    expect(shape.sourceCount).toBe(SOURCES.length - 3);
    expect(shape.rowCount).toBe((SOURCES.length - 3) * 10);
  });

  it('ignores a source whose recorded range does not overlap the window', () => {
    const ev = bundle({
      sources: [{
        table: 'hr_attendance', owner: 'x', label: 'Attendance', evidences: 'y',
        rowCount: 100, earliestDay: '2020-01-01', latestDay: '2020-06-01',
        verifiedRowCount: 0, metricAvg: null, unreadable: false, because: 'old',
      }],
    });
    expect(shapeWithin(ev, '2026-01-01', '2026-08-23').sourceCount).toBe(0);
  });
});
