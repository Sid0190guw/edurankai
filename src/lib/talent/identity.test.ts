// src/lib/talent/identity.test.ts — the identity registry's RULES, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. identity.ts resolves its database handle lazily inside
// ctx(), so importing canChangeStatus() must not require DATABASE_URL. If that ever regresses —
// somebody adds a module-scope `import { db }` — this file fails at COLLECTION rather than on an
// assertion, which is exactly the signal wanted.
//
// THREE RULES ARE TESTED HERE, AND THEY ARE THE THREE THIS MODULE EXISTS FOR:
//
//  1. The code is immutable and never reused. Testable as: which series a type draws from, and the
//     absence of any exported way to renumber one.
//  2. The status lattice. A terminated identity does not come back to life; nothing reaches
//     `converted` by hand; active is only ever entered from verification.
//  3. Conversion is a new row, not an update — so converting to the type somebody already holds is
//     refused and sent to Transfer by name.
//
// Nothing below opens a connection, and nothing below asserts on a query.
import { describe, it, expect } from 'vitest';
import * as registry from '@/lib/talent/identity';
import {
  canChangeStatus, legalNextStatuses, statusChangeProblem,
  transferProblem, conversionProblem,
  codeSeriesFor, codeSeriesLabel, resolveIdentityType,
  statusesInFilter, isKnownStatusFilter, IDENTITY_STATUS_GROUPS, IDENTITY_CLOSED, isClosedStatus,
  isIdentityRef, isIdentityStatus, isIdentityType,
  createIdentityFromOnboarding,
} from '@/lib/talent/identity';
import { formatCode } from '@/lib/talent/ids';
import {
  IDENTITY_STATUSES, IDENTITY_TYPES, IDENTITY_STATUS_LABELS, SERIES_FOR_TYPE,
  type IdentityStatus,
} from '@/lib/talent/types';

const REF = '3f2a9c11-4d5e-4b7a-9c8d-1e2f3a4b5c6d';
const REF2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

// ---------------------------------------------------------------------------------------------
// RULE 1 — THE CODE IS IMMUTABLE AND NEVER REUSED. Spec 17.4 rule 3.
// ---------------------------------------------------------------------------------------------

