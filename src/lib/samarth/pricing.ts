// SAMARTH consultancy packages and the eligibility assessment (spec Parts 6 and 13).
//
// PURE. No database, no Node built-ins: /samarth/consultancy bundles this file into the browser so
// the "which package fits" estimator and the consultant's indicative assessment on
// /admin/samarth/applications/<id> are computed by the SAME function. Its only import is the
// equally pure categories module. Do not add a dependency here that a browser cannot load.
//
// THESE PACKAGES ARE NOT THE FIRST STEP. Every applicant first registers and pays the consultation
// booking fee (fees.ts, configured per category and currency). A package is a SEPARATE, later
// engagement with its own approved quotation and terms (samarth_engagements). Nothing here is ever
// charged directly from a public form.
//
// Three rules from the specification are enforced in code, not left to copy:
//   1. Packages are never combined or stacked. assessEligibility() returns ONE recommendation, and
//      validatePackageChoice() refuses anything but a single known code.
//   2. Turnover bands are commercial pricing criteria, NOT statutory MSME classifications. Nothing
//      here, and no page that renders it, may call a band "MSME".
//   3. No standard fee includes unlimited engineering, development, licensing or IP transfer. Every
//      package carries that exclusion explicitly (STANDARD_EXCLUSIONS).

import { isApplicantCategory, type ApplicantCategory } from '@/lib/samarth/categories';

export type PackageCode =
  | 'general'
  | 'micro'
  | 'medium'
  | 'large'
  | 'startup_general'
  | 'startup_venture'
  | 'government'
  | 'engineering'
  | 'infrastructure'
  | 'custom';

/**
 * fixed       the list price is the price
 * starting    the list price is the minimum; scope confirmation can raise it
 * per_project the list price is charged once per defined project
 * onwards     same as starting, for venture-specific startup work
 * quotation   no list price; a consultant quotes after discovery
 */
export type PriceKind = 'fixed' | 'starting' | 'per_project' | 'onwards' | 'quotation';

export interface ConsultancyPackage {
  code: PackageCode;
  label: string;
  /** Who it is for, in the words the pricing table uses. */
  eligibility: string;
  priceKind: PriceKind;
  /** List price in paise. null for quotation-only packages. */
  basePaise: number | null;
  /** True when a confirmed amount may be taken through the online checkout. */
  checkoutEligible: boolean;
  scope: string[];
  /** Package-specific exclusions, shown beside STANDARD_EXCLUSIONS. */
  excludes: string[];
}

/** Every package carries these. Part 6.6: never include them in a standard consultancy fee. */
export const STANDARD_EXCLUSIONS: readonly string[] = [
  'Engineering, software development or hardware build beyond the agreed consultancy deliverables',
  'Software, model or technology licences, and any transfer of intellectual property',
  'Procurement of equipment, infrastructure or third-party services',
  'Implementation, installation or commissioning work',
];

const RUPEE = 100; // paise per rupee

