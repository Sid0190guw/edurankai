// src/lib/hr-intelligence/access.test.ts — THE GATE, TESTED BY TRYING TO GET THROUGH IT.
//
// The database is mocked, not reached. resolveHrIntelAccess() touches it only through
// canSeePerformanceOf(), which is the Organization Graph's question and belongs to another module;
// mocking that boundary is what makes the AUTHORIZATION decisions testable on their own, which is
// the point of the three layers being separate in the first place.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seesPerformanceOf = vi.fn(async () => false);

vi.mock('@/lib/performance-scope', () => ({
  canSeePerformanceOf: (...args: any[]) => seesPerformanceOf(...(args as [])),
}));

vi.mock('@/lib/db', () => ({ db: { execute: async () => [] } }));
vi.mock('@/lib/logger', () => ({ logEvent: () => {} }));
vi.mock('@/lib/hr-intelligence/schema', () => ({
  ensureHrIntelSchema: async () => ({ ok: false, tables: [], accessLogAppendOnly: false, accessLogNote: '', error: 'mocked away', checkedAt: '' }),
}));

const {
  resolveHrIntelAccess,
  recordAccess,
  registerConsentReader,
  clearConsentReader,
  HR_DESK,
  PERSON_360,
  FOUNDATIONAL,
  LEARNING_ASSIGN,
  ROLES_VIEW,
  PERF_MANAGE,
} = await import('./access');

const SUBJECT = '11111111-1111-4111-8111-111111111111';

const viewer: any = {
  userId: '22222222-2222-4222-8222-222222222222',
  employeeId: '33333333-3333-4333-8333-333333333333',
  fullName: 'A Viewer',
  departmentId: null,
  initialized: true,
  managesOrg: false,
  reports: [],
  reportIds: [],
  reviewSubjects: [],
  kind: 'none',
  explanation: '',
};

/** A capability test built from a list, the way composeWorkspace().holds behaves. */
const holding = (...keys: string[]) => (k: string) => keys.indexOf(k) >= 0 || keys.indexOf('*') >= 0;

const open = (holds: (k: string) => boolean, over: any = {}) =>
  resolveHrIntelAccess({
    viewer,
    subjectEmployeeId: SUBJECT,
    holds,
    purpose: 'Preparing a development conversation.',
    ...over,
  });

beforeEach(() => {
  seesPerformanceOf.mockReset();
  seesPerformanceOf.mockResolvedValue(false);
  clearConsentReader();
});

// =================================================================================================
// THE DOOR
// =================================================================================================

