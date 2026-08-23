// src/lib/horizon/views.test.ts — PATCH 19. FLOWS 11-15 AGAINST THE REAL HORIZON ACCESS MODEL.
//
// =================================================================================================
// WHY THIS IS A SEPARATE SUITE FROM leakage.test.ts
// =================================================================================================
//
// leakage.test.ts drives the three general authorization mechanisms this codebase already had:
// can(), holdsCapability() and the rbac grant engine. This one drives the thing HORIZON added on
// top of them — resolveHorizonAccess(), which decides the TABS of one person's intelligence record
// before a single row is read.
//
// That ordering is the property worth testing. A withheld tab in this design is not a hidden tab:
// it is a tab whose query never ran, and which says so in a sentence rather than rendering an empty
// panel that reads as "this person has nothing". Every assertion below is about that distinction.
//
// PURE. resolveHorizonAccess() takes `holds` as an argument and touches no database, no session and
// no clock, which is what makes flows 11-15 testable at all without a connection.
import { describe, it, expect } from 'vitest';

import {
  resolveHorizonAccess,
  grantOf,
  type HorizonViewer,
  type HorizonAccess,
} from '@/lib/horizon/access';

import {
  HORIZON_SECTIONS,
  PEOPLE_VIEW_360,
  EMPLOYEE_MANAGE,
  PERFORMANCE_MANAGE,
  ATTENDANCE_ROSTER_MANAGE,
  AUDIT_VIEW,
  HORIZON_BEHAVIOUR_VIEW,
  HORIZON_PERSONAL_SUMMARY_VIEW,
  HORIZON_SUSTAINABILITY_VIEW,
} from '@/lib/horizon/sections';

import { can, type Permission } from '@/lib/auth/permissions';

// -------------------------------------------------------------------------------------------------
// FIXTURES
// -------------------------------------------------------------------------------------------------

const SUBJECT = {
  employeeId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as any;

const viewer = (over: Partial<HorizonViewer> = {}): HorizonViewer => ({
  userId: '99999999-9999-4999-8999-999999999999',
  employeeId: '88888888-8888-4888-8888-888888888888',
  role: 'hr',
  name: 'A Viewer',
  ...over,
});

/** The `holds` a real admin page passes in: the compiled matrix for one role. */
const holdsForRole = (role: string) => (key: string) =>
  can({ id: 'u', role, isActive: true } as any, key as Permission);

const holdsNothing = () => false;
const holdsEverything = () => true;

const PROPOSED_CAPABILITIES = [
  HORIZON_BEHAVIOUR_VIEW,
  HORIZON_PERSONAL_SUMMARY_VIEW,
  HORIZON_SUSTAINABILITY_VIEW,
];

const sectionsNeeding = (capability: string) =>
  HORIZON_SECTIONS.filter((s) => s.capability === capability).map((s) => s.key);

// -------------------------------------------------------------------------------------------------
// THE SHAPE OF THE DECISION
// -------------------------------------------------------------------------------------------------

describe('flow 11: every section is decided before anything is read', () => {
  it('returns a grant for every declared section, and no others', () => {
    const access = resolveHorizonAccess(viewer(), SUBJECT, holdsEverything);
    expect(access.grants.length).toBe(HORIZON_SECTIONS.length);
    expect(access.grants.map((g) => g.section).sort()).toEqual(HORIZON_SECTIONS.map((s) => s.key).sort());
  });

  it('partitions every section into exactly one of granted, withheld or awaiting ratification', () => {
    for (const holds of [holdsNothing, holdsEverything, holdsForRole('hr'), holdsForRole('department_head')]) {
      const a = resolveHorizonAccess(viewer(), SUBJECT, holds);
      const total = a.granted.length + a.withheld.length + a.awaitingRatification.length;
      expect(total).toBe(HORIZON_SECTIONS.length);
      // No section may appear in two buckets.
      const seen = new Set([...a.granted, ...a.withheld, ...a.awaitingRatification]);
      expect(seen.size).toBe(HORIZON_SECTIONS.length);
    }
  });

  it('says WHY on every single grant, granted or not', () => {
    // A withheld tab that says nothing is a tab somebody reads as "empty record".
    const a = resolveHorizonAccess(viewer(), SUBJECT, holdsForRole('department_head'));
    for (const g of a.grants) {
      expect({ section: g.section, hasReason: g.because.trim().length > 0 })
        .toEqual({ section: g.section, hasReason: true });
    }
  });

  it('states that nothing was read on every withheld section', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holdsNothing);
    for (const key of a.withheld) {
      expect({ key, saysUnread: /nothing was read/i.test(grantOf(a, key).because) })
        .toEqual({ key, saysUnread: true });
    }
  });

  it('falls to withheld for a section nobody decided', () => {
    const a = resolveHorizonAccess(viewer(), SUBJECT, holdsEverything);
    const invented = grantOf({ ...a, grants: [] } as HorizonAccess, 'overview');
    expect(invented.granted).toBe(false);
    expect(invented.outcome).toBe('withheld');
  });
});

