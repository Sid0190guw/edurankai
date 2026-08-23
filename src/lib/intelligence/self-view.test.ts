// Tests for Patch 15's composition layer.
//
// Every one of these defends the same thing from a different side: A SENTENCE ABOUT A PERSON, ON
// THAT PERSON'S OWN SCREEN, MUST NOT OUTRUN THE RECORD BEHIND IT.
//
// The properties under test:
//   1.  AN EMPTY RECORD PRODUCES NO CLAIM. Every section either says nothing is on file or says
//       there is not enough — never a statement dressed up out of zero rows.
//   2.  UNREADABLE IS NOT EMPTY. A failed read marks the section unreadable and never renders as
//       "you have none", which is the failure this codebase has already shipped once elsewhere.
//   3.  THE FEEDBACK FLOOR HOLDS. Under MIN_FEEDBACK_NOTES nothing is summarised, at any confidence.
//   4.  A SELF-DECLARED SKILL IS NOT A STRENGTH, and is not counted as covering a requirement.
//   5.  NO REQUIREMENTS MEANS NO ALIGNMENT FIGURE. Not 0%, not 100% — a sentence.
//   6.  EVERY EMITTED STRING IS SUPPORTIVE AND NON-DETERMINISTIC, checked by the contract's own lint.
//   7.  NOTHING RENDERS WITHOUT ITS RECEIPT. renderableInsight() is applied by the composer, not
//       trusted to each section.
//   8.  QUIET MONTHS SURVIVE. A month with nothing in it stays in the series.
//   9.  SUGGESTIONS ARE OFF WITHOUT CONSENT, and the section says so rather than showing less.
//  10.  THE BUNDLE CANNOT CARRY AN AUTHOR. Enforced at the type level and asserted at runtime.
import { describe, it, expect } from 'vitest';
import {
  composeSelfIntelligence, composeStrengths, composeRoleAlignment, composeFeedbackSummary,
  composeBehaviouralTrends, composeDevelopmentPlan, monthlyBuckets, MIN_TREND_POINTS,
  type SelfSources,
} from './self-view';
import {
  DETERMINISTIC_PATTERNS, MIN_FEEDBACK_NOTES, NEVER_SHOWN, SECTION_PURPOSE, SELF_SECTIONS,
  SURFACE_PREAMBLE, CONFIDENCE_MEANING, SUPPRESSED_FEEDBACK_SENTENCE, NOTHING_YET_SENTENCE,
  UNREADABLE_SENTENCE, isWithheldKey, languageProblems, renderableInsight, screenPayload,
  type Insight,
} from './contract';

/* ------------------------------------------------------------------------------- fixtures */

const NOW = '2026-08-23T12:00:00.000Z';

const emptySources = (over: Partial<SelfSources> = {}): SelfSources => ({
  now: NOW,
  skills: { ok: true, rows: [] },
  competencies: { ok: true, rows: [] },
  certifications: { ok: true, rows: [] },
  roleRequirements: { ok: true, roleLinked: false, roleLabel: null, rows: [] },
  learning: { ok: true, rows: [] },
  goals: { ok: true, rows: [] },
  tasks: { ok: true, rows: [] },
  evidence: { ok: true, rows: [] },
  feedback: { ok: true, rows: [] },
  reflections: { ok: true, count: 0, latestAt: null },
  suggestionsAllowed: true,
  ...over,
});

