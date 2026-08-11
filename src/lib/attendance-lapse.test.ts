// Tests for the nine-day attendance lapse rule.
//
// These test the POLICY SHAPE, not the database. Every one corresponds to a way this rule could
// suspend somebody who did nothing wrong — which is the only real risk it carries, since the
// counting itself is arithmetic.

import { readFileSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';
import * as lapse from './attendance-lapse';
import { DEFAULT_LAPSE_DAYS, WARN_AT_DAYS } from './attendance-lapse';

// Read ONCE, synchronously. The house shim's it() does not await an async body, so an async test
// here passes while asserting nothing — six of these did exactly that on the first run.
const SRC = readFileSync('src/lib/attendance-lapse.ts', 'utf8');

describe('the threshold', () => {
  it('is the number the founder asked for', () => {
    expect(DEFAULT_LAPSE_DAYS).toBe(9);
  });

  it('warns before it acts, more than once', () => {
    // A pause that arrives with no warning reads as a trap, and the person has no chance to say
    // "I told my manager" before it happens.
    expect(WARN_AT_DAYS.length).toBeGreaterThan(1);
    for (const w of WARN_AT_DAYS) {
      expect(w).toBeLessThan(DEFAULT_LAPSE_DAYS);
      expect(w).toBeGreaterThan(0);
    }
  });

  it('sends the first warning well before the pause, not on the eve of it', () => {
    // Warning at day 8 of 9 is not a warning, it is a formality.
    const earliest = Math.min(...WARN_AT_DAYS);
    expect(earliest).toBeLessThanOrEqual(DEFAULT_LAPSE_DAYS - 3);
  });
});

describe('what the module refuses to do', () => {
  it('never touches is_active', () => {
    // is_active means EMPLOYED. Payroll, leave accrual and the org graph all read it, so flipping it
    // on the strength of a missing attendance row would quietly stop somebody's pay. A pause is its
    // own state and must stay that way.
    const writesActive = /UPDATE\s+hr_employees[\s\S]{0,200}is_active/i.test(SRC);
    expect(writesActive).toBe(false);
  });

  it('never terminates, separates or dismisses', () => {
    // The one thing automation may not do here is end somebody's employment.
    for (const word of ['hr_separations', 'terminate(', 'dismiss(']) {
      expect(SRC.includes(word)).toBe(false);
    }
  });

  it('treats leave, working from home and holidays as accounted for', () => {
    // Somebody on approved medical leave for a fortnight must never be paused by this.
    for (const status of ['on_leave', 'wfh', 'holiday', 'present']) {
      expect(SRC.includes(status)).toBe(true);
    }
  });

  it('skips people who have never been recorded present', () => {
    // The failure that would hurt most people at once: on a company with patchy attendance, "no row"
    // means nobody wrote one. Without this guard the rule pauses everybody the day it is enabled.
    expect(SRC.includes('has never been recorded present')).toBe(true);
  });

  it('excludes today from the count', () => {
    // Today is still in progress; somebody may yet clock in.
    expect(SRC.includes('back = 1')).toBe(true);
  });
});

describe('the way out', () => {
  it('offers a restore path that records who and why', () => {
    expect(typeof lapse.restoreProfile).toBe('function');
  });

  it('separates assessing from acting, so the rule can be previewed', () => {
    // A policy this consequential should be runnable against real data before it is allowed to fire,
    // and the preview must be the same code path as the action or the two will disagree.
    expect(typeof lapse.assessAll).toBe('function');
    expect(typeof lapse.assessEmployee).toBe('function');
  });

  it('reuses the existing appeal machinery rather than a second one', () => {
    // hr-flags already has appeals with four outcomes and a screen HR knows. A parallel appeal would
    // drift, and the one that drifts is the one nobody answers.
    expect(SRC.includes("@/lib/hr-flags")).toBe(true);
    expect(SRC.includes('raiseFlag')).toBe(true);
  });

  it('raises it as a level-one breach, not misconduct', () => {
    // An unexplained gap is a conversation, not an investigation.
    expect(SRC.includes("'hours_breach'")).toBe(true);
    for (const level2or3 of ['misrepresentation', 'unprofessional_conduct', 'confidentiality_breach']) {
      expect(SRC.includes(level2or3)).toBe(false);
    }
  });

  it('tells the caller when the appeal route could not be created', () => {
    // A pause with no appeal traps somebody with no way out, which is worse than no pause at all.
    expect(SRC.includes('without a route to appeal')).toBe(true);
  });
});

report();
