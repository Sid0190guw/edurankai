// Discovery pathways: the requirement questions SAMARTH asks, adapted to the kind of project
// (spec Parts 12.3 and 12.4). PURE: the requirements form renders from this file and the server
// validates against the same definitions, so a question cannot exist on screen and be dropped on
// save, or be required on save and missing from the screen.
//
// The answers are the APPLICANT'S OWN words. Anything an assistant suggests is stored separately
// (applications.assessment) and labelled as a suggestion; it is never written into these answers.

import { INDUSTRIES } from '@/lib/samarth/catalog';
import { PROCUREMENT_ROUTES } from '@/lib/samarth/categories';

export type QuestionKind = 'text' | 'textarea' | 'select' | 'yesno';

export interface Question {
  key: string;
  label: string;
  kind: QuestionKind;
  options?: readonly { value: string; label: string }[];
  required?: boolean;
  help?: string;
  max?: number;
}

export type PathwayId =
  | 'government' | 'business' | 'manufacturing' | 'industrial' | 'university' | 'healthcare'
  | 'startup' | 'research' | 'enterprise' | 'infrastructure';

export interface Pathway { id: PathwayId; label: string; intro: string; questions: Question[] }

const opts = (...labels: string[]) => labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label: l }));

export const BUDGET_BANDS = opts('Under USD 10,000 or equivalent', 'USD 10,000 to 100,000 or equivalent', 'USD 100,000 to 1 million or equivalent', 'USD 1 million to 10 million or equivalent', 'Above USD 10 million or equivalent', 'Not decided yet');
export const FUNDING_STATUS = opts('Funding approved', 'Partly funded', 'Seeking funding', 'Not yet identified');
export const TIMELINES = opts('Within 3 months', '3 to 6 months', '6 to 12 months', '1 to 2 years', 'More than 2 years', 'Flexible');

/** Asked of everyone, whatever the pathway. */
export const COMMON_QUESTIONS: readonly Question[] = [
  { key: 'industry', label: 'Industry or sector', kind: 'select', options: INDUSTRIES.map((i) => ({ value: i, label: i })), required: true },
  { key: 'objectives', label: 'What should this project achieve?', kind: 'textarea', required: true, max: 3000, help: 'The outcomes you need, in your own words.' },
  { key: 'existing_infrastructure', label: 'Existing infrastructure', kind: 'textarea', max: 2000, help: 'Facilities, hardware, networks or computing you already have.' },
  { key: 'current_systems', label: 'Current systems and software', kind: 'textarea', max: 2000 },
  { key: 'software_requirements', label: 'Software requirements', kind: 'textarea', max: 2000 },
  { key: 'hardware_requirements', label: 'Hardware requirements', kind: 'textarea', max: 2000 },
  { key: 'ai_requirements', label: 'AI requirements', kind: 'textarea', max: 2000 },
  { key: 'infrastructure_requirements', label: 'Infrastructure requirements', kind: 'textarea', max: 2000 },
  { key: 'data_integration', label: 'Data and integration requirements', kind: 'textarea', max: 2000, help: 'Which systems or data sources must this connect to?' },
  { key: 'security_requirements', label: 'Security and data-protection requirements', kind: 'textarea', max: 2000, help: 'Residency, classification, regulation. Do not paste personal or confidential records here.' },
  { key: 'budget', label: 'Budget expectation', kind: 'select', options: BUDGET_BANDS, required: true },
  { key: 'funding', label: 'Funding availability', kind: 'select', options: FUNDING_STATUS, required: true },
  { key: 'timeline', label: 'Timeline', kind: 'select', options: TIMELINES, required: true },
  { key: 'expected_outcomes', label: 'How will you measure success?', kind: 'textarea', max: 2000 },
];

