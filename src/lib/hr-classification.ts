// Worker Classification Register — per Global HR Framework §2.1.
// Every person engaged by the group must be classified correctly. Wrong
// classification (e.g. calling an employee a contractor) is the single biggest
// compliance risk in the lifecycle. Auto-bootstraps a column on hr_employees
// and exposes a structured matrix.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;

export function ensureClassificationSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification VARCHAR(40) DEFAULT 'permanent'`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS country_of_work VARCHAR(80) DEFAULT 'IN'`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS engaged_via VARCHAR(40)`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS classification_reviewed_by UUID`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hre_classification_idx ON hr_employees(classification, country_of_work)`);
    } catch (_) {}
  })();
  return ready;
}

export const CLASSIFICATIONS = {
  permanent:   { label: 'Permanent employee',  risk: 'low',  description: 'Direct full-time on our payroll. Statutory contributions, leave, gratuity, all benefits.' },
  fixed_term:  { label: 'Fixed-term employee', risk: 'low',  description: 'Direct employment with a defined end date.' },
  intern:      { label: 'Paid intern',         risk: 'low',  description: 'Stipend-paid intern. Time-bounded. Convertible to FT.' },
  contractor:  { label: 'Independent contractor', risk: 'high', description: 'Genuine contractor: invoices, controls own hours and tools, paid for outcomes. Wrong classification = serious legal risk.' },
  eor:         { label: 'EOR-employed (foreign)', risk: 'low', description: 'Employed by our Employer-of-Record partner in their country. We pay the EOR; they handle local payroll + compliance.' },
  consultant:  { label: 'Consultant / advisor',  risk: 'medium', description: 'Short engagement, advisory. Should have a separate consulting agreement.' },
  volunteer:   { label: 'Volunteer / unpaid',    risk: 'high', description: 'Unpaid contributor. Use sparingly; check local labour law.' },
};

export const ENGAGEMENT_VIAS = {
  direct_payroll:   { label: 'Direct payroll',    description: 'We pay them directly through our entity' },
  eor_partner:      { label: 'EOR partner',       description: 'Our Employer-of-Record (e.g. Remote / Deel / Velocity) employs them' },
  staffing_agency:  { label: 'Staffing agency',   description: 'Third-party agency provides the worker' },
  intern_programme: { label: 'Intern programme',  description: 'Paid intern via our intern-to-FT pipeline' },
  contractor_direct:{ label: 'Direct contractor', description: 'Invoiced contractor with their own entity' },
  marketplace:      { label: 'Talent marketplace',description: 'Engaged via Toptal / Upwork / similar' },
};

export const COUNTRY_CODES = [
  { code: 'IN', name: 'India · 🇮🇳' },
  { code: 'US', name: 'United States · 🇺🇸' },
  { code: 'GB', name: 'United Kingdom · 🇬🇧' },
  { code: 'DE', name: 'Germany · 🇩🇪' },
  { code: 'FR', name: 'France · 🇫🇷' },
  { code: 'SG', name: 'Singapore · 🇸🇬' },
  { code: 'AE', name: 'UAE · 🇦🇪' },
  { code: 'AU', name: 'Australia · 🇦🇺' },
  { code: 'CA', name: 'Canada · 🇨🇦' },
  { code: 'NL', name: 'Netherlands · 🇳🇱' },
  { code: 'CH', name: 'Switzerland · 🇨🇭' },
  { code: 'JP', name: 'Japan · 🇯🇵' },
  { code: 'KR', name: 'South Korea · 🇰🇷' },
  { code: 'IL', name: 'Israel · 🇮🇱' },
  { code: 'OTHER', name: 'Other' },
];
