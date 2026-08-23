// src/lib/talent/stages.test.ts — the pipeline rules, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. stages.ts resolves its database handle lazily, so
// importing decideAdvance() must not require DATABASE_URL. If that ever regresses — someone adds a
// module-scope `import { db }` — this file fails at COLLECTION rather than on an assertion, which is
// exactly the signal wanted: the whole suite going dark is what happened to fourteen suites here
// before vitest.config.ts was written, and it reads as a broken file rather than a broken rule.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STAGES, STAGE_STATUSES, STAGE_TYPES,
  isStageOutcome, outcomeForStatus, statusForRow,
  passScoreOf, isRequiredOf,
  publicStageFor, applicationStatusFor,
  scorePercent, bestScoreFor, decideAdvance, decidePass, completion,
  latestPerStage, progressFromHistory,
  type StageRules, type StageProgress, type EvaluationSummary, type StageStatus,
} from '@/lib/talent/stages';
import type { ApplicationStage } from '@/lib/talent/types';

// A pipeline the pure rules can be run against. DEFAULT_STAGES already satisfies StageRules.
const P: StageRules[] = DEFAULT_STAGES.map((s) => ({
  ordinal: s.ordinal, key: s.key, label: s.label, config: s.config,
}));

const prog = (pairs: [string, StageStatus][]): StageProgress[] =>
  pairs.map(([stageKey, status]) => ({
    stageKey, status, ordinal: P.find((s) => s.key === stageKey)?.ordinal ?? 0,
  }));

const evalFor = (stageKey: string, score: number | null, maxScore = 100): EvaluationSummary =>
  ({ stageKey, score, maxScore, recommendation: null });

const row = (o: Partial<ApplicationStage> & { stageKey: string }): ApplicationStage => ({
  id: 'r-' + o.stageKey, applicationId: 'a1', ordinal: 1, enteredAt: '2026-06-01T00:00:00Z',
  dueAt: null, completedAt: null, outcome: null, ownerUserId: null, note: null, actorUserId: null,
  ...o,
});

describe('the seven default stages', () => {
  it('are seven, uniquely keyed, and ordinally 1..7', () => {
    expect(DEFAULT_STAGES).toHaveLength(7);
    expect(DEFAULT_STAGES.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(DEFAULT_STAGES.map((s) => s.key)).size).toBe(7);
  });

  it('classify every stage with a stageType the contract knows', () => {
    for (const s of DEFAULT_STAGES) expect(STAGE_TYPES).toContain(s.stageType);
  });

  it('end on a terminal stage, and only on a terminal stage', () => {
    expect(DEFAULT_STAGES.filter((s) => s.isTerminal).map((s) => s.key)).toEqual(['decision']);
  });

  it('make exactly the assignment and assessment optional', () => {
    const optional = DEFAULT_STAGES.filter((s) => !isRequiredOf(s)).map((s) => s.key);
    expect(optional).toEqual(['assignment', 'assessment']);
  });
});

describe('outcome and status are inverses, and degenerate rows fail closed', () => {
  it('round-trips every status that writes an outcome', () => {
    for (const status of ['passed', 'failed', 'skipped'] as StageStatus[]) {
      const outcome = outcomeForStatus(status);
      expect(outcome).not.toBeNull();
      expect(statusForRow({ outcome, completedAt: '2026-06-01T00:00:00Z' })).toBe(status);
    }
  });

  it('writes no outcome for in_progress, and reads that back as in_progress', () => {
    expect(outcomeForStatus('in_progress')).toBeNull();
    expect(statusForRow({ outcome: null, completedAt: null })).toBe('in_progress');
  });

  it('records a rollback as reverted, which reads as pending', () => {
    expect(outcomeForStatus('pending')).toBe('reverted');
    expect(statusForRow({ outcome: 'reverted', completedAt: '2026-06-01T00:00:00Z' })).toBe('pending');
  });

  it('reads a row closed with NO outcome as pending, never as cleared', () => {
    // The dangerous direction. A foreign writer that sets completed_at and forgets the outcome must
    // not thereby let somebody past a required stage.
    expect(statusForRow({ outcome: null, completedAt: '2026-06-01T00:00:00Z' })).toBe('pending');
  });

  it('reads an UNRECOGNISED outcome as pending, never as cleared', () => {
    expect(statusForRow({ outcome: 'something_new', completedAt: '2026-06-01T00:00:00Z' })).toBe('pending');
  });

  it('recognises exactly the four contract outcomes', () => {
    for (const o of ['pass', 'fail', 'waived', 'reverted']) expect(isStageOutcome(o)).toBe(true);
    for (const o of ['passed', 'PASS', '', null, undefined, 7, {}]) expect(isStageOutcome(o)).toBe(false);
  });

  it('covers every declared status', () => {
    expect(STAGE_STATUSES).toHaveLength(5);
    for (const s of STAGE_STATUSES) expect(() => outcomeForStatus(s)).not.toThrow();
  });
});

