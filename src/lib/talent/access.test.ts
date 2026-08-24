// src/lib/talent/access.test.ts — THE ACCESS RULES, EXERCISED WITH NO DATABASE.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. access.ts resolves its database handle inside ctx() and
// loads the permission catalogue through a lazy import, so reaching deriveAccess() must not require
// DATABASE_URL or the registry. If that regresses — somebody adds a module-scope
// `import { BUILTIN_PERMISSIONS }` or a bare `import { db }` — this file fails at COLLECTION rather
// than on an assertion, which is exactly the signal wanted.
//
// WHY THIS FILE MATTERS MORE THAN THE OTHER TESTS IN ITS BATCH. Every other rule in the talent
// platform decides how a screen reads. These decide what a person can reach. The first describe
// block is the one to keep working: a suspended identity and a terminated identity resolve to NO
// access, whatever department, position, type or standing exception they hold. Spec 21.2 makes
// status the first term of the formula, and an implementation that applied it as a last filter
// would pass a casual reading of the code and still hand a suspended department head their
// department.
import { describe, it, expect } from 'vitest';
import {
  deriveAccess, diffAccess, formatDay, toMs, parseList,
  groupProblem, policyProblem, grantWindowProblem, defaultGrantUntil,
  advanceRequest, reviewOutcome, isUuid,
  ACCESS_CLASSIFICATIONS, SUBJECT_KINDS,
  type DerivableIdentity, type DerivablePolicy, type DerivableGrant,
} from '@/lib/talent/access';
import { ACCESS_REQUEST_LIMITS, type IdentityStatus } from '@/lib/talent/types';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const DAY = 86400000;

const GROUP_DEPT = '11111111-1111-4111-8111-111111111111';
const GROUP_POS = '22222222-2222-4222-8222-222222222222';
const GROUP_TYPE = '33333333-3333-4333-8333-333333333333';
const GROUP_MANUAL = '44444444-4444-4444-8444-444444444444';

const identity = (over: Partial<DerivableIdentity> = {}): DerivableIdentity => ({
  id: 'id-1',
  identityType: 'employee',
  departmentId: 'engineering',
  positionId: '99999999-9999-4999-8999-999999999999',
  status: 'active',
  ...over,
});

const policy = (over: Partial<DerivablePolicy> & { subjectKind: string; subjectKey: string; accessGroupId: string }): DerivablePolicy => ({
  id: 'p-' + over.subjectKind + '-' + over.accessGroupId,
  version: 1,
  isActive: true,
  ...over,
});

const grant = (over: Partial<DerivableGrant> & { accessGroupId: string }): DerivableGrant => ({
  id: 'g-' + over.accessGroupId,
  source: 'manual',
  reason: 'Covering for the release',
  validUntil: new Date(NOW + 30 * DAY).toISOString(),
  ...over,
});

const FULL_POLICY: DerivablePolicy[] = [
  policy({ subjectKind: 'department', subjectKey: 'engineering', accessGroupId: GROUP_DEPT }),
  policy({ subjectKind: 'position', subjectKey: '99999999-9999-4999-8999-999999999999', accessGroupId: GROUP_POS }),
  policy({ subjectKind: 'identity_type', subjectKey: 'employee', accessGroupId: GROUP_TYPE }),
];

// ---------------------------------------------------------------------------------------------

