// src/lib/aquin-immersive.ts — the "digital clinical campus" (spec §3, §4). A registry of immersive
// and observation sessions (360° operating rooms, ward rounds, anatomy, skills demos, simulations,
// lab/industry visits, VR labs) captured at partner institutions and replayed to learners worldwide,
// optionally with AI overlays. Immersive tech AUGMENTS hands-on training — it never replaces the
// psychomotor and real-patient competencies that must be earned at accredited partners.
//
// The actual 360°/multi-angle capture rigs and VR headsets are partner/hardware concerns; this module
// is the software seam — the session catalog, playback surface and AI-overlay configuration.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// WHAT WAS WRONG. addSession() was the only INSERT into aquin_immersive_sessions and nothing called
// it, so /aquintutor/clinical-campus — which reads sessionsByKind() — could only ever render a
// catalogue with nothing in it, under copy describing a library of recorded theatre and ward
// sessions. The mount is /admin/aquintutor/curriculum, where a session is registered against a
// partner recording. The reads are discriminated so an unreadable catalogue is not printed as an
// empty one.

export type ImmersiveRead<T> = { ok: true; value: T } | { ok: false; reason: string };

// Session kinds with the founder's estimated observation-contribution (spec §3 table).
export interface SessionKind { key: string; label: string; contribution: string; }
export const SESSION_KINDS: SessionKind[] = [
  { key: 'surgery_360', label: 'Operating-room 360°', contribution: '95–100%' },
  { key: 'industry_visit', label: 'Industrial / biomedical visit', contribution: '95–100%' },
  { key: 'skills_demo', label: 'Clinical skills demonstration', contribution: '90–95%' },
  { key: 'simulation', label: 'Emergency / trauma simulation', contribution: '90–95%' },
  { key: 'ward_round', label: 'Clinical ward round', contribution: '85–95%' },
  { key: 'anatomy', label: 'Anatomy demonstration', contribution: '85–95%' },
  { key: 'lab_demo', label: 'Laboratory demonstration', contribution: '85–90%' },
  { key: 'vr_lab', label: 'VR laboratory / immersive lab', contribution: 'Immersive' },
];
export function kindLabel(key: string): string { return (SESSION_KINDS.find((k) => k.key === key) || { label: key }).label; }

// AI overlays that can be layered onto a recorded/live session (spec §3 "Integration with AI").
export const AI_OVERLAYS = [
  { key: 'labels', label: 'Instrument / structure labels' },
  { key: 'subtitles', label: 'Live subtitles' },
  { key: 'translation', label: 'Multi-language translation' },
  { key: 'quiz', label: 'Auto-generated quizzes' },
  { key: 'summary', label: 'Summaries & notes' },
  { key: 'highlights', label: 'Critical-event highlighting' },
] as const;

// What immersive tech does NOT replace — surfaced honestly to learners.
export const PSYCHOMOTOR_NOTE = 'Immersive observation cannot replace psychomotor skills — performing procedures, palpation, applied force, and bedside communication. Those competencies are earned through supervised practice at accredited partner institutions.';

let _ready: Promise<void> | null = null;
export function ensureImmersiveSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aquin_immersive_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'skills_demo',
        discipline TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        storage_key TEXT NOT NULL DEFAULT '',
        partner_id UUID,
        is_360 BOOLEAN NOT NULL DEFAULT false,
        ai_overlays JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'recorded',
        recorded_at TIMESTAMPTZ,
        is_published BOOLEAN NOT NULL DEFAULT true,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aquin_immersive_kind_idx ON aquin_immersive_sessions (kind, created_at DESC)`);
    } catch (e: any) {
      console.error('[aquin-immersive] schema ensure failed:', reasonOf(e));
      _ready = null; // the next request retries rather than caching a failed bootstrap
      throw e;
    }
  })();
  return _ready;
}

export interface ImmersiveSession {
  id: string; title: string; kind: string; discipline: string; sourceUrl: string; storageKey: string;
  is360: boolean; aiOverlays: string[]; status: string; recordedAt: string | null;
}
function toSession(r: any): ImmersiveSession {
  let overlays: string[] = [];
  try { overlays = Array.isArray(r.ai_overlays) ? r.ai_overlays : JSON.parse(r.ai_overlays || '[]'); } catch { overlays = []; }
  return {
    id: String(r.id), title: r.title, kind: r.kind || 'skills_demo', discipline: r.discipline || '',
    sourceUrl: r.source_url || '', storageKey: r.storage_key || '', is360: !!r.is_360, aiOverlays: overlays,
    status: r.status || 'recorded', recordedAt: r.recorded_at ? new Date(r.recorded_at).toISOString() : null,
  };
}

export async function listSessions(publishedOnly = true): Promise<ImmersiveRead<ImmersiveSession[]>> {
  try {
    await ensureImmersiveSchema();
    const where = publishedOnly ? sql`WHERE is_published = true` : sql``;
    const r = rows(await db.execute(sql`SELECT * FROM aquin_immersive_sessions ${where} ORDER BY created_at DESC`));
    return { ok: true, value: r.map(toSession) };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-immersive] listSessions:', reason);
    return { ok: false, reason };
  }
}

export async function sessionsByKind(publishedOnly = true): Promise<ImmersiveRead<{ kind: SessionKind; sessions: ImmersiveSession[] }[]>> {
  const all = await listSessions(publishedOnly);
  if (!all.ok) return all;
  return {
    ok: true,
    value: SESSION_KINDS.map((kind) => ({ kind, sessions: all.value.filter((s) => s.kind === kind.key) })).filter((g) => g.sessions.length > 0),
  };
}

export async function addSession(s: {
  title: string; kind: string; discipline?: string; sourceUrl?: string; is360?: boolean;
  aiOverlays?: string[]; status?: string; createdBy?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const title = String(s.title || '').trim();
  if (!title) return { ok: false, error: 'Session title is required.' };
  const kind = SESSION_KINDS.some((k) => k.key === s.kind) ? s.kind : 'skills_demo';
  const overlays = (s.aiOverlays || []).filter((o) => AI_OVERLAYS.some((a) => a.key === o));
  const url = String(s.sourceUrl || '').trim();
  // Recordings are LINKED, never uploaded — the same rule the rest of this product follows for
  // documents. A link that is not a link would render as a dead player with no explanation.
  if (url && !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'The recording address must start with http:// or https://.' };
  }
  try {
    await ensureImmersiveSchema();
    await db.execute(sql`INSERT INTO aquin_immersive_sessions (title, kind, discipline, source_url, is_360, ai_overlays, status, created_by)
      VALUES (${title.slice(0, 200)}, ${kind}, ${String(s.discipline || '').slice(0, 100)}, ${url.slice(0, 500)},
        ${!!s.is360}, ${JSON.stringify(overlays)}::jsonb, ${['scheduled', 'live', 'recorded'].includes(s.status || '') ? s.status : 'recorded'}, ${s.createdBy || null})`);
    return { ok: true };
  } catch (e: any) {
    // A write path never swallows: the operator is told the catalogue is unchanged.
    const reason = reasonOf(e);
    console.error('[aquin-immersive] addSession:', reason);
    return { ok: false, error: 'That session was not registered. The catalogue is unchanged. (' + reason + ')' };
  }
}
