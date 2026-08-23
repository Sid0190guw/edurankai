// src/lib/xscale/taxonomy.test.ts — the rules that stop this department misrepresenting itself.
//
// These are not coverage tests. Each one pins a claim the department makes in public, and would fail
// if a later edit quietly widened it: that a scale range never reads as experimental reach, that a
// closed posting cannot accept an application, and that no generated job description contains the
// vague requirement language the brief forbids.
import { describe, it, expect } from 'vitest';
import {
  CAREER_LADDER, JOB_STATUSES, RESEARCH_CLASSIFICATIONS, SCALE_BANDS, SKILL_CATEGORIES,
  allowedTransitions, bandsForRange, categoriesForSkills, classificationEvidence, clampExp,
  effectiveJobStatus, expText, jobStatusDef, rangeIsExperimentallyAccessible, roleLevelForRung,
  scaleRangeText, SCALE_DISCLAIMER,
} from './taxonomy';
import {
  XSCALE_DIVISIONS, XSCALE_ROLES, XSCALE_DEPARTMENT, XSCALE_ROLE_COUNT,
} from '@/data/xscale-catalog';

describe('scale bands', () => {
  it('cover the whole declared span with no gap', () => {
    for (let i = 1; i < SCALE_BANDS.length; i++) {
      expect(SCALE_BANDS[i].minExp).toBe(SCALE_BANDS[i - 1].maxExp);
    }
    expect(SCALE_BANDS[0].minExp).toBe(-100);
    expect(SCALE_BANDS[SCALE_BANDS.length - 1].maxExp).toBe(100);
  });

  it('mark the two experimentally unreachable ends as unreachable', () => {
    // Below the Planck length and beyond the observable universe. If either of these ever flips to
    // true, the department starts advertising reach it does not have.
    expect(SCALE_BANDS.find((b) => b.id === 'BAND_01')!.experimentallyAccessible).toBe(false);
    expect(SCALE_BANDS.find((b) => b.id === 'BAND_02')!.experimentallyAccessible).toBe(false);
    expect(SCALE_BANDS.find((b) => b.id === 'BAND_11')!.experimentallyAccessible).toBe(false);
  });

  it('resolve a range to every band it overlaps', () => {
    expect(bandsForRange(-9, -6).map((b) => b.id)).toEqual(['BAND_05']);
    expect(bandsForRange(-9, -3).map((b) => b.id)).toEqual(['BAND_05', 'BAND_06']);
    // The whole declared span touches all eleven.
    expect(bandsForRange(-100, 100).length).toBe(SCALE_BANDS.length);
  });

  it('does not drop a range declared exactly at the top of the span', () => {
    expect(bandsForRange(100, 100).length).toBeGreaterThan(0);
  });

  it('clamps out-of-range exponents rather than publishing them', () => {
    expect(clampExp(9999)).toBe(100);
    expect(clampExp(-9999)).toBe(-100);
    expect(clampExp(Number.NaN)).toBe(0);
  });

  it('formats ranges in ASCII, with no arrow or superscript characters', () => {
    const s = scaleRangeText(-9, -6);
    expect(s).toBe('10^-9 m to 10^-6 m');
    // Arrows and superscripts have broken .astro parsing on this project before.
    expect(/[←-⇿⁰-₟]/.test(s)).toBe(false);
    expect(expText(-35)).toBe('10^-35 m');
  });
});

describe('evidential standing', () => {
  it('never reports work below the Planck length as anything but speculative', () => {
    // Even COMPUTATIONAL, whose own default is "computational research on established physics".
    const ev = classificationEvidence('COMPUTATIONAL', -100, -35);
    expect(ev?.key).toBe('speculative');
  });

  it('never reports work beyond the observable universe as established', () => {
    const ev = classificationEvidence('APPLIED_ENGINEERING', 30, 100);
    expect(ev?.key).toBe('speculative');
  });

  it('leaves an accessible range at its classification default', () => {
    expect(classificationEvidence('EXPERIMENTAL', -9, -6)?.key).toBe('experimental');
    expect(classificationEvidence('APPLIED_ENGINEERING', 0, 3)?.key).toBe('established');
  });

  it('can only weaken a claim, never strengthen one', () => {
    // Long-horizon frontier work stays speculative even in a band instruments reach.
    expect(classificationEvidence('LONG_HORIZON_FRONTIER', -9, -6)?.key).toBe('speculative');
  });

  it('agrees with rangeIsExperimentallyAccessible at the boundaries', () => {
    expect(rangeIsExperimentallyAccessible(-100, -35)).toBe(false);
    expect(rangeIsExperimentallyAccessible(-18, -12)).toBe(true);
    expect(rangeIsExperimentallyAccessible(26, 100)).toBe(false);
  });
});