describe('status is the first term, and a closed gate empties the set', () => {
  it('gives a SUSPENDED identity no access at all, whatever else it holds', () => {
    const d = deriveAccess(
      identity({ status: 'suspended' }),
      FULL_POLICY,
      [grant({ accessGroupId: GROUP_MANUAL })],
      NOW,
    );
    expect(d.groups).toEqual([]);
    expect(d.reasons).toEqual([]);
    expect(d.gatedReason).toBeTruthy();
  });

  it('gives a TERMINATED identity no access at all, whatever else it holds', () => {
    const d = deriveAccess(
      identity({ status: 'terminated' }),
      FULL_POLICY,
      [grant({ accessGroupId: GROUP_MANUAL })],
      NOW,
    );
    expect(d.groups).toEqual([]);
    expect(d.reasons).toEqual([]);
    expect(d.gatedReason).toBeTruthy();
  });

  it('closes the gate for every status that is not active or serving notice', () => {
    const closed: IdentityStatus[] = [
      'invited_for_onboarding', 'onboarding_started', 'onboarding_pending', 'verification',
      'on_leave', 'suspended', 'exited', 'terminated', 'archived', 'converted',
    ];
    for (const status of closed) {
      const d = deriveAccess(identity({ status }), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL })], NOW);
      expect(d.groups, 'status ' + status + ' must derive to nothing').toEqual([]);
      expect(d.reasons).toEqual([]);
    }
  });

  it('keeps access while somebody is serving notice, which is what notice means', () => {
    const d = deriveAccess(identity({ status: 'notice' }), FULL_POLICY, [], NOW);
    expect(d.groups).toEqual([GROUP_DEPT, GROUP_POS, GROUP_TYPE]);
    expect(d.gatedReason).toBeNull();
  });

  it('says WHY the set is empty rather than leaving a bare zero on the screen', () => {
    const d = deriveAccess(identity({ status: 'suspended' }), FULL_POLICY, [], NOW);
    expect(d.gatedReason).toContain('suspended');
    expect(String(d.gatedReason)).toContain('no access at all');
  });

  it('reports BOTH kinds of refusal for a gated identity, and grants neither', () => {
    // A suspended identity holding one live exception and one already-expired exception. The live
    // one is withheld by the gate; the dead one was never access anyway. Both belong in `refused`
    // with their own explanation, and the screen must be able to tell them apart — an administrator
    // deciding whether to reinstate somebody needs to know which of the two they are looking at.
    const d = deriveAccess(
      identity({ status: 'suspended' }),
      [FULL_POLICY[0]],
      [
        grant({ accessGroupId: GROUP_MANUAL }),
        grant({ accessGroupId: GROUP_POS, validUntil: new Date(NOW - DAY).toISOString() }),
      ],
      NOW,
    );
    expect(d.groups).toEqual([]);
    expect(d.reasons).toEqual([]);
    const withheld = d.refused.filter((r) => r.explanation.includes('Withheld'));
    const expired = d.refused.filter((r) => r.explanation.includes('expired'));
    expect(withheld.map((r) => r.accessGroupId).sort()).toEqual([GROUP_DEPT, GROUP_MANUAL].sort());
    expect(expired.map((r) => r.accessGroupId)).toEqual([GROUP_POS]);
    expect(withheld.length + expired.length).toBe(d.refused.length);
  });

  it('reports what reinstatement would restore, as refused and never as access', () => {
    const d = deriveAccess(identity({ status: 'suspended' }), FULL_POLICY, [], NOW);
    expect(d.refused.length).toBe(3);
    for (const r of d.refused) expect(r.explanation).toContain('Withheld');
    // The refused list is not access: nothing in it appears in groups.
    for (const r of d.refused) expect(d.groups).not.toContain(r.accessGroupId);
  });

  it('MARKS a withheld term as withheld, so nothing downstream can call it dead', () => {
    // THE ASSERTION THAT PAYS FOR THIS FLAG. A suspended person holding one live manual grant and
    // one already-expired manual grant produces two refused rows that read alike at a glance and
    // are opposite facts: the live one returns by itself on reinstatement, the expired one is gone
    // for good. The admin surface offers a permanent, destructive withdraw control beside both, and
    // with nothing separating them it labelled the live grant "the dead exception". A consumer
    // matching on the wording of `explanation` would break the first time the sentence is reworded,
    // so the distinction is a field.
    const d = deriveAccess(
      identity({ status: 'suspended' }),
      [],
      [
        grant({ accessGroupId: GROUP_MANUAL }),
        grant({ accessGroupId: GROUP_POS, validUntil: new Date(NOW - DAY).toISOString() }),
      ],
      NOW,
    );
    const live = d.refused.find((r) => r.accessGroupId === GROUP_MANUAL);
    const dead = d.refused.find((r) => r.accessGroupId === GROUP_POS);
    expect(live?.gated).toBe(true);
    expect(dead?.gated).toBeFalsy();
    // And the sentence says which it is, for the reader rather than for the code.
    expect(String(live?.explanation)).toContain('returns by itself');
    expect(String(dead?.explanation)).toContain('expired');
  });

  it('marks every policy term the gate withheld, not just the exceptions', () => {
    const d = deriveAccess(identity({ status: 'exited' }), FULL_POLICY, [], NOW);
    expect(d.refused.length).toBe(3);
    for (const r of d.refused) expect(r.gated).toBe(true);
  });

  it('never marks anything gated for an identity the gate lets through', () => {
    const d = deriveAccess(
      identity(),
      FULL_POLICY,
      [grant({ accessGroupId: GROUP_MANUAL, validUntil: new Date(NOW - DAY).toISOString() })],
      NOW,
    );
    for (const r of d.reasons) expect(r.gated).toBeFalsy();
    for (const r of d.refused) expect(r.gated).toBeFalsy();
  });
});

