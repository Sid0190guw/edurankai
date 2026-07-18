// src/lib/edu-notify.ts — Notifications (Prompt 18). A lightweight in-app notification center plus
// OPTIONAL email (via the platform's existing own-SMTP mail system — provider config in env/DB, no
// hardcoded keys), triggered by real platform events (credential issued, assessment graded, admission
// decision, deadlines). Respects the student's per-type/channel preferences (Prompt 14) and fans out
// GUARDIAN alerts for linked minors. The preference logic is pure and unit-tested.

export type NotifType = 'result' | 'credential' | 'admission' | 'deadline' | 'guardian' | 'general';

interface Prefs { notifications?: { deadlines?: boolean; results?: boolean; email?: boolean } }
/** Should this type appear in-app for a user with these prefs? Results/deadlines are opt-outable. Pure. */
export function shouldNotifyInApp(prefs: Prefs, type: NotifType): boolean {
  const n = prefs?.notifications || {};
  if (type === 'result') return n.results !== false;
  if (type === 'deadline') return n.deadlines !== false;
  return true;   // credential/admission/guardian/general always in-app
}
/** Should we also email? Only when the user opted into email. Pure. */
export function shouldEmail(prefs: Prefs): boolean { return !!(prefs?.notifications && prefs.notifications.email); }

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureNotifySchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, read BOOLEAN NOT NULL DEFAULT false, channel TEXT NOT NULL DEFAULT 'in_app', at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_notif_user_idx ON edu_notifications (user_id, read, at DESC)`));
  booted = true;
}

async function prefsFor(userId: string): Promise<Prefs> {
  try { const { getProfile } = await import('@/lib/student-settings'); const p = await getProfile(userId); return { notifications: p.notifications }; } catch { return {}; }
}

/** Create a notification for a user (respecting prefs) + optional email. Best-effort. Returns delivered channels. */
export async function notify(userId: string, n: { type: NotifType; title: string; body?: string; link?: string }): Promise<string[]> {
  await ensureNotifySchema(); const { db, sql } = await ctx();
  const prefs = await prefsFor(userId);
  const delivered: string[] = [];
  if (shouldNotifyInApp(prefs, n.type)) {
    await db.execute(sql`INSERT INTO edu_notifications (user_id, type, title, body, link, channel) VALUES (${userId}, ${n.type}, ${n.title}, ${n.body || ''}, ${n.link || null}, 'in_app')`);
    delivered.push('in_app');
  }
  if (shouldEmail(prefs)) {
    try {
      const to = rows(await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`))[0]?.email;
      if (to) { const mail: any = await import('@/lib/mail').catch(() => null); if (mail?.sendExternal) { await mail.sendExternal({ to, subject: n.title, text: (n.body || '') + (n.link ? '\n\n' + n.link : '') }); delivered.push('email'); } }
    } catch { /* email best-effort; provider via env/DB, never hardcoded */ }
  }
  return delivered;
}

/** Fan out a guardian alert to everyone linked to a minor. */
export async function notifyGuardians(minorId: string, n: { title: string; body?: string; link?: string }): Promise<number> {
  const { db, sql } = await ctx();
  const guardians = rows(await db.execute(sql`SELECT guardian_user_id FROM rbac_guardian_links WHERE minor_user_id = ${minorId}`).catch(() => []));
  for (const g of guardians) await notify(g.guardian_user_id, { type: 'guardian', title: n.title, body: n.body, link: n.link });
  return guardians.length;
}

export async function listNotifications(userId: string, limit = 50): Promise<any[]> {
  await ensureNotifySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_notifications WHERE user_id = ${userId} ORDER BY at DESC LIMIT ${limit}`));
}
export async function unreadCount(userId: string): Promise<number> {
  await ensureNotifySchema(); const { db, sql } = await ctx();
  return Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_notifications WHERE user_id = ${userId} AND read = false`))[0]?.c || 0);
}
export async function markAllRead(userId: string): Promise<void> {
  await ensureNotifySchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_notifications SET read = true WHERE user_id = ${userId} AND read = false`);
}
export async function deliveryLog(limit = 100): Promise<any[]> {
  await ensureNotifySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT n.type, n.title, n.channel, n.read, n.at, u.name AS user_name FROM edu_notifications n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.at DESC LIMIT ${limit}`));
}
