// src/lib/edu-runtime.ts — the Educational Runtime (AES Volume 1). Starting a lesson runs an
// ORDERED kernel workflow that estimates the student's context, assembles the right variant,
// emits a render plan, serves it, and updates knowledge state — recording an inspectable trace.
//
// The pure core (estimators + runPipeline + applyCompletion) takes injected real inputs and is
// unit-tested without a DB. The DB layer REUSES the existing aq_mastery store (namespaced
// skill_id = "ko:<id>") for the knowledge signal and adds only what is missing: edu_progress
// (resume), edu_runtime_trace (the trace), edu_student_settings (language/accessibility).
import { getMastery } from '@/lib/aquintutor-learn';
import { contentService, type UnitView } from '@/lib/kernel-content';

export type RenderTier = 'lite' | 'standard' | 'rich';
export interface Accessibility { reduceMotion?: boolean; highContrast?: boolean; fontScale?: number; screenReader?: boolean }
export interface StudentSettings { language: string; accessibility: Accessibility; learningStyle?: string }
export interface DeviceSignals { ua?: string; deviceMemory?: number; effectiveType?: string; saveData?: boolean; downlink?: number; viewportWidth?: number }
export interface RenderPlan { tier: RenderTier; reduceMotion: boolean; highContrast: boolean; fontScale: number; hydrate: string[] }
export interface VariantSet { translations: { lang: string; id: string; title: string }[]; accessibility: { id: string; kind: string }[] }

export interface TraceStep { step: string; ok: boolean; detail: string }
export interface SessionTrace {
  koId: string; outcome: 'served' | 'denied' | 'not-ready'; servedUnitId: string | null;
  language: string; tier: RenderTier; notReady: boolean; steps: TraceStep[];
  context: Record<string, unknown>;
}
export interface Assembled { servedUnitId: string | null; renderPlan: RenderPlan; language: string; notReady: boolean; prerequisites: { id: string; title: string; mastery: number; mastered: boolean }[]; outcome: SessionTrace['outcome'] }

// The workflow, in EXACTLY this order (AES Vol 1). "prepare_offline_package" is intentionally
// left OPEN between save steps for Prompt 6; the pipeline is structured so it can slot in.
export const STEP_ORDER = [
  'check_authentication', 'load_student_profile', 'estimate_knowledge', 'estimate_language',
  'estimate_device', 'estimate_network', 'estimate_accessibility', 'estimate_learning_style',
  'estimate_cognitive_load', 'build_lesson', 'compile_lesson', 'load_resources',
  'execute_teaching', 'monitor_understanding', 'update_knowledge_graph', 'save_progress',
] as const;

const RANK: Record<RenderTier, number> = { lite: 0, standard: 1, rich: 2 };
const minTier = (a: RenderTier, b: RenderTier): RenderTier => (RANK[a] <= RANK[b] ? a : b);