describe('the derivation is the union of department, position, type and unexpired exceptions', () => {
  it('derives one group per matching policy term, with the source on each', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [], NOW);
    expect(d.groups).toEqual([GROUP_DEPT, GROUP_POS, GROUP_TYPE]);
    expect(d.reasons.map((r) => r.source)).toEqual(['department', 'position', 'type']);
  });

  it('gives every single group a reason somebody can read', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL })], NOW);
    expect(d.groups).toHaveLength(4);
    for (const g of d.groups) {
      const reason = d.reasons.find((r) => r.accessGroupId === g);
      expect(reason, 'group ' + g + ' must carry a reason').toBeTruthy();
      expect(String(reason!.explanation).length).toBeGreaterThan(0);
    }
  });

  it('names the department, the position and the type in the words it prints', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [], NOW);
    expect(d.reasons[0].explanation).toBe('From department engineering');
    expect(d.reasons[1].explanation).toContain('From position ');
    expect(d.reasons[2].explanation).toBe('From identity type Employee');
  });

  it('derives nothing from a department the identity is not in', () => {
    const d = deriveAccess(identity({ departmentId: 'design' }), FULL_POLICY, [], NOW);
    expect(d.groups).toEqual([GROUP_POS, GROUP_TYPE]);
  });

  it('derives nothing from a department policy when the identity has no department', () => {
    const d = deriveAccess(identity({ departmentId: null }), FULL_POLICY, [], NOW);
    expect(d.groups).not.toContain(GROUP_DEPT);
  });

  it('matches a department id case-insensitively and around stray whitespace', () => {
    const d = deriveAccess(
      identity({ departmentId: '  Engineering ' }),
      [policy({ subjectKind: 'department', subjectKey: 'ENGINEERING', accessGroupId: GROUP_DEPT })],
      [], NOW,
    );
    expect(d.groups).toEqual([GROUP_DEPT]);
  });

  it('derives nothing from a RETIRED policy, which is what retirement means', () => {
    const retired = FULL_POLICY.map((p) => ({ ...p, isActive: false }));
    const d = deriveAccess(identity(), retired, [], NOW);
    expect(d.groups).toEqual([]);
    expect(d.gatedReason).toBeNull();
  });

  it('lets a retired policy and its live replacement coexist without doubling the group', () => {
    const rows: DerivablePolicy[] = [
      policy({ id: 'v1', subjectKind: 'department', subjectKey: 'engineering', accessGroupId: GROUP_DEPT, version: 1, isActive: false }),
      policy({ id: 'v2', subjectKind: 'department', subjectKey: 'engineering', accessGroupId: GROUP_DEPT, version: 2, isActive: true }),
    ];
    const d = deriveAccess(identity(), rows, [], NOW);
    expect(d.groups).toEqual([GROUP_DEPT]);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0].policyVersion).toBe(2);
  });

  it('keeps BOTH answers when one group arrives from two sources, and lists the group once', () => {
    const rows: DerivablePolicy[] = [
      policy({ id: 'a', subjectKind: 'department', subjectKey: 'engineering', accessGroupId: GROUP_DEPT }),
      policy({ id: 'b', subjectKind: 'identity_type', subjectKey: 'employee', accessGroupId: GROUP_DEPT }),
    ];
    const d = deriveAccess(identity(), rows, [], NOW);
    expect(d.groups).toEqual([GROUP_DEPT]);
    expect(d.reasons.map((r) => r.source)).toEqual(['department', 'type']);
  });

  it('ignores a policy row whose subject kind nobody can interpret', () => {
    const d = deriveAccess(
      identity(),
      [policy({ subjectKind: 'project', subjectKey: 'engineering', accessGroupId: GROUP_DEPT })],
      [], NOW,
    );
    expect(d.groups).toEqual([]);
  });

  it('never lists a group without a reason, and never a reason for a group it did not list', () => {
    // The first half is already asserted above. THIS IS THE OTHER DIRECTION, and it is the one that
    // matters on the screen: the page renders one row per REASON and treats that table as the
    // answer. A reason pointing at a group missing from `groups` would print an access row for
    // access the formula did not grant — the exact fabrication the reason column exists to rule out.
    const d = deriveAccess(identity(), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL })], NOW);
    const listed = new Set(d.groups);
    for (const r of d.reasons) {
      expect(listed.has(r.accessGroupId), 'reason for ' + r.accessGroupId + ' must name a listed group').toBe(true);
    }
    expect(new Set(d.reasons.map((r) => r.accessGroupId))).toEqual(listed);
    // And nothing refused ever appears among the reasons.
    for (const r of d.refused) expect(d.reasons.map((x) => x.accessGroupId + '|' + x.source)).not.toContain(r.accessGroupId + '|' + r.source);
  });

  it('treats an exception with an unrecognised source as an exception, not as a policy term', () => {
    // tal_identity_access.source is TEXT with no check constraint, so a row written by anything
    // other than this module can carry a value the union does not know. Reading it as 'department'
    // would give it a policy term's privileges — no expiry, no written reason — which is precisely
    // backwards. It falls to 'manual' and obeys every exception rule, expiry included.
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, source: 'imported' })], NOW);
    expect(d.reasons[0].source).toBe('manual');
    const dead = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, source: 'imported', validUntil: null })], NOW);
    expect(dead.groups).toEqual([]);
  });

  it('is deterministic: the same inputs give the same answer in the same order', () => {
    const a = deriveAccess(identity(), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL })], NOW);
    const b = deriveAccess(identity(), FULL_POLICY.slice().reverse(), [grant({ accessGroupId: GROUP_MANUAL })], NOW);
    expect(a.groups).toEqual(b.groups);
    expect(a.reasons.map((r) => r.explanation)).toEqual(b.reasons.map((r) => r.explanation));
  });
});

