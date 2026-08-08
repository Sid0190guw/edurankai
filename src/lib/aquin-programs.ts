// src/lib/aquin-programs.ts — AquinTutor's degree/program catalog, classified by the delivery-model
// taxonomy (see docs/aquintutor-university-model.md §1). Each program declares HOW it is delivered:
// the digital-academics share (virtualPct) and the partner type that supplies practical training.
// Self-bootstrapping DDL + an idempotent seed of the founder's degree portfolio.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export interface DeliveryModel {
  n: number; key: string; title: string; academics: string; practical: string;
  virtualPct: number; partnerType: string;
}

// The 8 delivery models — the spine of the catalog.
export const DELIVERY_MODELS: DeliveryModel[] = [
  { n: 1, key: 'fully-virtual', title: 'Fully Virtual', academics: '95–100% online', practical: 'None required', virtualPct: 100, partnerType: 'None — fully online' },
  { n: 2, key: 'industry-projects', title: 'Virtual + Industry Projects', academics: 'Online', practical: 'Projects with industry partners', virtualPct: 85, partnerType: 'Industry partners (GitHub, cloud, remote GPUs, mentors)' },
  { n: 3, key: 'remote-labs', title: 'Virtual + Remote Laboratories', academics: 'Online', practical: 'Remote / virtual laboratories', virtualPct: 80, partnerType: 'Remote FPGA / PLC / oscilloscope / circuit-sim labs' },
  { n: 4, key: 'partner-industry-labs', title: 'Virtual + Partner Industry Labs', academics: 'Online', practical: 'Hands-on at partner facilities', virtualPct: 75, partnerType: 'Manufacturing plants, engineering & testing firms' },
  { n: 5, key: 'hospital-partnerships', title: 'Virtual + Hospital Partnerships', academics: 'Online', practical: 'Clinical rotations, certified supervision', virtualPct: 70, partnerType: 'Affiliated hospitals & clinics' },
  { n: 6, key: 'research-institutes', title: 'Virtual + Research Institutes', academics: 'Online', practical: 'Research at partner institutes', virtualPct: 75, partnerType: 'National labs, research & R&D centres' },
  { n: 7, key: 'field-work', title: 'Virtual + Field Work', academics: 'Online', practical: 'Supervised local fieldwork', virtualPct: 80, partnerType: 'NGOs, govt agencies, farms, field centres' },
  { n: 8, key: 'creative-studios', title: 'Virtual + Creative Studios', academics: 'Online', practical: 'Studio practice at partners', virtualPct: 80, partnerType: 'Partner studios, production houses, maker spaces' },
];
export function modelByN(n: number): DeliveryModel { return DELIVERY_MODELS.find((m) => m.n === n) || DELIVERY_MODELS[0]; }

export type ProgramLevel = 'Bachelor' | 'Master' | 'Diploma' | 'Certificate';

interface SeedProgram { name: string; level: ProgramLevel; discipline: string; model: number; }

