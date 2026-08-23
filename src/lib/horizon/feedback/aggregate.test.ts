// src/lib/horizon/feedback/aggregate.test.ts
//
// The aggregation is pure, so it is tested exactly, with no database and no mocking. `asOf` is
// passed in everywhere, which is what makes recency assertions possible at all.
//
// THE FIRST BLOCK IS THE ONE THAT MATTERS. "Do not allow one negative feedback item to determine the
// profile" is the requirement this patch exists to satisfy, and it is tested as four independent
// properties rather than as one happy path, because a single mechanism failing silently is exactly
// how that requirement gets lost.
import { describe, it, expect } from 'vitest';
import {
  aggregateDimension,
  aggregateFeedback,
  classifyEvidence,
  detectAuthorTendency,
  detectRepeatedUnsupported,
  recencyFactor,
  MAX_AUTHOR_SHARE,
  MAX_SOURCE_TYPE_SHARE,
  MIN_SOURCES_FOR_SCORE,
  OUTLIER_WEIGHT_FACTOR,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  UNSUPPORTED_REPEAT_THRESHOLD,
} from './aggregate';
import type { EvidenceQuality, FeedbackItem, FeedbackSourceType } from './types';

const NOW = new Date('2026-08-01T00:00:00.000Z');

let seq = 0;
// `ratings` is OMITTED from the Partial before the looser shape is added, rather than intersected
// with it. An intersection produces `DimensionRating[] & {dimension:string;rating:number}[]`, which
// demands BOTH shapes at once — so every one of the sixty-six call sites below had to spell out a
// `comment: null` that says nothing, to satisfy a type the helper exists to spare them.
function item(
  over: Omit<Partial<FeedbackItem>, 'ratings'> & { ratings?: { dimension: string; rating: number }[] } = {},
): FeedbackItem {
  seq += 1;
  const author = over.authorKey || 'author-' + seq;
  return {
    id: over.id || 'fb-' + seq,
    subjectEmployeeId: 'subject-1',
    sourceType: (over.sourceType || 'peer') as FeedbackSourceType,
    sourceVerified: true,
    sourceVerifiedNote: null,
    authorKey: author,
    authorUserId: author,
    authorEmployeeId: author,
    authorName: over.authorName || ('Author ' + author),
    context: 'day_to_day',
    contextNote: null,
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
    evidence: 'They rewrote the intake form after the 14 May incident and it has not failed since.',
    evidenceQuality: (over.evidenceQuality || 'specific') as EvidenceQuality,
    confidentiality: 'standard',
    status: over.status || 'submitted',
    ratings: (over.ratings || [{ dimension: 'work_quality', rating: 4 }]) as any,
    examples: [],
    createdAt: over.createdAt || '2026-07-01T00:00:00.000Z',
    withdrawnAt: null,
    withdrawnReason: null,
    cycleId: null,
  } as FeedbackItem;
}

