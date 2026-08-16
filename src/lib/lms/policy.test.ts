// src/lib/lms/policy.test.ts — the grade arithmetic, tested without a database.
//
// These are the numbers a learner can dispute, so each case here is written as the dispute:
// "I submitted at 00:00:01 and lost a whole day", "my average dropped because the final exam has
// not happened yet", "the rubric added up to more than the assignment is worth".
import { describe, it, expect } from 'vitest';
import {
  lateness, applyLatePolicy, submissionState, acceptingSubmissions, letterFor, courseGrade,
  gpa, rubricTotal, releaseState, relativeDue, pctOf, DEFAULT_SCALE,
} from './policy';

const DUE = new Date('2026-08-10T23:59:00Z');

describe('lateness', () => {
  it('is not late with no due date', () => {
    expect(lateness(null, new Date('2030-01-01T00:00:00Z')).isLate).toBe(false);
  });

  it('is not late one second before the deadline', () => {
    expect(lateness(DUE, new Date('2026-08-10T23:58:59Z')).isLate).toBe(false);
  });

  it('counts one second past the deadline as one day late', () => {
    const late = lateness(DUE, new Date('2026-08-10T23:59:01Z'));
    expect(late.isLate).toBe(true);
    expect(late.daysLate).toBe(1);
  });

  it('ceilings partial days', () => {
    expect(lateness(DUE, new Date('2026-08-12T06:00:00Z')).daysLate).toBe(2);
  });

  it('ignores an unparseable due date rather than calling everything late', () => {
    expect(lateness('not a date', new Date()).isLate).toBe(false);
  });
});

describe('applyLatePolicy', () => {
  const policy = { allowLate: true, penaltyPctPerDay: 10, maxLateDays: 5 };

  it('costs nothing on time', () => {
    expect(applyLatePolicy(100, 0, policy).penaltyPoints).toBe(0);
  });

  it('takes ten percent of the total per day, not of the score', () => {
    expect(applyLatePolicy(80, 2, policy).penaltyPoints).toBe(16);
  });

  it('never exceeds the assignment, so a late grade cannot go negative', () => {
    const out = applyLatePolicy(100, 40, { allowLate: true, penaltyPctPerDay: 10, maxLateDays: 0 });
    expect(out.penaltyPoints).toBe(100);
  });

  it('refuses the submission past the cap', () => {
    expect(applyLatePolicy(100, 6, policy).accepted).toBe(false);
  });

  it('refuses any lateness when late work is not allowed', () => {
    expect(applyLatePolicy(100, 1, { allowLate: false, penaltyPctPerDay: 0, maxLateDays: 0 }).accepted).toBe(false);
  });
});

describe('submissionState', () => {
  const base = { dueAt: DUE, allowLate: true, maxLateDays: 5 };

  it('is locked before it opens', () => {
    expect(submissionState({ ...base, availableFrom: '2026-08-01T00:00:00Z' }, new Date('2026-07-30T00:00:00Z'))).toBe('locked');
  });

  it('is not started before the due date with nothing submitted', () => {
    expect(submissionState(base, new Date('2026-08-01T00:00:00Z'))).toBe('not_started');
  });

  it('is overdue after the due date with nothing submitted', () => {
    expect(submissionState(base, new Date('2026-08-12T00:00:00Z'))).toBe('missing');
  });

  it('is closed once late work can no longer be accepted', () => {
    expect(submissionState(base, new Date('2026-08-20T00:00:00Z'))).toBe('closed');
  });

  it('reports a posted grade as graded, whatever the clock says', () => {
    expect(submissionState({ ...base, graded: true }, new Date('2030-01-01T00:00:00Z'))).toBe('graded');
  });

  it('reports a returned submission as returned, not as submitted', () => {
    expect(submissionState({ ...base, submissionStatus: 'returned' }, new Date('2026-08-01T00:00:00Z'))).toBe('returned');
  });
});

describe('acceptingSubmissions', () => {
  it('warns that a submission WILL be late before it is written', () => {
    const w = acceptingSubmissions({ dueAt: DUE, allowLate: true, maxLateDays: 5 }, new Date('2026-08-12T00:00:00Z'));
    expect(w.open).toBe(true);
    expect(w.willBeLate).toBe(true);
    expect(w.daysLate).toBe(2);
  });

  it('closes at the hard close even when late work is allowed', () => {
    const w = acceptingSubmissions({ dueAt: DUE, closesAt: '2026-08-11T00:00:00Z', allowLate: true, maxLateDays: 30 }, new Date('2026-08-15T00:00:00Z'));
    expect(w.open).toBe(false);
  });
});