// Founder's degree portfolio, mapped to delivery models. Regulated hybrid-only programs are marked
// with `regulated: true` in the DDL seed below (they stay partner-delivered for clinical competency).
const SEED: SeedProgram[] = [
  // 1 — Fully virtual
  ...['Business Administration (BBA)', 'Commerce (B.Com.)', 'Arts', 'Economics', 'Public Policy',
    'International Relations', 'Psychology (non-clinical)', 'Data Analytics', 'Digital Marketing',
    'Human Resource Management', 'Finance', 'Accounting', 'Supply Chain Management', 'Entrepreneurship',
    'Project Management', 'Journalism (digital)', 'Graphic Design', 'UI/UX Design', 'Animation',
    'Game Design', 'Cyber Law', 'Intellectual Property', 'Philosophy']
    .map((d): SeedProgram => ({ name: 'Bachelor of ' + d, level: 'Bachelor', discipline: d, model: 1 })),
  // 2 — Virtual + industry projects
  ...['Computer Science', 'Software Engineering', 'Artificial Intelligence', 'Data Science',
    'Information Technology', 'Cybersecurity', 'Cloud Computing', 'Blockchain', 'Quantum Computing (software)',
    'Robotics Software', 'DevOps', 'Product Management', 'Business Analytics']
    .map((d): SeedProgram => ({ name: 'B.Tech / B.Sc ' + d, level: 'Bachelor', discipline: d, model: 2 })),
  // 3 — Virtual + remote labs
  ...['Electronics Engineering', 'Electrical Engineering', 'Mechatronics', 'Internet of Things',
    'Embedded Systems', 'Telecommunications']
    .map((d): SeedProgram => ({ name: 'B.Tech ' + d, level: 'Bachelor', discipline: d, model: 3 })),
  // 4 — Virtual + partner industry labs
  ...['Mechanical Engineering', 'Civil Engineering', 'Chemical Engineering', 'Automobile Engineering',
    'Manufacturing Engineering', 'Industrial Engineering', 'Textile Engineering', 'Mining Engineering']
    .map((d): SeedProgram => ({ name: 'B.Tech ' + d, level: 'Bachelor', discipline: d, model: 4 })),
  // 5 — Virtual + hospital partnerships
  ...['Nursing', 'Physiotherapy', 'Occupational Therapy', 'Radiology', 'Medical Laboratory Technology',
    'Public Health', 'Nutrition', 'Pharmacy', 'Dental Hygiene']
    .map((d): SeedProgram => ({ name: 'Bachelor of ' + d, level: 'Bachelor', discipline: d, model: 5 })),
  // 6 — Virtual + research institutes
  ...['Physics', 'Chemistry', 'Biology', 'Biotechnology', 'Materials Science', 'Environmental Science', 'Earth Sciences']
    .map((d): SeedProgram => ({ name: 'B.Sc ' + d, level: 'Bachelor', discipline: d, model: 6 })),
  // 7 — Virtual + field work
  ...['Agriculture', 'Forestry', 'Environmental Studies', 'Wildlife Science', 'Geology', 'Geography']
    .map((d): SeedProgram => ({ name: 'B.Sc ' + d, level: 'Bachelor', discipline: d, model: 7 })),
  // 8 — Virtual + creative studios
  ...['Architecture', 'Interior Design', 'Fashion Design', 'Film Production', 'Music Production']
    .map((d): SeedProgram => ({ name: 'Bachelor of ' + d, level: 'Bachelor', discipline: d, model: 8 })),
  // Postgraduate & professional (virtual-first)
  { name: 'Master of Business Administration (MBA)', level: 'Master', discipline: 'Business Administration', model: 1 },
  { name: 'Executive MBA', level: 'Master', discipline: 'Business Administration', model: 1 },
  { name: 'Master of Commerce (M.Com.)', level: 'Master', discipline: 'Commerce', model: 1 },
  { name: 'M.Sc Artificial Intelligence', level: 'Master', discipline: 'Artificial Intelligence', model: 2 },
  { name: 'M.Sc Data Science', level: 'Master', discipline: 'Data Science', model: 2 },
  { name: 'M.Tech Artificial Intelligence', level: 'Master', discipline: 'Artificial Intelligence', model: 2 },
  { name: 'Postgraduate Diploma (various)', level: 'Diploma', discipline: 'Interdisciplinary', model: 1 },
  { name: 'Professional Certificate (various)', level: 'Certificate', discipline: 'Interdisciplinary', model: 1 },
  { name: 'Micro-credential (various)', level: 'Certificate', discipline: 'Interdisciplinary', model: 1 },
];