describe('one item must never determine the profile', () => {
  it('produces NO score from a single source, however extreme it is', () => {
    const d = aggregateDimension('work_quality', [item({ ratings: [{ dimension: 'work_quality', rating: 1 }] })], NOW);
    expect(d.score).toBeNull();
    expect(d.band).toBe('insufficient');
    expect(d.sourceCount).toBe(1);
    // and it says why, in words a person can read
    expect(d.explanation.processing.join(' ')).toContain('independent sources');
  });

  it('still produces no score when one author writes ten items', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      item({ authorKey: 'loud', ratings: [{ dimension: 'work_quality', rating: 1 }], id: 'x' + i }));
    const d = aggregateDimension('work_quality', many, NOW);
    expect(d.sourceCount).toBe(1);
    expect(d.score).toBeNull();
  });

  it('caps a prolific author at MAX_AUTHOR_SHARE of the weight', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item({ authorKey: 'loud', id: 'loud' + i, ratings: [{ dimension: 'work_quality', rating: 1 }] })),
      item({ authorKey: 'quiet-a', ratings: [{ dimension: 'work_quality', rating: 5 }] }),
      item({ authorKey: 'quiet-b', ratings: [{ dimension: 'work_quality', rating: 5 }] }),
    ];
    const d = aggregateDimension('work_quality', items, NOW);
    const loudShare = d.contributions
      .filter((c) => c.authorKey === 'loud')
      .reduce((a, c) => a + c.weight, 0);
    expect(loudShare).toBeLessThanOrEqual(MAX_AUTHOR_SHARE + 0.01);
    // the eight 1s cannot drag the score below the midpoint against two 5s
    expect(d.score as number).toBeGreaterThan(3);
  });

  it('caps one KIND of source at MAX_SOURCE_TYPE_SHARE', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) =>
        item({ authorKey: 'peer' + i, sourceType: 'peer', ratings: [{ dimension: 'teamwork', rating: 2 }] })),
      item({ authorKey: 'mgr', sourceType: 'reporting_manager', ratings: [{ dimension: 'teamwork', rating: 5 }] }),
    ];
    const d = aggregateDimension('teamwork', items, NOW);
    const peerShare = d.contributions
      .filter((c) => c.sourceType === 'peer')
      .reduce((a, c) => a + c.weight, 0);
    expect(peerShare).toBeLessThanOrEqual(MAX_SOURCE_TYPE_SHARE + 0.01);
  });

  it('damps an outlier by half and keeps it, rather than deleting it', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'reliability', rating: 4 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'reliability', rating: 4 }] }),
      item({ authorKey: 'c', ratings: [{ dimension: 'reliability', rating: 4 }] }),
      item({ authorKey: 'd', ratings: [{ dimension: 'reliability', rating: 4 }] }),
      item({ authorKey: 'e', id: 'the-outlier', ratings: [{ dimension: 'reliability', rating: 1 }] }),
    ];
    const d = aggregateDimension('reliability', items, NOW);
    const outlier = d.contributions.find((c) => c.feedbackId === 'the-outlier');
    expect(outlier).toBeDefined();
    expect(outlier?.isOutlier).toBe(true);
    // still present, still weighted, still readable
    expect((outlier?.weight ?? 0)).toBeGreaterThan(0);
    expect(d.outlierCount).toBe(1);
    expect(outlier?.weightSteps.some((s) => s.factor === 'outlier' && s.value === OUTLIER_WEIGHT_FACTOR)).toBe(true);
  });

  it('holds the band at "low" when exactly two people agree perfectly', () => {
    const items = [
      item({ authorKey: 'a', sourceType: 'reporting_manager', ratings: [{ dimension: 'ownership', rating: 5 }] }),
      item({ authorKey: 'b', sourceType: 'peer', ratings: [{ dimension: 'ownership', rating: 5 }] }),
    ];
    const d = aggregateDimension('ownership', items, NOW);
    expect(d.sourceCount).toBe(MIN_SOURCES_FOR_SCORE);
    expect(d.score).toBe(5);
    expect(d.band).toBe('low');
  });
});

describe('self-reflection is held apart, never averaged in', () => {
  it('excludes self from the score and reports the gap', () => {
    const items = [
      item({ authorKey: 'self-1', sourceType: 'self', ratings: [{ dimension: 'communication', rating: 5 }] }),
      item({ authorKey: 'a', ratings: [{ dimension: 'communication', rating: 3 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'communication', rating: 3 }] }),
    ];
    const d = aggregateDimension('communication', items, NOW);
    expect(d.score).toBe(3);
    expect(d.selfRating).toBe(5);
    expect(d.selfGap).toBe(2);
    expect(d.selfGapLabel).toBe('rates_self_higher');
    // the self item is not among the contributions at all
    expect(d.contributions.some((c) => c.sourceType === 'self')).toBe(false);
  });

  it('a self-reflection alone produces no score', () => {
    const d = aggregateDimension('learning', [
      item({ sourceType: 'self', ratings: [{ dimension: 'learning', rating: 4 }] }),
    ], NOW);
    expect(d.score).toBeNull();
    expect(d.selfRating).toBe(4);
  });
});