describe('letterFor', () => {
  it('maps the boundaries exactly', () => {
    expect(letterFor(93, DEFAULT_SCALE).letter).toBe('A');
    expect(letterFor(92.99, DEFAULT_SCALE).letter).toBe('A-');
    expect(letterFor(0, DEFAULT_SCALE).letter).toBe('F');
  });

  it('honours a course scale that is not the default', () => {
    const scale = [{ letter: 'Pass', min: 50, points: 4 }, { letter: 'Fail', min: 0, points: 0 }];
    expect(letterFor(51, scale).letter).toBe('Pass');
    expect(letterFor(49, scale).letter).toBe('Fail');
  });
});

describe('courseGrade', () => {
  const cats = [
    { id: 'hw', name: 'Homework', weight: 40, dropLowest: 0 },
    { id: 'exam', name: 'Exams', weight: 60, dropLowest: 0 },
  ];

  it('weights categories rather than averaging assignments', () => {
    const g = courseGrade(cats, [
      { categoryId: 'hw', points: 100, total: 100 },
      { categoryId: 'exam', points: 50, total: 100 },
    ]);
    expect(g.pct).toBe(70);   // 100*0.4 + 50*0.6
  });

  it('does NOT count an ungraded category as zero', () => {
    const g = courseGrade(cats, [{ categoryId: 'hw', points: 92, total: 100 }]);
    expect(g.pct).toBe(92);
    expect(g.ungradedWeight).toBe(60);
    expect(g.complete).toBe(false);
  });

  it('reports no grade at all when nothing is graded', () => {
    const g = courseGrade(cats, []);
    expect(g.pct).toBeNull();
  });

  it('drops the lowest by percentage, not by raw points', () => {
    const g = courseGrade(
      [{ id: 'q', name: 'Quizzes', weight: 100, dropLowest: 1 }],
      [
        { categoryId: 'q', points: 9, total: 10 },     // 90%
        { categoryId: 'q', points: 60, total: 100 },   // 60% — the real lowest
        { categoryId: 'q', points: 10, total: 10 },    // 100%
      ],
    );
    expect(g.pct).toBe(95);   // (9 + 10) / (10 + 10)
  });

  it('falls back to one flat category when a course defines none', () => {
    const g = courseGrade([], [{ categoryId: null, points: 8, total: 10 }]);
    expect(g.pct).toBe(80);
  });

  // WORK AN INSTRUCTOR NEVER FILED USED TO BE COUNTED IN WHICHEVER CATEGORY SORTED FIRST.
  // Silently, taking that category's weight, producing a course percentage nobody could account
  // for. It now gets its own visible bucket carrying the weight the named categories left unclaimed.
  it('does not smuggle uncategorised work into the first category', () => {
    const g = courseGrade(cats, [
      { categoryId: 'hw', points: 100, total: 100 },
      { categoryId: 'exam', points: 100, total: 100 },
      { categoryId: null, points: 0, total: 100 },   // a zero that must not drag Homework down
    ]);
    expect(g.categories.find((c) => c.id === 'hw')!.pct).toBe(100);
    expect(g.pct).toBe(100);   // the named categories add to 100, so the stray work has no weight
  });

  it('shows the uncategorised bucket so the setup mistake is visible rather than absorbed', () => {
    const g = courseGrade(cats, [{ categoryId: 'hw', points: 90, total: 100 }, { categoryId: null, points: 50, total: 100 }]);
    const stray = g.categories.find((c) => c.name === 'Uncategorised');
    expect(stray).toBeTruthy();
    expect(stray!.pct).toBe(50);
    expect(stray!.weight).toBe(0);
  });

  it('gives uncategorised work the unclaimed weight when the categories do not add to 100', () => {
    const light = [{ id: 'hw', name: 'Homework', weight: 60, dropLowest: 0 }];
    const g = courseGrade(light, [{ categoryId: 'hw', points: 100, total: 100 }, { categoryId: null, points: 0, total: 100 }]);
    const stray = g.categories.find((c) => c.name === 'Uncategorised')!;
    expect(stray.weight).toBe(40);
    expect(g.pct).toBe(60);   // 100 * 0.6 + 0 * 0.4
  });

  it('adds no bucket at all when every score is filed', () => {
    const g = courseGrade(cats, [{ categoryId: 'hw', points: 90, total: 100 }]);
    expect(g.categories.some((c) => c.name === 'Uncategorised')).toBe(false);
  });

  it('ignores zero-point assignments instead of dividing by them', () => {
    const g = courseGrade([], [{ categoryId: null, points: 0, total: 0 }, { categoryId: null, points: 5, total: 10 }]);
    expect(g.pct).toBe(50);
  });
});

