// Encrypted activity / proctoring log.
//
// Captures the full learner journey — apply -> purchase -> learn -> test ->
// exam -> certificate — as TEXT only (never media bytes). During a timed test
// the client samples screen activity, audio (transcribed to text), and camera
// presence every minute and ships text lines here. Each detail line is
// encrypted at rest with AES-256-GCM; only an evaluator view decrypts it.
//
// Advisory only: nothing here auto-penalises a learner. A human reads the
// decrypted log + summary and decides.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const ex = async (q: any) => { try { await db.execute(q); } catch (_) {} };
    await ex(sql`CREATE TABLE IF NOT EXISTS activity_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      session_id VARCHAR(80) NOT NULL,
      journey_stage VARCHAR(20) NOT NULL DEFAULT 'general',
        -- apply | purchase | learn | test | exam | certificate | general
      ref_id VARCHAR(80),
        -- e.g. test attempt id, course id
      event_type VARCHAR(40) NOT NULL,
      severity VARCHAR(10) NOT NULL DEFAULT 'info',
        -- info | low | medium | high
      minute_bucket INT,
      ciphertext TEXT NOT NULL,
      iv VARCHAR(32) NOT NULL,
      client_ts BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await ex(sql`CREATE INDEX IF NOT EXISTS ae_session_idx ON activity_events(session_id, created_at)`);
    await ex(sql`CREATE INDEX IF NOT EXISTS ae_user_idx ON activity_events(user_id, journey_stage, created_at DESC)`);
  })();
  return ready;
}

// 32-byte key from env, or a stable dev key derived from a server secret.
function encKey(): Buffer {
  const raw = process.env.ACTIVITY_ENC_KEY || process.env.SESSION_SECRET || 'edurankai-activity-dev-key-v1';
  return createHash('sha256').update(raw).digest(); // 32 bytes
}
function encrypt(plain: string): { ciphertext: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]).toString('base64'), iv: iv.toString('hex') };
}
function decrypt(ciphertext: string, ivHex: string): string {
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const tag = buf.subarray(buf.length - 16);
    const enc = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return '[decrypt failed]'; }
}

export interface ActivityEvent {
  userId?: string | null;
  sessionId: string;
  stage?: string;
  refId?: string;
  type: string;
  severity?: 'info' | 'low' | 'medium' | 'high';
  minuteBucket?: number;
  detail: string;
  clientTs?: number;
}

export async function logActivity(e: ActivityEvent): Promise<void> {
  await ensureSchema();
  const { ciphertext, iv } = encrypt(e.detail || '');
  await db.execute(sql`
    INSERT INTO activity_events (user_id, session_id, journey_stage, ref_id, event_type, severity, minute_bucket, ciphertext, iv, client_ts)
    VALUES (${e.userId || null}, ${e.sessionId}, ${e.stage || 'general'}, ${e.refId || null}, ${e.type}, ${e.severity || 'info'}, ${e.minuteBucket ?? null}, ${ciphertext}, ${iv}, ${e.clientTs || null})
  `).catch(() => {});
}

export async function logBatch(events: ActivityEvent[]): Promise<number> {
  let n = 0;
  for (const e of events.slice(0, 200)) { await logActivity(e); n++; }
  return n;
}

// Evaluator view — decrypt the whole session, chronological.
export async function getSessionLog(sessionId: string) {
  await ensureSchema();
  const raw = rows(await db.execute(sql`
    SELECT id, user_id, journey_stage, ref_id, event_type, severity, minute_bucket, ciphertext, iv, client_ts, created_at
    FROM activity_events WHERE session_id = ${sessionId} ORDER BY created_at ASC, client_ts ASC LIMIT 5000
  `));
  return raw.map((r: any) => ({
    id: r.id, stage: r.journey_stage, refId: r.ref_id, type: r.event_type,
    severity: r.severity, minute: r.minute_bucket, ts: r.client_ts, at: r.created_at,
    detail: decrypt(r.ciphertext, r.iv),
  }));
}

// Whole-journey log for a learner (decrypted, newest first).
export async function getUserJourney(userId: string, limit = 500) {
  await ensureSchema();
  const raw = rows(await db.execute(sql`
    SELECT id, session_id, journey_stage, event_type, severity, ciphertext, iv, created_at
    FROM activity_events WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}
  `));
  return raw.map((r: any) => ({
    id: r.id, sessionId: r.session_id, stage: r.journey_stage, type: r.event_type,
    severity: r.severity, at: r.created_at, detail: decrypt(r.ciphertext, r.iv),
  }));
}

// Auto text summary of a session (advisory). Counts by type + severity, span,
// per-minute coverage, transcript word count, top flags.
export function summarize(events: { type: string; severity: string; minute: number | null; detail: string; at: any }[]): {
  total: number; spanMinutes: number; byType: { type: string; n: number }[];
  high: number; medium: number; low: number; transcriptWords: number;
  minutesCovered: number; verdict: string;
} {
  const total = events.length;
  const counts: { [k: string]: number } = {};
  let high = 0, medium = 0, low = 0, transcriptWords = 0;
  const minutes = new Set<number>();
  let first: any = null, last: any = null;
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.severity === 'high') high++; else if (e.severity === 'medium') medium++; else if (e.severity === 'low') low++;
    if (e.minute != null) minutes.add(e.minute);
    if (e.type === 'audio_transcript' && e.detail) transcriptWords += e.detail.split(/\s+/).filter(Boolean).length;
    const t = e.at ? new Date(e.at).getTime() : 0;
    if (t) { if (!first || t < first) first = t; if (!last || t > last) last = t; }
  }
  const byType = Object.entries(counts).map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
  const spanMinutes = first && last ? Math.max(1, Math.round((last - first) / 60000)) : 0;
  let verdict = 'Clean — no high-severity signals.';
  if (high >= 3) verdict = 'Multiple high-severity signals — recommend full human review.';
  else if (high >= 1) verdict = 'One or more high-severity signals — human review advised.';
  else if (medium >= 3) verdict = 'Several medium signals — spot-check advised.';
  return { total, spanMinutes, byType, high, medium, low, transcriptWords, minutesCovered: minutes.size, verdict };
}