describe('evidence changes weight, and it is the biggest lever', () => {
  it('an unevidenced rating counts for less than an evidenced one', () => {
    const items = [
      item({ authorKey: 'thin', evidenceQuality: 'none', ratings: [{ dimension: 'initiative', rating: 1 }] }),
      item({ authorKey: 'solid', evidenceQuality: 'specific', ratings: [{ dimension: 'initiative', rating: 5 }] }),
    ];
    const d = aggregateDimension('initiative', items, NOW);
    const thin = d.contributions.find((c) => c.authorKey === 'thin');
    const solid = d.contributions.find((c) => c.authorKey === 'solid');
    expect((solid?.weight ?? 0)).toBeGreaterThan(thin?.weight ?? 0);
    expect(d.score as number).toBeGreaterThan(3);
  });

  it('classifyEvidence rewards a cited example over length alone', () => {
    expect(classifyEvidence('', 0)).toBe('none');
    expect(classifyEvidence('Good work generally, nothing specific comes to mind here.', 0)).toBe('general');
    expect(classifyEvidence('Handled the escalation well.', 1)).toBe('specific');
    expect(classifyEvidence('x'.repeat(200), 0)).toBe('general'); // long but no concrete marker
    expect(classifyEvidence('On 12 June they '.padEnd(200, 'x'), 0)).toBe('specific');
  });
});

describe('recency', () => {
  it('halves over the half-life and never falls below the floor', () => {
    const fresh = recencyFactor(NOW.toISOString(), NOW);
    expect(fresh).toBeCloseTo(1, 5);
    const halfLifeAgo = new Date(NOW.getTime() - RECENCY_HALF_LIFE_DAYS * 86400000).toISOString();
    expect(recencyFactor(halfLifeAgo, NOW)).toBeCloseTo(0.5, 2);
    const ancient = new Date(NOW.getTime() - 4000 * 86400000).toISOString();
    expect(recencyFactor(ancient, NOW)).toBe(RECENCY_FLOOR);
  });

  it('weights a recent item above an old one from the same kind of source', () => {
    const items = [
      item({ authorKey: 'old', createdAt: '2023-01-01T00:00:00.000Z', ratings: [{ dimension: 'discipline', rating: 1 }] }),
      item({ authorKey: 'new', createdAt: '2026-07-25T00:00:00.000Z', ratings: [{ dimension: 'discipline', rating: 5 }] }),
    ];
    const d = aggregateDimension('discipline', items, NOW);
    const oldC = d.contributions.find((c) => c.authorKey === 'old');
    const newC = d.contributions.find((c) => c.authorKey === 'new');
    expect((newC?.weight ?? 0)).toBeGreaterThan(oldC?.weight ?? 0);
  });
});

describe('disagreement and consensus', () => {
  it('names a cross-source disagreement rather than averaging it away', () => {
    const items = [
      item({ authorKey: 'm', sourceType: 'reporting_manager', ratings: [{ dimension: 'teamwork', rating: 5 }] }),
      item({ authorKey: 'p1', sourceType: 'peer', ratings: [{ dimension: 'teamwork', rating: 2 }] }),
      item({ authorKey: 'p2', sourceType: 'peer', ratings: [{ dimension: 'teamwork', rating: 2 }] }),
    ];
    const d = aggregateDimension('teamwork', items, NOW);
    expect(d.disagreement).toBe('across_sources');
    expect(d.disagreementNote).toContain('Reporting manager');
    expect(d.consensusIndex).toBeLessThan(1);
  });

  it('reports consensus of 1 when everybody agrees', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'adaptability', rating: 4 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'adaptability', rating: 4 }] }),
      item({ authorKey: 'c', ratings: [{ dimension: 'adaptability', rating: 4 }] }),
    ];
    const d = aggregateDimension('adaptability', items, NOW);
    expect(d.consensusIndex).toBe(1);
    expect(d.disagreement).toBe('none');
    expect(d.spread).toBe(0);
  });

  it('flags a wide spread within one kind of source', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'problem_solving', rating: 5 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'problem_solving', rating: 3 }] }),
      item({ authorKey: 'c', ratings: [{ dimension: 'problem_solving', rating: 3 }] }),
    ];
    const d = aggregateDimension('problem_solving', items, NOW);
    expect(d.disagreement).toBe('within_source');
  });
});