describe('config is the only home of the pass mark and optionality', () => {
  it('reads a pass mark that is there', () => {
    expect(passScoreOf({ config: { passScore: 60 } })).toBe(60);
    expect(passScoreOf({ config: { passScore: '60' } })).toBe(60);
    expect(passScoreOf({ config: { passScore: 0 } })).toBe(0);
  });

  it('treats absent, null, empty and unreadable as NO pass mark, not an unclearable one', () => {
    expect(passScoreOf({ config: {} })).toBeNull();
    expect(passScoreOf({ config: { passScore: null } })).toBeNull();
    expect(passScoreOf({ config: { passScore: '' } })).toBeNull();
    expect(passScoreOf({ config: { passScore: 'sixty' } })).toBeNull();
    expect(passScoreOf({ config: undefined as any })).toBeNull();
  });

  it('treats a stage that does not say it is optional as REQUIRED', () => {
    expect(isRequiredOf({ config: {} })).toBe(true);
    expect(isRequiredOf({ config: { isRequired: null } })).toBe(true);
    expect(isRequiredOf({ config: undefined as any })).toBe(true);
    expect(isRequiredOf({ config: { isRequired: true } })).toBe(true);
    expect(isRequiredOf({ config: { isRequired: false } })).toBe(false);
  });
});

