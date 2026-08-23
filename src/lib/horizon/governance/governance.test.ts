// src/lib/horizon/governance/governance.test.ts — the policy, asserted as a document.
//
// Everything tested here is pure and needs no database. That is why the policy lives in matrix.ts
// rather than in the pages that enforce it: the answer to "may this person be served this view for
// this reason" is demonstrable in a test run, not only by signing in and clicking.
//
// Each case names the brief rule it holds to. A failure here is a rule that stopped being true.
import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_PERMISSION,
  HORIZON_PERMISSIONS,
  HORIZON_PERMISSION_KEYS,
  PURPOSES,
  governancePermission,
  holdsGovernancePermission,
  impactOfPurpose,
  isPurpose,
  purposeMeta,
  resolveAudience,
} from './matrix';
import { AUDIENCE_SPECS, HORIZON_AUDIENCES } from '@/lib/horizon/visibility';
import { RETENTION_TARGETS, sweepableHere } from './retention';
import { MIN_RATIONALE } from './ledger';
import { MIN_HIGH_IMPACT_PURPOSE } from './gate';
import { MIN_PURPOSE_CHARS } from '@/lib/horizon/visibility';

const perms = (...keys: string[]) => new Set(keys);

// -------------------------------------------------------------------------------------------
describe('the permission catalogue', () => {
  it('uses keys the registry will accept', () => {
    // registry.ts validates keys against a lowercase dotted shape and refuses anything else at
    // registration. A key that failed here would be silently unpublishable.
    for (const key of HORIZON_PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(HORIZON_PERMISSION_KEYS).size).toBe(HORIZON_PERMISSION_KEYS.length);
  });

  it('marks every explicit-grant-only key as sensitive as well', () => {
    for (const p of HORIZON_PERMISSIONS) if (p.explicitGrantOnly) expect(p.sensitive).toBe(true);
  });
});