// Regulated, hybrid-only qualifications — offered ONLY within statutory requirements, clinical
// competency delivered through accredited partners (see docs §3). Listed separately, not "virtual".
const REGULATED: { name: string; discipline: string; note: string }[] = [
  { name: 'MBBS', discipline: 'Medicine', note: 'Hybrid only — National Medical Commission standards; clinical training at accredited partner hospitals.' },
  { name: 'BDS', discipline: 'Dentistry', note: 'Hybrid only — Dental Council framework; clinical training at accredited partners.' },
  { name: 'Veterinary Medicine', discipline: 'Veterinary', note: 'Hybrid only — regulated clinical practical at accredited partners.' },
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * THE FAILURE THAT LOOKED LIKE AN EMPTY CATALOGUE.
 *
 * ensureProgramsSchema() ended in `catch (_) { _ready = null; }` and seedPrograms() in
 * `catch (_) {}`, with nothing logged by either. listPrograms() then ran its SELECT against a table
 * that might not exist, and /aquintutor/programs rendered a catalogue with no programmes in it and
 * no message — pixel-identical to "nothing has been published yet". The programme portfolio is the
 * university model's public face; "we publish nothing" is not a sentence to say by accident.
 *
 * Both now log the real reason (e.cause, not e.message, which is only the failed SQL), and
 * listPrograms() reports whether it actually looked.
 */
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

let _ready: Promise<void> | null = null;
export function ensureProgramsSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aquin_programs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'Bachelor',
        discipline TEXT NOT NULL DEFAULT '',
        delivery_model INT NOT NULL DEFAULT 1,
        virtual_pct INT NOT NULL DEFAULT 100,
        partner_type TEXT NOT NULL DEFAULT '',
        regulated BOOLEAN NOT NULL DEFAULT false,
        regulatory_note TEXT NOT NULL DEFAULT '',
        is_published BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aquin_programs_model_idx ON aquin_programs (delivery_model, sort_order)`);
    } catch (e: any) {
      // Dropped from the cache so the next request retries, and NAMED so the empty catalogue that
      // follows is explicable to whoever is looking at the logs.
      console.error('[aquin-programs] ensureProgramsSchema', reasonOf(e));
      _ready = null;
      throw e;
    }
  })();
  // Swallowed here only so existing callers keep their tolerate-missing-schema behaviour; the reason
  // is already logged and listPrograms() below reports the failure to the page.
  return _ready.catch(() => {});
}

/** Idempotent seed — inserts the portfolio once; safe to call on every page load (skips if present). */
export async function seedPrograms(): Promise<void> {
  await ensureProgramsSchema();
  try {
    const n = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM aquin_programs`))[0]?.c || 0);
    if (n > 0) return;
    let order = 0;
    for (const p of SEED) {
      const m = modelByN(p.model);
      await db.execute(sql`INSERT INTO aquin_programs (slug, name, level, discipline, delivery_model, virtual_pct, partner_type, sort_order)
        VALUES (${slugify(p.name + '-' + p.discipline)}, ${p.name}, ${p.level}, ${p.discipline}, ${p.model}, ${m.virtualPct}, ${m.partnerType}, ${order++})
        ON CONFLICT (slug) DO NOTHING`);
    }
    for (const r of REGULATED) {
      await db.execute(sql`INSERT INTO aquin_programs (slug, name, level, discipline, delivery_model, virtual_pct, partner_type, regulated, regulatory_note, sort_order)
        VALUES (${slugify(r.name)}, ${r.name}, 'Bachelor', ${r.discipline}, 5, 60, 'Accredited teaching hospitals / regulated partners', true, ${r.note}, ${order++})
        ON CONFLICT (slug) DO NOTHING`);
    }
  } catch (e: any) {
    // Best-effort by design — a seed failure must not take the page down — but never silent. An
    // unseeded catalogue and a published-nothing catalogue look identical on screen.
    console.error('[aquin-programs] seedPrograms', reasonOf(e));
  }
}

export interface Program {
  id: string; slug: string; name: string; level: string; discipline: string;
  deliveryModel: number; virtualPct: number; partnerType: string; regulated: boolean; regulatoryNote: string;
}
function toProgram(r: any): Program {
  return {
    id: String(r.id), slug: r.slug, name: r.name, level: r.level, discipline: r.discipline,
    deliveryModel: Number(r.delivery_model) || 1, virtualPct: Number(r.virtual_pct) || 0,
    partnerType: r.partner_type || '', regulated: !!r.regulated, regulatoryNote: r.regulatory_note || '',
  };
}

