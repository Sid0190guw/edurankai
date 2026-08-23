// src/lib/talent/evaluations.test.ts — the marking rules, exercised with no database.
//
// As with stages.test.ts, THE IMPORT IS THE FIRST ASSERTION: evaluations.ts resolves its database
// handle lazily, so importing panelVerdict() must not require DATABASE_URL. A module-scope database
// import creeping back in makes this file fail at collection.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_SCORE, NUMERIC_CEILING, MAX_COMMENT_CHARS,
  EVALUATION_TYPE_OPTIONS, RECOMMENDATIONS,
  isEvaluationType, isRecommendation, isEvaluationStatus,
  maxScoreOf, normalisedScore, panelVerdict,
} from '@/lib/talent/evaluations';
import { EVALUATION_TYPES } from '@/lib/talent/types';

describe('the contract vocabulary', () => {
  it('offers an option for every evaluation type the contract declares', () => {
    expect(EVALUATION_TYPE_OPTIONS.map((o) => o.key).sort()).toEqual([...EVALUATION_TYPES].sort());
  });

  it('offers exactly the three recommendations', () => {
    expect(RECOMMENDATIONS.map((r) => r.key)).toEqual(['advance', 'hold', 'decline']);
  });

  it('recognises its own members and rejects everything else', () => {
    for (const t of EVALUATION_TYPES) expect(isEvaluationType(t)).toBe(true);
    for (const bad of ['interview', 'ASSESSMENT', '', null, undefined, 7, {}]) {
      expect(isEvaluationType(bad)).toBe(false);
    }
    for (const r of ['advance', 'hold', 'decline']) expect(isRecommendation(r)).toBe(true);
    for (const bad of ['reject', 'ADVANCE', '', null, undefined]) expect(isRecommendation(bad)).toBe(false);
    for (const s of ['pending', 'submitted', 'waived']) expect(isEvaluationStatus(s)).toBe(true);
    for (const bad of ['draft', '', null, undefined]) expect(isEvaluationStatus(bad)).toBe(false);
  });

  it('keeps its guard rails at sane values', () => {
    expect(DEFAULT_MAX_SCORE).toBe(100);
    expect(NUMERIC_CEILING).toBeLessThan(10000); // NUMERIC(6,2) cannot hold 10000
    expect(MAX_COMMENT_CHARS).toBeGreaterThan(0);
  });
});

