// src/lib/horizon/feedback/visibility.test.ts
//
// The redaction rules, tested as PROPERTIES rather than as examples. A confidentiality bug is not a
// wrong pixel — it is a note somebody wrote about their manager, shown to that manager — so the
// tests below assert the negative case first and the positive case second, in that order, for each
// rule.
//
// resolveFeedbackView() is NOT tested here: it delegates to canSeePerformanceOf(), which reads the
// Organization Graph, and a test that mocked the graph would be a test of the mock. What is tested
// here is everything downstream of the view, which is where the redaction actually happens.
import { describe, it, expect } from 'vitest';
import { redactItems, redactSignal, VIEW_RIGHTS, viewNotice, type FeedbackView } from './visibility-rules';
import { aggregateFeedback } from './aggregate';
import type { FeedbackConfidentiality, FeedbackItem, FeedbackItemStatus } from './types';

const NOW = new Date('2026-08-01T00:00:00.000Z');

let seq = 0;
function item(over: Partial<FeedbackItem> = {}): FeedbackItem {
  seq += 1;
  const author = over.authorKey || 'author-' + seq;
  return {
    id: over.id || 'fb-' + seq,
    subjectEmployeeId: 'subject-1',
    sourceType: over.sourceType || 'peer',
    sourceVerified: true,
    sourceVerifiedNote: null,
    authorKey: author,
    authorUserId: over.authorUserId !== undefined ? over.authorUserId : author,
    authorEmployeeId: over.authorEmployeeId !== undefined ? over.authorEmployeeId : author,
    authorName: 'Author ' + author,
    context: 'day_to_day',
    contextNote: null,
    periodStart: null,
    periodEnd: null,
    evidence: 'They rewrote the intake form after the 14 May incident.',
    evidenceQuality: over.evidenceQuality || 'specific',
    confidentiality: (over.confidentiality || 'standard') as FeedbackConfidentiality,
    status: (over.status || 'submitted') as FeedbackItemStatus,
    ratings: (over.ratings || [{ dimension: 'work_quality', rating: 4, comment: null }]) as any,
    examples: [],
    createdAt: over.createdAt || '2026-07-01T00:00:00.000Z',
    withdrawnAt: null,
    withdrawnReason: null,
    cycleId: null,
  } as FeedbackItem;
}

const stranger = { employeeId: 'nobody', userId: 'nobody-user' };

describe('the people-desk channel', () => {
  const items = [
    item({ id: 'open', confidentiality: 'standard' }),
    item({ id: 'private', confidentiality: 'hr_channel' }),
  ];

  it('is HIDDEN from the reporting line', () => {
    const seen = redactItems(items, 'responsible', stranger).map((i) => i.id);
    expect(seen).toEqual(['open']);
  });

  it('is visible to the person it is about', () => {
    const seen = redactItems(items, 'subject', stranger).map((i) => i.id);
    expect(seen).toEqual(['open', 'private']);
  });

  it('is visible to the people desk', () => {
    const seen = redactItems(items, 'hr', stranger).map((i) => i.id);
    expect(seen).toEqual(['open', 'private']);
  });

  it('is still visible to whoever wrote it, in any view', () => {
    const mine = [item({ id: 'mine', confidentiality: 'hr_channel', authorEmployeeId: 'me', authorUserId: 'me-user' })];
    const asManager = redactItems(mine, 'responsible', { employeeId: 'me', userId: 'me-user' });
    expect(asManager.map((i) => i.id)).toEqual(['mine']);
    // ...and to nobody else in that same view
    expect(redactItems(mine, 'responsible', stranger)).toEqual([]);
  });
});

describe('drafts', () => {
  it('belong to nobody but their author, not even the people desk', () => {
    const items = [item({ id: 'wip', status: 'draft', authorEmployeeId: 'me', authorUserId: 'me-user' })];
    expect(redactItems(items, 'hr', stranger)).toEqual([]);
    expect(redactItems(items, 'subject', stranger)).toEqual([]);
    expect(redactItems(items, 'responsible', stranger)).toEqual([]);
    expect(redactItems(items, 'hr', { employeeId: 'me', userId: 'me-user' }).map((i) => i.id)).toEqual(['wip']);
  });
});

describe('the "none" view', () => {
  it('returns nothing except the reader\'s own items, and never throws', () => {
    const items = [item({ id: 'theirs' }), item({ id: 'mine', authorEmployeeId: 'me', authorUserId: 'me-user' })];
    expect(redactItems(items, 'none', stranger)).toEqual([]);
    expect(redactItems(items, 'none', { employeeId: 'me', userId: 'me-user' }).map((i) => i.id)).toEqual(['mine']);
  });
});