describe('the projection onto the six published steps', () => {
  it('maps every internal stage to a published step', () => {
    for (const s of DEFAULT_STAGES) expect(typeof publicStageFor(s.key)).toBe('string');
    expect(publicStageFor('application')).toBe('submitted');
    expect(publicStageFor('screening')).toBe('review');
    expect(publicStageFor('assignment')).toBe('assessment');
    expect(publicStageFor('assessment')).toBe('assessment');
    expect(publicStageFor('interview')).toBe('interview');
    expect(publicStageFor('evaluation')).toBe('decision');
    expect(publicStageFor('decision')).toBe('decision');
  });

  it('never shows a candidate an internal stage name for an unknown key', () => {
    expect(publicStageFor('nonsense')).toBe('submitted');
    expect(publicStageFor('')).toBe('submitted');
  });

  it('maps every internal stage onto a real applications.status value', () => {
    const allowed = ['submitted', 'reviewing', 'task_sent', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
    for (const s of DEFAULT_STAGES) expect(allowed).toContain(applicationStatusFor(s.key));
    expect(applicationStatusFor('unknown')).toBe('submitted');
  });
});

describe('scoring', () => {
  it('computes a percentage', () => {
    expect(scorePercent(evalFor('x', 45, 90))).toBe(50);
  });

  it('returns null rather than Infinity or NaN for an unusable denominator', () => {
    expect(scorePercent(evalFor('x', 10, 0))).toBeNull();
    expect(scorePercent(evalFor('x', 10, -5))).toBeNull();
    expect(scorePercent(evalFor('x', 10, Number.NaN))).toBeNull();
    expect(scorePercent(evalFor('x', null))).toBeNull();
    expect(scorePercent(evalFor('x', Number.NaN))).toBeNull();
  });

  it('takes the BEST score for a stage, not the mean', () => {
    // The retake rule. Averaging 20 and 80 gives 50 and silently makes the second attempt worthless.
    expect(bestScoreFor('assignment', [evalFor('assignment', 20), evalFor('assignment', 80)])).toBe(80);
  });

  it('ignores unscored evaluations rather than letting them drag a stage down', () => {
    expect(bestScoreFor('assignment', [evalFor('assignment', 70), evalFor('assignment', null)])).toBe(70);
  });

  it('ignores evaluations belonging to another stage', () => {
    expect(bestScoreFor('assignment', [evalFor('interview', 99)])).toBeNull();
  });

  it('is null when nothing is scored', () => {
    expect(bestScoreFor('assignment', [])).toBeNull();
  });
});

describe('decideAdvance', () => {
  it('lets a fresh application enter its first stage', () => {
    expect(decideAdvance(P, [], [], 'application', false).ok).toBe(true);
  });

  it('refuses to resume a CLOSED application', () => {
    const d = decideAdvance(P, [], [], 'application', true);
    expect(d.ok).toBe(false);
    expect(d.outcome).toBe('application_closed');
  });

  it('refuses a stage that is not on the pipeline', () => {
    expect(decideAdvance(P, [], [], 'not_a_stage', false).outcome).toBe('unknown_stage');
  });

  it('refuses a stage that has already been cleared', () => {
    const d = decideAdvance(P, prog([['application', 'passed']]), [], 'application', false);
    expect(d.outcome).toBe('already_final');
  });

  it('refuses a jump to the end of the pipeline', () => {
    // The whole point of the ladder: one click must not skip every check.
    const d = decideAdvance(P, [], [], 'decision', false);
    expect(d.ok).toBe(false);
    expect(['out_of_order', 'prior_stage_incomplete']).toContain(d.outcome);
  });

  it('refuses while a REQUIRED prior stage is still open', () => {
    const d = decideAdvance(P, prog([['application', 'in_progress']]), [], 'screening', false);
    expect(d.ok).toBe(false);
    expect(d.outcome).toBe('prior_stage_incomplete');
  });

  it('refuses while a prior stage stands FAILED, and says so distinctly', () => {
    const d = decideAdvance(P, prog([['application', 'failed']]), [], 'screening', false);
    expect(d.ok).toBe(false);
    expect(d.outcome).toBe('prior_stage_incomplete');
    expect(d.message).toMatch(/not cleared/i);
  });

  it('allows an OPTIONAL stage to be passed over entirely', () => {
    // assignment (3) and assessment (4) are optional, so a cleared screening reaches interview (5).
    const d = decideAdvance(P, prog([['application', 'passed'], ['screening', 'passed']]), [], 'interview', false);
    expect(d.ok).toBe(true);
  });

  it('still refuses to skip a REQUIRED stage even when optional ones lie between', () => {
    const d = decideAdvance(P, prog([['application', 'passed'], ['screening', 'passed']]), [], 'decision', false);
    expect(d.ok).toBe(false);
  });

  it('treats an explicitly waived stage as cleared', () => {
    const d = decideAdvance(
      P,
      prog([['application', 'passed'], ['screening', 'passed'], ['assignment', 'skipped'], ['assessment', 'skipped']]),
      [], 'interview', false,
    );
    expect(d.ok).toBe(true);
  });

  it('walks the whole ladder in order', () => {
    const done: [string, StageStatus][] = [];
    for (const s of DEFAULT_STAGES) {
      const d = decideAdvance(P, prog(done), [], s.key, false);
      expect(d.ok, `should be able to enter ${s.key}`).toBe(true);
      done.push([s.key, 'passed']);
    }
  });
});

describe('decidePass', () => {
  it('clears a stage that carries no pass mark', () => {
    expect(decidePass(P, [], 'screening').ok).toBe(true);
  });

  it('refuses a stage with a pass mark when NOTHING has been scored', () => {
    // Silence is not evidence.
    const d = decidePass(P, [], 'assignment');
    expect(d.ok).toBe(false);
    expect(d.outcome).toBe('score_below_threshold');
    expect(d.message).toMatch(/nothing has been scored/i);
  });

  it('refuses a score below the mark', () => {
    expect(decidePass(P, [evalFor('assignment', 59)], 'assignment').ok).toBe(false);
  });

  it('clears a score EXACTLY at the mark', () => {
    // The boundary. A pass mark of 60 means 60 passes.
    expect(decidePass(P, [evalFor('assignment', 60)], 'assignment').ok).toBe(true);
  });

  it('clears a score above the mark and reports it', () => {
    const d = decidePass(P, [evalFor('assignment', 88)], 'assignment');
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/88\.0%/);
  });

  it('uses the BEST attempt against the mark', () => {
    expect(decidePass(P, [evalFor('assignment', 10), evalFor('assignment', 75)], 'assignment').ok).toBe(true);
  });

  it('refuses a stage that is not on the pipeline', () => {
    expect(decidePass(P, [], 'not_a_stage').outcome).toBe('unknown_stage');
  });

  it('does not let a corrupt denominator clear a threshold', () => {
    // maxScore 0 makes the percentage unreadable; that must read as no score, not as a pass.
    expect(decidePass(P, [evalFor('assignment', 999, 0)], 'assignment').ok).toBe(false);
  });
});

