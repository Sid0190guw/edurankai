// Processing & verification fee charged after an application is submitted.
// Source of truth is the role's own `application_fee_amount` (set by the
// hiring-posts seed and editable in /admin/roles). When that is missing we
// fall back to a level-tiered default. Amounts are in CHF and settled in INR
// via live FX at order time.

export type RoleLevel = 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice' | string | null | undefined;

// Policy (announced 2026-07): internships and apprenticeships carry NO
// application fee — no payment gateway ever appears for them. Enforced
// centrally here so every surface (fee display, pay page, submission) agrees
// no matter what a role row says. We match on BOTH the seniority level AND the
// engagement type, because a role can be an internship at any titled level.
export function isFeeExempt(level: RoleLevel, engagementType?: string | null): boolean {
  const l = (level || '').toString();
  const e = (engagementType || '').toString();
  return l === 'Intern' || l === 'Apprentice'
    || e === 'Internship' || e === 'Apprenticeship';
}

// Fallback for any role missing application_fee_amount. Aligned with the
// current scale: Junior 1, Mid 5, Senior 10, Lead 50, C-Level 100.
// Intern / Apprentice are free (fee-exempt) regardless.
export function applicationFeeChf(level: RoleLevel): number {
  if (isFeeExempt(level)) return 0;
  switch ((level || 'Junior')) {
    case 'C-Level':              return 100;
    case 'Lead':                 return 50;
    case 'Senior':               return 10;
    case 'Mid':                  return 5;
    case 'Junior':
    default:                     return 1;
  }
}

// Resolve the fee in CHF for an application: per-role amount if present,
// otherwise the level-tiered default. Interns/apprentices are always 0, even
// if a stale role row carries an application_fee_amount.
export function resolveApplicationFeeChf(opts: { roleFee?: number | string | null; level?: RoleLevel; engagementType?: string | null }): number {
  if (isFeeExempt(opts.level, opts.engagementType)) return 0;
  if (opts.roleFee != null && opts.roleFee !== '') {
    const n = Number(opts.roleFee);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return applicationFeeChf(opts.level);
}