describe('job status', () => {
  it('lets only PUBLISHED accept an application', () => {
    for (const s of JOB_STATUSES) {
      expect(s.acceptsApplications).toBe(s.key === 'PUBLISHED');
    }
  });

  it('closes a posting whose deadline has passed, whatever the column says', () => {
    const past = new Date(Date.now() - 86400000);
    const status = effectiveJobStatus({ jobStatus: 'PUBLISHED', isOpen: true, applicationDeadline: past });
    expect(status.acceptsApplications).toBe(false);
    expect(status.key).toBe('CLOSED');
    expect(status.publicNote).toMatch(/deadline/i);
  });

  it('keeps a posting open when the deadline is still ahead', () => {
    const future = new Date(Date.now() + 86400000);
    expect(effectiveJobStatus({ jobStatus: 'PUBLISHED', isOpen: true, applicationDeadline: future }).acceptsApplications).toBe(true);
  });

  it('falls back to is_open for a row written before job_status existed', () => {
    expect(effectiveJobStatus({ jobStatus: null, isOpen: false }).key).toBe('CLOSED');
    expect(effectiveJobStatus({ jobStatus: null, isOpen: true }).key).toBe('PUBLISHED');
  });

  it('keeps a closed posting reachable so a candidate is told, not 404-ed', () => {
    expect(jobStatusDef('CLOSED')!.publiclyVisible).toBe(true);
    expect(jobStatusDef('CLOSED')!.listed).toBe(false);
    expect(jobStatusDef('PAUSED')!.publiclyVisible).toBe(true);
    // A draft is not reachable at all — an unfinished advertisement is not an advertisement.
    expect(jobStatusDef('DRAFT')!.publiclyVisible).toBe(false);
    expect(jobStatusDef('ARCHIVED')!.publiclyVisible).toBe(false);
  });

  it('offers no transition that skips review of a published posting', () => {
    expect(allowedTransitions('PUBLISHED')).not.toContain('DRAFT');
    expect(allowedTransitions('DRAFT')).toContain('PUBLISHED');
  });
});