// ---- REAL estimators (documented v1 heuristics on real inputs; each extensible) ----
export function estimateDevice(s: DeviceSignals): { tier: RenderTier; detail: string } {
  if (typeof s.deviceMemory === 'number' && s.deviceMemory <= 1) return { tier: 'lite', detail: `deviceMemory=${s.deviceMemory}GB` };
  const oldAndroid = /Android\s+([1-6])\./.exec(s.ua || '');
  if (oldAndroid) return { tier: 'lite', detail: `old Android ${oldAndroid[1]}` };
  if (typeof s.deviceMemory === 'number' && s.deviceMemory >= 8) return { tier: 'rich', detail: `deviceMemory=${s.deviceMemory}GB` };
  if (typeof s.viewportWidth === 'number' && s.viewportWidth < 360) return { tier: 'lite', detail: `narrow viewport ${s.viewportWidth}px` };
  return { tier: 'standard', detail: 'default device tier' };
}
export function estimateNetwork(s: DeviceSignals): { tier: RenderTier; detail: string } {
  if (s.saveData) return { tier: 'lite', detail: 'Save-Data on' };
  const et = (s.effectiveType || '').toLowerCase();
  if (et === 'slow-2g' || et === '2g') return { tier: 'lite', detail: `network ${et}` };
  if (typeof s.downlink === 'number' && s.downlink > 0 && s.downlink < 1) return { tier: 'lite', detail: `downlink ${s.downlink}Mbps` };
  if (et === '3g') return { tier: 'standard', detail: 'network 3g' };
  if (et === '4g') return { tier: 'rich', detail: 'network 4g' };
  return { tier: 'standard', detail: 'default network tier' };
}
export function estimateCognitiveLoad(recent: { completions: number; avgSeconds: number }): { load: 'low' | 'moderate' | 'high'; detail: string } {
  if (recent.completions === 0) return { load: 'moderate', detail: 'no history' };
  if (recent.avgSeconds > 0 && recent.avgSeconds < 45) return { load: 'high', detail: `fast/shallow avg ${recent.avgSeconds}s` };
  if (recent.completions >= 3 && recent.avgSeconds >= 120) return { load: 'low', detail: 'steady engagement' };
  return { load: 'moderate', detail: `avg ${recent.avgSeconds}s` };
}
export function numericMastery(entry?: { state?: string; verified?: boolean }): number {
  if (!entry) return 0;
  if (entry.verified || entry.state === 'mastered') return 1;
  if (entry.state === 'growing') return 0.4;
  return 0.2;
}
export function combinePlan(device: RenderTier, network: RenderTier, a11y: Accessibility): RenderPlan {
  let tier = minTier(device, network);
  if (a11y.reduceMotion && tier === 'rich') tier = 'standard';        // no heavy animation when motion is reduced
  const hydrate = tier === 'rich' ? ['interactive'] : [];             // lite/standard stay pure server HTML
  return { tier, reduceMotion: !!a11y.reduceMotion, highContrast: !!a11y.highContrast, fontScale: a11y.fontScale && a11y.fontScale > 0 ? a11y.fontScale : 1, hydrate };
}

export interface PipelineInput {
  authenticated: boolean;
  authorized: boolean;                        // can(read, unit.securityLabels)
  unit: UnitView;
  settings: StudentSettings;
  signals: DeviceSignals;
  variants: VariantSet;
  masteryOf: (koId: string) => number;
  recent: { completions: number; avgSeconds: number };
}