describe('who may open it at all', () => {
  it('refuses somebody holding nothing, and reads nothing', async () => {
    const a = await open(holding());
    expect(a.mayOpen).toBe(false);
    expect(a.granted).toEqual([]);
    expect(a.grantedActions).toEqual([]);
    expect(a.sentence).toContain(HR_DESK);
  });

  it('opens for the people desk key', async () => {
    const a = await open(holding(HR_DESK));
    expect(a.mayOpen).toBe(true);
    expect(a.capabilityUsed).toBe(HR_DESK);
  });

  it('opens for the assembled-record key', async () => {
    const a = await open(holding(PERSON_360));
    expect(a.mayOpen).toBe(true);
    expect(a.capabilityUsed).toBe(PERSON_360);
  });

  // THE ONE THAT MATTERS MOST. A reporting line is Patch 14's door, not this one.
  it('does NOT open for a reporting manager who holds neither key', async () => {
    seesPerformanceOf.mockResolvedValue(true);
    const a = await open(holding());
    expect(a.mayOpen).toBe(false);
    expect(a.sentence).toMatch(/does not open the people desk's development record/i);
  });

  it('does NOT open for the subject themselves, and says where their own record is', async () => {
    const a = await resolveHrIntelAccess({
      viewer: { ...viewer, employeeId: SUBJECT },
      subjectEmployeeId: SUBJECT,
      holds: holding(),
      purpose: 'Curiosity.',
    });
    expect(a.mayOpen).toBe(false);
    expect(a.sentence).toMatch(/lives on your portal/i);
  });

  it('never asks the org graph about somebody looking at their own record', async () => {
    await resolveHrIntelAccess({
      viewer: { ...viewer, employeeId: SUBJECT },
      subjectEmployeeId: SUBJECT,
      holds: holding(HR_DESK),
      purpose: 'p',
    });
    expect(seesPerformanceOf).not.toHaveBeenCalled();
  });

  it('treats a throwing capability test as holding nothing', async () => {
    const a = await open(() => { throw new Error('registry down'); });
    expect(a.mayOpen).toBe(false);
  });

  it('survives an org graph that throws, and denies the relationship rather than granting it', async () => {
    seesPerformanceOf.mockRejectedValue(new Error('graph down'));
    const a = await open(holding(PERSON_360));
    expect(a.mayOpen).toBe(true);
    expect(a.granted).not.toContain('interventions');
  });
});

// =================================================================================================
// SECTIONS
// =================================================================================================

describe('what each key actually opens', () => {
  it('gives the people desk every section', async () => {
    const a = await open(holding(HR_DESK, ROLES_VIEW));
    expect(a.withheld).toEqual([]);
    expect(a.granted.length).toBe(10);
  });

  it('gives the assembled-record key the person-level sections but not the desk-only ones', async () => {
    const a = await open(holding(PERSON_360));
    expect(a.granted).toContain('role_status');
    expect(a.granted).toContain('development_needs');
    expect(a.granted).toContain('training');
    expect(a.granted).toContain('behaviour_trends');
    // Interventions and the department view are the people desk's own record.
    expect(a.granted).not.toContain('interventions');
    expect(a.granted).not.toContain('org_development');
    expect(a.granted).not.toContain('feedback');
  });

  it('opens the performance-backed sections for the appraisal key', async () => {
    const a = await open(holding(PERSON_360, PERF_MANAGE));
    expect(a.granted).toContain('feedback');
    expect(a.granted).toContain('promotion_readiness');
  });

  it('opens them for a reporting relationship too, resolved per row', async () => {
    seesPerformanceOf.mockResolvedValue(true);
    const a = await open(holding(PERSON_360));
    expect(a.granted).toContain('feedback');
    expect(a.granted).toContain('promotion_readiness');
    expect(a.granted).toContain('skill_gaps');
  });

  it('names every withheld section rather than dropping it silently', async () => {
    const a = await open(holding(PERSON_360));
    expect(a.withheld.length).toBeGreaterThan(0);
    for (const w of a.withheld) {
      expect(w.because).toMatch(/withheld/i);
      expect(w.because).toMatch(/never issued/i);
    }
  });

  it('mentions an uninitialised org graph, so an empty graph is not read as having no relationship', async () => {
    const a = await resolveHrIntelAccess({
      viewer: { ...viewer, initialized: false },
      subjectEmployeeId: SUBJECT,
      holds: holding(PERSON_360),
      purpose: 'p',
    });
    const withheld = a.withheld.find((w) => w.section === 'feedback');
    expect(withheld?.because).toMatch(/has not been set up yet/i);
  });
});

// =================================================================================================
// ACTIONS ASK THE OWNING MODULE'S KEY
// =================================================================================================

describe('actions', () => {
  it('does not grant training assignment on the strength of the people desk key', async () => {
    const a = await open(holding(HR_DESK));
    expect(a.grantedActions).not.toContain('assign_training');
    expect(a.grantedActions).not.toContain('schedule_review');
    const denied = a.actions.find((x) => x.kind === 'assign_training');
    expect(denied?.because).toContain(LEARNING_ASSIGN);
  });

  it('grants it on the learning module\'s own key', async () => {
    const a = await open(holding(HR_DESK, LEARNING_ASSIGN));
    expect(a.grantedActions).toContain('assign_training');
    expect(a.grantedActions).toContain('schedule_review');
  });

  it('needs both the people desk and the role catalogue to open a mobility review', async () => {
    expect((await open(holding(HR_DESK))).grantedActions).not.toContain('initiate_mobility_review');
    expect((await open(holding(ROLES_VIEW))).grantedActions).not.toContain('initiate_mobility_review');
    expect((await open(holding(HR_DESK, ROLES_VIEW))).grantedActions).toContain('initiate_mobility_review');
  });

  it('grants no action at all to somebody who cannot open the record', async () => {
    const a = await open(holding(LEARNING_ASSIGN));
    expect(a.mayOpen).toBe(false);
    expect(a.grantedActions).toEqual([]);
  });

  it('gives every refused action a reason naming what is missing', async () => {
    const a = await open(holding(PERSON_360));
    for (const action of a.actions.filter((x) => !x.granted)) {
      expect(action.because.length).toBeGreaterThan(10);
    }
  });
});

// =================================================================================================
// THE DEPTH BOUNDARY — THE PATCH REQUIREMENT
// =================================================================================================

describe('foundational computation is never automatic', () => {
  it('gives the people desk actionable depth and nothing more', async () => {
    const a = await open(holding(HR_DESK));
    expect(a.depth).toBe('actionable');
    expect(a.consentRecordId).toBeNull();
  });

  it('stays actionable even when the deep key is held, unless it is asked for', async () => {
    const a = await open(holding(HR_DESK, FOUNDATIONAL));
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toMatch(/was not requested/i);
  });

  it('refuses the deep tier without the deep key, however senior the desk key is', async () => {
    const a = await open(holding(HR_DESK), { requestFoundational: true });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toContain(FOUNDATIONAL);
    expect(a.depthReason).toMatch(/does not confer it/i);
  });

  it('refuses it with the key but no stated purpose', async () => {
    const a = await open(holding(HR_DESK, FOUNDATIONAL), { requestFoundational: true, purpose: '   ' });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toMatch(/needs a stated purpose/i);
  });

  it('refuses it with the key and a purpose but no consent registry on the platform', async () => {
    const a = await open(holding(HR_DESK, FOUNDATIONAL), { requestFoundational: true });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toMatch(/no consent registry/i);
  });

  it('refuses it when a registered reader says consent is not on record', async () => {
    registerConsentReader({
      id: 'test',
      read: async () => ({ granted: false, sentence: 'This person has not consented.' }),
    });
    const a = await open(holding(HR_DESK, FOUNDATIONAL), { requestFoundational: true });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toContain('has not consented');
  });

  it('treats a consent reader that throws as consent that is not on record', async () => {
    registerConsentReader({
      id: 'test',
      read: async () => { throw new Error('consent service down'); },
    });
    const a = await open(holding(HR_DESK, FOUNDATIONAL), { requestFoundational: true });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toMatch(/treated as consent that is not on record/i);
  });

  it('grants it only when all three hold at once', async () => {
    registerConsentReader({
      id: 'test',
      read: async () => ({ granted: true, consentRecordId: 'consent-1', expiresAt: null }),
    });
    const a = await open(holding(HR_DESK, FOUNDATIONAL), { requestFoundational: true });
    expect(a.depth).toBe('foundational');
    expect(a.consentRecordId).toBe('consent-1');
  });

  it('gives a wildcard holder the deep key but still stops at consent', async () => {
    const a = await open(holding('*'), { requestFoundational: true });
    expect(a.depth).toBe('actionable');
    expect(a.depthReason).toMatch(/no consent registry/i);
  });
});

// =================================================================================================
// NO ACCESS ROW, NO VIEW
// =================================================================================================

describe('the access row', () => {
  it('refuses a read with no stated purpose, rather than defaulting one', async () => {
    const r = await recordAccess({
      viewerUserId: viewer.userId,
      viewerName: 'A Viewer',
      subjectEmployeeId: SUBJECT,
      depth: 'actionable',
      purpose: '   ',
      sectionsGranted: [],
      sectionsWithheld: [],
      capabilityUsed: HR_DESK,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/purpose is required/i);
  });

  it('refuses the read when the log cannot be prepared, and offers no unlogged fallback', async () => {
    const r = await recordAccess({
      viewerUserId: viewer.userId,
      viewerName: 'A Viewer',
      subjectEmployeeId: SUBJECT,
      depth: 'actionable',
      purpose: 'Preparing a development conversation.',
      sectionsGranted: ['role_status'],
      sectionsWithheld: [],
      capabilityUsed: HR_DESK,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not offered as a fallback/i);
  });
});
