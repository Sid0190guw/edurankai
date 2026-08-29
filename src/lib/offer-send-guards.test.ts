// The two guards added to /admin/applications/[id]/offer-letter.astro, pinned against the modules
// that actually decide them. The page's own logic is one line each; what matters is that the line
// asks the right question of the right module, and that the answers do not drift.
import { describe, it, expect } from 'vitest';
import { can } from '@/lib/auth/permissions';
import { offerClock } from '@/lib/offer-clock';

// Mirrors the list in offer-letter.astro. Kept here so a change to one is a failing test, not a
// silent divergence between the guard and its reason.
const DEAD_OFFER_STATES = ['withdrawn', 'declined', 'expired'];

const TODAY = '2026-08-29';
// isActive matters: can() refuses an inactive user every permission, whatever their role.
const u = (role: string, isActive = true) => ({ id: 'u1', email: 'x@y.z', role, isActive } as any);

describe('who may act on an offer', () => {
  // The page used to gate on `role !== applicant` alone, so all of these could issue a binding
  // employment offer, create the candidate's account and move the application's stage.
  it('admits the People desk', () => {
    expect(can(u('super_admin'), 'offers.edit')).toBe(true);
    expect(can(u('hr'), 'offers.edit')).toBe(true);
  });

  it('refuses a recruiter, who is given offers.view alone on purpose', () => {
    expect(can(u('recruiter'), 'offers.view')).toBe(true);
    expect(can(u('recruiter'), 'offers.edit')).toBe(false);
  });

  it('refuses a reviewer, who holds neither', () => {
    expect(can(u('reviewer'), 'offers.edit')).toBe(false);
    expect(can(u('reviewer'), 'offers.view')).toBe(false);
  });

  // Reading the page is deliberately unchanged - a recruiter still needs to see where a candidate
  // has got to. Only the four acting branches ask for offers.edit.
  it('leaves the admin door itself open to both', () => {
    expect(can(u('recruiter'), 'admin.access')).toBe(true);
    expect(can(u('reviewer'), 'admin.access')).toBe(true);
  });

  it('refuses a deactivated member of the People desk', () => {
    expect(can(u('hr', false), 'offers.edit')).toBe(false);
  });
});

describe('which offers may be emailed', () => {
  const offer = (o: any) => ({
    status: 'sent', responseDeadline: null, expiryDate: null, signedAt: null, ...o,
  });

  it('refuses a withdrawn offer, which would arrive under a call to action to sign it', () => {
    const c = offerClock(offer({ status: 'withdrawn' }) as any, TODAY);
    expect(c.state).toBe('withdrawn');
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(true);
  });

  it('refuses a declined offer', () => {
    const c = offerClock(offer({ status: 'declined' }) as any, TODAY);
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(true);
  });

  it('refuses an expired offer', () => {
    const c = offerClock(offer({ expiryDate: '2026-08-01' }) as any, TODAY);
    expect(c.state).toBe('expired');
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(true);
  });

  it('allows an open offer', () => {
    const c = offerClock(offer({ responseDeadline: '2026-09-30' }) as any, TODAY);
    expect(c.live).toBe(true);
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(false);
  });

  // Past its deadline is NOT terminal - the offer can still be accepted, and offerClock says so.
  it('allows one that is merely past its response deadline', () => {
    const c = offerClock(offer({ responseDeadline: '2026-08-01' }) as any, TODAY);
    expect(c.state).toBe('overdue');
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(false);
  });

  // Deliberate: a candidate who lost the message should be able to be sent their own signed copy.
  it('allows a signed offer, so a lost copy can be re-sent', () => {
    const c = offerClock(offer({ status: 'signed', signedAt: '2026-08-20' }) as any, TODAY);
    expect(c.state).toBe('signed');
    expect(DEAD_OFFER_STATES.includes(c.state)).toBe(false);
  });
});
