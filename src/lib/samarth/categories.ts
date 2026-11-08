// Who a SAMARTH applicant is. PURE: bundled into the browser by /samarth/register and
// /samarth/consultancy, so no imports and no Node built-ins.
//
// The category is the key the consultation booking fee is configured on (with currency), so it is
// deliberately COARSE and STABLE: renaming a value orphans every fee row and application that
// carries it. Labels may change; values may not.
//
// SAMARTH serves clients worldwide (governments at every level in every country, international
// bodies, businesses, institutions and individuals). Nothing in this file is India-specific.

export type ApplicantCategory =
  | 'government'
  | 'intergovernmental'
  | 'public_sector'
  | 'enterprise'
  | 'business'
  | 'startup'
  | 'university'
  | 'research'
  | 'healthcare'
  | 'nonprofit'
  | 'individual';

export interface CategoryDef {
  value: ApplicantCategory;
  label: string;
  hint: string;
  /** Official bodies: these applicants also give department, representative and procurement details. */
  official: boolean;
}

export const APPLICANT_CATEGORIES: readonly CategoryDef[] = [
  { value: 'government', label: 'Government', hint: 'Local, district or county, state or provincial, or national government, a ministry, department or agency, in any country', official: true },
  { value: 'intergovernmental', label: 'International or intergovernmental body', hint: 'An organisation established by, or acting for, more than one government', official: true },
  { value: 'public_sector', label: 'Public-sector undertaking', hint: 'A state-owned enterprise, public utility or government-funded organisation', official: true },
  { value: 'enterprise', label: 'Large enterprise', hint: 'A large company or group, in any industry', official: false },
  { value: 'business', label: 'Business or industry', hint: 'A small or mid-sized company, manufacturer or industrial firm', official: false },
  { value: 'startup', label: 'Startup', hint: 'A new venture, before or after its first revenue', official: false },
  { value: 'university', label: 'University or academic institution', hint: 'A university, college or school, public or private', official: false },
  { value: 'research', label: 'Research institution', hint: 'A research institute, laboratory or centre', official: false },
  { value: 'healthcare', label: 'Hospital or healthcare provider', hint: 'A hospital, clinic network or health service', official: false },
  { value: 'nonprofit', label: 'Non-profit or foundation', hint: 'A charity, foundation or civil-society organisation', official: false },
  { value: 'individual', label: 'Individual', hint: 'A person applying in their own name', official: false },
];

/** The fee-schedule wildcard: a row for '*' applies to every category that has no row of its own. */
export const ANY_CATEGORY = '*';

export function isApplicantCategory(v: unknown): v is ApplicantCategory {
  return APPLICANT_CATEGORIES.some((c) => c.value === v);
}

export function categoryDef(v: unknown): CategoryDef | null {
  return APPLICANT_CATEGORIES.find((c) => c.value === v) || null;
}

export function categoryLabel(v: unknown): string {
  if (v === ANY_CATEGORY) return 'All categories';
  return categoryDef(v)?.label || String(v || 'Unknown');
}

export function isOfficialCategory(v: unknown): boolean {
  return !!categoryDef(v)?.official;
}

/** Levels of government an official applicant may represent. Global wording, any country. */
export type GovernmentLevel = 'local' | 'district' | 'state' | 'national' | 'international';

export const GOVERNMENT_LEVELS: readonly { value: GovernmentLevel; label: string }[] = [
  { value: 'local', label: 'Local government: municipal, city, town or village administration' },
  { value: 'district', label: 'District, county or regional administration' },
  { value: 'state', label: 'State, provincial or territorial government' },
  { value: 'national', label: 'National or federal government, ministry or agency' },
  { value: 'international', label: 'International or intergovernmental' },
];

export function isGovernmentLevel(v: unknown): v is GovernmentLevel {
  return GOVERNMENT_LEVELS.some((l) => l.value === v);
}

export function governmentLevelLabel(v: unknown): string {
  return GOVERNMENT_LEVELS.find((l) => l.value === v)?.label || String(v || '');
}

/** How an official body intends to buy. Names no specific portal or vendor. */
export const PROCUREMENT_ROUTES: readonly { value: string; label: string }[] = [
  { value: 'open_tender', label: 'Open tender or request for proposals' },
  { value: 'limited_tender', label: 'Limited or restricted tender' },
  { value: 'e_marketplace', label: 'A government e-marketplace or framework agreement' },
  { value: 'direct', label: 'Direct engagement, where the rules permit it' },
  { value: 'grant', label: 'Through a grant or funded programme' },
  { value: 'undecided', label: 'Not decided yet' },
];