export const PATHWAYS: readonly Pathway[] = [
  {
    id: 'government', label: 'Government or public body',
    intro: 'For a ministry, department, agency, local body or public-sector organisation in any country.',
    questions: [
      { key: 'service_area', label: 'Which department, service or function does the project serve?', kind: 'text', required: true, max: 300 },
      { key: 'geographic_scope', label: 'Geographic scope', kind: 'select', required: true, options: opts('A single office or site', 'A city or municipality', 'A district, county or region', 'A state or province', 'National', 'Several states, provinces or countries') },
      { key: 'institutional_coverage', label: 'How many offices or institutions are covered?', kind: 'text', max: 200 },
      { key: 'beneficiaries', label: 'Who benefits, and roughly how many people?', kind: 'textarea', required: true, max: 1500 },
      { key: 'procurement_route', label: 'Expected procurement route', kind: 'select', required: true, options: PROCUREMENT_ROUTES },
      { key: 'procurement_stage', label: 'Where is the procurement today?', kind: 'select', options: opts('Exploring options', 'Budget approved', 'Tender being drafted', 'Tender published', 'Other') },
    ],
  },
  {
    id: 'business', label: 'Private business',
    intro: 'For a company improving how it operates, sells or serves its customers.',
    questions: [
      { key: 'business_model', label: 'What does the business do, and for whom?', kind: 'textarea', required: true, max: 1500 },
      { key: 'processes', label: 'Which processes most need improving?', kind: 'textarea', required: true, max: 1500 },
      { key: 'tech_team', label: 'Do you have an in-house technology team?', kind: 'select', options: opts('Yes, a full team', 'One or two people', 'No') },
    ],
  },
  {
    id: 'manufacturing', label: 'Manufacturing',
    intro: 'For plants and production lines becoming connected and intelligent.',
    questions: [
      { key: 'plants', label: 'How many plants or lines are involved?', kind: 'text', required: true, max: 200 },
      { key: 'production_type', label: 'Type of production', kind: 'select', required: true, options: opts('Discrete', 'Process', 'Batch', 'Mixed') },
      { key: 'automation_level', label: 'Current level of automation', kind: 'select', options: opts('Mostly manual', 'Partly automated', 'Highly automated') },
      { key: 'quality_downtime', label: 'Main quality, downtime or yield problems', kind: 'textarea', required: true, max: 1500 },
      { key: 'production_data', label: 'Is production data already collected?', kind: 'select', options: opts('Yes, digitally', 'On paper', 'Not at all') },
    ],
  },
  {
    id: 'industrial', label: 'Industrial organisation',
    intro: 'For construction, energy, chemicals, materials, electronics and heavy industry.',
    questions: [
      { key: 'segment', label: 'Industrial segment', kind: 'select', required: true, options: opts('Construction', 'Energy', 'Chemicals', 'Materials', 'Electronics', 'Heavy industry', 'Other') },
      { key: 'assets', label: 'Which assets or processes are involved?', kind: 'textarea', required: true, max: 1500 },
      { key: 'safety_regulatory', label: 'Safety and regulatory constraints', kind: 'textarea', max: 1500 },
    ],
  },
  {
    id: 'university', label: 'University or academic institution',
    intro: 'For universities and colleges, public or private, anywhere.',
    questions: [
      { key: 'institution_type', label: 'Institution type', kind: 'select', required: true, options: opts('Public', 'Private', 'Other') },
      { key: 'size', label: 'Approximate number of students and staff', kind: 'text', max: 200 },
      { key: 'academic_goals', label: 'What should change for students, staff or research?', kind: 'textarea', required: true, max: 1500 },
    ],
  },
  {
    id: 'healthcare', label: 'Healthcare',
    intro: 'For hospitals, clinic networks and health services.',
    questions: [
      { key: 'facility_type', label: 'Type of facility or service', kind: 'select', required: true, options: opts('Hospital', 'Clinic network', 'Diagnostic service', 'Public health programme', 'Other') },
      { key: 'scale', label: 'Scale (beds, sites or patients served)', kind: 'text', max: 200 },
      { key: 'clinical_constraints', label: 'Clinical, privacy or regulatory constraints', kind: 'textarea', required: true, max: 1500, help: 'Describe the rules that apply. Never include patient records.' },
    ],
  },
  {
    id: 'startup', label: 'Startup',
    intro: 'For founders building a new product or venture.',
    questions: [
      { key: 'stage', label: 'Stage', kind: 'select', required: true, options: opts('Idea', 'Prototype', 'Product in use', 'Earning revenue') },
      { key: 'product', label: 'The product, and the problem it solves', kind: 'textarea', required: true, max: 2000 },
      { key: 'market', label: 'Who is the market?', kind: 'textarea', required: true, max: 1500 },
      { key: 'team', label: 'Team and technical skills', kind: 'textarea', max: 1500 },
    ],
  },
  {
    id: 'research', label: 'Research institution',
    intro: 'For institutes and laboratories needing computing, instruments or data platforms.',
    questions: [
      { key: 'field', label: 'Research field', kind: 'text', required: true, max: 300 },
      { key: 'compute_data', label: 'Computing and data needs', kind: 'textarea', required: true, max: 1500 },
      { key: 'instrumentation', label: 'Instruments or laboratories involved', kind: 'textarea', max: 1500 },
    ],
  },
  {
    id: 'enterprise', label: 'Large enterprise',
    intro: 'For large organisations with several units or countries.',
    questions: [
      { key: 'units', label: 'Business units and countries involved', kind: 'textarea', required: true, max: 1500 },
      { key: 'landscape', label: 'Current technology landscape', kind: 'textarea', required: true, max: 2000 },
      { key: 'decision_makers', label: 'Who sponsors and decides on this project?', kind: 'text', max: 300 },
    ],
  },
  {
    id: 'infrastructure', label: 'Infrastructure project',
    intro: 'For data centres, computing clusters, facilities, campuses and energy systems.',
    questions: [
      { key: 'facility_kind', label: 'Kind of infrastructure', kind: 'select', required: true, options: opts('Data centre', 'GPU or AI computing', 'Smart factory', 'Campus', 'Hospital', 'Energy system', 'Research laboratory', 'Other') },
      { key: 'site_status', label: 'Site status', kind: 'select', required: true, options: opts('Site identified and available', 'Site under consideration', 'No site yet', 'Existing facility') },
      { key: 'capacity', label: 'Intended capacity', kind: 'text', max: 300, help: 'For example power in MW, racks, GPUs or floor area.' },
      { key: 'approvals', label: 'Status of permits and approvals', kind: 'select', options: opts('Not started', 'In progress', 'Granted', 'Not applicable') },
      { key: 'regulated', label: 'Does it involve nuclear, high-voltage grid or other licensed facilities?', kind: 'yesno', required: true },
    ],
  },
];