// -------------------------------------------------------------------------------------------------
// THE SAFETY PROPERTY THAT MATTERS MOST: THE UNRATIFIED TABS ARE SHUT FOR EVERYBODY
// -------------------------------------------------------------------------------------------------

describe('flows 12-13: the three unratified sections are closed to every viewer, founder included', () => {
  it('never grants a proposed-capability section, whatever the role', () => {
    for (const role of ['super_admin', 'hr', 'department_head', 'recruiter', 'applicant']) {
      const a = resolveHorizonAccess(viewer({ role }), SUBJECT, holdsForRole(role));
      for (const capability of PROPOSED_CAPABILITIES) {
        for (const key of sectionsNeeding(capability)) {
          expect({ role, key, granted: a.granted.includes(key) }).toEqual({ role, key, granted: false });
          expect({ role, key, outcome: grantOf(a, key).outcome })
            .toEqual({ role, key, outcome: 'awaiting_ratification' });
        }
      }
    }
  });

  it('marks every proposed section sensitive, so it can never be opened casually later', () => {
    for (const capability of PROPOSED_CAPABILITIES) {
      for (const key of sectionsNeeding(capability)) {
        const def = HORIZON_SECTIONS.find((s) => s.key === key);
        expect({ key, sensitive: def?.sensitive }).toEqual({ key, sensitive: true });
      }
    }
  });

  it('does not hold any proposed capability in the compiled permission matrix', () => {
    // THE SEAM. access.ts routes a section to `awaiting_ratification` because the capability is not
    // in the registry. If somebody later adds one of these keys to PERMS_BY_ROLE without also
    // reworking the section definition, three sensitive tabs open at once and nothing else notices.
    for (const capability of PROPOSED_CAPABILITIES) {
      for (const role of ['super_admin', 'hr', 'department_head', 'recruiter', 'applicant']) {
        expect({ capability, role, holds: can({ id: 'u', role, isActive: true } as any, capability as Permission) })
          .toEqual({ capability, role, holds: false });
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// FLOWS 12, 13, 14, 15 — ONE VIEWER CLASS AT A TIME
// -------------------------------------------------------------------------------------------------

describe('flow 12: the founder gets the widest view, and it is still not everything', () => {
  const a = () => resolveHorizonAccess(viewer({ role: 'super_admin' }), SUBJECT, holdsForRole('super_admin'));

  it('opens the ratified sections', () => {
    const access = a();
    expect(access.anyGranted).toBe(true);
    for (const key of sectionsNeeding(PEOPLE_VIEW_360).concat(sectionsNeeding(EMPLOYEE_MANAGE), sectionsNeeding(AUDIT_VIEW))) {
      const def = HORIZON_SECTIONS.find((s) => s.key === key);
      if (!def || def.proposed) continue;
      const holdsIt = can({ id: 'u', role: 'super_admin', isActive: true } as any, def.capability as Permission);
      expect({ key, granted: access.granted.includes(key) }).toEqual({ key, granted: holdsIt });
    }
  });

  it('is still refused the three unratified sections', () => {
    expect(a().awaitingRatification.length).toBe(
      HORIZON_SECTIONS.filter((s) => s.proposed).length,
    );
  });
});

describe('flow 13: HR gets the people sections and only those', () => {
  const access = () => resolveHorizonAccess(viewer({ role: 'hr' }), SUBJECT, holdsForRole('hr'));

  it('grants exactly the sections whose capability HR holds', () => {
    const a = access();
    for (const def of HORIZON_SECTIONS) {
      if (def.capability === null || def.proposed) continue;
      const holdsIt = can({ id: 'u', role: 'hr', isActive: true } as any, def.capability as Permission);
      expect({ key: def.key, granted: a.granted.includes(def.key) })
        .toEqual({ key: def.key, granted: holdsIt });
    }
  });

  it('withholds the audit trail from HR, because HR does not hold audit.view', () => {
    const a = access();
    for (const key of sectionsNeeding(AUDIT_VIEW)) {
      expect({ key, granted: a.granted.includes(key) }).toEqual({ key, granted: false });
    }
  });
});

describe('flow 14: a department head is not a people manager', () => {
  const access = () => resolveHorizonAccess(viewer({ role: 'department_head' }), SUBJECT, holdsForRole('department_head'));

  it('is granted no section that needs performance.manage or employee.manage', () => {
    const a = access();
    for (const capability of [PERFORMANCE_MANAGE, EMPLOYEE_MANAGE, ATTENDANCE_ROSTER_MANAGE, PEOPLE_VIEW_360]) {
      for (const key of sectionsNeeding(capability)) {
        const holdsIt = can({ id: 'u', role: 'department_head', isActive: true } as any, capability as Permission);
        expect({ capability, key, granted: a.granted.includes(key) })
          .toEqual({ capability, key, granted: holdsIt });
      }
    }
  });

  it('gets a sentence that says nothing was read, when nothing is granted', () => {
    const a = access();
    if (!a.anyGranted) {
      expect(/nothing was read/i.test(a.sentence)).toBe(true);
    }
  });
});

describe('flow 15: looking at your own record does not widen it', () => {
  it('reports isSelf without granting a single extra section', () => {
    const selfViewer = viewer({ role: 'applicant', employeeId: SUBJECT.employeeId, userId: SUBJECT.userId });
    const otherViewer = viewer({ role: 'applicant' });

    const mine = resolveHorizonAccess(selfViewer, SUBJECT, holdsForRole('applicant'));
    const theirs = resolveHorizonAccess(otherViewer, SUBJECT, holdsForRole('applicant'));

    expect(mine.isSelf).toBe(true);
    expect(theirs.isSelf).toBe(false);
    // THE PROPERTY. Self is printed, never granted: the two grant sets are identical.
    expect(mine.granted).toEqual(theirs.granted);
    expect(mine.withheld).toEqual(theirs.withheld);
    expect(mine.awaitingRatification).toEqual(theirs.awaitingRatification);
  });

  it('matches on either identity, because a person occupies more than one id space here', () => {
    const byEmployee = resolveHorizonAccess(viewer({ employeeId: SUBJECT.employeeId }), SUBJECT, holdsNothing);
    const byUser = resolveHorizonAccess(viewer({ userId: SUBJECT.userId }), SUBJECT, holdsNothing);
    expect(byEmployee.isSelf).toBe(true);
    expect(byUser.isSelf).toBe(true);
  });

  it('does not call a viewer with no employee record the subject of somebody else’s profile', () => {
    const nullIdentity = viewer({ employeeId: null, userId: 'someone-else' });
    const subjectWithNoUser = { employeeId: null, userId: null } as any;
    expect(resolveHorizonAccess(nullIdentity, subjectWithNoUser, holdsNothing).isSelf).toBe(false);
  });

  it('grants an account with no capability nothing at all', () => {
    const a = resolveHorizonAccess(viewer({ role: 'applicant' }), SUBJECT, holdsNothing);
    expect(a.anyGranted).toBe(false);
    expect(a.granted).toEqual([]);
    expect(/nothing was read/i.test(a.sentence)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// THE ROLL-UP TAB, WHICH IS THE ONE THAT COULD LEAK BY ARITHMETIC
// -------------------------------------------------------------------------------------------------

describe('flow 11: the capability-free roll-up tab cannot become a way around the others', () => {
  const rollUp = HORIZON_SECTIONS.filter((s) => s.capability === null).map((s) => s.key);

  it('exists, and is the only section with no capability of its own', () => {
    expect(rollUp.length).toBe(1);
  });

  it('is not granted to a viewer who has been granted nothing else', () => {
    // Its answer depends on the count of other grants. A roll-up that opened for a viewer holding
    // nothing would be a summary of sections that viewer may not read.
    const a = resolveHorizonAccess(viewer({ role: 'applicant' }), SUBJECT, holdsNothing);
    for (const key of rollUp) {
      expect({ key, granted: a.granted.includes(key) }).toEqual({ key, granted: false });
    }
  });
});
