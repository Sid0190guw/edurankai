// Server-side issuance of an event artifact (certificate / award / letter / LOR).
// Single path used by: admin manual issue, per-level payment auto-issue, and
// test-pass auto-issue. Idempotent per (registration, level, artifact_type).

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  artifactTitle, defaultArtifactBody, makeSerial, makeShareToken,
  integrityHash, isArtifactType, type ArtifactType,
} from '@/lib/event-cert';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export interface IssueParams {
  registrationId: string;
  eventId: string;
  levelId?: string | null;
  artifactType: ArtifactType;
  title?: string;
  body?: string;
  issuedByUserId?: string | null;
  autoIssued?: boolean;
}

export async function issueArtifact(p: IssueParams): Promise<{ ok: boolean; id?: string; serial?: string; shareToken?: string; error?: string; existing?: boolean }> {
  if (!isArtifactType(p.artifactType)) return { ok: false, error: 'invalid artifact type' };
  if (!p.registrationId || !p.eventId) return { ok: false, error: 'missing ids' };

  // Idempotency: reuse an existing non-revoked artifact of this type for this reg+level.
  const dup = await db.execute(sql`
    SELECT id, serial, share_token FROM event_certificates
    WHERE registration_id = ${p.registrationId}
      AND artifact_type = ${p.artifactType}
      AND ${p.levelId ? sql`level_id = ${p.levelId}` : sql`level_id IS NULL`}
      AND revoked = false
    LIMIT 1
  `);
  const dupRows = rowsOf(dup);
  if (dupRows.length > 0) {
    const e: any = dupRows[0];
    return { ok: true, id: e.id, serial: e.serial, shareToken: e.share_token, existing: true };
  }

  // Gather names.
  const reg = rowsOf(await db.execute(sql`SELECT participant_name FROM event_registrations WHERE id = ${p.registrationId} LIMIT 1`))[0] as any;
  if (!reg) return { ok: false, error: 'registration not found' };
  const ev = rowsOf(await db.execute(sql`SELECT title, organiser FROM events WHERE id = ${p.eventId} LIMIT 1`))[0] as any;
  let levelName: string | null = null;
  if (p.levelId) {
    const lv = rowsOf(await db.execute(sql`SELECT name FROM event_levels WHERE id = ${p.levelId} LIMIT 1`))[0] as any;
    levelName = lv?.name || null;
  }

  const participantName = reg.participant_name || 'Recipient';
  const eventTitle = ev?.title || 'EduRankAI Event';
  const organiser = ev?.organiser || 'EduRankAI';
  const title = (p.title && p.title.trim()) || artifactTitle(p.artifactType);
  const body = (p.body && p.body.trim()) || defaultArtifactBody(p.artifactType, { participantName, eventTitle, levelName: levelName || undefined, organiser });

  const serial = makeSerial();
  const shareToken = makeShareToken();
  const issuedAtIso = new Date().toISOString();
  const hash = integrityHash({ serial, participantName, eventTitle, levelName: levelName || undefined, artifactType: p.artifactType, issuedAt: issuedAtIso });

  try {
    const ins = await db.execute(sql`
      INSERT INTO event_certificates (
        registration_id, level_id, event_id, artifact_type, title,
        participant_name, event_title, level_name, body, serial,
        integrity_hash, share_token, issued_by_user_id, auto_issued
      ) VALUES (
        ${p.registrationId}, ${p.levelId || null}, ${p.eventId}, ${p.artifactType}, ${title},
        ${participantName}, ${eventTitle}, ${levelName}, ${body}, ${serial},
        ${hash}, ${shareToken}, ${p.issuedByUserId || null}, ${!!p.autoIssued}
      ) RETURNING id
    `);
    const id = rowsOf(ins)[0]?.id;
    return { ok: true, id, serial, shareToken };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'insert failed' };
  }
}