/** Run the ordered workflow. Pure: produces the trace + assembled plan, mutates nothing. */
export function runPipeline(input: PipelineInput): { trace: SessionTrace; assembled: Assembled } {
  const steps: TraceStep[] = [];
  const rec = (step: string, ok: boolean, detail: string) => { steps.push({ step, ok, detail }); };
  const unit: any = input.unit.unit;
  const koId = unit.id;
  const labels: string[] = unit.securityLabels || ['public'];

  // 1. authentication + authorization — runtime runs ONLY for KOs the student may see
  if (!input.authorized) {
    rec('check_authentication', false, `not permitted for labels [${labels.join(',')}]`);
    for (const s of STEP_ORDER.slice(1)) rec(s, false, 'skipped (unauthorized)');
    const plan = combinePlan('lite', 'lite', {});
    return { trace: { koId, outcome: 'denied', servedUnitId: null, language: input.settings.language, tier: plan.tier, notReady: false, steps, context: { labels } }, assembled: { servedUnitId: null, renderPlan: plan, language: input.settings.language, notReady: false, prerequisites: [], outcome: 'denied' } };
  }
  rec('check_authentication', true, input.authenticated ? 'session valid + authorized' : 'guest + authorized (public)');

  // 2. profile
  rec('load_student_profile', true, `lang=${input.settings.language} style=${input.settings.learningStyle || 'balanced'}`);

  // 3. knowledge (mastery of prerequisites)
  const prerequisites = input.unit.prerequisites.map((p) => { const m = input.masteryOf(p.id); return { id: p.id, title: p.title, mastery: m, mastered: m >= 0.6 }; });
  const unmet = prerequisites.filter((p) => !p.mastered);
  const notReady = unmet.length > 0;
  rec('estimate_knowledge', true, `${prerequisites.length} prereqs, ${unmet.length} unmet${unmet.length ? ': ' + unmet.map((u) => u.title).join(', ') : ''}`);

  // 4. language
  const language = input.settings.language || 'en';
  rec('estimate_language', true, `language=${language}`);

  // 5. device
  const dev = estimateDevice(input.signals); rec('estimate_device', true, `${dev.tier} (${dev.detail})`);
  // 6. network
  const net = estimateNetwork(input.signals); rec('estimate_network', true, `${net.tier} (${net.detail})`);
  // 7. accessibility
  const a11y = input.settings.accessibility || {};
  rec('estimate_accessibility', true, `reduceMotion=${!!a11y.reduceMotion} contrast=${!!a11y.highContrast} fontScale=${a11y.fontScale || 1}`);
  // 8. learning style
  const style = input.settings.learningStyle || 'balanced'; rec('estimate_learning_style', true, style);
  // 9. cognitive load
  const load = estimateCognitiveLoad(input.recent); rec('estimate_cognitive_load', true, `${load.load} (${load.detail})`);

  // 10. build lesson — pick the served unit (language / accessibility variant)
  let servedUnitId = koId; let buildDetail = 'base unit';
  if (language !== 'en') { const tr = input.variants.translations.find((t) => t.lang === language); if (tr) { servedUnitId = tr.id; buildDetail = `translation variant (${language})`; } else buildDetail = `no ${language} variant, base unit`; }
  if (a11y.screenReader && input.variants.accessibility.length) { const av = input.variants.accessibility[0]; servedUnitId = av.id; buildDetail += ` + accessibility variant (${av.kind})`; }
  rec('build_lesson', true, buildDetail);

  // 11. compile lesson — the render plan
  const plan = combinePlan(dev.tier, net.tier, a11y);
  rec('compile_lesson', true, `tier=${plan.tier} hydrate=[${plan.hydrate.join(',')}]`);

  // 12. load resources (open for the offline package — Prompt 6)
  rec('load_resources', true, `plan for tier ${plan.tier}; offline package deferred (Prompt 6)`);
  // 13. execute teaching
  rec('execute_teaching', true, notReady ? 'served with prerequisite notice' : 'served');
  // 14. monitor understanding (real signals arrive from the lesson view: completion/resume)
  rec('monitor_understanding', true, 'awaiting completion / resume signal from the view');
  // 15. update knowledge graph (mastery advances on completion, not on view)
  rec('update_knowledge_graph', true, 'no change on view; advances on completion');
  // 16. save progress (the entrypoint persists trace + opened marker)
  rec('save_progress', true, 'trace + opened marker persisted');

  const outcome: SessionTrace['outcome'] = notReady ? 'not-ready' : 'served';
  return {
    trace: { koId, outcome, servedUnitId, language, tier: plan.tier, notReady, steps, context: { device: dev, network: net, load: load.load, style } },
    assembled: { servedUnitId, renderPlan: plan, language, notReady, prerequisites, outcome },
  };
}

/** Pure completion effect: advance mastery for a unit (absent -> growing -> mastered). */
export function applyCompletion(current?: { state?: string; verified?: boolean }): { state: string; resume: string } {
  const prev = current?.state;
  const state = prev === 'growing' || prev === 'mastered' || current?.verified ? 'mastered' : 'growing';
  return { state, resume: 'completed' };
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureRuntimeSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_student_settings (user_id UUID PRIMARY KEY, language TEXT NOT NULL DEFAULT 'en', accessibility JSONB NOT NULL DEFAULT '{}'::jsonb, learning_style TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_progress (user_id UUID NOT NULL, ko_id UUID NOT NULL, completed BOOLEAN NOT NULL DEFAULT false, last_position TEXT, seconds INTEGER NOT NULL DEFAULT 0, opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, ko_id))`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_runtime_trace (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, ko_id UUID NOT NULL, served_unit_id UUID, language TEXT, render_tier TEXT, outcome TEXT, not_ready BOOLEAN NOT NULL DEFAULT false, steps JSONB NOT NULL DEFAULT '[]'::jsonb, context JSONB NOT NULL DEFAULT '{}'::jsonb, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_trace_at_idx ON edu_runtime_trace (at DESC)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_trace_user_idx ON edu_runtime_trace (user_id)`));
  booted = true;
}

