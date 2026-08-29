import { describe, it, expect } from 'vitest';
import {
  stripOwnershipPromise,
  publicCompensation,
  isTraineeRole,
  isPaidTrainee,
  isUnpaidTrainee,
  stripTraineePayProse,
  stripTraineePayItems,
  offerCompensationFor, UNPAID_APPRENTICE_SALARY,
} from '@/lib/compensation-text';

describe('stripOwnershipPromise', () => {
  it('returns null for empty input', () => {
    expect(stripOwnershipPromise(null)).toBeNull();
    expect(stripOwnershipPromise(undefined)).toBeNull();
    expect(stripOwnershipPromise('   ')).toBeNull();
  });

  it('passes a clean pay string through byte-for-byte', () => {
    const clean = 'INR 20,00,000 - 40,00,000 per annum';
    expect(stripOwnershipPromise(clean)).toBe(clean);
  });

  it('drops a trailing equity clause', () => {
    expect(stripOwnershipPromise('up to INR 120 LPA + equity')).toBe('up to INR 120 LPA');
  });

  it('keeps a salary range intact instead of splitting on its hyphen', () => {
    // The regression this function exists to prevent: an earlier version split on " - " and " and "
    // and emitted "INR 50 LPA - 95 LPA base and expected contribution".
    const stored =
      'INR 50 LPA - 95 LPA base + meaningful equity. Compensation is commensurate with experience, ' +
      'capabilities, and expected contribution; the equity component is intentionally generous ' +
      'because the role compounds.';
    expect(stripOwnershipPromise(stored)).toBe('INR 50 LPA - 95 LPA base');
  });

  it('drops an equity clause from the middle and rejoins the survivors', () => {
    expect(
      stripOwnershipPromise(
        'Senior package + Top-quartile for Bharat-based AI startups + Significant ESOP allocation + Reviewed annually',
      ),
    ).toBe('Senior package + Top-quartile for Bharat-based AI startups + Reviewed annually');
  });

  it('strips a revenue share promised to an unpaid intern', () => {
    expect(
      stripOwnershipPromise(
        'Unpaid + Revenue Share on the product you ship + Fast-track to ESOP-eligible Founder Office role on exceptional contribution',
      ),
    ).toBe('Unpaid');
  });

  it('strips discretionary net-profit sharing from a public listing', () => {
    expect(
      stripOwnershipPromise(
        'Full-time compensation discussed individually with shortlisted candidates + Discretionary net-profit sharing for extraordinary C-level contribution',
      ),
    ).toBe('Full-time compensation discussed individually with shortlisted candidates');
  });

  it('returns null rather than publish a promise it cannot cut cleanly', () => {
    expect(stripOwnershipPromise('equity')).toBeNull();
    expect(stripOwnershipPromise('Generous ESOP allocation reviewed annually')).toBeNull();
  });

  it('does not mistake "budget shared openly" for a share of the firm', () => {
    const stored = 'Senior package + Market context and budget shared openly + Reviewed annually';
    expect(stripOwnershipPromise(stored)).toBe(stored);
  });

  it('leaves product ownership alone - it is responsibility, not a stake', () => {
    const stored = 'Unpaid + Full ownership of the product you ship + Direct Founder Office mentorship';
    expect(stripOwnershipPromise(stored)).toBe(stored);
  });

  it('handles an equity clause bounded on both sides', () => {
    expect(stripOwnershipPromise('Up to INR 60 LPA + program equity-share + performance bonus on outcomes'))
      .toBe('Up to INR 60 LPA + performance bonus on outcomes');
  });
});