describe('a manual grant is a time-bounded exception, and the boundary is the whole rule', () => {
  it('is access one millisecond before it ends', () => {
    const until = new Date(NOW + 1).toISOString();
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: until })], NOW);
    expect(d.groups).toEqual([GROUP_MANUAL]);
  });

  it('is NOT access at the exact instant it ends', () => {
    const until = new Date(NOW).toISOString();
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: until })], NOW);
    expect(d.groups).toEqual([]);
    expect(d.refused[0].explanation).toContain('expired');
  });

  it('is NOT access one millisecond after it ends', () => {
    const until = new Date(NOW - 1).toISOString();
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: until })], NOW);
    expect(d.groups).toEqual([]);
  });

  it('is NOT access with no end date at all, because an exception must be time-bounded', () => {
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: null })], NOW);
    expect(d.groups).toEqual([]);
    expect(d.refused[0].explanation).toContain('no end date');
  });

  it('is NOT access with an end date nothing can read, and fails closed rather than open', () => {
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: 'next Tuesday' })], NOW);
    expect(d.groups).toEqual([]);
    expect(d.refused[0].explanation).toContain('cannot be read');
  });

  it('stays visibly marked as a manual exception, and carries the written reason with it', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL, reason: 'Release cover' })], NOW);
    const manual = d.reasons.find((r) => r.accessGroupId === GROUP_MANUAL)!;
    expect(manual.source).toBe('manual');
    expect(manual.note).toBe('Release cover');
    expect(manual.explanation).toContain('Manual grant, until ');
  });

  it('prints the end date in the reason, so nobody has to look it up', () => {
    const until = '2026-09-12T00:00:00.000Z';
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, validUntil: until })], NOW);
    expect(d.reasons[0].explanation).toBe('Manual grant, until 12 Sep 2026');
  });

  it('distinguishes an approved request from an administrator grant', () => {
    const d = deriveAccess(identity(), [], [grant({ accessGroupId: GROUP_MANUAL, source: 'request' })], NOW);
    expect(d.reasons[0].source).toBe('request');
    expect(d.reasons[0].explanation).toContain('Approved access request');
  });

  it('sorts exceptions after policy terms, so an exception is never lost in the middle of a list', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [grant({ accessGroupId: GROUP_MANUAL })], NOW);
    expect(d.reasons.map((r) => r.source)).toEqual(['department', 'position', 'type', 'manual']);
  });
});