describe('the wildcard, and the two places it does not reach', () => {
  it('satisfies an ordinary governance key', () => {
    expect(holdsGovernancePermission(perms('*'), 'horizon.read.operations')).toBe(true);
  });

  it('does NOT satisfy attributed feedback (rules 24-25)', () => {
    // A super admin holds the wildcard. Reading who said what about a colleague is an explicit
    // grant, not a consequence of being an administrator.
    expect(holdsGovernancePermission(perms('*'), 'horizon.feedback.view.attributed')).toBe(false);
    expect(holdsGovernancePermission(perms('horizon.feedback.view.attributed'), 'horizon.feedback.view.attributed')).toBe(true);
  });

  it('does NOT satisfy the interpretive layer (rules 19-22)', () => {
    expect(holdsGovernancePermission(perms('*'), 'horizon.interpretive.view')).toBe(false);
    expect(holdsGovernancePermission(perms('*'), 'horizon.interpretive.internals')).toBe(false);
  });

  it('refuses an empty or missing permission set rather than defaulting open', () => {
    expect(holdsGovernancePermission(null, 'horizon.read.operations')).toBe(false);
    expect(holdsGovernancePermission(new Set<string>(), 'horizon.read.operations')).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
describe('the bridge to visibility.ts', () => {
  it('names a permission or a deliberate null for every audience visibility.ts defines', () => {
    // If the other patch adds an audience and nothing here maps it, resolveAudience would never
    // return it — the hole would be silent. This is what makes it loud.
    for (const audience of HORIZON_AUDIENCES) {
      expect(Object.prototype.hasOwnProperty.call(AUDIENCE_PERMISSION, audience)).toBe(true);
    }
  });

  it('gives the system audience no permission key at all', () => {
    // An engine audience reachable from a human session would hand `restricted` to whoever asked.
    expect(AUDIENCE_PERMISSION.system).toBeNull();
    expect(AUDIENCE_SPECS.system.maySee).toContain('restricted');
  });

  it('never lets a purpose list the system audience', () => {
    for (const p of PURPOSES) expect(p.audiences).not.toContain('system');
  });

  it('maps every referenced permission key to one this layer actually declares', () => {
    for (const audience of HORIZON_AUDIENCES) {
      const key = AUDIENCE_PERMISSION[audience];
      if (key) expect(governancePermission(key)).not.toBeNull();
    }
  });
});

// -------------------------------------------------------------------------------------------
describe('purpose limitation', () => {
  it('recognises exactly the catalogued purposes', () => {
    expect(isPurpose('promotion_assessment')).toBe(true);
    expect(isPurpose('because_i_am_curious')).toBe(false);
  });

  it('refuses an unknown purpose outright rather than falling back to a default', () => {
    const r = resolveAudience({ permissions: perms('*'), purpose: 'made_up', isSelf: false });
    expect(r.audience).toBeNull();
    expect(r.reason).toContain('not a purpose this system recognises');
  });

  it('opens no individual record for workforce planning, whatever the reader holds', () => {
    // Planning is an aggregate activity and the purpose most likely to be used as a pretext.
    const r = resolveAudience({ permissions: perms('*'), purpose: 'workforce_planning', isSelf: false });
    expect(r.audience).toBeNull();
    expect(purposeMeta('workforce_planning')!.audiences).toEqual([]);
  });

  it('opens no individual record for system administration either', () => {
    const r = resolveAudience({ permissions: perms('*'), purpose: 'system_administration', isSelf: false });
    expect(r.audience).toBeNull();
  });

  it('classifies the purposes that can change somebody\'s standing as high impact', () => {
    expect(impactOfPurpose('promotion_assessment')).toBe('high');
    expect(impactOfPurpose('compensation_review')).toBe('high');
    expect(impactOfPurpose('hiring_assessment')).toBe('high');
    expect(impactOfPurpose('system_administration')).toBe('informational');
  });
});

describe('resolving an audience', () => {
  it('refuses a reader holding nothing', () => {
    const r = resolveAudience({ permissions: perms(), purpose: 'performance_review', isSelf: false });
    expect(r.audience).toBeNull();
    expect(r.reason).toContain('horizon.read');
  });

  it('serves the strongest audience the purpose allows and the reader holds', () => {
    const r = resolveAudience({
      permissions: perms('horizon.read.operations', 'horizon.read.leadership'),
      purpose: 'promotion_assessment', isSelf: false,
    });
    expect(r.audience).toBe('hr_leadership');
    expect(r.permission).toBe('horizon.read.leadership');
  });

  it('does not promote a reader past what the PURPOSE allows', () => {
    // Compensation review lists hr_leadership only. A reader holding the auditor key gets nothing
    // from it, because an auditor is not one of the audiences that purpose admits.
    const r = resolveAudience({
      permissions: perms('horizon.read.audit'), purpose: 'compensation_review', isSelf: false,
    });
    expect(r.audience).toBeNull();
  });

  it('serves the subject as `self`, ahead of any key they happen to hold', () => {
    // A manager reading their own record reads it as themselves — the narrower view, and the right
    // one. Their authority over other people is not authority over their own record's machinery.
    const r = resolveAudience({
      permissions: perms('horizon.read.audit', 'horizon.read.leadership'),
      purpose: 'subject_access_request', isSelf: true,
    });
    expect(r.audience).toBe('self');
    expect(AUDIENCE_SPECS.self.maySee).not.toContain('restricted');
  });

  it('does not give `self` to a purpose that does not admit it', () => {
    const r = resolveAudience({ permissions: perms(), purpose: 'promotion_assessment', isSelf: true });
    expect(r.audience).toBeNull();
  });

  it('records which permission the answer rested on, for the access log', () => {
    const r = resolveAudience({
      permissions: perms('horizon.read.panel'), purpose: 'hiring_assessment', isSelf: false,
    });
    expect(r.audience).toBe('reviewer_panel');
    expect(r.permission).toBe('horizon.read.panel');
    expect(r.reason).toContain('horizon.read.panel');
  });
});

describe('the interpretive layer (rules 19-22)', () => {
  it('is reachable only through a purpose that requires consent', () => {
    const learning = purposeMeta('learning_development')!;
    expect(learning.requiresConsent).toBe(true);
  });

  it('is reachable by NO high-impact purpose at all (rule 14 + rule 22)', () => {
    // The strongest form of the guarantee, asserted across the whole catalogue rather than one
    // purpose at a time: no purpose that can change somebody's standing requires — or admits — the
    // consent-gated interpretive path. Adding one would fail here.
    for (const p of PURPOSES) {
      if (impactOfPurpose(p.purpose) === 'high') expect(p.requiresConsent).toBe(false);
    }
  });

  it('keeps the interpretation and the underlying method on separate keys', () => {
    expect(governancePermission('horizon.interpretive.view')!.explicitGrantOnly).toBe(true);
    expect(governancePermission('horizon.interpretive.internals')!.explicitGrantOnly).toBe(true);
  });

  it('uses no folk name for the method anywhere in the permission catalogue (rule 19)', () => {
    const banned = /astrolog|horoscope|zodiac|natal|kundli|birth ?chart/i;
    for (const p of HORIZON_PERMISSIONS) {
      expect(banned.test(p.label + ' ' + p.description)).toBe(false);
    }
    for (const p of PURPOSES) {
      expect(banned.test(p.label + ' ' + p.description)).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------
describe('the thresholds', () => {
  it('asks more of a high-impact purpose than the shared floor does', () => {
    // visibility.MIN_PURPOSE_CHARS is another module's published contract and other callers rely on
    // it. The stricter floor is applied in this layer rather than by lowering theirs.
    expect(MIN_HIGH_IMPACT_PURPOSE).toBeGreaterThan(MIN_PURPOSE_CHARS);
  });

  it('will not accept "ok" as the reason for a decision about somebody', () => {
    expect(MIN_RATIONALE).toBeGreaterThan('agreed'.length);
  });
});

// -------------------------------------------------------------------------------------------
describe('retention', () => {
  it('sweeps only tables this layer owns', () => {
    // Brief rules 2, 5 and 11. A retention job that deletes out of another patch's table is a
    // cross-patch write, and the first symptom is a feature quietly missing rows.
    for (const t of RETENTION_TARGETS) {
      if (sweepableHere(t.recordClass)) expect(t.table).toMatch(/^hgov_/);
      else expect(t.table).toMatch(/^hzn_/);
    }
  });

  it('names an owning module for every class', () => {
    for (const t of RETENTION_TARGETS) expect(t.ownerModule.length).toBeGreaterThan(0);
  });

  it('never expires an evidential class on a timer', () => {
    for (const cls of ['access_log', 'decision_log', 'consent_event', 'erasure_request']) {
      const t = RETENTION_TARGETS.find((x) => x.recordClass === cls);
      expect(t, cls + ' should have a retention target').toBeTruthy();
      expect(t!.defaultAction).toBe('review');
    }
  });

  it('gives every period a stated basis', () => {
    for (const t of RETENTION_TARGETS) expect(t.basis.length).toBeGreaterThan(20);
  });

  it('redacts subject_id rather than nulling it when anonymising', () => {
    // subject_id is NOT NULL on every table here. Nulling it would fail the statement; the row is
    // kept as a statistic about nobody instead, which is what anonymising means.
    for (const t of RETENTION_TARGETS) {
      if (t.defaultAction === 'anonymise') expect(t.identityColumns).toContain('subject_id');
    }
  });
});
