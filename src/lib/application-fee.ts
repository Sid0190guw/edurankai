// Processing & verification fee charged after an application is submitted.
// Source of truth is the role's own `application_fee_amount` (set by the
// hiring-posts seed and editable in /admin/roles). When that is missing we
// fall back to a level-tiered default. Amounts are in CHF and settled in INR
// via live FX at order time.

export type RoleLevel = 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice' | string | null | undefined;

// Fallback for any role missing application_fee_amount. Aligned with the
// current scale: Intern/Junior 1, Mid 5, Senior 10, Lead 50, C-Level 100.
export function applicationFeeChf(level: RoleLevel): number {
  switch ((level || 'Intern')) {
    case 'C-Level':              return 100;
    case 'Lead':                 return 50;
    case 'Senior':               return 10;
    case 'Mid':                  return 5;
    case 'Junior':
    case 'Intern':
    case 'Apprentice':
    default:                     return 1;
  }
}

// Resolve the fee in CHF for an application: per-role amount if present,
// otherwise the level-tiered default.
export function resolveApplicationFeeChf(opts: { roleFee?: number | string | null; level?: RoleLevel }): number {
  if (opts.roleFee != null && opts.roleFee !== '') {
    const n = Number(opts.roleFee);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return applicationFeeChf(opts.level);
}
