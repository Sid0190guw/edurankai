// AquinTutor Research — the postgraduate tier signature: a literature + thesis
// workspace. Manage references (add / tag / status / notes), export clean
// citations (APA, IEEE, BibTeX) computed from structured fields, and track
// thesis milestones. Server-persisted, self-bootstrapping schema, no LLM.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export const REF_STATUSES = ['to-read', 'reading', 'read', 'cited'] as const;
export type RefStatus = typeof REF_STATUSES[number];

// The canonical thesis pipeline (fixed order); learners tick milestones off.
export const THESIS_STEPS: { key: string; label: string }[] = [
  { key: 'topic', label: 'Topic & research question fixed' },
  { key: 'proposal', label: 'Proposal approved' },
  { key: 'litreview', label: 'Literature review drafted' },
  { key: 'method', label: 'Methodology defined' },
  { key: 'ethics', label: 'Ethics / data approvals' },
  { key: 'experiments', label: 'Experiments / fieldwork done' },
  { key: 'analysis', label: 'Results analysed' },
  { key: 'draft', label: 'Full draft written' },
  { key: 'revision', label: 'Supervisor revisions incorporated' },
  { key: 'submit', label: 'Submitted' },
  { key: 'defense', label: 'Defended' },
];
const STEP_KEYS = new Set(THESIS_STEPS.map((s) => s.key));

export interface Reference {
  id: string; title: string; authors: string; year: number | null; venue: string;
  url: string; tags: string; status: RefStatus; notes: string;
}

let ready: Promise<void> | null = null;
export function ensureResearchSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_ref (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        title TEXT NOT NULL,
        authors TEXT NOT NULL DEFAULT '',
        year INT,
        venue TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'to-read',
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_ref_user_idx ON aq_ref (user_id, created_at DESC)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_thesis_step (
        user_id UUID NOT NULL,
        step_key TEXT NOT NULL,
        done BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, step_key))`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

function clampStatus(s: any): RefStatus { return (REF_STATUSES as readonly string[]).includes(s) ? s : 'to-read'; }
function clean(s: any, n = 500): string { return (s == null ? '' : String(s)).slice(0, n); }

export async function listRefs(userId: string): Promise<Reference[]> {
  await ensureResearchSchema();
  return rows(await db.execute(sql`SELECT id, title, authors, year, venue, url, tags, status, notes FROM aq_ref WHERE user_id = ${userId} ORDER BY created_at DESC`))
    .map((r: any) => ({ id: r.id, title: r.title, authors: r.authors, year: r.year != null ? Number(r.year) : null, venue: r.venue, url: r.url, tags: r.tags, status: clampStatus(r.status), notes: r.notes }));
}

export async function addRef(userId: string, f: Partial<Reference>): Promise<string | null> {
  await ensureResearchSchema();
  const title = clean(f.title, 500).trim();
  if (!title) return null;
  const year = f.year != null && !isNaN(Number(f.year)) ? Math.trunc(Number(f.year)) : null;
  const r = rows(await db.execute(sql`INSERT INTO aq_ref (user_id, title, authors, year, venue, url, tags, status, notes)
    VALUES (${userId}, ${title}, ${clean(f.authors, 800)}, ${year}, ${clean(f.venue, 300)}, ${clean(f.url, 500)}, ${clean(f.tags, 300)}, ${clampStatus(f.status)}, ${clean(f.notes, 4000)})
    RETURNING id`))[0];
  return r?.id || null;
}

export async function updateRef(userId: string, id: string, f: Partial<Reference>): Promise<void> {
  await ensureResearchSchema();
  const year = f.year != null && !isNaN(Number(f.year)) ? Math.trunc(Number(f.year)) : null;
  await db.execute(sql`UPDATE aq_ref SET
    title = ${clean(f.title, 500)}, authors = ${clean(f.authors, 800)}, year = ${year},
    venue = ${clean(f.venue, 300)}, url = ${clean(f.url, 500)}, tags = ${clean(f.tags, 300)},
    status = ${clampStatus(f.status)}, notes = ${clean(f.notes, 4000)}
    WHERE id = ${id} AND user_id = ${userId}`);
}

export async function setRefStatus(userId: string, id: string, status: RefStatus): Promise<void> {
  await ensureResearchSchema();
  await db.execute(sql`UPDATE aq_ref SET status = ${clampStatus(status)} WHERE id = ${id} AND user_id = ${userId}`);
}

export async function deleteRef(userId: string, id: string): Promise<void> {
  await ensureResearchSchema();
  await db.execute(sql`DELETE FROM aq_ref WHERE id = ${id} AND user_id = ${userId}`);
}

export async function getThesisSteps(userId: string): Promise<Record<string, boolean>> {
  await ensureResearchSchema();
  const out: Record<string, boolean> = {};
  rows(await db.execute(sql`SELECT step_key, done FROM aq_thesis_step WHERE user_id = ${userId}`)).forEach((r: any) => { out[r.step_key] = !!r.done; });
  return out;
}

export async function setThesisStep(userId: string, key: string, done: boolean): Promise<void> {
  await ensureResearchSchema();
  if (!STEP_KEYS.has(key)) return;
  await db.execute(sql`INSERT INTO aq_thesis_step (user_id, step_key, done) VALUES (${userId}, ${key}, ${done})
    ON CONFLICT (user_id, step_key) DO UPDATE SET done = ${done}, updated_at = NOW()`);
}