describe('drift between the cache and the formula is reported in both directions', () => {
  it('finds nothing to report when the cache agrees with the derivation', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [], NOW);
    const cached = d.reasons.map((r) => ({ accessGroupId: r.accessGroupId, source: r.source }));
    expect(diffAccess(d.reasons, cached)).toEqual({ missing: [], stale: [] });
  });

  it('reports a derived group the cache has not materialised', () => {
    const d = deriveAccess(identity(), FULL_POLICY, [], NOW);
    const drift = diffAccess(d.reasons, [{ accessGroupId: GROUP_DEPT, source: 'department' }]);
    expect(drift.missing.map((m) => m.accessGroupId)).toEqual([GROUP_POS, GROUP_TYPE]);
    expect(drift.stale).toEqual([]);
  });

  it('reports a cached group nothing derives any more, which is how an exit keeps access', () => {
    const d = deriveAccess(identity({ departmentId: 'design' }), FULL_POLICY, [], NOW);
    const drift = diffAccess(d.reasons, [
      { accessGroupId: GROUP_DEPT, source: 'department' },
      { accessGroupId: GROUP_POS, source: 'position' },
      { accessGroupId: GROUP_TYPE, source: 'type' },
    ]);
    expect(drift.stale.map((s) => s.accessGroupId)).toEqual([GROUP_DEPT]);
  });

  it('treats the same group from a different source as a different fact', () => {
    const d = deriveAccess(identity(), [FULL_POLICY[0]], [], NOW);
    const drift = diffAccess(d.reasons, [{ accessGroupId: GROUP_DEPT, source: 'manual' }]);
    expect(drift.missing).toHaveLength(1);
    expect(drift.stale).toHaveLength(1);
  });

  it('reports the whole cache as stale for a suspended identity, because it derives to nothing', () => {
    const d = deriveAccess(identity({ status: 'suspended' }), FULL_POLICY, [], NOW);
    const drift = diffAccess(d.reasons, [{ accessGroupId: GROUP_DEPT, source: 'department' }]);
    expect(drift.stale).toHaveLength(1);
  });
});