describe('trainee pay policy', () => {
  const AI_RESEARCH_INTERN = {
    slug: 'ai-research-intern',
    level: 'Intern',
    engagementType: 'Internship',
    // The exact string that was live on /careers/ai-research-intern.
    salary: 'up to INR 3 LPA + research stipend',
  };
  const LLM_FLAGSHIP = {
    slug: 'llm-engineering-intern',
    level: 'Intern',
    engagementType: 'Internship',
    salary: 'Performance-based stipend of up to INR 2,50,000 per month (India) or CHF 25,000 per month (overseas interns), awarded on demonstrated merit',
  };

  it('publishes nothing for an intern role whose stored row claims a stipend', () => {
    expect(publicCompensation(AI_RESEARCH_INTERN)).toBeNull();
  });

  it('publishes the stipend for the one paid programme', () => {
    expect(publicCompensation(LLM_FLAGSHIP)).toBe(LLM_FLAGSHIP.salary);
  });

  it('holds for an apprenticeship, and whichever field marks the engagement', () => {
    expect(publicCompensation({ slug: 'x', level: 'Apprentice', salary: 'INR 30,000 per month' })).toBeNull();
    expect(publicCompensation({ slug: 'x', engagementType: 'Internship', salary: 'INR 30,000 per month' })).toBeNull();
    expect(publicCompensation({ slug: 'x', level: 'intern', salary: 'INR 30,000 per month' })).toBeNull();
  });

  it('leaves permanent roles alone, ownership promises still stripped', () => {
    const senior = { slug: 'senior-ai-engineer', level: 'Senior', engagementType: 'Full-Time', salary: 'INR 50 LPA - 95 LPA base + equity' };
    expect(publicCompensation(senior)).toBe('INR 50 LPA - 95 LPA base');
  });

  it('recognises a trainee by level, engagement type, title or slug', () => {
    expect(isTraineeRole({ level: 'Intern' })).toBe(true);
    expect(isTraineeRole({ engagementType: 'Apprenticeship' })).toBe(true);
    expect(isTraineeRole({ level: 'Junior', engagementType: 'Full-Time' })).toBe(false);
    expect(isTraineeRole(null)).toBe(false);
    // Live row: level Intern, engagementType Full-Time. Reading either field alone gets it wrong.
    expect(isTraineeRole({ slug: 'visvambhara-aerospace-research-engineering-intern', level: 'Intern', engagementType: 'Full-Time' })).toBe(true);
    expect(isTraineeRole({ slug: 'x', title: 'Aerospace Research and Engineering Intern', level: '', engagementType: 'Full-Time' })).toBe(true);
    // The prefix is not the word.
    expect(isTraineeRole({ slug: 'internal-auditor', title: 'Internal Auditor', level: 'Mid', engagementType: 'Full-Time' })).toBe(false);
    expect(isTraineeRole({ slug: 'head-internal-audit', title: 'Head of Internal Audit', level: 'Lead', engagementType: 'Full-Time' })).toBe(false);
  });

  it('hides the pay band on a mislabelled intern posting', () => {
    expect(publicCompensation({
      slug: 'visvambhara-aerospace-research-engineering-intern',
      level: 'Intern',
      engagementType: 'Full-Time',
      salary: 'Performance-Based Stipend | Research Credit | Pre-Placement Opportunity',
    })).toBeNull();
  });

  it('allowlists exactly one slug', () => {
    expect(isPaidTrainee('llm-engineering-intern')).toBe(true);
    expect(isPaidTrainee('LLM-Engineering-Intern')).toBe(true);
    expect(isPaidTrainee('llm-engineer-intern')).toBe(false);
    expect(isPaidTrainee('ai-research-intern')).toBe(false);
    expect(isPaidTrainee(null)).toBe(false);
  });
});

describe('pay claims in prose', () => {
  // The exact sentence that was live on /careers/ai-research-intern, built by
  // .dev-scripts/seed-hiring-posts.cjs interpolating the salary into `about`.
  const ABOUT = 'About this role: AI Research Intern — up to ₹3 LPA + research stipend. '
    + 'Internship, 8 hours per day. Part-time options are available — see the Career page for details.';

  it('drops the sentence that carries the pay claim and keeps the rest', () => {
    const out = stripTraineePayProse(ABOUT);
    expect(out).not.toMatch(/3 LPA|research stipend/);
    expect(out).toContain('8 hours per day');
    expect(out).toContain('Part-time options are available');
  });

  it('leaves prose with no pay claim byte-for-byte alone', () => {
    const clean = 'You will work alongside researchers on live problems. Expect to read papers weekly.';
    expect(stripTraineePayProse(clean)).toBe(clean);
  });

  it('never removes a sentence that says the role is unpaid', () => {
    const honest = 'This is an unpaid internship. There is no stipend of any amount, not 1 rupee.';
    expect(stripTraineePayProse(honest)).toBe(honest);
  });

  it('drops the CHF bullet that was live on /careers/ui-ux-design-intern', () => {
    const perks = [
      'Certificate of completion',
      'Stipend of up to 1,000 CHF during the internship period.',
      'Performance-Based Bonus',
      'Letter of recommendation',
    ];
    expect(stripTraineePayItems(perks)).toEqual([
      'Certificate of completion',
      'Performance-Based Bonus',
      'Letter of recommendation',
    ]);
  });

  it('catches the shapes these rows actually use', () => {
    for (const claim of [
      'Full-time stipend: up to ₹25,000/mo for the duration.',
      'Stipend: INR 15,000 - 35,000 per month.',
      'Up to 1,000 CHF plus a performance bonus.',
      'You may be awarded up to USD 1,000 per month.',
    ]) {
      expect(stripTraineePayProse(claim)).toBe('');
    }
  });

  it('keeps paragraph structure rather than collapsing the copy', () => {
    const text = 'First para stands.\n\nSecond para pays ₹3 LPA.\n\nThird para stands.';
    const out = stripTraineePayProse(text);
    expect(out).toBe('First para stands.\n\nThird para stands.');
  });

  it('applies to unpaid trainees only', () => {
    expect(isUnpaidTrainee({ slug: 'ai-research-intern', level: 'Intern' })).toBe(true);
    expect(isUnpaidTrainee({ slug: 'llm-engineering-intern', level: 'Intern' })).toBe(false);
    expect(isUnpaidTrainee({ slug: 'staff-engineer', level: 'Lead', engagementType: 'Full-Time' })).toBe(false);
  });

  it('handles empty and non-array input without throwing', () => {
    expect(stripTraineePayProse(null)).toBe('');
    expect(stripTraineePayProse(undefined)).toBe('');
    expect(stripTraineePayItems(null)).toEqual([]);
    expect(stripTraineePayItems('not an array')).toEqual([]);
  });
});