describe('rule 1: the identity code is allocated once, from the series that matches the type', () => {
  it('sends each of the four primary types to its own series', () => {
    expect(codeSeriesFor('employee')).toBe('employee');
    expect(codeSeriesFor('intern')).toBe('intern');
    expect(codeSeriesFor('fellow')).toBe('fellow');
    expect(codeSeriesFor('member')).toBe('member');
  });

  it('registers every other engagement on an existing series rather than inventing one', () => {
    // A series per engagement produces codes nobody can read and a counter nobody maintains.
    expect(codeSeriesFor('contractor')).toBe('employee');
    expect(codeSeriesFor('consultant')).toBe('employee');
    expect(codeSeriesFor('volunteer')).toBe('member');
    expect(codeSeriesFor('campus_ambassador')).toBe('member');
  });

  it('agrees with SERIES_FOR_TYPE for every type the contract knows', () => {
    for (const t of IDENTITY_TYPES) expect(codeSeriesFor(t)).toBe(SERIES_FOR_TYPE[t]);
  });

  it('resolves an unknown or empty type to the employee series rather than throwing', () => {
    // The type usually arrives as a plain string off a form or a column, and a registry that threw
    // on an unexpected one would fail the whole admission over a spelling.
    expect(codeSeriesFor('sorcerer')).toBe('employee');
    expect(codeSeriesFor('')).toBe('employee');
    expect(codeSeriesFor(undefined as any)).toBe('employee');
  });

  it('derives code_series from the code prefix, so the column cannot disagree with the code', () => {
    expect(codeSeriesLabel('employee')).toBe('EMP');
    expect(codeSeriesLabel('intern')).toBe('INT');
    expect(codeSeriesLabel('fellow')).toBe('FEL');
    expect(codeSeriesLabel('member')).toBe('MEM');
  });

  it('produces a code whose prefix matches the series the label names', () => {
    for (const t of IDENTITY_TYPES) {
      const series = codeSeriesFor(t);
      const code = formatCode(series, 2184);
      expect(code.startsWith('ERAI-' + codeSeriesLabel(series) + '-')).toBe(true);
      // Identity series carry NO year segment: an identity outlives the year it was issued in.
      expect(code).toBe('ERAI-' + codeSeriesLabel(series) + '-002184');
    }
  });

  // THE STRUCTURAL HALF OF RULE 1. A mistaken identity is VOIDED, not renumbered, so there is no
  // deallocate and no way to rewrite identity_code. This test fails the moment somebody adds one.
  it('exports no way to renumber, deallocate or rewrite a code', () => {
    const offenders = Object.keys(registry).filter((k) =>
      /renumber|deallocate|releasecode|reassign|recode|setidentitycode|updatecode/i.test(k));
    expect(offenders.join(', ')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// RULE 2 — THE STATUS LATTICE. Spec 25.
// ---------------------------------------------------------------------------------------------

describe('rule 2: the status lattice decides every move', () => {
  it('knows every status the contract declares, and nothing else', () => {
    for (const s of IDENTITY_STATUSES) expect(isIdentityStatus(s)).toBe(true);
    expect(isIdentityStatus('retired')).toBe(false);
    expect(isIdentityStatus('')).toBe(false);
    // Every status is a key in the lattice: legalNextStatuses() answers for all twelve, so a new
    // status added to types.ts without a lattice entry shows up here rather than as a dead button.
    for (const s of IDENTITY_STATUSES) expect(Array.isArray(legalNextStatuses(s))).toBe(true);
  });

  it('never lets a status change into itself', () => {
    for (const s of IDENTITY_STATUSES) expect(canChangeStatus(s, s)).toBe(false);
  });

  it('only ever offers moves that are themselves real statuses', () => {
    for (const s of IDENTITY_STATUSES) {
      for (const n of legalNextStatuses(s)) expect(IDENTITY_STATUSES).toContain(n);
    }
  });

  // THE ONE THAT MATTERS MOST. Reinstating a person is a NEW identity linked by
  // previous_identity_id, never an UPDATE that quietly erases the termination.
  it('does not bring a terminated identity back to life', () => {
    expect(legalNextStatuses('terminated')).toEqual(['archived']);
    for (const s of IDENTITY_STATUSES) {
      if (s === 'archived') continue;
      expect(canChangeStatus('terminated', s)).toBe(false);
    }
  });

  it('does not bring an exited identity back to life either', () => {
    expect(canChangeStatus('exited', 'active')).toBe(false);
    expect(canChangeStatus('exited', 'on_leave')).toBe(false);
    expect(canChangeStatus('exited', 'notice')).toBe(false);
    expect(canChangeStatus('exited', 'archived')).toBe(true);
  });

  it('leads nowhere out of archived or converted', () => {
    expect(legalNextStatuses('archived')).toEqual([]);
    expect(legalNextStatuses('converted')).toEqual([]);
  });

  // `converted` is written by convertIdentity() on the old row, in the same transaction as the new
  // one is inserted. Setting it by hand would close an identity with no successor anywhere.
  it('refuses to reach converted from anywhere by a status change', () => {
    for (const s of IDENTITY_STATUSES) expect(canChangeStatus(s, 'converted')).toBe(false);
  });

  // TWO DIFFERENT ACTS REACH 'active', AND CONFLATING THEM IS HOW A REAL PERSON GETS STRANDED.
  //
  // ADMISSION happens once, and only verification may perform it: skipping forward inside the
  // paperwork is fine, skipping the last check a human makes before somebody is given access is not.
  // RESTORATION is not admission — it returns somebody who is already past that check, and it must
  // stay open or every person who takes leave or has a suspension lifted has no path back.
  //
  // This test asserted `toEqual(['verification'])` over ALL statuses, which reads as one rule and
  // silently forbids the other. It failed against a correct lattice, which is the dangerous
  // direction: the obvious way to make it green is to delete the two restorations.
  it('admits to active from verification alone, out of the pre-active chain', () => {
    const preActive = ['invited_for_onboarding', 'onboarding_started', 'onboarding_pending', 'verification'];
    const admitting = preActive.filter((s) => canChangeStatus(s, 'active'));
    expect(admitting).toEqual(['verification']);
  });

  it('restores to active from leave and from a lifted suspension, and from nowhere else', () => {
    expect(canChangeStatus('on_leave', 'active')).toBe(true);
    expect(canChangeStatus('suspended', 'active')).toBe(true);
    // Everything past the point of no return stays past it. 'notice' and 'exited' are on the way
    // out and are reversed by a new identity, not by an UPDATE; terminated never comes back at all.
    for (const s of ['notice', 'exited', 'terminated', 'archived', 'converted']) {
      expect(canChangeStatus(s, 'active')).toBe(false);
    }
  });

  // The whole set, pinned in one place, so a future widening has to be deliberate.
  it('reaches active from exactly three statuses', () => {
    const from = IDENTITY_STATUSES.filter((s) => canChangeStatus(s, 'active'));
    expect(from.slice().sort()).toEqual(['on_leave', 'suspended', 'verification']);
  });

  it('walks the onboarding chain forward and never backward', () => {
    expect(canChangeStatus('invited_for_onboarding', 'onboarding_started')).toBe(true);
    expect(canChangeStatus('invited_for_onboarding', 'verification')).toBe(true);
    expect(canChangeStatus('onboarding_pending', 'verification')).toBe(true);
    expect(canChangeStatus('verification', 'onboarding_pending')).toBe(false);
    expect(canChangeStatus('onboarding_started', 'invited_for_onboarding')).toBe(false);
    expect(canChangeStatus('active', 'verification')).toBe(false);
  });

  it('lets an active identity go on leave, be suspended, serve notice, or be terminated', () => {
    expect(legalNextStatuses('active')).toEqual(['on_leave', 'suspended', 'notice', 'terminated']);
    expect(canChangeStatus('on_leave', 'active')).toBe(true);
    expect(canChangeStatus('suspended', 'active')).toBe(true);
    expect(canChangeStatus('notice', 'exited')).toBe(true);
  });

  it('reaches terminated from every status that is not already finished', () => {
    for (const s of IDENTITY_STATUSES) {
      const finished = s === 'terminated' || s === 'archived' || s === 'converted';
      expect(canChangeStatus(s, 'terminated')).toBe(!finished);
    }
  });

  it('classes exactly the four finished statuses as closed', () => {
    expect([...IDENTITY_CLOSED]).toEqual(['exited', 'terminated', 'archived', 'converted']);
    for (const s of IDENTITY_STATUSES) {
      expect(isClosedStatus(s)).toBe((IDENTITY_CLOSED as readonly string[]).includes(s));
    }
  });
});

describe('rule 2: a status change without a written reason is not a status change', () => {
  it('refuses an empty or whitespace reason even when the move itself is legal', () => {
    expect(canChangeStatus('active', 'suspended')).toBe(true);
    expect(statusChangeProblem('active', 'suspended', '')).toMatch(/written reason/i);
    expect(statusChangeProblem('active', 'suspended', '   ')).toMatch(/written reason/i);
  });

  it('allows a legal move that carries one', () => {
    expect(statusChangeProblem('active', 'suspended', 'Pending the outcome of a conduct review.')).toBe('');
    expect(statusChangeProblem('verification', 'active', 'Documents checked by People Operations.')).toBe('');
    expect(statusChangeProblem('notice', 'exited', 'Last working day was 30 June.')).toBe('');
  });

  it('says the identity is already there rather than reporting an illegal move', () => {
    expect(statusChangeProblem('active', 'active', 'because')).toMatch(/already/i);
  });

  it('names the conversion path instead of letting anybody set converted by hand', () => {
    const problem = statusChangeProblem('active', 'converted', 'moving to a staff role');
    expect(problem).toMatch(/Convert/);
    expect(problem).toMatch(/chain/i);
  });

  it('tells somebody reinstating a terminated identity to issue a new one', () => {
    const problem = statusChangeProblem('terminated', 'active', 'rejoining us in August');
    expect(problem).toMatch(/NEW identity/);
    expect(statusChangeProblem('terminated', 'archived', 'closing the file')).toBe('');
  });

  // HONESTY OF THE REFUSAL, not just its existence. The sentence used to read "issue a NEW identity
  // linked to this one", which named an act NOTHING in this module performs: there is no
  // reinstateIdentity(), and convertIdentity() refuses a same-type move, so an ex-employee
  // returning as an employee cannot be given a linked identity from any surface. A refusal that
  // sends an operator to look for a button nobody wrote costs them the same search every time.
  // This test fails if the wording ever promises the link back without the code to make it.
  it('does not promise a linked reinstatement while no export can create one', () => {
    const promisesLink = /linked to this one|link(ed)? (it )?back to this/i;
    for (const from of ['terminated', 'exited'] as IdentityStatus[]) {
      const problem = statusChangeProblem(from, 'active', 'they are coming back');
      expect(problem).not.toBe('');
      const claimsLink = promisesLink.test(problem);
      const canLink = Object.keys(registry).some((k) => /^reinstate/i.test(k));
      expect(claimsLink).toBe(canLink);
    }
  });

  // Spec 25 draws notice as one-way, and this module follows the drawing rather than inventing an
  // arrow. Written down as a test so the day somebody DOES want a withdrawn resignation, the
  // decision is visible here instead of being discovered as a refusal on a live screen.
  it('treats notice as one-way: a withdrawn resignation is not a status change', () => {
    expect(canChangeStatus('notice', 'active')).toBe(false);
    expect(canChangeStatus('notice', 'on_leave')).toBe(false);
    expect(legalNextStatuses('notice')).toEqual(['exited', 'terminated']);
  });

  it('explains that active is entered from verification, not skipped into', () => {
    expect(statusChangeProblem('onboarding_pending', 'active', 'they start Monday')).toMatch(/verification/i);
  });

  it('lists what IS possible when the move is refused', () => {
    const problem = statusChangeProblem('notice', 'on_leave', 'taking leave before they go');
    expect(problem).toMatch(IDENTITY_STATUS_LABELS.exited);
    expect(problem).toMatch(IDENTITY_STATUS_LABELS.terminated);
  });

  it('refuses a status the registry does not know, in either direction', () => {
    expect(statusChangeProblem('active', 'retired', 'reason')).toMatch(/not an organizational status/i);
    expect(statusChangeProblem('gone', 'active', 'reason')).toMatch(/does not recognise/i);
  });

  it('agrees with canChangeStatus for every pair, once a reason is present', () => {
    for (const a of IDENTITY_STATUSES) {
      for (const b of IDENTITY_STATUSES) {
        const allowed = statusChangeProblem(a, b, 'a written reason') === '';
        expect(allowed).toBe(canChangeStatus(a, b));
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// RULE 3 — CONVERSION IS A NEW ROW; A MOVE WITHIN ONE TYPE IS A TRANSFER. Spec 17.6 rules 5 and 6.
// ---------------------------------------------------------------------------------------------

describe('rule 3: converting to the type somebody already holds is a transfer, and says so', () => {
  it('refuses a same-type conversion and names Transfer', () => {
    const problem = conversionProblem('active', 'employee', 'employee', 'promotion to senior');
    expect(problem).toMatch(/TRANSFER/i);
    expect(problem).toMatch(/same identity code/i);
  });

  it('allows a genuine cross-type move from a live identity', () => {
    expect(conversionProblem('active', 'intern', 'employee', 'Internship converted to a staff role.')).toBe('');
    expect(conversionProblem('on_leave', 'member', 'fellow', 'Accepted into the fellowship.')).toBe('');
  });

  it('refuses a conversion of anything that is not live', () => {
    for (const s of ['exited', 'terminated', 'archived', 'converted', 'suspended', 'notice', 'verification'] as IdentityStatus[]) {
      expect(conversionProblem(s, 'intern', 'employee', 'a reason')).not.toBe('');
    }
  });

  it('needs a written reason and a type the registry issues', () => {
    expect(conversionProblem('active', 'intern', 'employee', '')).toMatch(/written reason/i);
    expect(conversionProblem('active', 'intern', 'wizard', 'a reason')).toMatch(/not an identity type/i);
  });
});

describe('rule 3: a transfer keeps the code, and moves something', () => {
  it('allows a department move, a position move, or both', () => {
    expect(transferProblem('active', 'engineering', null, 'Moving to the platform team.')).toBe('');
    expect(transferProblem('active', null, REF, 'Promoted into an open position.')).toBe('');
    expect(transferProblem('active', 'engineering', REF, 'Both change on the same day.')).toBe('');
  });

  it('refuses a transfer that moves nothing', () => {
    expect(transferProblem('active', '', '', 'a reason')).toMatch(/has to move something/i);
  });

  it('refuses a transfer with no written reason', () => {
    expect(transferProblem('active', 'engineering', null, '')).toMatch(/written reason/i);
  });

  it('refuses to move somebody who has already left', () => {
    for (const s of IDENTITY_CLOSED) {
      expect(transferProblem(s, 'engineering', null, 'a reason')).not.toBe('');
    }
  });

  it('refuses a position reference that is not a reference', () => {
    expect(transferProblem('active', null, 'the-corner-office', 'a reason')).toMatch(/not a position reference/i);
  });

  it('allows a transfer while somebody is still in onboarding', () => {
    // The department on a selection snapshot is corrected more often than anything else here, and
    // the correction has to be possible before the person is active.
    expect(transferProblem('verification', 'design', null, 'Corrected department on the offer.')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// FILTERS, TYPES AND REFERENCES
// ---------------------------------------------------------------------------------------------

describe('the status filter groups', () => {
  it('treats all and an empty key as no predicate at all, never as "match nothing"', () => {
    expect(statusesInFilter('all')).toEqual([]);
    expect(statusesInFilter('')).toEqual([]);
  });

  it('expands each group to statuses the contract knows', () => {
    for (const [, members] of IDENTITY_STATUS_GROUPS) {
      expect(members.length).toBeGreaterThan(0);
      for (const s of members) expect(IDENTITY_STATUSES).toContain(s);
    }
  });

  it('covers every status exactly once across the groups', () => {
    const seen = IDENTITY_STATUS_GROUPS.flatMap(([, members]) => [...members]);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...IDENTITY_STATUSES].sort());
  });

  it('accepts a single status as its own filter', () => {
    expect(statusesInFilter('suspended')).toEqual(['suspended']);
    expect(statusesInFilter('live')).toEqual(['active', 'on_leave', 'notice']);
  });

  // THE ASSERTION THIS FILE USED TO GET WRONG. statusesInFilter() answers the EMPTY LIST for a key
  // it does not know — and it answers the empty list for 'all' as well, where the empty list means
  // "no status predicate, show everything". Reading the empty list alone, listIdentities() dropped
  // the predicate for BOTH, so `?status=activ` widened a filtered read into the whole registry,
  // terminated and archived people included, under a filter the operator thought was narrowing it.
  // The old test asserted the empty list and CLAIMED in its name that this "matches nothing", which
  // is the opposite of what the caller did with it: a test that mirrors the return value and
  // narrates a rule the system does not follow.
  it('answers the empty list for an unknown key, which is the same answer it gives for "all"', () => {
    expect(statusesInFilter('everything-please')).toEqual([]);
    expect(statusesInFilter('all')).toEqual([]);
  });

  it('separates "no predicate" from "not a filter at all", which the empty list cannot', () => {
    expect(isKnownStatusFilter('all')).toBe(true);
    expect(isKnownStatusFilter('')).toBe(true);
    for (const [key] of IDENTITY_STATUS_GROUPS) expect(isKnownStatusFilter(key)).toBe(true);
    for (const s of IDENTITY_STATUSES) expect(isKnownStatusFilter(s)).toBe(true);

    // The keys a hand-typed or stale query string actually produces.
    expect(isKnownStatusFilter('everything-please')).toBe(false);
    expect(isKnownStatusFilter('activ')).toBe(false);
    expect(isKnownStatusFilter('retired')).toBe(false);
    expect(isKnownStatusFilter('ACTIVE')).toBe(true);
  });

  it('every key the registry page can put in the query string is one the filter knows', () => {
    // The tabs on /admin/talent/identity. A tab whose key the filter does not recognise now matches
    // NOTHING rather than everything, so a drift between the two is an empty screen, not a leak of
    // the closed part of the registry into a live view.
    for (const key of ['live', 'onboarding', 'restricted', 'closed', 'converted', 'all']) {
      expect(isKnownStatusFilter(key)).toBe(true);
    }
  });
});

describe('the identity type a new identity is recorded as', () => {
  it('takes an explicit type when it is one the registry issues', () => {
    expect(resolveIdentityType('fellow', 'full_time')).toBe('fellow');
  });

  it('falls back to the single employment mapping when the explicit one is absent or unknown', () => {
    expect(resolveIdentityType('', 'internship')).toBe('intern');
    expect(resolveIdentityType(null, 'fellowship')).toBe('fellow');
    expect(resolveIdentityType('archmage', 'membership')).toBe('member');
    expect(resolveIdentityType(undefined, 'full_time')).toBe('employee');
  });

  it('resolves an unrecorded engagement to employee, which asks for more rather than less', () => {
    expect(resolveIdentityType(null, null)).toBe('employee');
    expect(resolveIdentityType(null, 'something nobody has typed before')).toBe('employee');
  });

  it('recognises exactly the declared identity types', () => {
    for (const t of IDENTITY_TYPES) expect(isIdentityType(t)).toBe(true);
    expect(isIdentityType('staff')).toBe(false);
  });

  // The type filter on the registry page is built from IDENTITY_TYPES, and listIdentities() now
  // treats a type it does not recognise as matching NOTHING rather than as no predicate at all —
  // the same rule as the status filter. This asserts the half that is testable without a
  // connection: which strings the query is allowed to treat as a real type filter.
  it('accepts a type filter only for a type the registry issues', () => {
    for (const t of IDENTITY_TYPES) expect(isIdentityType(String(t).toLowerCase())).toBe(true);
    expect(isIdentityType('staff')).toBe(false);
    expect(isIdentityType('employe')).toBe(false);
    expect(isIdentityType('EMPLOYEE')).toBe(false);
  });
});

describe('a reference that is not a reference is a missing record, not a broken database', () => {
  it('accepts a row id', () => {
    expect(isIdentityRef(REF)).toBe(true);
    expect(isIdentityRef(REF2)).toBe(true);
    expect(isIdentityRef(REF.toUpperCase())).toBe(true);
  });

  it('rejects a code, a truncation and an empty string', () => {
    // ERAI-EMP-002184 is what people actually hold, and it is NOT a row id.
    expect(isIdentityRef('ERAI-EMP-002184')).toBe(false);
    expect(isIdentityRef(REF.slice(0, 20))).toBe(false);
    expect(isIdentityRef('')).toBe(false);
    expect(isIdentityRef(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// THE PINNED CROSS-MODULE CONTRACT
// ---------------------------------------------------------------------------------------------

describe('the onboarding review desk resolves this module by name', () => {
  // src/lib/talent/onboarding-review.ts loads identity.ts through import.meta.glob and reads
  // createIdentityFromOnboarding off it. A rename here is a silent refusal there — the desk reports
  // "the identity registry is not part of this deployment" and no approval can complete.
  it('exports createIdentityFromOnboarding as a function taking one options object', () => {
    expect(typeof createIdentityFromOnboarding).toBe('function');
    expect(createIdentityFromOnboarding.length).toBe(1);
  });

  it('exports the reads and writes the registry desk needs', () => {
    for (const name of [
      'listIdentities', 'getIdentity', 'identityCounts', 'identityLineage',
      'createIdentityFromOnboarding', 'changeIdentityStatus', 'transferIdentity', 'convertIdentity',
    ]) {
      expect(typeof (registry as any)[name]).toBe('function');
    }
  });
});
