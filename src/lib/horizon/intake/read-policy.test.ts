// WHO MAY READ THIS DATA — the policy, tested on its own.
//
// mayRead() is separated from readPersonalFoundation() precisely so this suite exists: the rule can
// be exercised without a database, without key material and without a session, which means it is
// checked on every run rather than only when somebody happens to exercise the whole path.
//
// The `compliance-review` branch asks the permission registry and therefore needs a connection, so
// it is not covered here beyond the two refusals that happen BEFORE the registry is consulted. That
// gap is stated rather than papered over.
import { describe, expect, it } from 'vitest';
import { applicantSubject } from '@/lib/horizon/ids';
import { mayRead } from './foundation';
import type { ReadActor } from './types';

/**
 * The full ReadActor from the one or two fields a case actually cares about.
 *
 * ReadActor has three required fields and every case here varies at most two of them. Spelling the
 * other one out at each of the nine call sites would say nothing and would hide the field that the
 * case is actually about.
 */
const reader = (over: Partial<ReadActor> = {}): ReadActor =>
  ({ userId: null, service: null, ipAddress: null, ...over });

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEBODY_ELSE = '22222222-2222-4222-8222-222222222222';
const SUBJECT = applicantSubject(ME, 'user');

describe('subject-self-service', () => {
  it('lets the person read their own record', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: ME }), purpose: 'subject-self-service' });
    expect(r.ok).toBe(true);
  });

  it('refuses another signed-in account', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: SOMEBODY_ELSE }), purpose: 'subject-self-service' });
    expect(r.ok).toBe(false);
  });

  it('refuses an anonymous caller', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: null }), purpose: 'subject-self-service' });
    expect(r.ok).toBe(false);
  });

  // A subject anchored on an application or a talent-person row cannot be proved to BE the
  // signed-in account without the identity patch's SubjectResolver. Guessing there would hand one
  // person another person's record, so the honest answer is a refusal until that resolver exists.
  it('refuses a subject anchored on something other than the signed-in user', async () => {
    const viaApplication = applicantSubject(ME, 'application');
    const r = await mayRead({ subject: viaApplication, actor: reader({ userId: ME }), purpose: 'subject-self-service' });
    expect(r.ok).toBe(false);
  });
});

describe('intelligence-computation', () => {
  it('lets a server-side engine read', async () => {
    const r = await mayRead({
      subject: SUBJECT, actor: reader({ userId: null, service: 'horizon-engine' }), purpose: 'intelligence-computation',
    });
    expect(r.ok).toBe(true);
  });

  // THE DISTINCTION THE AUDIT LOG EXISTS TO RECORD. A human must not be able to borrow the engine's
  // purpose and disappear into it — they ask for compliance-review and are logged as a person.
  it('refuses a human wearing the engine purpose', async () => {
    const r = await mayRead({
      subject: SUBJECT, actor: reader({ userId: ME, service: 'horizon-engine' }), purpose: 'intelligence-computation',
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a caller that is neither', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: null }), purpose: 'intelligence-computation' });
    expect(r.ok).toBe(false);
  });
});

describe('everything else', () => {
  it('refuses a purpose that is not on the list', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: ME }), purpose: 'because-i-am-curious' as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-purpose');
  });

  it('refuses an unnamed compliance read before it ever asks the registry', async () => {
    const r = await mayRead({ subject: SUBJECT, actor: reader({ userId: null }), purpose: 'compliance-review' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('forbidden');
  });
});