export const PACKAGES: readonly ConsultancyPackage[] = [
  {
    code: 'general',
    label: 'General technology consultancy',
    eligibility: 'General engagement for any organisation or founder',
    priceKind: 'starting',
    basePaise: 30000 * RUPEE,
    checkoutEligible: true,
    scope: [
      'A structured consultation on one defined technology question',
      'Review of the material you share with us',
      'Written summary of findings and recommended next steps',
    ],
    excludes: ['A full organisational assessment, which the category packages cover'],
  },
  {
    code: 'micro',
    label: 'Micro business consultancy',
    eligibility: 'Annual turnover up to Rs 2 crore',
    priceKind: 'fixed',
    basePaise: 50000 * RUPEE,
    checkoutEligible: true,
    scope: [
      'Business assessment',
      'Technology assessment',
      'Workflow analysis',
      'AI opportunities',
      'Automation opportunities',
      'Digital transformation roadmap',
      'Technical architecture',
      'Implementation planning',
    ],
    excludes: [],
  },
  {
    code: 'medium',
    label: 'Medium enterprise consultancy',
    eligibility: 'Project-based engagement for an established enterprise',
    priceKind: 'per_project',
    basePaise: 250000 * RUPEE,
    checkoutEligible: true,
    scope: [
      'Technology assessment',
      'Operational analysis',
      'Enterprise architecture',
      'Intelligent systems strategy',
      'AI integration',
      'Industrial automation',
      'Engineering consultation',
      'Feasibility studies',
      'Implementation roadmap',
    ],
    excludes: ['Work outside the one project defined at scope confirmation'],
  },
  {
    code: 'large',
    label: 'Large enterprise consultancy',
    eligibility: 'Enterprise-wide engagement, annual turnover up to USD 1 billion',
    priceKind: 'fixed',
    basePaise: 499999 * RUPEE,
    checkoutEligible: true,
    scope: [
      'Enterprise-wide technology assessment',
      'Intelligent systems strategy',
      'Advanced technology adoption',
      'Infrastructure assessment',
      'Manufacturing transformation',
      'Research and engineering',
      'Technology transfer planning',
      'Long-term implementation strategy',
    ],
    excludes: [],
  },
  {
    code: 'startup_general',
    label: 'Startup general consultancy',
    eligibility: 'Pre-revenue startups',
    priceKind: 'fixed',
    basePaise: 40000 * RUPEE,
    checkoutEligible: true,
    scope: [
      'Review of the proposed product, problem, technology and market',
      'Technical feasibility view',
      'Architecture and build-sequence guidance',
      'Written recommendations',
    ],
    excludes: [],
  },
  {
    code: 'startup_venture',
    label: 'Startup-specific consultancy',
    eligibility: 'Venture-specific work for a startup at any stage',
    priceKind: 'onwards',
    basePaise: 40000 * RUPEE,
    checkoutEligible: true,
    scope: [
      'Consultancy scoped to one venture and its specific technical questions',
      'Feasibility assessment by a human consultant',
      'A formal proposal for any follow-on work',
    ],
    excludes: [],
  },
  {
    code: 'government',
    label: 'Government projects',
    eligibility: 'Government departments, bodies and public-sector organisations',
    priceKind: 'quotation',
    basePaise: null,
    checkoutEligible: false,
    scope: ['Scoped individually against the project level, procurement route and statutory requirements'],
    excludes: [],
  },
  {
    code: 'engineering',
    label: 'Engineering projects',
    eligibility: 'Software, AI, hardware and industrial engineering builds',
    priceKind: 'quotation',
    basePaise: null,
    checkoutEligible: false,
    scope: ['Discovery, technical assessment, proposal and quotation before any commitment'],
    excludes: [],
  },
  {
    code: 'infrastructure',
    label: 'Infrastructure projects',
    eligibility: 'Computing, facility, energy and intelligent infrastructure',
    priceKind: 'quotation',
    basePaise: null,
    checkoutEligible: false,
    scope: ['Requirement discovery, site assessment and feasibility before any quotation'],
    excludes: [],
  },
  {
    code: 'custom',
    label: 'Custom quotation',
    eligibility: 'Engagements outside the published bands',
    priceKind: 'quotation',
    basePaise: null,
    checkoutEligible: false,
    scope: ['A consultant reviews the request and proposes a scope and fee'],
    excludes: [],
  },
];

/** The packages shown in the public pricing table, in the specification's order. */
export const PUBLISHED_CODES: readonly PackageCode[] = [
  'general', 'micro', 'medium', 'large', 'startup_general', 'startup_venture', 'government', 'engineering', 'infrastructure',
];

export function packageByCode(code: unknown): ConsultancyPackage | null {
  const c = String(code || '');
  return PACKAGES.find((p) => p.code === c) || null;
}

/** Indian digit grouping, e.g. 25000000 paise -> "2,50,000". No currency symbol. */
export function groupInr(rupees: number): string {
  const neg = rupees < 0;
  const whole = Math.floor(Math.abs(rupees));
  const s = String(whole);
  if (s.length <= 3) return (neg ? '-' : '') + s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) parts.unshift(rest);
  return (neg ? '-' : '') + parts.join(',') + ',' + last3;
}

/** "Rs 2,50,000" style label from paise. Uses the rupee sign. */
export function formatInrPaise(paise: number | null | undefined): string {
  if (paise == null || !Number.isFinite(Number(paise))) return '';
  const rupees = Math.round(Number(paise)) / 100;
  const whole = Math.floor(rupees);
  const frac = Math.round((rupees - whole) * 100);
  return '₹' + groupInr(whole) + (frac ? '.' + String(frac).padStart(2, '0') : '');
}

