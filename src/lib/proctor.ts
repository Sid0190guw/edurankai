// src/lib/proctor.ts — ATLAS proctoring (Prompt 11). Privacy-preserving: the browser emits only
// small TEXT events (face-present/absent, multiple-faces, focus-lost, fullscreen-exit, copy/paste,
// network-drop) — NO video/audio/image bytes ever leave the device. The server stores a per-attempt
// event log + a risk SUMMARY. Advisory only: flags never auto-penalize; a human proctor reviews and
// decides. The sanitizer guarantees the media-free contract even if a client tries to attach bytes.

export const EVENT_TYPES = ['face_present', 'face_absent', 'multiple_faces', 'focus_lost', 'fullscreen_exit', 'copy', 'paste', 'network_drop'] as const;
export type ProctorEventType = (typeof EVENT_TYPES)[number];
const WEIGHTS: Record<ProctorEventType, number> = {
  face_present: 0, face_absent: 3, multiple_faces: 5, focus_lost: 2, fullscreen_exit: 2, copy: 2, paste: 3, network_drop: 1,
};
export const DEFAULT_ENABLED: ProctorEventType[] = [...EVENT_TYPES];

export interface ProctorEvent { type: ProctorEventType; at: number }

/** Strip incoming events to ONLY { type, at } for known types — drops any attached media/bytes or
 *  unknown field. This is what enforces "no media leaves the browser" server-side. Pure. */
export function sanitizeEvents(raw: any[]): ProctorEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ProctorEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const type = String(e.type || '');
    if (!(EVENT_TYPES as readonly string[]).includes(type)) continue;   // unknown type (e.g. "frame"/"video") dropped
    const at = Number(e.at) || Date.now();
    out.push({ type: type as ProctorEventType, at });                    // ONLY type + at survive — any bytes are discarded
  }
  return out.slice(0, 500);
}