describe('an access group is refused at save time when it would lie about itself', () => {
  const good = { key: 'eng.tooling', name: 'Engineering tooling', classification: 'internal', capabilities: ['roles.view'] };

  it('accepts a well-formed group', () => {
    expect(groupProblem(good)).toBeNull();
  });

  it('needs a key and a name', () => {
    expect(groupProblem({ ...good, key: '' })).toContain('key');
    expect(groupProblem({ ...good, name: '  ' })).toContain('name');
  });

  it('refuses a key that is not lower-case dotted', () => {
    expect(groupProblem({ ...good, key: 'Eng Tooling' })).toContain('lower case');
    expect(groupProblem({ ...good, key: 'eng..tooling' })).toContain('lower case');
    expect(groupProblem({ ...good, key: '1eng' })).toContain('lower case');
  });

  it('refuses a classification outside the four the contract defines', () => {
    for (const c of ACCESS_CLASSIFICATIONS) expect(groupProblem({ ...good, classification: c })).toBeNull();
    expect(groupProblem({ ...good, classification: 'secret' })).toContain('Classification must be');
  });

  it('refuses a capability that is not shaped like a permission key', () => {
    expect(groupProblem({ ...good, capabilities: ['Access Manage'] })).toContain('not a permission key');
  });

  it('refuses a capability the catalogue has never heard of, because it would grant nothing', () => {
    const problem = groupProblem({ ...good, capabilities: ['roles.view', 'nope.invented'] }, ['roles.view', 'access.manage']);
    expect(problem).toContain('does not exist in the permission catalogue');
  });

  it('checks nothing against a catalogue it was not given, and says so for both spellings of "not given"', () => {
    // undefined is the shape the caller actually passes: createAccessGroup does `known || undefined`
    // and knownCapabilities() returns null when the registry cannot be read. The empty array is the
    // same fact arriving by a different route — catalogue() refuses a catalogue with no entries in
    // it rather than treating "the registry answered with nothing" as "no key exists". Both must
    // skip the existence check rather than refuse every key on the form.
    expect(groupProblem({ ...good, capabilities: ['roles.view'] }, undefined)).toBeNull();
    expect(groupProblem({ ...good, capabilities: ['roles.view'] }, [])).toBeNull();
    // And the SHAPE check still runs without a catalogue, so an unreadable catalogue never turns
    // this into a form that accepts anything at all.
    expect(groupProblem({ ...good, capabilities: ['Not A Key'] }, undefined)).toContain('not a permission key');
  });
});

describe('a policy may not hand out sensitive access in bulk', () => {
  const plain = { key: 'eng.tooling', name: 'Engineering tooling', isActive: true, classification: 'internal', capabilities: ['roles.view'] };
  const sensitiveGroup = { ...plain, key: 'people.admin', capabilities: ['roles.view', 'access.manage'] };
  const SENSITIVE = ['access.manage', 'identity.manage'];

  it('accepts a plain group given to a department', () => {
    expect(policyProblem({ subjectKind: 'department', subjectKey: 'engineering', group: plain, sensitiveCapabilities: SENSITIVE })).toBeNull();
  });

  it('refuses a SENSITIVE capability through a department default', () => {
    const problem = policyProblem({ subjectKind: 'department', subjectKey: 'engineering', group: sensitiveGroup, sensitiveCapabilities: SENSITIVE });
    expect(problem).toContain('access.manage');
    expect(problem).toContain('one identity at a time');
  });

  it('refuses it through a position default and an identity-type default too, because all three are bulk', () => {
    for (const kind of ['position', 'identity_type'] as const) {
      const key = kind === 'identity_type' ? 'employee' : 'a-position';
      const problem = policyProblem({ subjectKind: kind, subjectKey: key, group: sensitiveGroup, sensitiveCapabilities: SENSITIVE });
      expect(problem, kind + ' must refuse a sensitive capability').toContain('access.manage');
    }
  });

  it('refuses a CLASSIFIED group by policy whatever capabilities it carries', () => {
    const classified = { ...plain, classification: 'classified' };
    expect(policyProblem({ subjectKind: 'department', subjectKey: 'engineering', group: classified, sensitiveCapabilities: SENSITIVE }))
      .toContain('classified');
  });

  it('refuses a retired group', () => {
    expect(policyProblem({ subjectKind: 'department', subjectKey: 'engineering', group: { ...plain, isActive: false }, sensitiveCapabilities: SENSITIVE }))
      .toContain('retired');
  });

  it('refuses a group that does not exist', () => {
    expect(policyProblem({ subjectKind: 'department', subjectKey: 'engineering', group: null, sensitiveCapabilities: SENSITIVE }))
      .toContain('does not exist');
  });

  it('refuses a subject kind outside the three, and an empty subject key', () => {
    expect(policyProblem({ subjectKind: 'project', subjectKey: 'x', group: plain, sensitiveCapabilities: [] }))
      .toContain('department, a position or an identity type');
    for (const kind of SUBJECT_KINDS) {
      expect(policyProblem({ subjectKind: kind, subjectKey: '   ', group: plain, sensitiveCapabilities: [] })).toBeTruthy();
    }
  });

  it('refuses an identity type nobody issues', () => {
    expect(policyProblem({ subjectKind: 'identity_type', subjectKey: 'wizard', group: plain, sensitiveCapabilities: [] }))
      .toContain('not an identity type');
    expect(policyProblem({ subjectKind: 'identity_type', subjectKey: 'Intern', group: plain, sensitiveCapabilities: [] })).toBeNull();
  });
});

