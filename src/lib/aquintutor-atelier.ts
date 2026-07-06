// AquinTutor Atelier — the vocational / lifelong tier signature. A career-
// switcher picks a trade credential track and works through its practical
// competencies, logging EVIDENCE for each (the way apprenticeship / NVQ
// portfolios work) until the track is portfolio-ready. Server-persisted,
// self-bootstrapping schema, no LLM. Competency-based, evidence-driven — not
// passive video.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export interface Competency { key: string; label: string; detail: string; }
export interface Track { id: string; name: string; field: string; blurb: string; competencies: Competency[]; }

export const TRACKS: Track[] = [
  {
    id: 'solar-pv', name: 'Solar PV Installer', field: 'Renewable energy',
    blurb: 'Install and commission rooftop solar safely — from site survey to handover.',
    competencies: [
      { key: 'site', label: 'Site assessment & shading survey', detail: 'Assess roof orientation, tilt, load-bearing and shading; record a survey with expected yield.' },
      { key: 'mount', label: 'Panel mounting & racking', detail: 'Mount rails and clamp panels to spec, with correct spacing and weatherproofing.' },
      { key: 'dcwiring', label: 'DC string wiring', detail: 'Wire panels into strings with correct polarity, connectors and cable management.' },
      { key: 'inverter', label: 'Inverter installation & configuration', detail: 'Mount and configure the inverter; set grid parameters correctly.' },
      { key: 'earthing', label: 'Earthing & electrical safety', detail: 'Install earthing/bonding and isolation; demonstrate safe lock-out procedure.' },
      { key: 'commission', label: 'Commissioning & testing', detail: 'Run insulation, polarity and performance tests; verify against expected output.' },
      { key: 'handover', label: 'Handover documentation', detail: 'Produce a commissioning report and customer handover pack.' },
    ],
  },
  {
    id: 'web-dev', name: 'Full-Stack Web Developer', field: 'Software',
    blurb: 'Build, secure and ship a full web application end to end.',
    competencies: [
      { key: 'layout', label: 'Semantic, responsive layout', detail: 'Build an accessible, responsive page with semantic HTML and modern CSS.' },
      { key: 'interactivity', label: 'Client-side interactivity', detail: 'Implement stateful UI behaviour without breaking accessibility.' },
      { key: 'api', label: 'REST API design & build', detail: 'Design and implement a versioned REST API with validation and error handling.' },
      { key: 'db', label: 'Relational data modelling', detail: 'Design a normalised schema with keys, indexes and migrations.' },
      { key: 'auth', label: 'Authentication & sessions', detail: 'Implement secure sign-in and session management (no plaintext secrets).' },
      { key: 'vcs', label: 'Version control workflow', detail: 'Use branches, reviews and meaningful commits on a real repository.' },
      { key: 'deploy', label: 'Deploy to production', detail: 'Ship to a live environment with env config and a rollback plan.' },
    ],
  },
  {
    id: 'cnc', name: 'CNC Machinist', field: 'Precision manufacturing',
    blurb: 'Turn an engineering drawing into a finished, inspected part.',
    competencies: [
      { key: 'drawings', label: 'Read engineering drawings', detail: 'Interpret GD&T, tolerances and datums from a technical drawing.' },
      { key: 'material', label: 'Material & tooling selection', detail: 'Select stock, tools and speeds/feeds for the material and finish required.' },
      { key: 'setup', label: 'Machine & work-holding setup', detail: 'Set work offsets, tool offsets and secure work-holding safely.' },
      { key: 'cam', label: 'CAM programming', detail: 'Generate a tool-path program and verify it by simulation before cutting.' },
      { key: 'operate', label: 'Safe machine operation', detail: 'Run the job with correct PPE, guarding and emergency procedures.' },
      { key: 'qc', label: 'Measurement & quality control', detail: 'Inspect the part against tolerance using calipers, micrometers or CMM.' },
      { key: 'maintain', label: 'Preventive maintenance', detail: 'Perform routine machine checks and record maintenance.' },
    ],
  },
  {
    id: 'data-analyst', name: 'Data Analyst', field: 'Data',
    blurb: 'Turn raw data into a decision a stakeholder can act on.',
    competencies: [
      { key: 'clean', label: 'Data cleaning & preparation', detail: 'Handle missing values, types and duplicates to produce a tidy dataset.' },
      { key: 'sql', label: 'SQL querying', detail: 'Write joins, aggregations and window functions to answer real questions.' },
      { key: 'stats', label: 'Applied statistics', detail: 'Choose and apply appropriate summary statistics and significance tests.' },
      { key: 'viz', label: 'Data visualisation', detail: 'Build clear, honest charts that answer the question (no chartjunk).' },
      { key: 'dashboard', label: 'Dashboard build', detail: 'Assemble an interactive dashboard with the right KPIs.' },
      { key: 'experiment', label: 'Experiment interpretation', detail: 'Interpret an A/B test correctly, including caveats and confidence.' },
      { key: 'report', label: 'Stakeholder reporting', detail: 'Communicate findings and a recommendation to a non-technical audience.' },
    ],
  },
];
export const TRACK_BY_ID: Record<string, Track> = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

let ready: Promise<void> | null = null;
export function ensureAtelierSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_atelier_evidence (
        user_id UUID NOT NULL,
        track TEXT NOT NULL,
        competency_key TEXT NOT NULL,
        demonstrated BOOLEAN NOT NULL DEFAULT false,
        evidence TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, track, competency_key))`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export interface CompetencyState extends Competency { demonstrated: boolean; evidence: string; }

export async function getTrackState(userId: string, trackId: string): Promise<{ track: Track; items: CompetencyState[]; done: number } | null> {
  await ensureAtelierSchema();
  const track = TRACK_BY_ID[trackId];
  if (!track) return null;
  const ev: Record<string, { demonstrated: boolean; evidence: string }> = {};
  rows(await db.execute(sql`SELECT competency_key, demonstrated, evidence FROM aq_atelier_evidence WHERE user_id = ${userId} AND track = ${trackId}`))
    .forEach((r: any) => { ev[r.competency_key] = { demonstrated: !!r.demonstrated, evidence: r.evidence || '' }; });
  const items = track.competencies.map((c) => ({ ...c, demonstrated: ev[c.key]?.demonstrated || false, evidence: ev[c.key]?.evidence || '' }));
  return { track, items, done: items.filter((i) => i.demonstrated).length };
}

export async function saveEvidence(userId: string, trackId: string, key: string, demonstrated: boolean, evidence: string): Promise<boolean> {
  await ensureAtelierSchema();
  const track = TRACK_BY_ID[trackId];
  if (!track || !track.competencies.some((c) => c.key === key)) return false;
  await db.execute(sql`INSERT INTO aq_atelier_evidence (user_id, track, competency_key, demonstrated, evidence)
    VALUES (${userId}, ${trackId}, ${key}, ${demonstrated}, ${(evidence || '').slice(0, 4000)})
    ON CONFLICT (user_id, track, competency_key) DO UPDATE SET demonstrated = ${demonstrated}, evidence = ${(evidence || '').slice(0, 4000)}, updated_at = NOW()`);
  return true;
}

// Cross-track summary for the picker (how far along each track is).
export async function getProgressByTrack(userId: string): Promise<Record<string, number>> {
  await ensureAtelierSchema();
  const out: Record<string, number> = {};
  rows(await db.execute(sql`SELECT track, COUNT(*) FILTER (WHERE demonstrated)::int AS done FROM aq_atelier_evidence WHERE user_id = ${userId} GROUP BY track`))
    .forEach((r: any) => { out[r.track] = Number(r.done || 0); });
  return out;
}
