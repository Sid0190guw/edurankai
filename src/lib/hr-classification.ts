// Worker Classification Register — per Global HR Framework §2.1.
// Every person engaged by the group must be classified correctly. Wrong
// classification (e.g. calling an employee a contractor) is the single biggest
// compliance risk in the lifecycle. Auto-bootstraps a column on hr_employees
// and exposes a structured matrix.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[hr-classification] ' + tag, e?.cause?.message || e?.message);

/**
 * Add the classification columns to hr_employees if they are absent. Idempotent.
 *
 * WAS a hand-rolled `let ready` memo with `catch (_) {}` inside it: the failure was never logged AND
 * the resolved promise was cached for the life of the process, so one transient error left every
 * classification read selecting a column that does not exist — for as long as the server ran, with
 * nothing in the log. Wrong worker classification is described at the top of this file as the single
 * biggest compliance risk in the lifecycle, which is not a thing to fail silently about. ensureOnce()
 * drops a failed run so the next request retries; the catch names the reason and re-throws so it does.
 */
export function ensureClassificationSchema(): Promise<void> {
  return ensureOnce('hr_classification_v1', async () => {
    try {
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification VARCHAR(40) DEFAULT 'permanent'`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS country_of_work VARCHAR(80) DEFAULT 'IN'`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS engaged_via VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_by UUID`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hre_classification_idx ON hr_employees(classification, country_of_work)`);
    } catch (e: any) {
      logFail('ensureClassificationSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// THE SPINE. Every other engagement vocabulary in this repository is a derivation of this one.
// -------------------------------------------------------------------------------------------------
// There are already five ways this codebase names an engagement — this map, ENGAGEMENT_VIAS below,
// the free text in hr_employees.employment_type, EngagementTypeName in src/lib/engagement-policy.ts
// and EngagementKind in src/lib/offer-templates.ts. A sixth would not help anybody. THIS is the one
// with the legal meaning attached (a risk rating per key), so it is the one that decides things:
// src/lib/onboarding-packs.ts keys its step packs off these keys and nothing else.
//
// THREE KEYS WERE MISSING AND THEIR ABSENCE WAS NOT COSMETIC.
//
//   part_time      A part-time worker is an EMPLOYEE. Contributions, leave and gratuity apply
//                  pro-rata. The only home for one was `permanent`, whose own description says
//                  "direct FULL-TIME on our payroll" — so recording a part-timer recorded something
//                  false, and every alternative (contractor, consultant) was a downgrade out of
//                  employment altogether.
//   apprentice     Under the Apprentices Act 1961 an apprentice is a trainee under a registered
//                  contract of apprenticeship and is expressly NOT a "worker" for most purposes.
//                  This product already treats apprentices as a band everywhere else — an
//                  EngagementLevel, an offer-letter template, a row on the credits screen — and the
//                  spine was the only place they did not exist, so every one of them read as
//                  `permanent` by default.
//   intern_unpaid  The company default is that an internship is UNPAID unless a stipend is
//                  explicitly recorded, and the only intern key here says "stipend-paid". The
//                  default case of the most common engagement this company runs had no value at
//                  all. `volunteer` is NOT the substitute: a volunteer donates labour with no
//                  expectation of training or certification, while an unpaid intern receives
//                  hours, supervision, credits and a certificate. Recording one as the other
//                  misstates the relationship in the opposite direction from the contractor
//                  problem, and still misstates it.
//
// `freelance` is deliberately NOT a key. Freelance is not a legal category distinct from
// independent contractor — it is the same relationship reached by a different sourcing route, and
// the route is what ENGAGEMENT_VIAS already carries (contractor_direct vs marketplace). A separate
// key would split the HIGH-risk population in two and let half of it fall out of every query that
// filters on 'contractor'. What was missing was a MAPPING, and that is
// resolveEngagementKey() in src/lib/onboarding-packs.ts.
export const CLASSIFICATIONS = {
  permanent:   { label: 'Permanent employee',  risk: 'low',  description: 'Direct full-time on our payroll. Statutory contributions, leave, gratuity, all benefits.' },
  part_time:   { label: 'Part-time employee',  risk: 'low',  description: 'An employee working agreed reduced days or hours. Same statutory contributions, leave and gratuity as any employee, pro-rata. State the agreed days and hours in writing: a part-time worker whose hours are never stated is a full-time worker in fact.' },
  fixed_term:  { label: 'Fixed-term employee', risk: 'low',  description: 'Direct employment with a defined end date.' },
  intern:      { label: 'Paid intern (stipend recorded)', risk: 'low', description: 'Intern on a learning programme with a stipend explicitly recorded. Time-bounded, hours counted toward credits. Convertible to a permanent role.' },
  intern_unpaid: { label: 'Unpaid intern',     risk: 'medium', description: 'Intern on a learning programme with NO stipend recorded, which is the default for this company. They still receive hours, supervision, credits and a certificate, which is exactly what makes them an intern and not a volunteer. If a stipend has been agreed, record them as a paid intern instead. Unpaid training relationships attract scrutiny: keep the learning agreement, the mentor and the end date on file.' },
  apprentice:  { label: 'Apprentice',          risk: 'low',  description: 'Trainee under a registered contract of apprenticeship, on a structured programme with assessment points and a prescribed stipend. Legally distinct from both an intern and an employee, which changes what may be asked of them.' },
  contractor:  { label: 'Independent contractor', risk: 'high', description: 'Genuine contractor: invoices, controls own hours and tools, paid for outcomes. Wrong classification = serious legal risk. Covers freelance work, whether direct or through a marketplace — record which on "engaged via".' },
  eor:         { label: 'EOR-employed (foreign)', risk: 'low', description: 'Employed by our Employer-of-Record partner in their country. We pay the EOR; they handle local payroll + compliance.' },
  consultant:  { label: 'Consultant / advisor',  risk: 'medium', description: 'Short engagement, advisory. Should have a separate consulting agreement.' },
  volunteer:   { label: 'Volunteer / unpaid',    risk: 'high', description: 'Unpaid contributor who donates their labour, with no training programme, no credits and no certificate. Not a substitute for an unpaid intern. Use sparingly; check local labour law.' },
};

/** Every key in the spine. The one list, so a new engagement cannot be half-added. */
export const CLASSIFICATION_KEY_LIST: readonly string[] = Object.keys(CLASSIFICATIONS);

/**
 * THE CLASSIFICATIONS THAT ARE AN INTERNSHIP, named once.
 *
 * src/lib/auth/intern-signals.ts derives "settled NOT an internship" by removing 'intern' from the
 * spine and treating everything left as a settled no. Adding `intern_unpaid` and `apprentice` above
 * would therefore have made a reviewed unpaid intern read as a settled NON-intern — silently handing
 * the trainee population whatever an ordinary employee can reach. The set is declared HERE, beside
 * the vocabulary it partitions, so the two can never disagree again.
 *
 * `apprentice` is in it because intern-signals already answers true for anybody hired into an
 * Apprentice-level role, and the two arms must not contradict each other over the same person.
 */
export const INTERNSHIP_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'intern',
  'intern_unpaid',
  'apprentice',
]);

// NO REAL COMPANY IS NAMED HERE. Two of these descriptions listed named Employer-of-Record vendors
// and named talent marketplaces. They are not rendered today — the register draws `label` only — but
// they sit one `{v.description}` away from being user-facing copy, and this codebase's rule is that
// no competitor and no real company is named on any surface. Described by what they are instead.
export const ENGAGEMENT_VIAS = {
  direct_payroll:   { label: 'Direct payroll',    description: 'We pay them directly through our entity' },
  eor_partner:      { label: 'EOR partner',       description: 'An Employer-of-Record partner employs them in their own country and handles local payroll and compliance' },
  staffing_agency:  { label: 'Staffing agency',   description: 'Third-party agency provides the worker' },
  intern_programme: { label: 'Intern programme',  description: 'Intern engaged through our own internship programme, paid or unpaid' },
  apprenticeship:   { label: 'Apprenticeship programme', description: 'Registered contract of apprenticeship on a structured training programme' },
  contractor_direct:{ label: 'Direct contractor', description: 'Invoiced contractor with their own entity' },
  marketplace:      { label: 'Talent marketplace',description: 'Engaged through a third-party freelance marketplace' },
};

export const COUNTRY_CODES = [
  { code: 'IN', name: 'India' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'SG', name: 'Singapore' },
  { code: 'AE', name: 'UAE' },
  { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'IL', name: 'Israel' },
  { code: 'OTHER', name: 'Other' },
];