export type ProgramsResult =
  | { ok: true; programs: Program[] }
  | { ok: false; reason: string };

/**
 * The published portfolio, with the read's own outcome attached.
 *
 * This used to throw out of the page (or, with the swallowed schema-ensure above it, return nothing
 * at all) and the catalogue rendered empty. An empty catalogue is a claim — "we publish no
 * programmes" — and it must never be made by a failed query.
 */
export async function listProgramsResult(): Promise<ProgramsResult> {
  try {
    await seedPrograms();
    const r = rows(await db.execute(sql`SELECT * FROM aquin_programs WHERE is_published = true ORDER BY regulated ASC, delivery_model ASC, sort_order ASC`));
    return { ok: true, programs: r.map(toProgram) };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[aquin-programs] listPrograms', reason);
    return { ok: false, reason };
  }
}

/** Kept for callers that only want the rows. Prefer listProgramsResult() on any page that renders
 *  an empty state, so a read failure is not printed as "nothing is published". */
export async function listPrograms(): Promise<Program[]> {
  const r = await listProgramsResult();
  return r.ok ? r.programs : [];
}

export async function getProgram(slug: string): Promise<Program | null> {
  await ensureProgramsSchema();
  const r = rows(await db.execute(sql`SELECT * FROM aquin_programs WHERE slug = ${slug} AND is_published = true LIMIT 1`))[0];
  return r ? toProgram(r) : null;
}

/** All published program slugs — for static path generation on the detail route. */
export async function allProgramSlugs(): Promise<string[]> {
  try { await seedPrograms(); return rows(await db.execute(sql`SELECT slug FROM aquin_programs WHERE is_published = true`)).map((r) => String(r.slug)); }
  catch { return []; }
}

/** The delivery breakdown for one program — what is digital, what is virtual-lab, what is partner
 *  practical, and how it is assessed. Derived from the delivery model; honest per §1 of the spec. */
export function deliveryBreakdown(p: Program): { digital: string; practical: string; assessment: string; immersive: string } {
  const m = modelByN(p.deliveryModel);
  return {
    digital: `${p.virtualPct}% delivered online — live and recorded classes, AI tutoring, real-time visualization and simulations, on a laptop, tablet or phone.`,
    practical: p.deliveryModel === 1
      ? 'No external practical component — this program is fully online.'
      : `Practical training through ${m.partnerType.toLowerCase()}, with competencies assessed on-site.`,
    assessment: p.deliveryModel === 1
      ? 'Continuous online assessment, proctored examinations and verifiable credentials.'
      : 'Joint, competency-based assessment by AquinTutor and the partner institution.',
    immersive: 'AR/VR/XR is used selectively — for laboratory work, anatomy, simulations and design visualization — not as the everyday teaching medium.',
  };
}

/** Programs grouped by delivery model (virtual first), plus a separate regulated/hybrid bucket. */
/**
 * `ok` travels with the grouping so /aquintutor/programs can distinguish "no programme is published"
 * from "the catalogue could not be read". The page used to wrap this whole call in
 * `catch (e) { /* renders the taxonomy even if the DB is unavailable *\/ }` and then render the
 * delivery-model taxonomy with zero programmes under it, which reads as a portfolio we have not
 * filled in rather than one we could not load.
 */
export async function programsByModel(): Promise<{ ok: boolean; reason?: string; virtual: { model: DeliveryModel; programs: Program[] }[]; regulated: Program[] }> {
  const res = await listProgramsResult();
  if (!res.ok) return { ok: false, reason: res.reason, virtual: [], regulated: [] };
  const all = res.programs;
  const virtual = DELIVERY_MODELS.map((model) => ({ model, programs: all.filter((p) => !p.regulated && p.deliveryModel === model.n) }))
    .filter((g) => g.programs.length > 0);
  const regulated = all.filter((p) => p.regulated);
  return { ok: true, virtual, regulated };
}
