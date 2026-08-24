import { describe, it, expect } from 'vitest';
import { roleSchema } from '@/lib/validators';

// A complete, valid role. Individual tests override only the fields under test.
const base = {
  title: 'AI Research Intern',
  slug: 'ai-research-intern',
  departmentId: 'ai-research',
  level: 'Intern',
  function: 'Work on frontier reasoning models with senior researchers.',
  engagementType: 'Internship',
  location: 'On-site, Kolkata',
  duration: '3-6 months',
  salary: 'up to INR 3 LPA + research stipend',
  about: 'A structured internship on live research problems.',
  responsibilities: [],
  skills: [],
  eligibility: [],
  isOpen: true,
  isFeatured: false,
  sortOrder: 0,
};

const parse = (over: Record<string, unknown> = {}) => {
  const r = roleSchema.safeParse({ ...base, ...over });
  if (!r.success) throw new Error('unexpected validation failure: ' + r.error.message);
  return r.data;
};

describe('roleSchema trainee pay policy', () => {
  it('normalises the exact string that was live on /careers/ai-research-intern', () => {
    expect(parse().salary).toBe('Unpaid — internship certificate, mentorship, and real project experience');
  });

  it('normalises a row whose level and engagement disagree', () => {
    // The live shape of visvambhara-aerospace-research-engineering-intern: Intern + Full-Time.
    const out = parse({
      slug: 'visvambhara-aerospace-research-engineering-intern',
      title: 'Aerospace Research and Engineering Intern',
      engagementType: 'Full-Time',
      salary: 'Performance-Based Stipend | Research Credit | Pre-Placement Opportunity',
    });
    expect(out.salary.startsWith('Unpaid')).toBe(true);
  });

  it('writes the apprenticeship noun for an apprenticeship', () => {
    expect(parse({ level: 'Apprentice', engagementType: 'Apprenticeship', slug: 'design-apprentice' }).salary)
      .toBe('Unpaid — apprenticeship certificate, mentorship, and real project experience');
  });

  it('leaves the one paid programme alone', () => {
    const salary = 'Performance-based stipend of up to INR 2,50,000 per month, awarded on demonstrated merit';
    expect(parse({ slug: 'llm-engineering-intern', title: 'LLM Engineering Intern', salary }).salary).toBe(salary);
  });

  it('leaves a more specific unpaid line intact rather than flattening it', () => {
    // The Campus Ambassador and Extreme-Scale lines both open with "Unpaid" and say more than the
    // generic wording. The prefix is the contract; equality is not.
    const specific = 'Unpaid — certificate, verifiable credential, and fee-waiver benefits';
    expect(parse({ slug: 'campus-ambassador', title: 'Campus Ambassador', salary: specific }).salary).toBe(specific);
  });

  it('does not touch a permanent role, including one with a trainee word in its name', () => {
    const salary = 'INR 20,00,000 - 40,00,000 per annum';
    expect(parse({ slug: 'head-internal-audit', title: 'Head of Internal Audit', level: 'Lead', engagementType: 'Full-Time', salary }).salary).toBe(salary);
    expect(parse({ slug: 'staff-engineer', title: 'Staff Engineer', level: 'Lead', engagementType: 'Full-Time', salary }).salary).toBe(salary);
  });

  it('still rejects what it rejected before - the transform does not swallow validation', () => {
    expect(roleSchema.safeParse({ ...base, slug: 'Not A Slug' }).success).toBe(false);
    expect(roleSchema.safeParse({ ...base, engagementType: 'Freelance' }).success).toBe(false);
    expect(roleSchema.safeParse({ ...base, title: 'x' }).success).toBe(false);
  });
});
