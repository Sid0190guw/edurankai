// src/lib/aquin-competencies.ts — competency-based progression (spec §6). Students progress by
// DEMONSTRATING competencies across a blend of online theory, partner practical, projects, community,
// wellness and research — assessed online, at a partner, or jointly. Competencies are defined per
// program by faculty (no fake seed); this module provides the framework, schema and progress tracking.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// The six progression dimensions — the blend every learner develops across.
export interface Dimension { key: string; label: string; blurb: string; }
export const DIMENSIONS: Dimension[] = [
  { key: 'theory', label: 'Online theory', blurb: 'Foundational knowledge through live and recorded classes, AI tutoring and assessments.' },
  { key: 'practical', label: 'Partner practical', blurb: 'Hands-on competencies completed at accredited partner institutions.' },
  { key: 'projects', label: 'Industry projects', blurb: 'Applied work with industry partners, open-source and real deliverables.' },
  { key: 'community', label: 'Community engagement', blurb: 'Service and contribution through community partners.' },
  { key: 'wellness', label: 'Sports & wellness', blurb: 'Physical, mental and social development through local wellness partners.' },
  { key: 'research', label: 'Research & innovation', blurb: 'Inquiry and innovation through research institutes and R&D.' },
];
export function dimensionLabel(key: string): string { return (DIMENSIONS.find((d) => d.key === key) || { label: key }).label; }

// How a competency is assessed.
export const ASSESSMENT_MODES = [
  { key: 'online', label: 'Online', blurb: 'Assessed digitally — proctored exams, projects, AI-assisted evaluation.' },
  { key: 'partner', label: 'At partner', blurb: 'Assessed on-site by certified partner supervisors.' },
  { key: 'joint', label: 'Joint', blurb: 'Assessed jointly by AquinTutor and the partner, competency-based.' },
] as const;

// Progress states for a learner against one competency.
export const PROGRESS_STATES = ['not_started', 'in_progress', 'demonstrated', 'verified'] as const;
export type ProgressState = typeof PROGRESS_STATES[number];

let _ready: Promise<void> | null = null;
export function ensureCompetencySchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aquin_competencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_slug TEXT NOT NULL DEFAULT '',
        code TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        dimension TEXT NOT NULL DEFAULT 'theory',
        assessment_mode TEXT NOT NULL DEFAULT 'online',
        description TEXT NOT NULL DEFAULT '',
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aquin_competencies_prog_idx ON aquin_competencies (program_slug, sort_order)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aquin_competency_progress (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        competency_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_started',
        verified_by UUID,
        note TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT aquin_comp_progress_user_comp_key UNIQUE (user_id, competency_id))`);
    } catch (_) { _ready = null; }
  })();
  return _ready;
}

export interface Competency {
  id: string; programSlug: string; code: string; name: string; dimension: string; assessmentMode: string; description: string;
}
function toCompetency(r: any): Competency {
  return { id: String(r.id), programSlug: r.program_slug || '', code: r.code || '', name: r.name, dimension: r.dimension || 'theory', assessmentMode: r.assessment_mode || 'online', description: r.description || '' };
}

export async function listCompetencies(programSlug: string): Promise<Competency[]> {
  await ensureCompetencySchema();
  return rows(await db.execute(sql`SELECT * FROM aquin_competencies WHERE program_slug = ${programSlug} ORDER BY sort_order ASC, code ASC`)).map(toCompetency);
}

export async function addCompetency(c: { programSlug: string; code?: string; name: string; dimension?: string; assessmentMode?: string; description?: string; sortOrder?: number }): Promise<{ ok: boolean; error?: string }> {
  const name = String(c.name || '').trim();
  if (!name) return { ok: false, error: 'Competency name is required.' };
  const dimension = DIMENSIONS.some((d) => d.key === c.dimension) ? c.dimension! : 'theory';
  const mode = ASSESSMENT_MODES.some((m) => m.key === c.assessmentMode) ? c.assessmentMode! : 'online';
  await ensureCompetencySchema();
  await db.execute(sql`INSERT INTO aquin_competencies (program_slug, code, name, dimension, assessment_mode, description, sort_order)
    VALUES (${String(c.programSlug || '').slice(0, 80)}, ${String(c.code || '').slice(0, 40)}, ${name.slice(0, 200)}, ${dimension}, ${mode}, ${String(c.description || '').slice(0, 600)}, ${c.sortOrder ?? 0})`);
  return { ok: true };
}

/** A learner's progress across a program's competencies (empty when none defined yet). */
export async function progressFor(userId: string, programSlug: string): Promise<{ competency: Competency; status: ProgressState }[]> {
  await ensureCompetencySchema();
  const comps = await listCompetencies(programSlug);
  if (comps.length === 0) return [];
  const prog = rows(await db.execute(sql`SELECT competency_id, status FROM aquin_competency_progress WHERE user_id = ${userId}`));
  const byId = new Map(prog.map((p: any) => [String(p.competency_id), p.status]));
  return comps.map((c) => ({ competency: c, status: (byId.get(c.id) as ProgressState) || 'not_started' }));
}

export async function setProgress(userId: string, competencyId: string, status: ProgressState, verifiedBy?: string | null): Promise<void> {
  await ensureCompetencySchema();
  const s = PROGRESS_STATES.includes(status) ? status : 'not_started';
  await db.execute(sql`INSERT INTO aquin_competency_progress (user_id, competency_id, status, verified_by, updated_at)
    VALUES (${userId}, ${competencyId}, ${s}, ${verifiedBy || null}, NOW())
    ON CONFLICT (user_id, competency_id) DO UPDATE SET status = ${s}, verified_by = ${verifiedBy || null}, updated_at = NOW()`);
}
