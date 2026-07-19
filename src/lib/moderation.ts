// src/lib/moderation.ts — real-time moderation for LIVE surfaces (Prompt AP2). A message is screened
// BEFORE it fans out: clean passes, flagged is queued for a moderator, severe is blocked. Rooms with
// MINORS use strict mode (mild language + unmoderated peer-contact attempts are blocked, not just
// flagged) — a reframe can never lower a minor room's protection. The screen is PURE (tested); the
// queue + live mute/kick are DB-backed. Incident logs are data-minimized (redacted text, category).
export type Severity = 'clean' | 'mild' | 'severe';
export interface ScreenResult { severity: Severity; categories: string[]; allowed: boolean; flagged: boolean; redacted: string }

// Defensive content lists (small but real). MILD = coarse language; SEVERE = harassment/self-harm
// directed at a person; CONTACT = attempts to move a minor to unmoderated private contact.
const MILD = ['damn', 'hell', 'crap', 'stupid', 'idiot', 'loser', 'shut up', 'sucks', 'moron'];
const SEVERE = ['kill yourself', 'kys', 'go die', 'worthless', 'nobody likes you', 'i hate you', 'hurt you'];
const CONTACT: RegExp[] = [/\b\d{10}\b/, /\b[\w.+-]+@[\w-]+\.[\w.]+\b/, /\bwhats\s?app\b/i, /\btelegram\b/i, /\bsnap(chat)?\b/i, /(^|\s)@[a-z0-9_]{3,}/i, /\bdm me\b/i, /\bmeet me\b/i];

function maskWords(text: string, words: string[]): string {
  let out = text;
  for (const w of words) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
  return out;
}

/** Screen a message. strict=true (a minor-containing room) blocks mild language + contact attempts. */
export function screenMessage(text: string, opts: { strict?: boolean } = {}): ScreenResult {
  const t = String(text || ''); const lower = t.toLowerCase(); const categories: string[] = [];
  const severeHit = SEVERE.some((w) => lower.includes(w));
  const mildHit = MILD.some((w) => lower.includes(w));
  const contactHit = CONTACT.some((r) => r.test(t));
  if (severeHit) categories.push('harassment');
  if (mildHit) categories.push('profanity');
  if (contactHit) categories.push('contact');
  const severity: Severity = severeHit ? 'severe' : (mildHit || contactHit) ? 'mild' : 'clean';
  const strict = !!opts.strict;
  // severe is always blocked; strict rooms also block mild language + contact attempts
  const allowed = !severeHit && !(strict && (mildHit || contactHit)) && !(contactHit && strict);
  const flagged = severity !== 'clean';
  const redacted = maskWords(t, [...MILD, ...SEVERE]).slice(0, 500);
  return { severity, categories, allowed, flagged, redacted };
}

/** A minor-safety event that must alert a guardian (severe content by/at a minor, or a contact attempt). */
export function isSafetyEvent(res: ScreenResult, subjectIsMinor: boolean): boolean {
  return subjectIsMinor && (res.severity === 'severe' || res.categories.includes('contact'));
}

// ---- DB: live moderation queue + per-room mute/kick state (additive, self-bootstrapping) ----
const MOD_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_mod_queue (
    id bigserial PRIMARY KEY, surface text NOT NULL, room_id text, user_id text, redacted text NOT NULL DEFAULT '',
    severity text NOT NULL DEFAULT 'mild', categories text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending',
    reporter text, moderator text, created_at timestamptz NOT NULL DEFAULT now(), acted_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS edu_mod_queue_status_idx ON edu_mod_queue (status, id)`,
  `CREATE TABLE IF NOT EXISTS edu_room_moderation (
    room_id text NOT NULL, user_id text NOT NULL, muted boolean NOT NULL DEFAULT false, removed boolean NOT NULL DEFAULT false,
    by_user text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (room_id, user_id)
  )`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const ddl of MOD_DDL) await db.execute(sql.raw(ddl)); _ready = true; }
  return { db, sql };
}

export async function enqueueIncident(surface: string, roomId: string | null, userId: string | null, res: ScreenResult, opts: { reporter?: string | null; status?: string; minimize?: boolean } = {}): Promise<number> {
  const { db, sql } = await ctx();
  // AP2b child-safety: for a minor we DATA-MINIMIZE — store the category/severity, not the message text
  const stored = opts.minimize ? '[minimized]' : res.redacted;
  const r = rows(await db.execute(sql`INSERT INTO edu_mod_queue (surface, room_id, user_id, redacted, severity, categories, status, reporter)
    VALUES (${surface}, ${roomId}, ${userId}, ${stored}, ${res.severity}, ${res.categories as any}, ${opts.status || 'pending'}, ${opts.reporter || null}) RETURNING id`));
  return Number(r[0]?.id || 0);
}
export async function listQueue(status = 'pending', limit = 50): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_mod_queue WHERE status = ${status} ORDER BY id DESC LIMIT ${limit}`));
}
export async function actOnIncident(id: number, action: 'remove' | 'allow' | 'dismiss', moderator: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_mod_queue SET status = ${action === 'remove' ? 'removed' : action === 'allow' ? 'allowed' : 'dismissed'}, moderator = ${moderator}, acted_at = now() WHERE id = ${id}`);
}
export async function setRoomModeration(roomId: string, userId: string, patch: { muted?: boolean; removed?: boolean }, by: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_room_moderation (room_id, user_id, muted, removed, by_user, updated_at)
    VALUES (${roomId}, ${userId}, ${patch.muted ?? false}, ${patch.removed ?? false}, ${by}, now())
    ON CONFLICT (room_id, user_id) DO UPDATE SET muted = COALESCE(${patch.muted ?? null}, edu_room_moderation.muted), removed = COALESCE(${patch.removed ?? null}, edu_room_moderation.removed), by_user = ${by}, updated_at = now()`);
}
export async function roomModerationState(roomId: string, userId: string): Promise<{ muted: boolean; removed: boolean }> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT muted, removed FROM edu_room_moderation WHERE room_id = ${roomId} AND user_id = ${userId} LIMIT 1`))[0];
  return { muted: !!r?.muted, removed: !!r?.removed };
}