describe('repeated unsupported feedback', () => {
  it('raises an author only at the threshold, and counts both extremes', () => {
    const low = Array.from({ length: UNSUPPORTED_REPEAT_THRESHOLD }, (_, i) =>
      item({ authorKey: 'grinder', id: 'g' + i, evidenceQuality: 'none', ratings: [{ dimension: 'work_quality', rating: 1 }] }));
    const high = Array.from({ length: UNSUPPORTED_REPEAT_THRESHOLD }, (_, i) =>
      item({ authorKey: 'booster', id: 'b' + i, evidenceQuality: 'none', ratings: [{ dimension: 'work_quality', rating: 5 }] }));
    const belowThreshold = [
      item({ authorKey: 'occasional', evidenceQuality: 'none', ratings: [{ dimension: 'work_quality', rating: 1 }] }),
    ];
    const found = detectRepeatedUnsupported([...low, ...high, ...belowThreshold]);
    expect(found.has('grinder')).toBe(true);
    expect(found.has('booster')).toBe(true);
    expect(found.has('occasional')).toBe(false);
  });

  it('does not raise an author whose extreme ratings are evidenced', () => {
    const evidenced = Array.from({ length: 5 }, (_, i) =>
      item({ authorKey: 'careful', id: 'c' + i, evidenceQuality: 'specific', ratings: [{ dimension: 'work_quality', rating: 1 }] }));
    expect(detectRepeatedUnsupported(evidenced).size).toBe(0);
  });

  it('reduces that author\'s weight without removing them', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) =>
        item({ authorKey: 'grinder', id: 'g' + i, evidenceQuality: 'none', ratings: [{ dimension: 'work_quality', rating: 1 }] })),
      item({ authorKey: 'other', evidenceQuality: 'specific', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'third', evidenceQuality: 'specific', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    const dim = signal.dimensions.find((d) => d.dimension === 'work_quality');
    const grinder = dim?.contributions.filter((c) => c.authorKey === 'grinder') || [];
    expect(grinder.length).toBe(3);
    expect(grinder.every((c) => c.weightSteps.some((s) => s.factor === 'unsupported-pattern'))).toBe(true);
    const flag = signal.flags.find((f) => f.kind === 'repeated_unsupported');
    expect(flag).toBeDefined();
    expect(flag?.evidenceRefs.length).toBe(3);
  });
});

