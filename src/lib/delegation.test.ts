// Tests for delegation.
//
// These test the RULES, not the database. Every one of them corresponds to a way a temporary
// authority quietly becomes a permanent or unbounded one — which is the entire risk of this
// feature, and the reason it is a module rather than a form.

import { describe, it, expect, report } from './test-shim';
import {
  DELEGABLE_DOMAINS, NEVER_DELEGABLE, MAX_DELEGATION_DAYS, DOMAIN_LABELS, checkGrant,
} from './delegation';

const A = '11111111-1111-4111-8111-111111111111';   // principal
const B = '22222222-2222-4222-8222-222222222222';   // the person standing in
const U = '33333333-3333-4333-8333-333333333333';   // the signed-in actor

const day = 86_400_000;
const base = () => ({
  principalEmployeeId: A,
  delegateEmployeeId: B,
  domains: ['approvals.queue'] as any,
  from: new Date('2026-08-10T00:00:00Z'),
  until: new Date('2026-08-24T00:00:00Z'),
  reason: 'Away at a conference.',
  actorUserId: U,
});

describe('a well-formed delegation', () => {
  it('is accepted', () => {
    const r = checkGrant(base());
    expect(r.ok).toBe(true);
    expect(r.problems.length).toBe(0);
  });
});

describe('it must end', () => {
  it('refuses a delegation with no end date', () => {
    // The single most important rule here: an open-ended delegation is how somebody is still
    // approving on the founder's behalf two years after the week they covered.
    const r = checkGrant({ ...base(), until: '' as any });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('end date is required');
  });

  it('refuses an end date before the start', () => {
    const r = checkGrant({ ...base(), until: new Date('2026-08-01T00:00:00Z') });
    expect(r.ok).toBe(false);
  });

  it('refuses a delegation longer than the cap', () => {
    const from = new Date('2026-08-10T00:00:00Z');
    const until = new Date(from.getTime() + (MAX_DELEGATION_DAYS + 1) * day);
    const r = checkGrant({ ...base(), from, until });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('at most');
  });

  it('accepts one exactly at the cap', () => {
    const from = new Date('2026-08-10T00:00:00Z');
    const until = new Date(from.getTime() + MAX_DELEGATION_DAYS * day);
    expect(checkGrant({ ...base(), from, until }).ok).toBe(true);
  });
});

describe('it must be narrow, and to somebody else', () => {
  it('refuses a delegation that names nothing', () => {
    const r = checkGrant({ ...base(), domains: [] as any });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('at least one');
  });

  it('refuses a domain that is not delegable', () => {
    const r = checkGrant({ ...base(), domains: ['pay.change'] as any });
    expect(r.ok).toBe(false);
  });

  it('refuses delegating to yourself', () => {
    // Not a delegation: a way to make one person's action look like two people agreed.
    const r = checkGrant({ ...base(), delegateEmployeeId: A });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('cannot delegate to themselves');
  });

  it('requires a reason', () => {
    const r = checkGrant({ ...base(), reason: '   ' });
    expect(r.ok).toBe(false);
  });

  it('requires a signed-in actor', () => {
    const r = checkGrant({ ...base(), actorUserId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
  });
});

describe('the things no delegation carries', () => {
  it('never lists a forbidden act as delegable', () => {
    // The two lists must not overlap. If they ever do, the form offers the founder a control that
    // hands over something the rest of the system assumes nobody can hand over.
    for (const n of NEVER_DELEGABLE) {
      expect((DELEGABLE_DOMAINS as readonly string[]).includes(n.id)).toBe(false);
    }
  });

  it('keeps the power to grant power on the forbidden list', () => {
    // This is the one that makes every other exclusion enforceable: if granting authority could be
    // delegated, each remaining limit could be routed around in two moves.
    expect(NEVER_DELEGABLE.some((n) => n.id === 'authority.grant')).toBe(true);
  });

  it('keeps pay, employment status and achievement records off the table', () => {
    const ids = NEVER_DELEGABLE.map((n) => n.id);
    expect(ids.includes('pay.change')).toBe(true);
    expect(ids.includes('employment.status')).toBe(true);
    expect(ids.includes('achievement.record')).toBe(true);
  });

  it('keeps wellness and legal hold unreachable, since the principal cannot reach them either', () => {
    const ids = NEVER_DELEGABLE.map((n) => n.id);
    expect(ids.includes('wellness.read')).toBe(true);
    expect(ids.includes('legalhold.access')).toBe(true);
  });

  it('gives a reason for every exclusion', () => {
    // A refusal a person cannot understand reads as an arbitrary limit and invites a workaround.
    for (const n of NEVER_DELEGABLE) {
      expect(n.why.length > 20).toBe(true);
    }
  });
});

describe('the form can be built from the module', () => {
  it('labels every delegable domain', () => {
    // A checkbox whose label is a dotted key is a checkbox nobody reads before handing over
    // authority, and an unread grant is not consent.
    for (const d of DELEGABLE_DOMAINS) {
      expect(typeof (DOMAIN_LABELS as any)[d]).toBe('string');
      expect((DOMAIN_LABELS as any)[d].length > 5).toBe(true);
    }
  });
});

report();