export interface RiskSummary { score: number; level: 'low' | 'elevated' | 'high'; counts: Record<string, number>; total: number }
/** Compute an advisory risk summary from text events, honoring the enabled-type policy. Pure. */
export function riskSummary(events: ProctorEvent[], enabledTypes: string[] = DEFAULT_ENABLED): RiskSummary {
  const enabled = new Set(enabledTypes);
  const counts: Record<string, number> = {};
  let score = 0, total = 0;
  for (const e of events) {
    if (!enabled.has(e.type)) continue;              // a disabled event type does not count
    counts[e.type] = (counts[e.type] || 0) + 1;
    score += WEIGHTS[e.type] || 0; total++;
  }
  const level: RiskSummary['level'] = score >= 12 ? 'high' : score >= 5 ? 'elevated' : 'low';
  return { score, level, counts, total };
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureProctorSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_proctor_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id TEXT NOT NULL, user_id UUID, type TEXT NOT NULL, at BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_proctor_events_sid ON edu_proctor_events (session_id)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_proctor_policy (id INTEGER PRIMARY KEY DEFAULT 1, enabled_types TEXT[] NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  try { await db.execute(sql.raw(`ALTER TABLE edu_attempts ADD COLUMN IF NOT EXISTS proctor_session_id TEXT`)); } catch { /* attempts table may not exist yet */ }
  booted = true;
}
export async function getEnabledTypes(): Promise<string[]> {
  try { await ensureProctorSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT enabled_types FROM edu_proctor_policy WHERE id = 1 LIMIT 1`))[0];
    return r && Array.isArray(r.enabled_types) && r.enabled_types.length ? r.enabled_types : DEFAULT_ENABLED;
  } catch { return DEFAULT_ENABLED; }
}
export async function setEnabledTypes(types: string[]): Promise<void> {
  await ensureProctorSchema(); const { db, sql } = await ctx();
  const clean = types.filter((t) => (EVENT_TYPES as readonly string[]).includes(t));
  await db.execute(sql`INSERT INTO edu_proctor_policy (id, enabled_types) VALUES (1, ${clean}) ON CONFLICT (id) DO UPDATE SET enabled_types = ${clean}, updated_at = NOW()`);
}
/**
 * May `userId` write events into `sessionId`?
 *
 * WHY THIS EXISTS. /api/aquintutor/proctor took `sessionId` out of the request body and passed it to
 * recordEvents() verbatim, with nothing checking that the session belonged to the caller. Any
 * signed-in user could therefore inject fabricated events into ANOTHER candidate's session, and
 * riskSummary()/proctoredAttempts() compute that candidate's advisory risk purely from session_id —
 * so the human reviewer at /admin/proctoring would be weighing evidence anyone could plant. Advisory
 * or not, a flag a stranger can forge is worse than no flag at all.
 *
 * The rule is FIRST CLAIM WINS, checked two ways:
 *   - if an edu_attempts row already carries this proctor_session_id, it must be the caller's;
 *   - if events already exist under it, they must be the caller's.
 * An unclaimed session id stays writable, which is what lets a candidate's own browser open one.
 *
 * FAILS CLOSED: a lookup that throws returns false. A proctoring event lost during a database hiccup
 * costs one advisory signal; accepting a forged one costs somebody their exam result.
 */
export async function canWriteProctorSession(sessionId: string, userId: string): Promise<boolean> {
  if (!sessionId || !userId) return false;
  try {
    await ensureProctorSchema(); const { db, sql } = await ctx();
    try {
      const owner = rows(await db.execute(sql`SELECT user_id FROM edu_attempts WHERE proctor_session_id = ${sessionId} LIMIT 1`))[0];
      if (owner && String(owner.user_id || '') !== String(userId)) return false;
    } catch (e: any) {
      // edu_attempts may not exist on a fresh environment. That is not evidence of a conflict, so it
      // does not deny on its own — the event-owner check below still runs and is authoritative.
      console.error('[proctor] attempt-owner lookup', e?.cause?.message || e?.message);
    }
    const prior = rows(await db.execute(sql`SELECT user_id FROM edu_proctor_events WHERE session_id = ${sessionId} AND user_id IS NOT NULL LIMIT 1`))[0];
    if (prior && String(prior.user_id || '') !== String(userId)) return false;
    return true;
  } catch (e: any) {
    console.error('[proctor] session-owner lookup', e?.cause?.message || e?.message);
    return false;
  }
}

/** Record sanitized (media-free) events for a proctor session, filtered to enabled types. */
export async function recordEvents(sessionId: string, userId: string | null, raw: any[]): Promise<number> {
  await ensureProctorSchema(); const { db, sql } = await ctx();
  const enabled = new Set(await getEnabledTypes());
  const events = sanitizeEvents(raw).filter((e) => enabled.has(e.type));
  for (const e of events) await db.execute(sql`INSERT INTO edu_proctor_events (session_id, user_id, type, at) VALUES (${sessionId}, ${userId}, ${e.type}, ${e.at})`);
  return events.length;
}
export async function eventsForSession(sessionId: string): Promise<ProctorEvent[]> {
  await ensureProctorSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT type, at FROM edu_proctor_events WHERE session_id = ${sessionId} ORDER BY at`)).map((r: any) => ({ type: r.type, at: Number(r.at) }));
}
/** Recent official attempts that carried proctoring, with an advisory risk summary each. */
export async function proctoredAttempts(limit = 50): Promise<any[]> {
  await ensureProctorSchema(); const { db, sql } = await ctx();
  const attempts = rows(await db.execute(sql`SELECT a.id, a.user_id, a.assessment_id, a.proctor_session_id, a.pct, a.state, a.started_at, u.name AS user_name
    FROM edu_attempts a LEFT JOIN users u ON u.id = a.user_id WHERE a.proctor_session_id IS NOT NULL ORDER BY a.started_at DESC LIMIT ${limit}`));
  const enabled = await getEnabledTypes();
  for (const a of attempts) a.risk = riskSummary(await eventsForSession(a.proctor_session_id), enabled);
  return attempts;
}