describe('gpa', () => {
  it('weights by credit hours', () => {
    expect(gpa([{ creditHours: 3, points: 4 }, { creditHours: 1, points: 2 }])).toBe(3.5);
  });

  it('ignores zero-credit rows', () => {
    expect(gpa([{ creditHours: 3, points: 4 }, { creditHours: 0, points: 0 }])).toBe(4);
  });

  it('returns null, not zero, when nothing counts', () => {
    expect(gpa([{ creditHours: 0, points: 4 }])).toBeNull();
  });
});

describe('rubricTotal', () => {
  const criteria = [{ id: 'a', label: 'Argument', points: 20 }, { id: 'b', label: 'Evidence', points: 30 }];

  it('adds the criteria', () => {
    expect(rubricTotal(criteria, { a: 15, b: 25 }).total).toBe(40);
  });

  it('clamps a criterion to its own maximum and says which', () => {
    const out = rubricTotal(criteria, { a: 99, b: 30 });
    expect(out.total).toBe(50);
    expect(out.clamped).toContain('a');
  });

  it('treats a missing or non-numeric score as zero rather than NaN', () => {
    expect(rubricTotal(criteria, { a: NaN as any }).total).toBe(0);
  });
});

describe('releaseState', () => {
  const ctx = { enrolledAt: '2026-08-01T00:00:00Z', completedLessonIds: ['l1'], gradedPctByAssignment: { a1: 55 } };

  it('opens when there is no rule', () => {
    expect(releaseState(null, ctx, new Date()).open).toBe(true);
  });

  it('holds until a fixed date', () => {
    expect(releaseState({ releaseAt: '2026-09-01T00:00:00Z' }, ctx, new Date('2026-08-15T00:00:00Z')).open).toBe(false);
  });

  it('counts days from the learner enrolment, not from the course start', () => {
    expect(releaseState({ releaseAfterDays: 7 }, ctx, new Date('2026-08-05T00:00:00Z')).open).toBe(false);
    expect(releaseState({ releaseAfterDays: 7 }, ctx, new Date('2026-08-09T00:00:00Z')).open).toBe(true);
  });

  it('requires the prerequisite lesson', () => {
    expect(releaseState({ requiresLessonId: 'l2' }, ctx, new Date()).open).toBe(false);
    expect(releaseState({ requiresLessonId: 'l1' }, ctx, new Date()).open).toBe(true);
  });

  it('enforces a minimum score on the prerequisite assignment', () => {
    expect(releaseState({ requiresAssignmentId: 'a1', minPct: 60 }, ctx, new Date()).open).toBe(false);
    expect(releaseState({ requiresAssignmentId: 'a1', minPct: 50 }, ctx, new Date()).open).toBe(true);
  });

  it('holds when the prerequisite assignment has not been graded at all', () => {
    expect(releaseState({ requiresAssignmentId: 'a9' }, ctx, new Date()).open).toBe(false);
  });
});

describe('relativeDue and pctOf', () => {
  it('phrases future and past differently', () => {
    expect(relativeDue(DUE, new Date('2026-08-08T23:59:00Z'))).toBe('Due in 2 days');
    expect(relativeDue(DUE, new Date('2026-08-11T23:59:00Z'))).toBe('24 hours overdue');
  });

  it('says so plainly when there is no due date', () => {
    expect(relativeDue(null, new Date())).toBe('No due date');
  });

  it('returns null rather than NaN for a zero-point assignment', () => {
    expect(pctOf(0, 0)).toBeNull();
    expect(pctOf(45, 50)).toBe(90);
  });
});