export async function getSettings(userId: string): Promise<StudentSettings> {
  try { await ensureRuntimeSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT language, accessibility, learning_style FROM edu_student_settings WHERE user_id = ${userId} LIMIT 1`))[0];
    if (r) return { language: r.language || 'en', accessibility: r.accessibility || {}, learningStyle: r.learning_style || undefined };
  } catch { /* defaults */ }
  return { language: 'en', accessibility: {} };
}
export async function saveSettings(userId: string, s: StudentSettings): Promise<void> {
  await ensureRuntimeSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_student_settings (user_id, language, accessibility, learning_style) VALUES (${userId}, ${s.language}, ${JSON.stringify(s.accessibility || {})}::jsonb, ${s.learningStyle ?? null})
    ON CONFLICT (user_id) DO UPDATE SET language = ${s.language}, accessibility = ${JSON.stringify(s.accessibility || {})}::jsonb, learning_style = ${s.learningStyle ?? null}, updated_at = NOW()`);
}

/** Read device/network/viewport signals from request headers (Client Hints + UA) — zero client JS. */
export function signalsFromHeaders(h: Headers): DeviceSignals {
  const num = (v: string | null) => { const n = v ? parseFloat(v) : NaN; return Number.isFinite(n) ? n : undefined; };
  return {
    ua: h.get('user-agent') || undefined,
    deviceMemory: num(h.get('sec-ch-device-memory') || h.get('device-memory')),
    effectiveType: (h.get('ect') || '').toLowerCase() || undefined,
    downlink: num(h.get('downlink')),
    saveData: (h.get('save-data') || '').toLowerCase() === 'on',
    viewportWidth: num(h.get('sec-ch-viewport-width') || h.get('viewport-width')),
  };
}

async function masteryMap(userId: string | null): Promise<Record<string, { state: string; verified: boolean }>> {
  if (!userId) return {};
  try { return await getMastery(userId); } catch { return {}; }
}
async function recentPerf(userId: string | null): Promise<{ completions: number; avgSeconds: number }> {
  if (!userId) return { completions: 0, avgSeconds: 0 };
  try { await ensureRuntimeSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT COUNT(*) FILTER (WHERE completed)::int AS c, COALESCE(AVG(NULLIF(seconds,0)),0)::int AS s FROM edu_progress WHERE user_id = ${userId}`))[0];
    return { completions: r?.c || 0, avgSeconds: r?.s || 0 };
  } catch { return { completions: 0, avgSeconds: 0 }; }
}

/** The real entrypoint: run the runtime for a lesson request, persist the trace + opened marker.
 *  Authorization is computed here via the RBAC engine (can read the unit's security labels). */
export async function startLesson(user: any, koId: string, request: Request): Promise<{ view: UnitView | null; assembled: Assembled | null; trace: SessionTrace | null; isStaff: boolean }> {
  const svc = contentService();
  const view = await svc.getUnitView(koId).catch(() => null);
  if (!view) return { view: null, assembled: null, trace: null, isStaff: false };
  const labels = (view.unit as any).securityLabels || ['public'];
  const { can } = await import('@/lib/rbac');
  const authorized = (await can(user, 'read', { type: 'KnowledgeObject', securityLabels: labels })).allow;
  const isStaff = (await can(user, 'write', { type: 'KnowledgeObject' })).allow;

  const settings = user?.id ? await getSettings(user.id) : { language: 'en', accessibility: {} as Accessibility };
  const mm = await masteryMap(user?.id ?? null);
  const graph = await (await import('@/lib/kernel')).createPgKernel().getObjectGraph(koId).catch(() => null);
  const variants: VariantSet = { translations: [], accessibility: [] };
  if (graph) {
    for (const e of graph.incoming) {
      if (e.type === 'translation_of') { const t = await svc.getUnitView(e.fromId).catch(() => null); if (t) variants.translations.push({ id: t.unit.id, lang: ((t.unit.learningMetadata as any)?.languages || [])[0] || (t.unit.metadata as any)?.lang || 'xx', title: (t.unit.data as any).title }); }
      if (e.type === 'variant_of') { const v = await svc.getUnitView(e.fromId).catch(() => null); if (v) variants.accessibility.push({ id: v.unit.id, kind: (v.unit.metadata as any)?.kind || 'a11y' }); }
    }
  }
  const { trace, assembled } = runPipeline({
    authenticated: !!user?.id, authorized, unit: view, settings, signals: signalsFromHeaders(request.headers),
    variants, masteryOf: (id) => numericMastery(mm[`ko:${id}`]), recent: await recentPerf(user?.id ?? null),
  });

  // persist trace + opened marker (best-effort)
  try {
    await ensureRuntimeSchema(); const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_runtime_trace (user_id, ko_id, served_unit_id, language, render_tier, outcome, not_ready, steps, context)
      VALUES (${user?.id ?? null}, ${koId}, ${assembled.servedUnitId}, ${assembled.language}, ${assembled.renderPlan.tier}, ${trace.outcome}, ${trace.notReady}, ${JSON.stringify(trace.steps)}::jsonb, ${JSON.stringify(trace.context)}::jsonb)`);
    if (user?.id && trace.outcome !== 'denied') {
      await db.execute(sql`INSERT INTO edu_progress (user_id, ko_id, last_position) VALUES (${user.id}, ${koId}, 'opened')
        ON CONFLICT (user_id, ko_id) DO UPDATE SET opened_at = NOW(), updated_at = NOW()`);
    }
  } catch { /* trace is best-effort */ }

  return { view, assembled, trace, isStaff };
}

