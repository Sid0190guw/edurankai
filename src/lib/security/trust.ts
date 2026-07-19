// src/lib/security/trust.ts — Block 11: an advisory continuous-trust score (0..100).
// Advisory only — step-up-auth / block decisions are human/config policy, not automated here.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function computeTrustScore(userId: string): Promise<{ score: number; factors: Record<string, number> }> {
  const factors: Record<string, number> = {};
  let score = 50;
  const { db, sql } = await ctx();

  const bump = (name: string, delta: number) => { factors[name] = delta; score += delta; };

  try {
    const totp = rows(await db.execute(sql`SELECT 1 FROM user_totp WHERE user_id = ${userId} AND confirmed_at IS NOT NULL LIMIT 1`)).length > 0;
    const passkey = rows(await db.execute(sql`SELECT 1 FROM user_passkeys WHERE user_id = ${userId} LIMIT 1`)).length > 0;
    if (totp || passkey) bump('strong-auth', 20);
  } catch { /* tables may not exist */ }

  try {
    const u = rows(await db.execute(sql`SELECT email_verified FROM users WHERE id = ${userId} LIMIT 1`))[0];
    if (u?.email_verified) bump('email-verified', 10);
  } catch { /* */ }

  try {
    const ips = rows(await db.execute(sql`SELECT ip_address FROM sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 2`)).map((r: any) => r.ip_address);
    if (ips.length === 2 && ips[0] && ips[0] === ips[1]) bump('stable-device', 10);
  } catch { /* */ }

  try {
    const sig = rows(await db.execute(sql`SELECT severity, COUNT(*)::int AS c FROM security_signals WHERE subject_user_id = ${userId} AND status = 'open' AND created_at >= NOW() - INTERVAL '24 hours' GROUP BY severity`));
    const high = sig.find((r: any) => r.severity === 'high')?.c ?? 0;
    const medium = sig.find((r: any) => r.severity === 'medium')?.c ?? 0;
    if (high > 0) bump('open-high-signal', -25);
    if (medium > 0) bump('open-medium-signal', -Math.min(30, medium * 10));
  } catch { /* */ }

  score = Math.max(0, Math.min(100, score));
  return { score, factors };
}