describe('a manual grant window is bounded at both ends', () => {
  it('accepts a window inside the cap', () => {
    expect(grantWindowProblem(new Date(NOW + 90 * DAY).toISOString(), NOW)).toBeNull();
  });

  it('refuses no end date at all', () => {
    expect(grantWindowProblem(null, NOW)).toContain('must end on a date');
    expect(grantWindowProblem('', NOW)).toContain('must end on a date');
  });

  it('refuses an end date nothing can read', () => {
    expect(grantWindowProblem('soon', NOW)).toContain('cannot be read');
  });

  it('refuses an end date in the past, and one exactly now', () => {
    expect(grantWindowProblem(new Date(NOW - DAY).toISOString(), NOW)).toContain('in the future');
    expect(grantWindowProblem(new Date(NOW).toISOString(), NOW)).toContain('in the future');
  });

  it('accepts exactly the cap and refuses one moment past it', () => {
    const cap = ACCESS_REQUEST_LIMITS.maxGrantDays;
    expect(grantWindowProblem(new Date(NOW + cap * DAY).toISOString(), NOW)).toBeNull();
    expect(grantWindowProblem(new Date(NOW + cap * DAY + 1000).toISOString(), NOW)).toContain('at most ' + cap + ' days');
  });

  it('defaults to the ninety days the spec names', () => {
    const until = defaultGrantUntil(NOW);
    expect(Date.parse(until) - NOW).toBe(ACCESS_REQUEST_LIMITS.defaultGrantDays * DAY);
    expect(grantWindowProblem(until, NOW)).toBeNull();
  });
});

