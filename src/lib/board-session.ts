// src/lib/board-session.ts — live board sessions (Prompt A1b). A teacher "fires" a template; the
// fire is persisted as a compact broadcast event (template id + params + playState + timelinePos —
// NEVER frames) and streamed to joined students, who render it ADAPTIVELY for their tier using the
// real Prompt-5 policy engine. DB-backed (works across serverless instances, unlike in-memory
// pub/sub); students resume with Last-Event-ID. Tables self-bootstrap (this repo's dominant pattern).
import type { DeviceSignals, RenderTier } from '@/lib/edu-runtime';
import { estimateDevice, estimateNetwork, combinePlan } from '@/lib/edu-runtime';
import { resolveDirective, type RenderDirective } from '@/lib/render-policy';

export interface BoardEvent { seq: number; sessionId: string; templateId: string; params: any; playState: string; timelinePos: number; actor: string | null; at: string }
export interface Participant { userId: string; tier: string; lastSeen: string; online: boolean }

// ── pure: adaptive tier for a joining student — REUSES the real Prompt-5 engine (no duplicate policy) ──
export function resolveBroadcastTier(signals: DeviceSignals, reduceMotion = false): { tier: RenderTier; directive: RenderDirective; animate: boolean } {
  const plan = combinePlan(estimateDevice(signals).tier, estimateNetwork(signals).tier, { reduceMotion });
  const directive = resolveDirective('AnimationObject', plan.tier);
  return { tier: plan.tier, directive, animate: directive.animation !== 'none' };   // lite -> static keyframe
}

function safeJson(v: any): any { if (v && typeof v === 'object') return v; try { return JSON.parse(String(v || '{}')); } catch { return {}; } }

// ── pure: normalize a DB row into the payload the browser renders ──
export function toBroadcast(row: any): BoardEvent {
  return {
    seq: Number(row.seq),
    sessionId: String(row.session_id),
    templateId: String(row.template_id),
    params: safeJson(row.params),
    playState: String(row.play_state || 'playing'),
    timelinePos: Number(row.timeline_pos || 0),
    actor: row.actor ? String(row.actor) : null,
    at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

// ── pure: which joined students are still "online" (recent heartbeat) ──
export function participantView(rows_: any[], now = Date.now(), windowMs = 30000): Participant[] {
  return (rows_ || []).map((r) => {
    const ls = r.last_seen ? new Date(r.last_seen).getTime() : 0;
    return { userId: String(r.user_id), tier: String(r.tier || 'standard'), lastSeen: new Date(ls).toISOString(), online: now - ls < windowMs };
  });
}

// ---- DB layer (self-bootstrapping, additive edu_board_* tables) ----
const BOARD_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_board_events (
    seq bigserial PRIMARY KEY,
    session_id text NOT NULL,
    template_id text NOT NULL,
    params jsonb NOT NULL DEFAULT '{}',
    play_state text NOT NULL DEFAULT 'playing',
    timeline_pos double precision NOT NULL DEFAULT 0,
    actor text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS edu_board_events_session_idx ON edu_board_events (session_id, seq)`,
  `CREATE TABLE IF NOT EXISTS edu_board_participants (
    session_id text NOT NULL,
    user_id text NOT NULL,
    tier text NOT NULL DEFAULT 'standard',
    joined_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS edu_board_detections (
    id bigserial PRIMARY KEY,
    session_id text NOT NULL,
    actor text,
    transcript text NOT NULL DEFAULT '',
    template_id text,
    params jsonb NOT NULL DEFAULT '{}',
    confidence double precision NOT NULL DEFAULT 0,
    source text NOT NULL DEFAULT 'rule',
    fired boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS edu_board_detections_session_idx ON edu_board_detections (session_id, id)`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const ddl of BOARD_DDL) await db.execute(sql.raw(ddl)); _ready = true; }
  return { db, sql };
}
export async function ensureBoardTables(): Promise<void> { await ctx(); }

/** Persist a fire as a broadcast event; returns its monotonic seq (also the SSE event id). */
export async function fireBoardEvent(sessionId: string, ev: { templateId: string; params: any; playState?: string; timelinePos?: number }, actor: string | null): Promise<number> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_board_events (session_id, template_id, params, play_state, timeline_pos, actor)
    VALUES (${sessionId}, ${ev.templateId}, ${JSON.stringify(ev.params || {})}::jsonb, ${ev.playState || 'playing'}, ${ev.timelinePos || 0}, ${actor})
    RETURNING seq`));
  return Number(r[0]?.seq || 0);
}

export async function eventsSince(sessionId: string, sinceSeq: number, limit = 50): Promise<BoardEvent[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_board_events WHERE session_id = ${sessionId} AND seq > ${sinceSeq} ORDER BY seq ASC LIMIT ${limit}`)).map(toBroadcast);
}

/** The single latest event — the current board state for a late joiner. */
export async function currentEvent(sessionId: string): Promise<BoardEvent | null> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT * FROM edu_board_events WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1`));
  return r[0] ? toBroadcast(r[0]) : null;
}

export async function joinSession(sessionId: string, userId: string, tier: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_board_participants (session_id, user_id, tier, last_seen)
    VALUES (${sessionId}, ${userId}, ${tier}, now())
    ON CONFLICT (session_id, user_id) DO UPDATE SET tier = EXCLUDED.tier, last_seen = now()`);
}

export async function touchParticipant(sessionId: string, userId: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_board_participants SET last_seen = now() WHERE session_id = ${sessionId} AND user_id = ${userId}`);
}

export interface Detection { id: number; transcript: string; templateId: string | null; params: any; confidence: number; source: string; fired: boolean; at: string }
function toDetection(r: any): Detection {
  return { id: Number(r.id), transcript: String(r.transcript || ''), templateId: r.template_id ? String(r.template_id) : null, params: safeJson(r.params), confidence: Number(r.confidence || 0), source: String(r.source || 'rule'), fired: !!r.fired, at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString() };
}

/** Log a speech->board detection (Prompt A2). Returns its id so the client can mark it fired. */
export async function logDetection(sessionId: string, actor: string | null, d: { transcript: string; templateId: string | null; params: any; confidence: number; source: string; fired?: boolean }): Promise<number> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_board_detections (session_id, actor, transcript, template_id, params, confidence, source, fired)
    VALUES (${sessionId}, ${actor}, ${d.transcript || ''}, ${d.templateId}, ${JSON.stringify(d.params || {})}::jsonb, ${d.confidence || 0}, ${d.source || 'rule'}, ${!!d.fired})
    RETURNING id`));
  return Number(r[0]?.id || 0);
}
export async function markDetectionFired(id: number): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_board_detections SET fired = true WHERE id = ${id}`);
}
export async function recentDetections(sessionId: string, limit = 12): Promise<Detection[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_board_detections WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${limit}`)).map(toDetection);
}

export async function sessionInspector(sessionId: string): Promise<{ participants: Participant[]; fires: BoardEvent[]; totalFires: number; online: number; detections: Detection[] }> {
  const { db, sql } = await ctx();
  const participants = participantView(rows(await db.execute(sql`SELECT * FROM edu_board_participants WHERE session_id = ${sessionId} ORDER BY joined_at ASC`)));
  const fires = rows(await db.execute(sql`SELECT * FROM edu_board_events WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 10`)).map(toBroadcast);
  const totalFires = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_board_events WHERE session_id = ${sessionId}`))[0]?.c || 0);
  const detections = await recentDetections(sessionId, 12).catch(() => []);
  return { participants, fires, totalFires, online: participants.filter((p) => p.online).length, detections };
}