/** The price as the pricing table prints it. */
export function priceLabel(p: ConsultancyPackage): string {
  if (p.priceKind === 'quotation' || p.basePaise == null) return 'Custom quotation';
  const amt = formatInrPaise(p.basePaise);
  if (p.priceKind === 'starting') return amt + ' starting';
  if (p.priceKind === 'onwards') return amt + ' onwards';
  if (p.priceKind === 'per_project') return amt + ' per project';
  return amt;
}

// -------------------------------------------------------------------------------------------------
// ELIGIBILITY
// -------------------------------------------------------------------------------------------------

/**
 * Commercial bands. NOT statutory MSME categories (Part 6.1). Large is "up to USD 1 billion"
 * exactly as the specification states it; above that is a custom quotation, not the large package.
 * The rupee band applies to the equivalent in any currency: SAMARTH serves applicants worldwide.
 */
export type TurnoverBand = 'pre_revenue' | 'upto_2cr' | 'above_2cr' | 'upto_usd1b' | 'above_usd1b' | 'not_disclosed';

/**
 * What the applicant wants. 'project' is one defined project (the medium package's shape);
 * 'enterprise_wide' is the whole organisation (the large package's shape).
 */
export type NeedType =
  | 'general' | 'assessment' | 'project' | 'enterprise_wide' | 'venture' | 'engineering' | 'infrastructure' | 'government_project';

export const TURNOVER_BANDS: readonly { value: TurnoverBand; label: string }[] = [
  { value: 'pre_revenue', label: 'Pre-revenue' },
  { value: 'upto_2cr', label: 'Up to Rs 2 crore a year, or the equivalent' },
  { value: 'above_2cr', label: 'Above Rs 2 crore a year (mid-sized), or the equivalent' },
  { value: 'upto_usd1b', label: 'Large, up to USD 1 billion a year' },
  { value: 'above_usd1b', label: 'Above USD 1 billion a year' },
  { value: 'not_disclosed', label: 'Prefer not to say yet' },
];

export const NEED_TYPES: readonly { value: NeedType; label: string }[] = [
  { value: 'general', label: 'A focused consultation on one technology question' },
  { value: 'assessment', label: 'A full technology and business assessment with a roadmap' },
  { value: 'project', label: 'Consultancy for one defined project' },
  { value: 'enterprise_wide', label: 'An enterprise-wide technology strategy' },
  { value: 'venture', label: 'Venture-specific advice for a startup' },
  { value: 'engineering', label: 'Something built: software, AI, hardware or an industrial system' },
  { value: 'infrastructure', label: 'Infrastructure: computing, data centre, facility or energy' },
  { value: 'government_project', label: 'A government project' },
];

export interface EligibilityInput {
  category: ApplicantCategory | string;
  turnover: TurnoverBand | string;
  need: NeedType | string;
}

export interface EligibilityResult {
  recommended: PackageCode;
  /** Other single packages the applicant may choose instead. Never a combination. */
  alternatives: PackageCode[];
  reasons: string[];
  /** A human must confirm eligibility before anything is charged. */
  requiresHumanReview: boolean;
}

const isOneOf = <T extends string>(v: unknown, list: readonly { value: T }[]): v is T =>
  list.some((x) => x.value === v);