describe('author tendency', () => {
  it('names an author who sits consistently below everybody else', () => {
    const dims = ['work_quality', 'reliability', 'ownership', 'communication'];
    const items = [
      item({ authorKey: 'harsh', authorName: 'Harsh Rater', ratings: dims.map((d) => ({ dimension: d, rating: 2 })) }),
      item({ authorKey: 'a', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
      item({ authorKey: 'b', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
      item({ authorKey: 'c', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
    ];
    const found = detectAuthorTendency(items);
    const harsh = found.find((f) => f.authorKey === 'harsh');
    expect(harsh).toBeDefined();
    expect(harsh?.meanDeviation).toBe(-2);
  });

  it('does not call a single disagreement a tendency', () => {
    const items = [
      item({ authorKey: 'x', ratings: [{ dimension: 'work_quality', rating: 1 }] }),
      item({ authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
    ];
    expect(detectAuthorTendency(items).length).toBe(0);
  });
});

describe('the whole signal', () => {
  it('refuses an overall figure until enough dimensions are scored', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 4 }, { dimension: 'reliability', rating: 4 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 4 }, { dimension: 'reliability', rating: 4 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    expect(signal.overall).toBeNull();
    expect(signal.overallBand).toBe('insufficient');
    expect(signal.explanation.output).toContain('No overall figure');
  });

  it('produces an overall figure once three dimensions are covered', () => {
    const dims = ['work_quality', 'reliability', 'ownership'];
    const items = [
      item({ authorKey: 'a', sourceType: 'reporting_manager', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
      item({ authorKey: 'b', sourceType: 'peer', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
      item({ authorKey: 'c', sourceType: 'peer', ratings: dims.map((d) => ({ dimension: d, rating: 4 })) }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    expect(signal.overall).toBe(4);
    expect(signal.sourceCount).toBe(3);
    expect(signal.advisoryOnly).toBe(true);
    expect(signal.decisionNotice).toContain('advisory');
  });

  it('excludes drafts and withdrawn items from every figure', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 5 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 5 }] }),
      item({ authorKey: 'c', status: 'withdrawn', ratings: [{ dimension: 'work_quality', rating: 1 }] }),
      item({ authorKey: 'd', status: 'draft', ratings: [{ dimension: 'work_quality', rating: 1 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    const dim = signal.dimensions.find((d) => d.dimension === 'work_quality');
    expect(dim?.score).toBe(5);
    expect(dim?.itemCount).toBe(2);
    expect(signal.itemCount).toBe(2);
  });

  it('flags a record built from one kind of source', () => {
    const items = [
      item({ authorKey: 'p1', sourceType: 'peer', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'p2', sourceType: 'peer', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    expect(signal.flags.some((f) => f.kind === 'source_type_imbalance')).toBe(true);
  });

  it('flags a record nobody has added to in over a year', () => {
    const items = [
      item({ authorKey: 'a', createdAt: '2024-01-01T00:00:00.000Z', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'b', createdAt: '2024-01-02T00:00:00.000Z', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    expect(signal.flags.some((f) => f.kind === 'stale_evidence')).toBe(true);
  });

  it('carries a complete explanation on every dimension it scores', () => {
    const items = [
      item({ authorKey: 'a', sourceType: 'reporting_manager', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'b', sourceType: 'peer', ratings: [{ dimension: 'work_quality', rating: 3 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    const dim = signal.dimensions.find((d) => d.dimension === 'work_quality');
    expect(dim?.explanation.inputs.length).toBeGreaterThan(0);
    expect(dim?.explanation.processing.length).toBeGreaterThan(0);
    expect(dim?.explanation.output).toContain('Work quality');
    expect(dim?.explanation.evidence).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(dim?.explanation.confidence).toContain('Coverage');
    expect(dim?.explanation.computedAt).toBe(NOW.toISOString());
    // every contribution can be reconstructed by hand
    for (const c of dim?.contributions || []) {
      expect(c.weightSteps.some((s) => s.factor === 'source')).toBe(true);
      expect(c.weightSteps.some((s) => s.factor === 'evidence')).toBe(true);
      expect(c.weightSteps.some((s) => s.factor === 'recency')).toBe(true);
    }
  });

  it('is deterministic — the same inputs give the same output', () => {
    const items = [
      item({ id: 'fixed-1', authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ id: 'fixed-2', authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 2 }] }),
    ];
    const one = aggregateFeedback('subject-1', items, NOW);
    const two = aggregateFeedback('subject-1', items, NOW);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('never invents a rating for a dimension nobody rated', () => {
    const items = [
      item({ authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
      item({ authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 4 }] }),
    ];
    const signal = aggregateFeedback('subject-1', items, NOW);
    expect(signal.dimensions.some((d) => d.dimension === 'leadership')).toBe(false);
    expect(signal.dimensions.length).toBe(1);
  });

  it('handles an empty record without throwing or producing a zero', () => {
    const signal = aggregateFeedback('subject-1', [], NOW);
    expect(signal.overall).toBeNull();
    expect(signal.dimensions).toEqual([]);
    expect(signal.itemCount).toBe(0);
    expect(signal.flags.some((f) => f.kind === 'single_source')).toBe(true);
  });
});
