// Shared plumbing for the SAMARTH store modules: result shapes, row mapping, the event timeline and
// the audit write. Every SAMARTH write goes through addEvent() (the record's own timeline) AND
// logAudit() (the platform audit log), so a change is visible on the record and in /admin/audit.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { ensureSamarthSchema, isMissingTable, dbReason, SAMARTH_NOT_SET_UP } from '@/lib/samarth/schema';

export const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type Read<T> = { ready: true; value: T } | { ready: false; error: string; missing?: boolean };
export type Write<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

/** Run a read; a missing table becomes the set-up sentence, anything else is reported, never emptied. */
export async function readSafely<T>(what: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    await ensureSamarthSchema();
    return { ready: true, value: await fn() };
  } catch (e: any) {
    if (isMissingTable(e)) return { ready: false, error: SAMARTH_NOT_SET_UP, missing: true };
    console.error('[samarth] reading ' + what + ' failed:', dbReason(e));
    return { ready: false, error: 'Could not read ' + what + ' just now (' + dbReason(e).slice(0, 160) + ').' };
  }
}

/** Run a write; the real Postgres reason is logged and returned. */
export async function writeSafely<T>(what: string, fn: () => Promise<Write<T>>): Promise<Write<T>> {
  try {
    await ensureSamarthSchema();
    return await fn();
  } catch (e: any) {
    if (isMissingTable(e)) return { ok: false, error: SAMARTH_NOT_SET_UP };
    console.error('[samarth] ' + what + ' failed:', dbReason(e));
    return { ok: false, error: 'Nothing was saved: ' + dbReason(e).slice(0, 200) };
  }
}

export const num = (v: unknown): number | null => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
export const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
};
export const isoDay = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
export const str = (v: unknown): string => (v == null ? '' : String(v));
export const isUuid = (v: unknown): v is string => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
export const json = (v: unknown): string => JSON.stringify(v ?? null);

export interface ActorRef { userId: string | null; name: string }
export const SYSTEM_ACTOR: ActorRef = { userId: null, name: 'SAMARTH system' };

export type SubjectType = 'application' | 'engagement' | 'partner' | 'x';

export interface SamarthEvent {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  body: string;
  visibility: 'internal' | 'applicant';
  actorName: string;
  createdAt: string;
}

/**
 * kind: 'status' | 'note' | 'message' (staff to applicant) | 'reply' (applicant to staff) |
 *       'payment' | 'assignment' | 'schedule' | 'system'
 * visibility 'applicant' means the applicant (or partner, or candidate) sees it on their page.
 */
export async function addEvent(
  subjectType: SubjectType,
  subjectId: string,
  e: { kind: string; from?: string | null; to?: string | null; body?: string | null; visibility?: 'internal' | 'applicant'; actor?: ActorRef },
): Promise<void> {
  const actor = e.actor || SYSTEM_ACTOR;
  await db.execute(sql`
    INSERT INTO samarth_events (subject_type, subject_id, kind, from_status, to_status, body, visibility, actor_user_id, actor_name)
    VALUES (${subjectType}, ${subjectId}::uuid, ${e.kind}, ${e.from || null}, ${e.to || null}, ${(e.body || '').slice(0, 5000) || null},
            ${e.visibility || 'internal'}, ${isUuid(actor.userId) ? actor.userId : null}::uuid, ${actor.name.slice(0, 200)})`);
}

export async function eventsFor(subjectType: SubjectType, subjectId: string, applicantOnly = false): Promise<Read<SamarthEvent[]>> {
  if (!isUuid(subjectId)) return { ready: true, value: [] };
  return readSafely('the timeline', async () => {
    const r = rows(await db.execute(sql`
      SELECT id, kind, from_status, to_status, body, visibility, actor_name, created_at
        FROM samarth_events
       WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}::uuid
         AND (${applicantOnly} = false OR visibility = 'applicant')
       ORDER BY created_at ASC
       LIMIT 500`));
    return r.map((x) => ({
      id: str(x.id), kind: str(x.kind), fromStatus: x.from_status || null, toStatus: x.to_status || null,
      body: str(x.body), visibility: x.visibility === 'applicant' ? 'applicant' as const : 'internal' as const,
      actorName: str(x.actor_name), createdAt: iso(x.created_at) || '',
    }));
  });
}

export async function audit(actor: ActorRef, action: string, entity: string, entityId: string, diff?: Record<string, unknown>): Promise<void> {
  await logAudit({ userId: isUuid(actor.userId) ? actor.userId : null, action, entity, entityId, diff });
}