describe('completion', () => {
  it('counts passed and skipped as done', () => {
    const c = completion(P, prog([['application', 'passed'], ['screening', 'skipped'], ['assignment', 'in_progress']]));
    expect(c.done).toBe(2);
    expect(c.total).toBe(7);
    expect(c.percent).toBe(29);
  });

  it('does not divide by zero on an empty pipeline', () => {
    expect(completion([], [])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it('reaches 100 when every stage is cleared', () => {
    expect(completion(P, prog(DEFAULT_STAGES.map((s) => [s.key, 'passed' as StageStatus]))).percent).toBe(100);
  });
});

describe('history reduces to where the application actually stands', () => {
  it('takes the NEWEST entry for a stage that was worked twice', () => {
    const history: ApplicationStage[] = [
      row({ stageKey: 'assignment', ordinal: 3, enteredAt: '2026-06-01T00:00:00Z', outcome: 'fail', completedAt: '2026-06-02T00:00:00Z' }),
      row({ stageKey: 'assignment', ordinal: 3, enteredAt: '2026-06-10T00:00:00Z', outcome: 'pass', completedAt: '2026-06-11T00:00:00Z' }),
    ];
    const latest = latestPerStage(history);
    expect(latest).toHaveLength(1);
    expect(latest[0].outcome).toBe('pass');
    expect(progressFromHistory(history)[0].status).toBe('passed');
  });

  it('sorts by ordinal, not by when rows happened to be written', () => {
    const history: ApplicationStage[] = [
      row({ stageKey: 'interview', ordinal: 5 }),
      row({ stageKey: 'application', ordinal: 1 }),
    ];
    expect(latestPerStage(history).map((r) => r.stageKey)).toEqual(['application', 'interview']);
  });

  it('sorts an unreadable entered_at oldest instead of throwing the reduction off', () => {
    const history: ApplicationStage[] = [
      row({ stageKey: 'assignment', ordinal: 3, enteredAt: 'not-a-date', outcome: 'fail', completedAt: 'x' }),
      row({ stageKey: 'assignment', ordinal: 3, enteredAt: '2026-06-10T00:00:00Z', outcome: 'pass', completedAt: 'y' }),
    ];
    expect(latestPerStage(history)[0].outcome).toBe('pass');
  });

  it('derives an in-progress stage from a row with neither outcome nor completion', () => {
    expect(progressFromHistory([row({ stageKey: 'screening', ordinal: 2 })])[0].status).toBe('in_progress');
  });

  it('is empty for an application that has entered nothing', () => {
    expect(progressFromHistory([])).toEqual([]);
  });
});