describe('readings about a named colleague', () => {
  // Three unevidenced extreme items from one author raises repeated_unsupported, which names them.
  const items = [
    ...Array.from({ length: 3 }, (_, i) =>
      item({ id: 'g' + i, authorKey: 'grinder', evidenceQuality: 'none', ratings: [{ dimension: 'work_quality', rating: 1, comment: null }] as any })),
    item({ authorKey: 'a', ratings: [{ dimension: 'work_quality', rating: 4, comment: null }] as any }),
    item({ authorKey: 'b', ratings: [{ dimension: 'work_quality', rating: 4, comment: null }] as any }),
  ];
  const signal = aggregateFeedback('subject-1', items, NOW);

  it('exist on the raw signal', () => {
    expect(signal.flags.some((f) => f.kind === 'repeated_unsupported')).toBe(true);
  });

  it('are WITHHELD from the subject — a judgement about a colleague, told to the wrong person', () => {
    const r = redactSignal(signal, 'subject', 0);
    expect(r.flags.some((f) => f.kind === 'repeated_unsupported')).toBe(false);
    expect(r.flags.some((f) => f.kind === 'author_tendency')).toBe(false);
  });

  it('are withheld from the reporting line', () => {
    const r = redactSignal(signal, 'responsible', 0);
    expect(r.flags.some((f) => f.kind === 'repeated_unsupported')).toBe(false);
  });

  it('reach the people desk, which is the only view that can act on them', () => {
    const r = redactSignal(signal, 'hr', 0);
    expect(r.flags.some((f) => f.kind === 'repeated_unsupported')).toBe(true);
    expect(r.flags.find((f) => f.kind === 'repeated_unsupported')?.aboutAuthorName).toBeTruthy();
  });
});

describe('weighting internals', () => {
  const items = [
    item({ authorKey: 'a', sourceType: 'reporting_manager' }),
    item({ authorKey: 'b', sourceType: 'peer' }),
  ];
  const signal = aggregateFeedback('subject-1', items, NOW);

  it('are stripped for the reporting line, but who-said-what is kept', () => {
    const r = redactSignal(signal, 'responsible', 0);
    const dim = r.dimensions[0];
    expect(dim.contributions.length).toBe(2);
    expect(dim.contributions.every((c) => c.weightSteps.length === 0)).toBe(true);
    // the rating, the author and the date survive — that is the point of the screen
    expect(dim.contributions.every((c) => c.rating > 0 && !!c.authorName && !!c.createdAt)).toBe(true);
  });

  it('are kept for the subject and the people desk', () => {
    for (const view of ['subject', 'hr'] as FeedbackView[]) {
      const r = redactSignal(signal, view, 0);
      expect(r.dimensions[0].contributions.every((c) => c.weightSteps.length > 0)).toBe(true);
    }
  });
});

describe('the hidden-item note', () => {
  const items = [item({ authorKey: 'a' }), item({ authorKey: 'b' })];
  const signal = aggregateFeedback('subject-1', items, NOW);

  it('says plainly that the figures were NOT recomputed from the visible subset', () => {
    const r = redactSignal(signal, 'responsible', 2);
    expect(r.hiddenItemCount).toBe(2);
    expect(r.redactionNote).toContain('not recomputed');
    // the score is unchanged by the hiding — that is the disclosure defence
    expect(r.dimensions[0].score).toBe(signal.dimensions[0].score);
  });

  it('is absent when nothing was hidden', () => {
    expect(redactSignal(signal, 'hr', 0).redactionNote).toBeNull();
  });
});

describe('the rights table', () => {
  it('never gives a view more than the one above it on any axis', () => {
    // hr is the widest; none is the narrowest. Every axis must be monotone across that order.
    const order: FeedbackView[] = ['none', 'author', 'responsible', 'subject', 'hr'];
    const axes = ['hrChannelItems', 'weightingInternals', 'authorLevelReadings', 'aggregate'] as const;
    for (const axis of axes) {
      // authorLevelReadings is the deliberate exception: only hr holds it, and subject must NOT.
      if (axis === 'authorLevelReadings') {
        expect(VIEW_RIGHTS.subject.authorLevelReadings).toBe(false);
        expect(VIEW_RIGHTS.responsible.authorLevelReadings).toBe(false);
        expect(VIEW_RIGHTS.hr.authorLevelReadings).toBe(true);
        continue;
      }
      const values = order.map((v) => VIEW_RIGHTS[v][axis]);
      // once true, it must stay true up the order
      const firstTrue = values.indexOf(true);
      if (firstTrue >= 0) {
        expect(values.slice(firstTrue).every(Boolean)).toBe(true);
      }
    }
  });

  it('gives the "none" view nothing at all', () => {
    expect(Object.values(VIEW_RIGHTS.none).every((v) => v === false)).toBe(true);
  });

  it('has a written notice for every view', () => {
    for (const v of ['subject', 'responsible', 'hr', 'author', 'none'] as FeedbackView[]) {
      expect(viewNotice(v).length).toBeGreaterThan(20);
    }
  });
});