describe('an access request walks its steps and never skips one', () => {
  it('goes manager, then department, then approved for an internal group', () => {
    const a = advanceRequest('pending', 'approve', 'internal');
    expect(a).toMatchObject({ ok: true, stage: 'manager', next: 'department', terminal: false });
    const b = advanceRequest('department', 'approve', 'internal');
    expect(b).toMatchObject({ ok: true, stage: 'department', next: 'approved', terminal: true });
  });

  it('adds the security step for a CLASSIFIED group, and only for one', () => {
    expect(advanceRequest('department', 'approve', 'classified')).toMatchObject({ next: 'security', terminal: false });
    expect(advanceRequest('security', 'approve', 'classified')).toMatchObject({ next: 'approved', terminal: true });
    expect(advanceRequest('department', 'approve', 'restricted')).toMatchObject({ next: 'approved' });
  });

  it('treats the two spellings of the manager step as one step', () => {
    expect(advanceRequest('manager', 'approve', 'internal').next).toBe('department');
    expect(advanceRequest('pending', 'approve', 'internal').next).toBe('department');
  });

  it('makes a refusal terminal from any step, with no "refused but continue"', () => {
    for (const s of ['pending', 'manager', 'department', 'security']) {
      expect(advanceRequest(s, 'reject', 'classified')).toMatchObject({ ok: true, next: 'rejected', terminal: true });
    }
  });

  it('refuses to re-decide a request that has already been decided', () => {
    for (const s of ['approved', 'rejected', 'expired']) {
      const a = advanceRequest(s, 'approve', 'internal');
      expect(a.ok).toBe(false);
      expect(a.problem).toContain('already been decided');
    }
  });

  it('makes a classified group cost THREE approvals, and cannot be approved in two', () => {
    // The whole point of the security step is that it cannot be skipped. Walking it end to end
    // rather than asserting one transition at a time is what would catch an implementation that
    // reached 'approved' from the department step whenever some other condition happened to hold.
    let status = 'pending';
    const stages: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const step = advanceRequest(status, 'approve', 'classified');
      expect(step.ok, 'step from ' + status + ' must be legal').toBe(true);
      stages.push(String(step.stage));
      status = String(step.next);
      if (step.terminal) break;
    }
    expect(stages).toEqual(['manager', 'department', 'security']);
    expect(status).toBe('approved');
    // Two approvals is NOT enough for a classified group, and the second one does not end it.
    expect(advanceRequest(advanceRequest('pending', 'approve', 'classified').next!, 'approve', 'classified'))
      .toMatchObject({ next: 'security', terminal: false });
  });

  it('costs two approvals for everything that is not classified, and never the security step', () => {
    for (const c of ['public', 'internal', 'restricted']) {
      const first = advanceRequest('pending', 'approve', c);
      expect(first.next).toBe('department');
      const second = advanceRequest(String(first.next), 'approve', c);
      expect(second, c + ' must finish at the department step').toMatchObject({ next: 'approved', terminal: true });
    }
  });

  it('refuses a status this workflow does not know rather than guessing at it', () => {
    const a = advanceRequest('escalated', 'approve', 'internal');
    expect(a.ok).toBe(false);
    expect(a.problem).toContain('does not know');
  });
});

describe('a provisioning run is a proposal, and reviewing it is a decision about it', () => {
  it('approves a proposed run and one already awaiting review', () => {
    expect(reviewOutcome('proposed', 'approve')).toMatchObject({ ok: true, next: 'approved', declined: false });
    expect(reviewOutcome('awaiting_review', 'approve')).toMatchObject({ ok: true, next: 'approved' });
  });

  it('records a decline as failed with a marker, because the contract has no declined state', () => {
    expect(reviewOutcome('proposed', 'decline')).toMatchObject({ ok: true, next: 'failed', declined: true });
  });

  it('refuses to review a run that is past review', () => {
    for (const s of ['approved', 'provisioning', 'provisioned', 'partially_failed', 'failed']) {
      const r = reviewOutcome(s, 'approve');
      expect(r.ok, s + ' must not be reviewable').toBe(false);
      expect(r.problem).toContain('Only a proposed run');
    }
  });
});

describe('the small helpers, which every screen above depends on', () => {
  it('formats a day the same way on every machine', () => {
    expect(formatDay('2026-09-12T00:00:00.000Z')).toBe('12 Sep 2026');
    expect(formatDay('2026-01-02T23:59:59.000Z')).toBe('02 Jan 2026');
    expect(formatDay(null)).toBe('');
    expect(formatDay('not a date')).toBe('');
  });

  it('never returns NaN from toMs', () => {
    expect(toMs('not a date')).toBeNull();
    expect(toMs(null)).toBeNull();
    expect(toMs('')).toBeNull();
    expect(toMs(NOW)).toBe(NOW);
    expect(toMs(new Date(NOW))).toBe(NOW);
  });

  it('splits a pasted list on commas and newlines and drops the empties', () => {
    expect(parseList('roles.view, access.manage\n\n identity.manage ,')).toEqual(['roles.view', 'access.manage', 'identity.manage']);
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });

  it('recognises a uuid and refuses anything else, so a bad id is not a 500', () => {
    expect(isUuid(GROUP_DEPT)).toBe(true);
    expect(isUuid('engineering')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