export function pathwayById(id: unknown): Pathway | null {
  return PATHWAYS.find((p) => p.id === id) || null;
}

/** The pathway a category usually takes, as the form's default. The applicant can change it. */
export function defaultPathwayFor(category: string): PathwayId {
  switch (category) {
    case 'government': case 'intergovernmental': case 'public_sector': return 'government';
    case 'enterprise': return 'enterprise';
    case 'startup': case 'individual': return 'startup';
    case 'university': return 'university';
    case 'research': return 'research';
    case 'healthcare': return 'healthcare';
    default: return 'business';
  }
}

export type Answers = Record<string, string>;

/** The field name a question is posted under. Prefixed so it can never collide with a top-level field. */
export const fieldName = (key: string) => 'q_' + key;

/**
 * Read and validate the answers for one pathway. `get` reads a posted value by field name.
 * Unknown option values are refused rather than stored, and every value is clipped.
 */
export function parseAnswers(pathwayId: string, get: (name: string) => string): { answers: Answers; missing: string[]; invalid: string[] } {
  const pathway = pathwayById(pathwayId);
  const questions = [...COMMON_QUESTIONS, ...(pathway ? pathway.questions : [])];
  const answers: Answers = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const q of questions) {
    const raw = String(get(fieldName(q.key)) ?? '').replace(/\u0000/g, '').trim();
    const max = q.max || (q.kind === 'textarea' ? 2000 : 300);
    let value = raw.slice(0, max);
    if (value && q.kind === 'select' && !(q.options || []).some((o) => o.value === value)) { invalid.push(q.label); value = ''; }
    if (value && q.kind === 'yesno' && value !== 'yes' && value !== 'no') { invalid.push(q.label); value = ''; }
    if (value) answers[q.key] = value;
    else if (q.required) missing.push(q.label);
  }
  if (!pathway) missing.unshift('Kind of project');
  return { answers, missing, invalid };
}

/** "Question: answer" pairs for display, in question order, with option values turned back into labels. */
export function describeAnswers(pathwayId: string, answers: Answers | null | undefined): { label: string; value: string }[] {
  const pathway = pathwayById(pathwayId);
  const a = answers || {};
  const out: { label: string; value: string }[] = [];
  for (const q of [...COMMON_QUESTIONS, ...(pathway ? pathway.questions : [])]) {
    const v = a[q.key];
    if (!v) continue;
    const shown = q.kind === 'select' ? ((q.options || []).find((o) => o.value === v)?.label || v) : q.kind === 'yesno' ? (v === 'yes' ? 'Yes' : 'No') : v;
    out.push({ label: q.label, value: shown });
  }
  return out;
}
