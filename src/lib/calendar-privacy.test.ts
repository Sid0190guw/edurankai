// Regression tests for the calendar health-data exposure.
//
// THE DEFECT. The shared/team calendar rendered the leave TYPE next to an identified person:
//
//     "Priya Sharma - Sick leave"
//     "Priya Sharma - Maternity leave"
//
// on a colleague's screen. That is health information about a named individual — and maternity is
// reproductive health information — disclosed to somebody with no clinical relationship, no consent
// record, and none of the MIN_GROUP suppression the wellness surfaces apply, because a per-person
// calendar row is not an aggregate.
//
// It also contradicted a decision already taken elsewhere in the codebase: hr-events.ts deliberately
// refuses to carry the leave type into an event payload for exactly this reason. A calendar that
// leaked what the event bus was careful not to carry made that decision meaningless.
//
// THE RULE, which these tests exist to hold:
//
//     Own calendar        -> the leave type may be named. It is the person's own information.
//     Someone else's      -> identity and availability only. Never the reason.
//
// The test is written against every leave type the product defines rather than against a hand-
// picked pair, so a type added later is covered the day it is added rather than the day it leaks.
import { describe, it, expect } from 'vitest';
import { leaveEventTitle } from '@/lib/calendar-hub';
import { LEAVE_TYPES } from '@/lib/hr-leave';

const NAME = 'Priya Sharma';

/** Words that must never reach another person's screen alongside an identity. */
const FORBIDDEN = [
  'sick', 'medical', 'maternity', 'paternity', 'miscarriage', 'menstrual', 'period',
  'bereavement', 'compassionate', 'mental', 'health', 'therapy', 'surgery', 'fertility',
  'adoption', 'disability', 'injury', 'illness',
];

describe('shared calendar: leave reasons are not disclosed', () => {
  it('shows identity and availability only, for every leave type the product defines', () => {
    for (const t of LEAVE_TYPES) {
      const title = leaveEventTitle(t.id, NAME, true);
      expect(title, `leave type "${t.id}" leaked into a shared title`).toBe(`${NAME} - Away`);
    }
  });

  it('leaks no sensitive word for any defined type, checked against the vocabulary not the format', () => {
    for (const t of LEAVE_TYPES) {
      const lower = leaveEventTitle(t.id, NAME, true).toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower.includes(word), `"${word}" appeared in the shared title for "${t.id}"`).toBe(false);
      }
    }
  });

  it('leaks nothing for an unknown or future leave type either', () => {
    // The guard must be structural, not a list of known-bad types. A type added to the database by
    // a migration this code has never heard of has to be safe by default.
    for (const invented of ['gender_affirmation', 'ivf_treatment', 'oncology_followup', 'whatever_comes_next']) {
      expect(leaveEventTitle(invented, NAME, true)).toBe(`${NAME} - Away`);
    }
  });

  it('still says somebody is away when the name is missing', () => {
    // Losing the name must degrade to "Away", never to the leave type — a missing join is exactly
    // when a fallback slips through.
    expect(leaveEventTitle('sick', null, true)).toBe('Away');
    expect(leaveEventTitle('maternity', null, true)).toBe('Away');
  });

  it('does not render the person\'s name into their own calendar entry', () => {
    // The own-calendar branch is keyed off the same flag; if it ever started receiving a name, the
    // title would be the leaked format again.
    expect(leaveEventTitle('sick', NAME, false)).not.toContain(NAME);
  });
});

describe('own calendar: the person sees their own information', () => {
  it('names the leave type on the person\'s own calendar', () => {
    expect(leaveEventTitle('sick', null, false)).toBe('Sick leave');
    expect(leaveEventTitle('maternity', null, false)).toBe('Maternity leave');
    expect(leaveEventTitle('casual', null, false)).toBe('Casual leave');
  });

  it('formats an underscored type readably', () => {
    expect(leaveEventTitle('comp_off', null, false)).toBe('Comp off leave');
  });

  it('falls back to a generic word rather than an empty title', () => {
    expect(leaveEventTitle('', null, false)).toBe('Leave');
  });
});

describe('the guard cannot be satisfied by a cosmetic change', () => {
  it('the shared title is independent of the type argument entirely', () => {
    // Any implementation that reads `type` in the withNames branch fails this: two different types
    // must be indistinguishable on somebody else's screen.
    const a = leaveEventTitle('sick', NAME, true);
    const b = leaveEventTitle('annual', NAME, true);
    const c = leaveEventTitle('maternity', NAME, true);
    expect(new Set([a, b, c]).size).toBe(1);
  });
});