describe('career ladder', () => {
  it('has eleven rungs, 0 to 10, each mapping onto an existing role level', () => {
    expect(CAREER_LADDER.map((r) => r.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const valid = ['C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice'];
    for (const r of CAREER_LADDER) expect(valid).toContain(r.roleLevel);
    expect(roleLevelForRung(1)).toBe('Intern');
    expect(roleLevelForRung(10)).toBe('C-Level');
  });
});

describe('skill taxonomy', () => {
  it('has the nineteen top-level categories the department is organised by', () => {
    expect(SKILL_CATEGORIES.length).toBe(19);
    for (const c of SKILL_CATEGORIES) expect(c.skills.length).toBeGreaterThan(0);
  });

  it('maps a skill string back to its category', () => {
    expect(categoriesForSkills(['CUDA and GPU computing'])).toContain('SCIENTIFIC_COMPUTING');
    expect(categoriesForSkills(['Topology'])).toContain('MATHEMATICS');
    expect(categoriesForSkills(['nothing in the taxonomy'])).toEqual([]);
  });
});

describe('the generated catalogue', () => {
  it('has fifteen divisions and a posting in every one of them', () => {
    expect(XSCALE_DIVISIONS.length).toBe(15);
    for (const d of XSCALE_DIVISIONS) {
      const mine = XSCALE_ROLES.filter((r) => r.divisionId === d.id);
      expect(mine.length).toBeGreaterThan(0);
    }
  });

  it('gives every posting a unique slug', () => {
    const seen = new Set<string>();
    for (const r of XSCALE_ROLES) {
      expect(seen.has(r.slug)).toBe(false);
      seen.add(r.slug);
    }
    expect(seen.size).toBe(XSCALE_ROLE_COUNT);
  });

  it('never exceeds the column widths the roles table declares', () => {
    for (const r of XSCALE_ROLES) {
      expect(r.slug.length).toBeLessThanOrEqual(200);
      expect(r.title.length).toBeLessThanOrEqual(200);
      expect(r.function.length).toBeLessThanOrEqual(300);
      expect(r.location.length).toBeLessThanOrEqual(100);
      expect(r.duration.length).toBeLessThanOrEqual(50);
      expect(r.salary.length).toBeLessThanOrEqual(300);
    }
  });

  it('classifies every posting and gives it a scale range inside the declared span', () => {
    const keys = RESEARCH_CLASSIFICATIONS.map((c) => c.key);
    for (const r of XSCALE_ROLES) {
      expect(keys).toContain(r.researchClassification as any);
      expect(r.scaleMinExp).toBeGreaterThanOrEqual(-100);
      expect(r.scaleMaxExp).toBeLessThanOrEqual(100);
      expect(r.scaleMinExp).toBeLessThanOrEqual(r.scaleMaxExp);
    }
  });

  it('carries the scale disclaimer in the STORED text of every posting', () => {
    // Not only in the page chrome. Everything that renders a role renders `about` — the existing job
    // detail page, the JSON feed, an admin preview — and the honesty has to travel with the row.
    for (const r of XSCALE_ROLES) {
      expect(r.about).toContain(SCALE_DISCLAIMER);
    }
  });

  it('imports every posting as a DRAFT rather than publishing the catalogue on one click', () => {
    for (const r of XSCALE_ROLES) expect(r.jobStatus).toBe('DRAFT');
  });

  it('never writes a vague requirement', () => {
    // The brief forbids requirements like "passionate about science" by name. This is the check that
    // keeps a later edit from reintroducing them one bullet at a time.
    const banned = [
      /passionate about/i, /rock ?star/i, /ninja/i, /guru/i, /self-starter/i,
      /think outside the box/i, /wear many hats/i, /strong desire to learn/i,
      /excellent communication skills\.?$/i,
    ];
    for (const r of XSCALE_ROLES) {
      const text = [...r.skills, ...r.eligibility, ...(r.preferredSkills || []), ...r.responsibilities].join(' | ');
      for (const b of banned) {
        expect(b.test(text)).toBe(false);
      }
    }
  });

  it('states measurable requirements: every must-have skill list is non-trivial', () => {
    for (const r of XSCALE_ROLES) {
      expect(r.skills.length).toBeGreaterThanOrEqual(5);
      expect(r.responsibilities.length).toBeGreaterThanOrEqual(5);
      expect(r.eligibility.length).toBeGreaterThanOrEqual(4);
      expect(r.deliverables.length).toBeGreaterThan(0);
      expect(r.evaluationCriteria.length).toBeGreaterThan(0);
    }
  });

  it('quotes no fabricated salary figure on a permanent research role', () => {
    // PART 15: do not generate misleading salary data. A digit in this string is parsed into Google
    // Jobs structured data by the job detail page, so a made-up band becomes a public claim.
    for (const r of XSCALE_ROLES) {
      if (r.engagementType === 'Internship') {
        // The detail page tests this exact prefix to decide whether to say "this is a paid internship".
        expect(r.salary.startsWith('Unpaid')).toBe(true);
      } else {
        expect(/\d/.test(r.salary)).toBe(false);
      }
    }
  });

  it('promises no equity or ownership share anywhere in the compensation text', () => {
    for (const r of XSCALE_ROLES) {
      expect(/\b(equity|esop|stock option|profit share)\b/i.test(r.salary)).toBe(
        /no equity/i.test(r.salary) ? true : false,
      );
      // And where the words appear at all, they appear as a denial.
      if (/\bequity\b/i.test(r.salary)) expect(/no equity/i.test(r.salary)).toBe(true);
    }
  });

  it('names no real company or competitor in any posting', () => {
    const forbidden = /\b(coursera|udemy|edx|byju|unacademy|google|microsoft|amazon|meta|openai|anthropic|nvidia|intel|ibm|tsmc|samsung)\b/i;
    for (const r of XSCALE_ROLES) {
      const text = [r.title, r.about, r.function, ...r.responsibilities, ...r.skills, ...(r.tools || [])].join(' ');
      expect(forbidden.test(text)).toBe(false);
    }
  });

  it('uses no emoji anywhere in the catalogue', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const r of XSCALE_ROLES) {
      const text = [r.title, r.about, r.function, ...r.responsibilities, ...r.skills].join(' ');
      expect(emoji.test(text)).toBe(false);
    }
    expect(emoji.test(XSCALE_DEPARTMENT.description)).toBe(false);
  });

  it('gives every division an integrity note that reaches the posting', () => {
    for (const d of XSCALE_DIVISIONS) {
      expect(d.integrityNote.length).toBeGreaterThan(80);
      const mine = XSCALE_ROLES.filter((r) => r.divisionId === d.id);
      for (const r of mine) expect(r.integrityNote).toContain(d.integrityNote);
    }
  });

  it('staffs the ladder rather than mechanically generating every rung in every division', () => {
    // The brief says not to create every level for every speciality where it would be meaningless.
    // This asserts the catalogue is genuinely uneven: no division carries all eleven rungs.
    for (const d of XSCALE_DIVISIONS) {
      const rungs = new Set(XSCALE_ROLES.filter((r) => r.divisionId === d.id).map((r) => r.careerLevel));
      expect(rungs.size).toBeLessThan(CAREER_LADDER.length);
    }
  });
});