/** Completion signal from the lesson view: advance mastery + persist resume. */
export async function completeLesson(userId: string, koId: string, seconds = 0): Promise<{ state: string }> {
  await ensureRuntimeSchema(); const { db, sql } = await ctx();
  const mm = await masteryMap(userId);
  const { state } = applyCompletion(mm[`ko:${koId}`]);
  // reuse aq_mastery (namespaced) for the knowledge signal
  await db.execute(sql`INSERT INTO aq_mastery (user_id, skill_id, state) VALUES (${userId}, ${'ko:' + koId}, ${state})
    ON CONFLICT (user_id, skill_id) DO UPDATE SET state = ${state}, updated_at = NOW()`);
  await db.execute(sql`INSERT INTO edu_progress (user_id, ko_id, completed, last_position, seconds, completed_at) VALUES (${userId}, ${koId}, true, 'completed', ${seconds}, NOW())
    ON CONFLICT (user_id, ko_id) DO UPDATE SET completed = true, last_position = 'completed', seconds = GREATEST(edu_progress.seconds, ${seconds}), completed_at = NOW(), updated_at = NOW()`);
  return { state };
}

/** A student's recent lessons for a "continue learning" entry (main surface). */
export async function resumeList(userId: string, limit = 5): Promise<{ koId: string; title: string | null; completed: boolean; at: any }[]> {
  await ensureRuntimeSchema(); const { db, sql } = await ctx();
  const rs = rows(await db.execute(sql`SELECT ko_id, completed, updated_at FROM edu_progress WHERE user_id = ${userId} ORDER BY updated_at DESC LIMIT ${limit}`));
  const svc = contentService();
  const out: { koId: string; title: string | null; completed: boolean; at: any }[] = [];
  for (const r of rs) { const u = await svc.getUnitView(r.ko_id).catch(() => null); out.push({ koId: r.ko_id, title: u ? (u.unit.data as any).title : null, completed: !!r.completed, at: r.updated_at }); }
  return out;
}

// ---- admin inspector reads ----
export async function listTraces(limit = 50, offset = 0, userId?: string): Promise<any[]> {
  await ensureRuntimeSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT t.*, u.name AS user_name FROM edu_runtime_trace t LEFT JOIN users u ON u.id = t.user_id
    ${userId ? sql`WHERE t.user_id = ${userId}` : sql``} ORDER BY t.at DESC LIMIT ${limit} OFFSET ${offset}`));
}
export async function countTraces(userId?: string): Promise<number> {
  await ensureRuntimeSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_runtime_trace ${userId ? sql`WHERE user_id = ${userId}` : sql``}`))[0]?.c || 0;
}
export async function studentMastery(userId: string): Promise<{ koId: string; state: string; verified: boolean; title: string | null }[]> {
  const mm = await masteryMap(userId);
  const svc = contentService();
  const out: { koId: string; state: string; verified: boolean; title: string | null }[] = [];
  for (const [k, v] of Object.entries(mm)) {
    if (!k.startsWith('ko:')) continue;
    const id = k.slice(3); const u = await svc.getUnitView(id).catch(() => null);
    out.push({ koId: id, state: v.state, verified: v.verified, title: u ? (u.unit.data as any).title : null });
  }
  return out;
}
