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

// WHAT WAS WRONG WITH THIS MODULE.
//
// It was a complete competency framework that nothing could reach. /aquintutor/competencies renders
// DIMENSIONS and ASSESSMENT_MODES — two constant arrays — and tells the reader that "a learner's
// progress moves through not started, in progress, demonstrated, verified". listCompetencies,
// addCompetency, progressFor and setProgress were called by no page, so aquin_competencies had no
// writer and aquin_competency_progress had neither a writer nor a reader. No learner could hold any
// state at all, and the sentence describing the progression described nothing.
//
// The mount is /admin/aquintutor/curriculum — defining competencies against a programme, and
// recording where a named learner has got to — plus the progress panel on /aquintutor/competencies,
// where a learner reads her own.
//
// THE READS ARE DISCRIMINATED. A programme with no competencies yet and a database that could not be
// read used to render the identical empty page. The difference matters: the first invites faculty to
// define some, the second means the ones they already defined are missing.

export type CompetencyRead<T> = { ok: true; value: T } | { ok: false; reason: string };
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

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
    } catch (e: any) {
      // _ready = null so the NEXT request retries instead of caching a failed bootstrap for the life
      // of the process. It is also LOGGED now: this used to be `catch (_) { _ready = null; }`, so a
      // missing table showed up much later as an empty framework page with nothing written anywhere.
      console.error('[aquin-competencies] schema ensure failed:', reasonOf(e));
      _ready = null;
      throw e;
    }
  })();
  return _ready;
}

export interface Competency {
  id: string; programSlug: string; code: string; name: string; dimension: string; assessmentMode: string; description: string;
}
function toCompetency(r: any): Competency {
  return { id: String(r.id), programSlug: r.program_slug || '', code: r.code || '', name: r.name, dimension: r.dimension || 'theory', assessmentMode: r.assessment_mode || 'online', description: r.description || '' };
}

export async function listCompetencies(programSlug: string): Promise<CompetencyRead<Competency[]>> {
  try {
    await ensureCompetencySchema();
    const r = rows(await db.execute(sql`SELECT * FROM aquin_competencies WHERE program_slug = ${programSlug} ORDER BY sort_order ASC, code ASC`));
    return { ok: true, value: r.map(toCompetency) };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-competencies] listCompetencies:', reason);
    return { ok: false, reason };
  }
}

/** Every programme that has at least one competency defined, with how many. */
export async function programsWithCompetencies(): Promise<CompetencyRead<{ programSlug: string; count: number }[]>> {
  try {
    await ensureCompetencySchema();
    const r = rows(await db.execute(sql`
      SELECT program_slug, COUNT(*)::int AS n FROM aquin_competencies
      GROUP BY program_slug ORDER BY program_slug ASC`));
    return { ok: true, value: r.map((x: any) => ({ programSlug: String(x.program_slug || ''), count: Number(x.n || 0) })) };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-competencies] programsWithCompetencies:', reason);
    return { ok: false, reason };
  }
}

export async function addCompetency(c: { programSlug: string; code?: string; name: string; dimension?: string; assessmentMode?: string; description?: string; sortOrder?: number }): Promise<{ ok: boolean; error?: string }> {
  const name = String(c.name || '').trim();
  if (!name) return { ok: false, error: 'Competency name is required.' };
  const programSlug = String(c.programSlug || '').trim().slice(0, 80);
  if (!programSlug) return { ok: false, error: 'Choose the programme this competency belongs to.' };
  const dimension = DIMENSIONS.some((d) => d.key === c.dimension) ? c.dimension! : 'theory';
  const mode = ASSESSMENT_MODES.some((m) => m.key === c.assessmentMode) ? c.assessmentMode! : 'online';
  try {
    await ensureCompetencySchema();
    await db.execute(sql`INSERT INTO aquin_competencies (program_slug, code, name, dimension, assessment_mode, description, sort_order)
      VALUES (${programSlug}, ${String(c.code || '').slice(0, 40)}, ${name.slice(0, 200)}, ${dimension}, ${mode}, ${String(c.description || '').slice(0, 600)}, ${c.sortOrder ?? 0})`);
    return { ok: true };
  } catch (e: any) {
    // A write path never swallows. The caller prints this instead of a page that looks like it saved.
    const reason = reasonOf(e);
    console.error('[aquin-competencies] addCompetency:', reason);
    return { ok: false, error: 'That competency was not saved. Nothing has been recorded. (' + reason + ')' };
  }
}

/**
 * A learner's progress across a programme's competencies.
 *
 * An empty array used to mean three different things — no competencies defined, none for this
 * programme, or the query failed — and a learner reading "nothing yet" cannot tell which. The result
 * is discriminated, and an empty value now means only one thing: nobody has defined any.
 */
export async function progressFor(userId: string, programSlug: string): Promise<CompetencyRead<{ competency: Competency; status: ProgressState }[]>> {
  const comps = await listCompetencies(programSlug);
  if (!comps.ok) return comps;
  if (comps.value.length === 0) return { ok: true, value: [] };
  try {
    const prog = rows(await db.execute(sql`SELECT competency_id, status FROM aquin_competency_progress WHERE user_id = ${userId}`));
    const byId = new Map(prog.map((p: any) => [String(p.competency_id), p.status]));
    return {
      ok: true,
      value: comps.value.map((c) => ({ competency: c, status: (byId.get(c.id) as ProgressState) || 'not_started' })),
    };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-competencies] progressFor:', reason);
    return { ok: false, reason };
  }
}

/**
 * Record where a learner has got to on one competency.
 *
 * 'verified' is the state that means somebody with authority watched this happen, so verifiedBy is
 * recorded with it. Reported rather than thrown, because the only caller is a form and a person is
 * waiting to be told whether it saved.
 */
export async function setProgress(userId: string, competencyId: string, status: ProgressState, verifiedBy?: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!userId || !competencyId) return { ok: false, error: 'Choose both a learner and a competency.' };
  const s = PROGRESS_STATES.includes(status) ? status : 'not_started';
  try {
    await ensureCompetencySchema();
    await db.execute(sql`INSERT INTO aquin_competency_progress (user_id, competency_id, status, verified_by, updated_at)
      VALUES (${userId}, ${competencyId}, ${s}, ${verifiedBy || null}, NOW())
      ON CONFLICT (user_id, competency_id) DO UPDATE SET status = ${s}, verified_by = ${verifiedBy || null}, updated_at = NOW()`);
    return { ok: true };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-competencies] setProgress:', reason);
    return { ok: false, error: 'That was not recorded. The learner still shows whatever they showed before. (' + reason + ')' };
  }
}