// THE OFFER PATH HAD NO GUARD AT ALL. publicCompensation()/isTraineeRole() were imported by the
// careers pages, the jobs feed and the apply form - and by nothing in the offer path. These pin the
// policy on the document the candidate actually signs.
describe('offerCompensationFor', () => {
  const INTERN = { level: 'Intern', engagementType: 'Internship', title: 'Research Intern', slug: 'research-intern' };

  it('refuses to state a stipend on an unpaid internship, whatever was typed', () => {
    expect(offerCompensationFor(INTERN, 'INR 30L')).toMatch(/^Unpaid/);
    expect(offerCompensationFor(INTERN, '25 LPA INR')).toMatch(/^Unpaid/);
    expect(offerCompensationFor(INTERN, 'stipend of 25,000/mo')).toMatch(/^Unpaid/);
  });

  // The exact production shape isTraineeRole was written for: level says Intern, engagement says
  // Full-Time. The old one-field test on the offer form read level alone and let this through.
  it('catches a trainee whose engagementType disagrees with its level', () => {
    const odd = { level: 'Intern', engagementType: 'Full-Time', title: 'Aerospace Research Engineering Intern', slug: 'visvambhara-aerospace-research-engineering-intern' };
    expect(offerCompensationFor(odd, '25 LPA INR')).toMatch(/^Unpaid/);
  });

  it('catches a trainee identified only by its title or slug', () => {
    expect(offerCompensationFor({ title: 'Design Intern' }, 'INR 30L')).toMatch(/^Unpaid/);
    expect(offerCompensationFor({ slug: 'design-intern' }, 'INR 30L')).toMatch(/^Unpaid/);
  });

  it('says apprenticeship, not internship, for an apprentice', () => {
    expect(offerCompensationFor({ level: 'Apprentice' }, 'INR 5L')).toBe(UNPAID_APPRENTICE_SALARY);
  });

  // The single exception, and it is decided by the slug allowlist and nothing else.
  it('leaves the one paid internship alone', () => {
    const paid = { level: 'Intern', engagementType: 'Internship', title: 'LLM Engineering Intern', slug: 'llm-engineering-intern' };
    expect(offerCompensationFor(paid, 'INR 60,000 per month')).toBe('INR 60,000 per month');
  });

  it('leaves a permanent role exactly as typed', () => {
    const perm = { level: 'Senior', engagementType: 'Full-Time', title: 'Staff Engineer', slug: 'staff-engineer' };
    expect(offerCompensationFor(perm, 'INR 45L')).toBe('INR 45L');
  });

  // Already unpaid, possibly in more specific words than the generic line: not overwritten.
  it('keeps a more specific unpaid wording', () => {
    const specific = 'Unpaid - certificate, mentorship and a verifiable credential';
    expect(offerCompensationFor(INTERN, specific)).toBe(specific);
  });

  // An unknown slug must land on the unpaid side, because that is the only safe direction here.
  it('treats a trainee with no slug as unpaid rather than as an exception', () => {
    expect(offerCompensationFor({ level: 'Intern' }, 'INR 30L')).toMatch(/^Unpaid/);
  });
});
