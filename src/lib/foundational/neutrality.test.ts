// src/lib/foundational/neutrality.test.ts — THE GUARANTEE, CHECKED RATHER THAN PROMISED.
//
// Two rules govern what this engine is allowed to say, and both are the kind of rule that decays
// quietly: somebody adds a helpful label, somebody else surfaces the technical block "just for
// debugging", and six months later a page an applicant can see is rendering a traditional framework
// as though it were an assessment of them.
//
//   1. NO DECISION LANGUAGE anywhere in a factor's code, label or value.
//   2. NO FRAMEWORK VOCABULARY in the default projection — only in `technical`, only for a viewer
//      holding the capability.
//
// So both are asserted against the REAL lists — DECISION_WORDS and allTechnicalTerms() — rather than
// against copies that would rot. A new term added to vocabulary.ts is automatically covered here.
import { describe, it, expect } from 'vitest';
import { computeFromInput } from './engine';
import {
  DECISION_WORDS, decisionWordIn, projectFactor, projectPeriod, projectComputation,
  maySeeTechnical, hasCapabilities, FOUNDATIONAL_CAPABILITIES,
  type ViewerContext,
} from './types';
import { allTechnicalTerms, POINT_LABELS, POINT_CODES } from './vocabulary';

const AT = '2026-08-23T00:00:00.000Z';

const profile = computeFromInput({
  date: '1994-08-03',
  time: '14:32',
  utcOffsetMinutes: 330,
  location: { latitude: 21.1458, longitude: 79.0882, placeLabel: 'Nagpur' },
  timePrecision: 'minute',
}, AT);

const ordinaryViewer: ViewerContext = {
  userId: 'u1',
  capabilities: [FOUNDATIONAL_CAPABILITIES.read],
};
const technicalViewer: ViewerContext = {
  userId: 'u2',
  capabilities: [FOUNDATIONAL_CAPABILITIES.read, FOUNDATIONAL_CAPABILITIES.technical],
};

describe('no decision language', () => {
  it('appears in any factor code, label or value', () => {
    for (const f of profile.factors) {
      for (const text of [f.factor_id, f.code, f.label, f.value]) {
        expect(decisionWordIn(text)).toBeNull();
      }
    }
  });

  it('appears in any period', () => {
    for (const p of [...profile.periods.level1, ...profile.periods.level2]) {
      expect(decisionWordIn(p.period_id + ' ' + p.ruler_code)).toBeNull();
    }
  });

  it('appears in the structural labels the engine exports for rendering', () => {
    for (const label of Object.values(POINT_LABELS)) expect(decisionWordIn(label)).toBeNull();
  });

  it('is a list that actually catches things', () => {
    // Guards the guard: a DECISION_WORDS that had been emptied would pass every test above.
    expect(DECISION_WORDS.length).toBeGreaterThan(10);
    expect(decisionWordIn('candidate is suitable for the role')).toBe('suitable');
    expect(decisionWordIn('RECOMMENDED for promotion')).toBeTruthy();
  });
});

describe('the default projection carries no framework vocabulary', () => {
  const terms = allTechnicalTerms();

  it('has terms to hide in the first place', () => {
    expect(terms.length).toBeGreaterThan(60);
  });

  it('strips the technical block from every factor for an ordinary viewer', () => {
    const allow = maySeeTechnical(ordinaryViewer);
    expect(allow).toBe(false);
    for (const f of profile.factors) {
      expect(projectFactor(f, allow).technical).toBeNull();
    }
  });

  it('leaves no framework term anywhere in the serialised neutral projection', () => {
    const projected = profile.factors.map((f) => projectFactor(f, false));
    const blob = JSON.stringify(projected).toLowerCase();
    const leaked = terms.filter((t) => blob.includes(t.toLowerCase()));
    expect(leaked).toEqual([]);
  });

  it('leaves no framework term in a projected period', () => {
    const projected = [...profile.periods.level1, ...profile.periods.level2].map((p) => projectPeriod(p, false));
    const blob = JSON.stringify(projected).toLowerCase();
    expect(terms.filter((t) => blob.includes(t.toLowerCase()))).toEqual([]);
  });

  it('strips the raw position block, which contains the birth input itself', () => {
    const record = {
      id: 'c1',
      subject: { kind: 'person' as const, id: 'p1' },
      calculation_method_version: 'fpc-1.0.0',
      input_hash: 'h', output_hash: 'o', reason: 'initial' as const,
      computed_at: AT, computed_by: null, factor_count: 1, period_count: 1,
      raw: profile.raw, method: profile.method,
    };
    const projected = projectComputation(record, false);
    expect(projected.raw).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('Nagpur');
    expect(JSON.stringify(projected)).not.toContain('1994-08-03');
  });

  it('restores the technical block only for a viewer holding BOTH capabilities', () => {
    expect(maySeeTechnical(technicalViewer)).toBe(true);
    // The technical capability on its own is not enough: read is the base right.
    expect(maySeeTechnical({ userId: 'u3', capabilities: [FOUNDATIONAL_CAPABILITIES.technical] })).toBe(false);
    const f = projectFactor(profile.factors[0], maySeeTechnical(technicalViewer));
    expect(f.technical).not.toBeNull();
    expect(f.technical!.term).toBeTruthy();
  });

  it('treats a viewer with no capabilities at all as having none', () => {
    expect(hasCapabilities(null, FOUNDATIONAL_CAPABILITIES.read)).toBe(false);
    expect(hasCapabilities({ userId: null, capabilities: [] }, FOUNDATIONAL_CAPABILITIES.read)).toBe(false);
  });
});

describe('the shared HORIZON terminology contract', () => {
  // Patch 00 owns FORBIDDEN_TERMS and screenTerminology(). Asserting against THEIR list rather than
  // a copy is the point: a term added there is covered here without anybody remembering to.
  it('is satisfied by every string in the neutral projection', async () => {
    const { screenTerminology } = await import('@/lib/horizon/contracts');
    const projected = profile.factors.map((f) => projectFactor(f, false));
    for (const f of projected) {
      for (const text of [f.code, f.label, f.value, JSON.stringify(f.evidence)]) {
        expect(screenTerminology(text).clean).toBe(true);
      }
    }
  });

  it('is satisfied by the structural labels this engine exports for rendering', async () => {
    const { assertNeutralTerminology } = await import('@/lib/horizon/contracts');
    expect(() => assertNeutralTerminology(Object.values(POINT_LABELS))).not.toThrow();
  });

  it('would catch a leak, so the assertion above is worth something', async () => {
    const { screenTerminology, NEUTRAL_TERM } = await import('@/lib/horizon/contracts');
    const check = screenTerminology('Point B02 in its ' + String.fromCharCode(114, 97, 115, 104, 105));
    expect(check.clean).toBe(false);
    expect(check.text).toBe(NEUTRAL_TERM);
  });
});

describe('the neutral codes are structural and complete', () => {
  it('names all nine points and nothing about a person', () => {
    expect(POINT_CODES).toHaveLength(9);
    for (const code of POINT_CODES) {
      expect(code).toMatch(/^B0[1-9]$/);
      expect(POINT_LABELS[code]).toBeTruthy();
    }
  });

  it('renders every factor value in codes rather than names', () => {
    for (const f of profile.factors) {
      // Every value mentions at least one structural code, and no value is prose about a person.
      expect(f.value).toMatch(/B0[1-9]|S\d{2}|G\d{2}|H\d{2}|forward|reverse/);
    }
  });
});
