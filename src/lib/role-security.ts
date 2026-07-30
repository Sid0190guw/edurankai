// src/lib/role-security.ts — per-role security classification.
//
// Some roles (the flagship LLM programme, restricted aerospace work) involve controlled research
// inside a high-protocol zone. For those, sharing a PRECISE location is a condition of applying, not
// an option: an applicant who will not say where they are cannot be vetted for site access.
//
// Two things make this real rather than decorative:
//
//  1. It is enforced SERVER-SIDE at submission (see requirePreciseLocation). A browser-only gate is
//     bypassed by anyone who opens devtools, so the client check is a courtesy to honest applicants
//     and the server check is the actual rule.
//  2. It is disclosed up front on the role's application form, so nobody reaches the end and is then
//     told their application cannot be accepted. Refusal is legitimate — it just means this
//     particular programme is not open to them, and every other role remains applyable.
//
// The column is added at runtime, matching the products/AICTE pattern.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export function ensureRoleSecurityColumn(): Promise<void> {
  return ensureOnce('roles_security_cols_v1', async () => {
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS requires_precise_location BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS security_note TEXT`);
  });
}

export async function setRoleSecurity(roleId: string, requiresPreciseLocation: boolean, securityNote?: string | null): Promise<void> {
  await ensureRoleSecurityColumn();
  await db.execute(sql`
    UPDATE roles SET
      requires_precise_location = ${!!requiresPreciseLocation},
      security_note = ${securityNote || null}
    WHERE id = ${roleId}`);
}

export interface RoleSecurity {
  requiresPreciseLocation: boolean;
  securityNote: string | null;
}

export async function getRoleSecurity(roleId: string | null | undefined): Promise<RoleSecurity> {
  const none: RoleSecurity = { requiresPreciseLocation: false, securityNote: null };
  if (!roleId) return none;
  try {
    await ensureRoleSecurityColumn();
    const r = rows(await db.execute(sql`
      SELECT requires_precise_location, security_note FROM roles WHERE id = ${roleId} LIMIT 1`))[0];
    if (!r) return none;
    return {
      requiresPreciseLocation: !!r.requires_precise_location,
      securityNote: r.security_note || null,
    };
  } catch { return none; }
}

/**
 * THE ENFORCEMENT POINT. Returns null when the applicant may proceed, or a message explaining why
 * they may not.
 *
 * Deliberately fails CLOSED for a security-classified role: if we cannot confirm a precise location
 * was shared, the application is not accepted. Everywhere else in this codebase location capture
 * fails open (it must never block an applicant) — this is the one place that inverts, because here
 * the location IS the requirement rather than observability around it.
 */
export async function requirePreciseLocation(opts: {
  roleId?: string | null;
  intentId?: string | null;
  email?: string | null;
  applicationId?: string | null;
}): Promise<string | null> {
  const sec = await getRoleSecurity(opts.roleId);
  if (!sec.requiresPreciseLocation) return null;

  try {
    const { getLocationTrail } = await import('@/lib/applicant-location');
    const trail = await getLocationTrail({
      applicationId: opts.applicationId || null,
      intentId: opts.intentId || null,
      email: opts.email || null,
    });
    const granted = trail.some((p) => p.source === 'gps' && p.gpsStatus === 'granted' && p.latitude != null && p.longitude != null);
    if (granted) return null;

    const declined = trail.some((p) => p.gpsStatus === 'denied');
    return declined
      ? 'This role involves controlled research inside a restricted-protocol zone, so sharing your precise location is a condition of applying. Your browser recorded that location access was declined. Please allow location access for this site and submit again — or apply to one of our other open roles, which do not carry this requirement.'
      : 'This role involves controlled research inside a restricted-protocol zone, so sharing your precise location is a condition of applying. We have not received a precise location from your device yet. Please allow location access when your browser asks, then submit again. If your browser did not ask, check that location is not blocked for this site.';
  } catch {
    // Fail closed: an unverifiable security-classified application must not be accepted.
    return 'We could not verify your location, which is required for this role. Please try again, or write to hr@edurankai.in.';
  }
}
