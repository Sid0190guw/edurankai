// src/lib/edu-notify.ts — Notifications (Prompt 18). A lightweight in-app notification center plus
// OPTIONAL email (via the platform's existing own-SMTP mail system — provider config in env/DB, no
// hardcoded keys), triggered by real platform events (credential issued, assessment graded, admission
// decision, deadlines). Respects the student's per-type/channel preferences (Prompt 14) and fans out
// GUARDIAN alerts for linked minors. The preference logic is pure and unit-tested.
//
// =================================================================================================
// THE EMAIL CHANNEL HAS NEVER SENT AN EMAIL, AND NOTHING SAID SO
// =================================================================================================
//
// The line was `const mail = await import('@/lib/mail'); if (mail?.sendExternal) { ... }`.
// `sendExternal` is NOT exported by src/lib/mail.ts — it lives in src/lib/mail-transport.ts, and
// mail.ts does not re-export it. So `mail.sendExternal` was `undefined` on every call, the `if`
// never entered, `delivered` never contained 'email', and the whole branch sat inside a `catch {}`
// that would have hidden the failure even if it had thrown. Every learner who ticked "email me" in
// their notification preferences has been getting nothing, silently, since this was written — and
// the delivery log on the admin side agreed with the preference screen, because both read a channel
// that was simply never attempted.
//
// The call was also malformed independently of the import. SendExternalParams requires `from` and
// `html`; this passed neither. sendExternal only normalises a From when it can parse an address out
// of the caller's, so an absent `from` stays absent and nodemailer refuses the message. Both are
// supplied now: the configured from_name/from_address (the one mail identity this product has) and
// an escaped HTML part built from the same text.
//
// It stays BEST EFFORT — a notification that cannot be emailed must still exist in the app, so the
// in-app row is written first and an email failure never throws out of notify(). What changes is
// that the reason is written down and the returned channel list tells the truth about what was
// actually delivered.

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
      if (to) {
        const { sendExternal } = await import('@/lib/mail-transport');
        const { getMailConfig } = await import('@/lib/mail');
        const { escapeHtml } = await import('@/lib/content-render');
        const cfg: any = await getMailConfig();
        const fromAddress = String(cfg?.fromAddress || '').trim();
        if (!fromAddress) {
          // Said out loud rather than attempted. With no configured sending address there is no
          // From header to write, and a send that cannot name its sender is refused by the server
          // anyway — reporting 'email' as delivered here would be the original bug in a new place.
          console.error('[edu-notify] email requested but no from_address is configured; in-app only');
        } else {
          const text = (n.body || '') + (n.link ? '\n\n' + n.link : '');
          const html = '<div>' + escapeHtml(n.body || '').replace(/\n/g, '<br/>') +
            (n.link ? '<p><a href="' + escapeHtml(n.link) + '">' + escapeHtml(n.link) + '</a></p>' : '') + '</div>';
          const res: any = await sendExternal({
            from: String(cfg?.fromName || 'EduRankAI') + ' <' + fromAddress + '>',
            to, subject: n.title, html, text,
          });
          // Only claim the channel when the transport says it went. `delivered` is read by callers
          // and by the delivery log; an optimistic push here is how "we emailed you" outlives the
          // mail server being down.
          if (res?.ok) delivered.push('email');
          else console.error('[edu-notify] email not delivered:', res?.error || 'unknown error');
        }
      }
    } catch (e: any) {
      // Best effort, NEVER silent. The in-app row above is already committed.
      console.error('[edu-notify] email send failed:', e?.cause?.message || e?.message);
    }
  }
  return delivered;
}

/** Fan out a guardian alert to everyone linked to a minor. */
export async function notifyGuardians(minorId: string, n: { title: string; body?: string; link?: string }): Promise<number> {
  const { db, sql } = await ctx();
  // The `.catch(() => [])` that used to sit here returned 0 to the caller for BOTH "this minor has
  // no guardian linked" and "the guardian table could not be read" — two facts a guardian-alert
  // fan-out must never confuse, because the second one means an alert about a child went nowhere
  // and the return value said everything was fine. The read failure is now recorded.
  let guardians: any[] = [];
  try {
    guardians = rows(await db.execute(sql`SELECT guardian_user_id FROM rbac_guardian_links WHERE minor_user_id = ${minorId}`));
  } catch (e: any) {
    console.error('[edu-notify] guardian lookup failed for ' + minorId + ':', e?.cause?.message || e?.message);
    throw e;
  }
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