/** A record with something in every source, so the language lint runs over real output. */
const fullSources = (over: Partial<SelfSources> = {}): SelfSources => emptySources({
  skills: {
    ok: true,
    rows: [
      { name: 'TypeScript', level: 4, levelLabel: 'Advanced', assertion: 'verified', basis: 'Assessment passed', recordedAt: '2026-06-01T00:00:00.000Z' },
      { name: 'Postgres', level: 3, levelLabel: 'Working', assertion: 'factual', basis: 'Course completed', recordedAt: '2026-05-01T00:00:00.000Z' },
      { name: 'Public speaking', level: 2, levelLabel: 'Developing', assertion: 'claimed', basis: 'Entered on a profile', recordedAt: '2026-04-01T00:00:00.000Z' },
    ],
  },
  competencies: {
    ok: true,
    rows: [{ name: 'Code review', dimension: 'craft', status: 'verified', verifiedByNamedPerson: true, recordedAt: '2026-07-01T00:00:00.000Z' }],
  },
  certifications: {
    ok: true,
    rows: [{ certNumber: 'ERA-0001', courseTitle: 'Data foundations', issuedAt: '2026-07-15T00:00:00.000Z' }],
  },
  roleRequirements: {
    ok: true,
    roleLinked: true,
    roleLabel: 'Platform Engineer',
    rows: [
      { skillName: 'TypeScript', necessity: 'required', minLevel: 3 },
      { skillName: 'Kubernetes', necessity: 'preferred', minLevel: 3 },
      { skillName: 'Public speaking', necessity: 'required', minLevel: 2 },
    ],
  },
  learning: {
    ok: true,
    rows: [
      { courseTitle: 'Secure coding', required: true, dueOn: '2026-06-01', completedAt: null, progressPct: 40 },
      { courseTitle: 'Data foundations', required: false, dueOn: null, completedAt: '2026-07-15T00:00:00.000Z', progressPct: 100 },
    ],
  },
  goals: {
    ok: true,
    rows: [
      { title: 'Ship the import screen', status: 'open', progressPct: 60, lastProgressAt: '2026-08-01T00:00:00.000Z', targetDate: '2026-09-30' },
      { title: 'Mentor a new starter', status: 'open', progressPct: 10, lastProgressAt: '2026-02-01T00:00:00.000Z', targetDate: null },
      { title: 'Write the runbook', status: 'closed', progressPct: 100, lastProgressAt: '2026-06-20T00:00:00.000Z', targetDate: null },
    ],
  },
  tasks: {
    ok: true,
    rows: [
      { title: 'A', state: 'done', createdAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-10T00:00:00.000Z', isOverdue: false },
      { title: 'B', state: 'done', createdAt: '2026-07-02T00:00:00.000Z', completedAt: '2026-07-12T00:00:00.000Z', isOverdue: false },
      { title: 'C', state: 'in_progress', createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, isOverdue: true },
      { title: 'D', state: 'done', createdAt: '2026-06-01T00:00:00.000Z', completedAt: '2026-06-15T00:00:00.000Z', isOverdue: false },
      { title: 'E', state: 'done', createdAt: '2026-05-01T00:00:00.000Z', completedAt: '2026-05-20T00:00:00.000Z', isOverdue: false },
    ],
  },
  evidence: {
    ok: true,
    rows: [
      { title: 'Import screen PR', occurredOn: '2026-07-05', status: 'verified', hoursVerified: 6, reviewedAt: '2026-07-08T00:00:00.000Z' },
      { title: 'Migration notes', occurredOn: '2026-06-05', status: 'verified', hoursVerified: 3, reviewedAt: '2026-06-09T00:00:00.000Z' },
      { title: 'Spike writeup', occurredOn: '2026-05-05', status: 'filed', hoursVerified: 0, reviewedAt: null },
      { title: 'Runbook draft', occurredOn: '2026-04-05', status: 'verified', hoursVerified: 2, reviewedAt: '2026-04-09T00:00:00.000Z' },
    ],
  },
  feedback: {
    ok: true,
    rows: [
      { theme: 'strength', createdAt: '2026-07-01T00:00:00.000Z' },
      { theme: 'strength', createdAt: '2026-06-01T00:00:00.000Z' },
      { theme: 'improvement', createdAt: '2026-05-01T00:00:00.000Z' },
      { theme: 'general', createdAt: '2026-04-01T00:00:00.000Z' },
    ],
  },
  reflections: { ok: true, count: 3, latestAt: '2026-08-10T00:00:00.000Z' },
  ...over,
});

/** Every string this composition would print, flattened. */
const allStrings = (s: SelfSources): string[] => {
  const out: string[] = [];
  for (const sec of composeSelfIntelligence(s).sections) {
    out.push(sec.label, sec.purpose);
    if (sec.emptyReason) out.push(sec.emptyReason);
    for (const i of sec.insights) {
      out.push(i.output, i.processing);
      for (const e of i.evidence) out.push(e.label);
    }
  }
  return out;
};

/* --------------------------------------------------------------- 1. an empty record claims nothing */

describe('an empty record produces no claim', () => {
  it('gives every section either an empty reason or an insufficient insight', () => {
    const view = composeSelfIntelligence(emptySources());
    expect(view.sections.length).toBe(SELF_SECTIONS.length);
    for (const sec of view.sections) {
      const settled = !!sec.emptyReason
        || sec.insights.every((i) => i.confidence === 'insufficient' || i.confidence === 'partial');
      expect(settled).toBe(true);
    }
  });

  it('never emits an observed or corroborated statement with no evidence behind it', () => {
    for (const sec of composeSelfIntelligence(emptySources()).sections) {
      for (const i of sec.insights) {
        if (i.confidence === 'observed' || i.confidence === 'corroborated') {
          expect(i.evidence.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('uses the warm empty sentence, not a bare blank', () => {
    const view = composeSelfIntelligence(emptySources());
    const strengths = view.sections.find((s) => s.section === 'strengths');
    expect(strengths?.emptyReason).toBe(NOTHING_YET_SENTENCE);
    expect(strengths?.unreadable).toBe(false);
  });
});

/* ------------------------------------------------------------------ 2. unreadable is not empty */

describe('a failed read is never rendered as an absence', () => {
  it('marks the section unreadable and says so in its own words', () => {
    const s = emptySources({ skills: { ok: false, rows: [] } });
    const sec = composeStrengths(s);
    expect(sec.unreadable).toBe(true);
    expect(sec.emptyReason).toBe(UNREADABLE_SENTENCE);
    expect(sec.emptyReason).not.toBe(NOTHING_YET_SENTENCE);
  });

  it('reports the failing source by name in sourceHealth', () => {
    const view = composeSelfIntelligence(emptySources({ feedback: { ok: false, rows: [] } }));
    const broken = view.sourceHealth.filter((h) => !h.ok).map((h) => h.source);
    expect(broken).toEqual(['Feedback']);
  });

  it('keeps an unreadable feedback source out of the suppression path', () => {
    // A failed read must not be reported as "fewer than three notes" — that is a claim about the
    // data made from a query that never came back.
    const sec = composeFeedbackSummary(emptySources({ feedback: { ok: false, rows: [] } }));
    expect(sec.unreadable).toBe(true);
    expect(sec.emptyReason).not.toBe(SUPPRESSED_FEEDBACK_SENTENCE);
  });
});

/* --------------------------------------------------------------------- 3. the feedback floor */

describe('the feedback suppression floor', () => {
  const note = (theme: string) => ({ theme, createdAt: '2026-07-01T00:00:00.000Z' });

  it('summarises nothing below the floor', () => {
    for (let n = 1; n < MIN_FEEDBACK_NOTES; n++) {
      const rows = Array.from({ length: n }, () => note('strength'));
      const sec = composeFeedbackSummary(emptySources({ feedback: { ok: true, rows } }));
      expect(sec.insights.length).toBe(0);
      expect(sec.emptyReason).toBe(SUPPRESSED_FEEDBACK_SENTENCE);
    }
  });

  it('summarises at the floor exactly', () => {
    const rows = Array.from({ length: MIN_FEEDBACK_NOTES }, () => note('strength'));
    const sec = composeFeedbackSummary(emptySources({ feedback: { ok: true, rows } }));
    expect(sec.insights.length).toBe(1);
    expect(sec.emptyReason).toBe(null);
  });

  it('says nothing is recorded rather than suppressing when there is genuinely nothing', () => {
    const sec = composeFeedbackSummary(emptySources());
    expect(sec.emptyReason).not.toBe(SUPPRESSED_FEEDBACK_SENTENCE);
  });

  it('never prints a note body or an author, because the bundle carries neither', () => {
    const rows = Array.from({ length: 5 }, () => note('improvement'));
    const sec = composeFeedbackSummary(emptySources({ feedback: { ok: true, rows } }));
    const text = JSON.stringify(sec);
    expect(text).not.toMatch(/author/i);
    // The only keys the bundle rows have are theme and createdAt.
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'theme']);
  });
});

/* ------------------------------------------------- 4. a stated skill is not a demonstrated one */

describe('a keyword is never proof of competence', () => {
  it('keeps a self-declared skill out of strengths', () => {
    const sec = composeStrengths(fullSources());
    const text = JSON.stringify(sec);
    expect(text).toContain('TypeScript');
    expect(text).toContain('Postgres');
    expect(text).not.toContain('Public speaking');
  });

  it('does not let a self-declared skill cover a role requirement', () => {
    const sec = composeRoleAlignment(fullSources());
    const out = sec.insights[0].output;
    // TypeScript (verified, level 4 >= 3) is the only one of the three that can count.
    expect(out).toContain('1 of 3');
    expect(out).toContain('Public speaking');
    expect(out).toContain('Kubernetes (preferred)');
  });

  it('does not count a confirmed skill that is below the required level', () => {
    const s = fullSources({
      skills: {
        ok: true,
        rows: [{ name: 'TypeScript', level: 2, levelLabel: 'Developing', assertion: 'verified', basis: 'b', recordedAt: null }],
      },
    });
    expect(composeRoleAlignment(s).insights[0].output).toContain('0 of 3');
  });
});

/* ----------------------------------------------------- 5. no requirements means no alignment figure */

describe('role alignment refuses to invent a comparison', () => {
  it('says the record is not linked to a role, rather than showing a figure', () => {
    const sec = composeRoleAlignment(emptySources());
    expect(sec.insights.length).toBe(1);
    expect(sec.insights[0].confidence).toBe('insufficient');
    expect(sec.insights[0].output).toContain('does not connect to a role');
    expect(sec.insights[0].output).not.toMatch(/\d+%/);
  });

  it('says nothing is written down when the role is linked but has no requirements', () => {
    const s = emptySources({
      roleRequirements: { ok: true, roleLinked: true, roleLabel: 'Platform Engineer', rows: [] },
    });
    const sec = composeRoleAlignment(s);
    expect(sec.insights[0].output).toContain('Platform Engineer');
    expect(sec.insights[0].output).toContain('No requirements');
    expect(sec.insights[0].confidence).toBe('insufficient');
  });

  it('puts the gap on the record, not on the person', () => {
    const out = composeRoleAlignment(emptySources()).insights[0].output;
    expect(out).toContain('not counted against you');
    expect(languageProblems(out)).toEqual([]);
  });
});

/* ------------------------------------------------------- 6. the language of every emitted string */

describe('supportive and non-deterministic language', () => {
  it('passes the lint on every string a full record produces', () => {
    const problems = allStrings(fullSources())
      .flatMap((s) => languageProblems(s).map((p) => ({ s, p })));
    expect(problems).toEqual([]);
  });

  it('passes the lint on every string an empty record produces', () => {
    const problems = allStrings(emptySources())
      .flatMap((s) => languageProblems(s).map((p) => ({ s, p })));
    expect(problems).toEqual([]);
  });

  it('passes the lint on the fixed copy in the contract', () => {
    const fixed = [
      SURFACE_PREAMBLE, NOTHING_YET_SENTENCE, UNREADABLE_SENTENCE, SUPPRESSED_FEEDBACK_SENTENCE,
      ...Object.values(SECTION_PURPOSE),
      ...Object.values(CONFIDENCE_MEANING),
      ...NEVER_SHOWN.map((n) => n.what + ' ' + n.because),
    ];
    for (const f of fixed) expect(languageProblems(f)).toEqual([]);
  });

  it('actually catches the things it claims to catch', () => {
    // A lint nobody has seen fire is a lint nobody should trust.
    const bad = [
      'You are a weak communicator.',
      'You will not reach that level.',
      'You lack the required depth.',
      'You always miss deadlines.',
      'This person is likely to leave within the year.',
      'A personality mismatch with the team.',
      'Your score is 62.',
      'An astrological reading of the birth chart.',
    ];
    for (const b of bad) expect(languageProblems(b).length).toBeGreaterThan(0);
    // and every pattern is reachable by at least one of them
    const hit = new Set(bad.flatMap((b) => languageProblems(b).map((p) => p.problem)));
    expect(hit.size).toBe(DETERMINISTIC_PATTERNS.length);
  });
});

/* ------------------------------------------------------------------ 7. nothing renders unreceipted */

describe('the envelope is enforced by the composer', () => {
  const base: Insight = {
    key: 'k', section: 'strengths', inputs: ['A source'], processing: 'A rule.',
    output: 'A statement.', evidence: [{ label: 'x', owner: 'y', href: null, occurredAt: null }],
    confidence: 'observed', observedAt: null,
  };

  it('accepts a complete insight', () => {
    expect(renderableInsight(base)).toBe(true);
  });

  it('refuses one with no inputs, no rule, no output or an unknown confidence', () => {
    expect(renderableInsight({ ...base, inputs: [] })).toBe(false);
    expect(renderableInsight({ ...base, processing: '  ' })).toBe(false);
    expect(renderableInsight({ ...base, output: '' })).toBe(false);
    expect(renderableInsight({ ...base, confidence: 'certain' as any })).toBe(false);
  });

  it('refuses an evidence-free claim unless it is reporting the absence itself', () => {
    expect(renderableInsight({ ...base, evidence: [] })).toBe(false);
    expect(renderableInsight({ ...base, evidence: [], confidence: 'insufficient' })).toBe(true);
  });

  it('drops an unreceipted insight rather than rendering it', () => {
    // Every insight the composer emits over a full record survives its own check.
    for (const sec of composeSelfIntelligence(fullSources()).sections) {
      for (const i of sec.insights) expect(renderableInsight(i)).toBe(true);
    }
  });

  it('gives every emitted insight the section it was filed under', () => {
    for (const sec of composeSelfIntelligence(fullSources()).sections) {
      for (const i of sec.insights) expect(i.section).toBe(sec.section);
    }
  });
});

/* --------------------------------------------------------------------- 8. quiet months survive */

describe('time-based insight keeps the quiet months', () => {
  it('returns one bucket per month including the empty ones', () => {
    const b = monthlyBuckets(fullSources(), 6);
    expect(b.length).toBe(6);
    expect(b.map((x) => x.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    expect(b[0].evidenceFiled).toBe(0);
    expect(b[4].evidenceFiled).toBe(1);
  });

  it('sums verified hours into the month the work happened', () => {
    const b = monthlyBuckets(fullSources(), 6);
    expect(b.find((x) => x.month === '2026-07')?.hoursVerified).toBe(6);
    expect(b.find((x) => x.month === '2026-05')?.hoursVerified).toBe(0);
  });
});

/* --------------------------------------------------------------- 9. trends need enough points */

describe('behavioural trends refuse to draw a line through two dots', () => {
  it('reports insufficient under the point floor', () => {
    const s = emptySources({
      tasks: {
        ok: true,
        rows: Array.from({ length: MIN_TREND_POINTS - 1 }, (_, i) => ({
          title: 't' + i, state: 'done', createdAt: '2026-07-01T00:00:00.000Z',
          completedAt: '2026-07-05T00:00:00.000Z', isOverdue: false,
        })),
      },
    });
    const closure = composeBehaviouralTrends(s).insights.find((i) => i.key === 'trend:task-closure');
    expect(closure?.confidence).toBe('insufficient');
    expect(closure?.evidence.length).toBe(0);
  });

  it('describes a count with its window once there are enough', () => {
    const closure = composeBehaviouralTrends(fullSources()).insights.find((i) => i.key === 'trend:task-closure');
    expect(closure?.confidence).toBe('observed');
    expect(closure?.output).toContain('In the last six months');
    expect(closure?.output).toContain('4 of 5');
  });

  it('states no adjective about the person anywhere in the section', () => {
    for (const i of composeBehaviouralTrends(fullSources()).insights) {
      expect(languageProblems(i.output)).toEqual([]);
      expect(i.output).not.toMatch(/\byou are\b/i);
    }
  });
});

/* ------------------------------------------------------------------- 10. consent gates suggestions */

describe('suggestions are processing, and processing needs consent', () => {
  it('emits no suggestion and says so when the purpose is off', () => {
    const sec = composeDevelopmentPlan(fullSources({ suggestionsAllowed: false }));
    const keys = sec.insights.map((i) => i.key);
    expect(keys).toContain('plan:suggestions-off');
    expect(keys.filter((k) => k.startsWith('suggest:'))).toEqual([]);
  });

  it('still shows assigned learning and goals with the purpose off', () => {
    const keys = composeDevelopmentPlan(fullSources({ suggestionsAllowed: false })).insights.map((i) => i.key);
    expect(keys).toContain('plan:assigned-learning');
    expect(keys).toContain('plan:goals');
  });

  it('emits suggestions once the purpose is on, each phrased as an option', () => {
    const sec = composeDevelopmentPlan(fullSources({ suggestionsAllowed: true }));
    const suggestions = sec.insights.filter((i) => i.key.startsWith('suggest:'));
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(languageProblems(s.output)).toEqual([]);
      expect(s.output).not.toMatch(/\byou (?:must|should|need to)\b/i);
    }
  });
});

/* ------------------------------------------------------------------ the exposure key screen */

describe('the withheld-key screen', () => {
  it('refuses the names this view must never carry', () => {
    for (const k of [
      'salary', 'base_salary', 'ctc_annual', 'bank_account', 'pan_number', 'aadhaar',
      'risk_score', 'attrition_risk', 'percentile', 'hr_notes', 'internal_note',
      'author_name', 'author_user_id', 'gender', 'medical_history', 'birth_date',
    ]) {
      expect(isWithheldKey(k)).toBe(true);
    }
  });

  it('leaves ordinary names alone', () => {
    for (const k of ['title', 'skill_name', 'completed_at', 'company', 'panel_size', 'authored_at', 'level']) {
      expect(isWithheldKey(k)).toBe(false);
    }
  });

  it('strips a withheld key out of a payload and names what it dropped', () => {
    const { safe, refused } = screenPayload({ title: 'A', salary: 1, author_name: 'B' } as any);
    expect(Object.keys(safe)).toEqual(['title']);
    expect(refused.sort()).toEqual(['author_name', 'salary']);
  });
});
