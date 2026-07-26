// Application fee — REMOVED for every level and engagement type.
//
// Policy (2026-07): applying to any role at EduRankAI is FREE. There is no
// processing / verification fee at any seniority, and no payment gateway ever
// appears in the application flow. This was previously charged on senior roles
// (Junior 1 → C-Level 100 CHF) with only interns/apprentices exempt; that whole
// charge is now gone.
//
// This file stays the single source of truth for every fee surface (fee
// display, checkout summary, pay page, submission, payment API). Keeping the
// same function signatures means each caller now simply sees "free / exempt"
// and routes applicants straight through to submission — no per-caller edits,
// no dead pay pages, no stale role.application_fee_amount can bring the fee
// back. To ever reintroduce a fee, change it HERE, not in the callers.

export type RoleLevel = 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice' | string | null | undefined;

// Every application is fee-exempt now, regardless of level or engagement type.
export function isFeeExempt(_level?: RoleLevel, _engagementType?: string | null): boolean {
  return true;
}

// No fee at any level.
export function applicationFeeChf(_level?: RoleLevel): number {
  return 0;
}

// Always 0 — a role row carrying a stale application_fee_amount is ignored.
export function resolveApplicationFeeChf(_opts: { roleFee?: number | string | null; level?: RoleLevel; engagementType?: string | null }): number {
  return 0;
}