describe('maxScoreOf — the only reader of rubric.maxScore', () => {
  it('treats an absent maximum as 100, so a raw mark is already a percentage', () => {
    expect(maxScoreOf({})).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf({ maxScore: null })).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf({ maxScore: '' })).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf({ maxScore: '   ' })).toBe(DEFAULT_MAX_SCORE);
  });

  it('treats a non-object rubric as absent', () => {
    expect(maxScoreOf(null)).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf(undefined)).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf('nonsense')).toBe(DEFAULT_MAX_SCORE);
    expect(maxScoreOf(42)).toBe(DEFAULT_MAX_SCORE);
  });

  it('reads a stated maximum', () => {
    expect(maxScoreOf({ maxScore: 50 })).toBe(50);
    expect(maxScoreOf({ maxScore: '25' })).toBe(25);
  });

  it('reports a PRESENT BUT UNUSABLE maximum as zero, not as a default', () => {
    // The important direction. Falling back to 100 for a corrupt rubric would invent a denominator
    // nobody agreed to and could clear a pass mark with it. Zero makes the evaluation invisible to
    // a pass check instead, which is the safe failure.
    expect(maxScoreOf({ maxScore: 0 })).toBe(0);
    expect(maxScoreOf({ maxScore: -10 })).toBe(0);
    expect(maxScoreOf({ maxScore: 'lots' })).toBe(0);
    expect(maxScoreOf({ maxScore: Number.NaN })).toBe(0);
    expect(maxScoreOf({ maxScore: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe('normalisedScore — never Infinity, never NaN', () => {
  it('computes a percentage', () => {
    expect(normalisedScore(45, 90)).toBe(50);
    expect(normalisedScore(0, 100)).toBe(0);
    expect(normalisedScore(100, 100)).toBe(100);
  });

  it('is null when there is no score', () => {
    expect(normalisedScore(null, 100)).toBeNull();
  });

  it('is null for an unusable denominator', () => {
    // Both wrong answers are confidently wrong against a less-than: Infinity clears every threshold
    // and NaN fails every one, including a threshold of zero.
    expect(normalisedScore(10, 0)).toBeNull();
    expect(normalisedScore(10, -1)).toBeNull();
    expect(normalisedScore(10, Number.NaN)).toBeNull();
    expect(normalisedScore(10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('is null for an unreadable score', () => {
    expect(normalisedScore(Number.NaN, 100)).toBeNull();
    expect(normalisedScore(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it('never returns a non-finite number for any combination', () => {
    const values: (number | null)[] = [null, 0, 1, -1, 50, Number.NaN, Number.POSITIVE_INFINITY];
    const maxes = [0, -1, 1, 100, Number.NaN, Number.POSITIVE_INFINITY];
    for (const v of values) {
      for (const m of maxes) {
        const r = normalisedScore(v, m);
        if (r !== null) expect(Number.isFinite(r)).toBe(true);
      }
    }
  });
});

describe('panelVerdict — advisory only, and never inventing agreement', () => {
  it('reads an empty panel as hold, not as advance', () => {
    // Nothing recorded is not consent.
    expect(panelVerdict([]).verdict).toBe('hold');
    expect(panelVerdict([]).counts).toEqual({ advance: 0, hold: 0, decline: 0 });
  });

  it('does NOT let a single decline veto a panel that wants to proceed', () => {
    // Three advances against one decline is a panel that wants to proceed. Giving the decline a veto
    // would make the most sceptical member of every panel be the panel.
    const r = panelVerdict(['advance', 'advance', 'advance', 'decline']);
    expect(r.verdict).toBe('advance');
    expect(r.counts).toEqual({ advance: 3, hold: 0, decline: 1 });
  });

  it('lets a MAJORITY decide, in either direction', () => {
    expect(panelVerdict(['decline', 'decline', 'advance']).verdict).toBe('decline');
    expect(panelVerdict(['advance', 'advance', 'decline']).verdict).toBe('advance');
  });

  it('treats a panel of one as that whole panel', () => {
    expect(panelVerdict(['decline']).verdict).toBe('decline');
    expect(panelVerdict(['advance']).verdict).toBe('advance');
  });

  it('falls to hold on a tie, never to advance', () => {
    expect(panelVerdict(['advance', 'decline']).verdict).toBe('hold');
    expect(panelVerdict(['advance', 'advance', 'decline', 'decline']).verdict).toBe('hold');
  });

  it('falls to hold when no side has more than half', () => {
    // Two advances, two holds, two declines: nobody has a majority.
    expect(panelVerdict(['advance', 'advance', 'hold', 'hold', 'decline', 'decline']).verdict).toBe('hold');
  });

  it('IGNORES absent and unreadable recommendations rather than counting them', () => {
    // Counting a blank as a hold would let an evaluator who did not fill the field in silently
    // dilute a real majority.
    const r = panelVerdict(['advance', 'advance', null, '', 'rubbish', undefined as any]);
    expect(r.counts).toEqual({ advance: 2, hold: 0, decline: 0 });
    expect(r.verdict).toBe('advance');
  });

  it('is case and whitespace insensitive', () => {
    expect(panelVerdict(['  ADVANCE ', 'Advance']).verdict).toBe('advance');
  });

  it('is exact at large panel sizes', () => {
    // 50 advance against 51 decline is a decline; the split-hair case a float division could fumble.
    const recs = [...Array(50).fill('advance'), ...Array(51).fill('decline')];
    expect(panelVerdict(recs).verdict).toBe('decline');
    const even = [...Array(50).fill('advance'), ...Array(50).fill('decline')];
    expect(panelVerdict(even).verdict).toBe('hold');
  });
});
