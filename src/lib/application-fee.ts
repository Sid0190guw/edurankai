// Processing & verification fee charged after an application is submitted.
// Tiered by role level. Amounts are in CHF (settled in INR via live FX).
// IMPORTANT: this fee is never advertised on role listings or the apply form -
// it is presented only on the post-submission payment step, and described in
// the policy document as "process and verification fees".

export type RoleLevel = 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice' | string | null | undefined;

// Level seniority (high -> low): C-Level > Lead > Senior > Mid > Junior > Intern > Apprentice
export function applicationFeeChf(level: RoleLevel): number {
  switch ((level || 'Intern')) {
    case 'C-Level': return 100;
    case 'Lead':
    case 'Senior': return 50;   // lead/above, below C-exec
    case 'Mid':
    case 'Junior': return 5;    // up to mid-level full-time
    case 'Intern':
    case 'Apprentice':
    default: return 1;          // every intern applicant
  }
}