export function assessEligibility(input: EligibilityInput): EligibilityResult {
  const org: ApplicantCategory | 'other' = isApplicantCategory(input.category) ? input.category : 'other';
  const band = isOneOf(input.turnover, TURNOVER_BANDS) ? input.turnover : 'not_disclosed';
  const need = isOneOf(input.need, NEED_TYPES) ? input.need : 'general';
  const reasons: string[] = [];

  const done = (recommended: PackageCode, alternatives: PackageCode[], humanReview?: boolean): EligibilityResult => {
    const pkg = packageByCode(recommended)!;
    const review = humanReview ?? (pkg.priceKind !== 'fixed' || (pkg.basePaise ?? 0) >= 250000 * RUPEE);
    return { recommended, alternatives: alternatives.filter((a) => a !== recommended), reasons, requiresHumanReview: review };
  };

  // Building or infrastructure work is never a consultancy package: it is quoted.
  if (need === 'engineering') { reasons.push('Engineering builds are scoped and quoted after discovery, never sold as a fixed consultancy fee.'); return done('engineering', [], true); }
  if (need === 'infrastructure') { reasons.push('Infrastructure projects need site and feasibility work before any figure is meaningful.'); return done('infrastructure', [], true); }
  if (org === 'government' || org === 'intergovernmental' || org === 'public_sector' || need === 'government_project') {
    reasons.push('Government and public-sector engagements follow procurement and statutory rules, so they are quoted per project.');
    return done('government', [], true);
  }

  if (org === 'startup' || org === 'individual') {
    if (band === 'pre_revenue' || band === 'not_disclosed' || org === 'individual') {
      if (need === 'venture' || need === 'project') {
        reasons.push('Venture-specific work starts at the startup rate; the final fee follows scope confirmation.');
        return done('startup_venture', ['startup_general']);
      }
      reasons.push('Pre-revenue startups qualify for the startup general consultancy.');
      return done('startup_general', ['startup_venture']);
    }
    reasons.push('A startup with revenue is assessed by its turnover band like any business.');
  }

  if (band === 'above_usd1b') {
    reasons.push('Turnover above USD 1 billion is outside the published bands, so a consultant will quote.');
    return done('custom', [], true);
  }

  if (need === 'general') {
    reasons.push('A focused consultation on one question is the general engagement. It does not replace a full category package.');
    return done('general', [], true);
  }

  if (band === 'upto_2cr') {
    reasons.push('Turnover up to Rs 2 crore matches the micro business package.');
    return done('micro', need === 'venture' ? ['startup_venture'] : []);
  }

  if (band === 'upto_usd1b' || org === 'enterprise' || need === 'enterprise_wide') {
    if (need === 'project') {
      reasons.push('One defined project for a large organisation is the per-project engagement.');
      return done('medium', ['large']);
    }
    reasons.push('An enterprise-wide engagement up to USD 1 billion turnover is the large enterprise package. Turnover is confirmed before payment.');
    return done('large', ['medium'], true);
  }

  if (band === 'above_2cr') {
    reasons.push('A mid-sized organisation engaging on a defined project matches the medium enterprise package.');
    return done('medium', []);
  }

  // Universities, research institutions, healthcare, non-profits and undisclosed turnover.
  reasons.push('We could not match a category from what you told us, so a consultant will confirm the right engagement.');
  return done('general', ['micro', 'medium'], true);
}

/**
 * The single package an applicant chose. Refuses an empty choice, an unknown code and any attempt
 * to submit more than one (the form posts one radio value; a list here means a crafted request).
 */
export function validatePackageChoice(raw: unknown): { ok: true; code: PackageCode } | { ok: false; error: string } {
  if (Array.isArray(raw)) {
    return raw.length === 1 ? validatePackageChoice(raw[0]) : { ok: false, error: 'Choose one package. Packages cannot be combined.' };
  }
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Choose a package.' };
  if (s.includes(',') || s.includes('+')) return { ok: false, error: 'Choose one package. Packages cannot be combined.' };
  const p = packageByCode(s);
  return p ? { ok: true, code: p.code } : { ok: false, error: 'That package does not exist.' };
}

/**
 * Whether an amount a consultant confirmed is consistent with the package. Fixed and per-project
 * prices must equal the list price; starting and onwards prices may not go below it; quotations
 * need any real amount. The gateway refuses anything below Rs 1, so this does too.
 */
export function validateConfirmedAmount(code: PackageCode, paise: number): { ok: true } | { ok: false; error: string } {
  const p = packageByCode(code);
  if (!p) return { ok: false, error: 'Unknown package.' };
  if (!Number.isInteger(paise) || paise < 100) return { ok: false, error: 'Enter an amount of at least Rs 1.' };
  if (paise > 100_000_000_000) return { ok: false, error: 'That amount is larger than this system accepts. Use a quotation and invoice instead.' };
  if (p.basePaise == null) return { ok: true };
  if ((p.priceKind === 'fixed' || p.priceKind === 'per_project') && paise !== p.basePaise) {
    return { ok: false, error: p.label + ' is ' + formatInrPaise(p.basePaise) + '. A different figure needs a different package or a custom quotation.' };
  }
  if ((p.priceKind === 'starting' || p.priceKind === 'onwards') && paise < p.basePaise) {
    return { ok: false, error: p.label + ' starts at ' + formatInrPaise(p.basePaise) + '.' };
  }
  return { ok: true };
}

/** Rupees typed by a person ("2,50,000" or "250000.50") to integer paise, or null. */
export function rupeesToPaise(input: unknown): number | null {
  const s = String(input ?? '').replace(/[,\s₹]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}
