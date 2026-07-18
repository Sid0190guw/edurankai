// src/lib/edu-runtime.test.ts — run: npx tsx src/lib/edu-runtime.test.ts
// Prompt 4 Educational Runtime, DB-free (in-memory kernel + pure pipeline). Plus a source-level
// check of Part A (the two admin sidebar links exist and are role-gated).
import { readFileSync } from 'node:fs';
import { runPipeline, estimateDevice, estimateNetwork, combinePlan, applyCompletion, STEP_ORDER, type PipelineInput, type VariantSet } from './edu-runtime';
import { ContentService } from './kernel-content';
import { createKernel } from '@/lib/kernel';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

async function main() {
  const svc = new ContentService(createKernel());
  const prereq = await svc.createUnit({ title: 'Limits' });
  const koHi = await svc.createUnit({ title: 'Derivatives (Hindi)' });
  const main = await svc.createUnit({ title: 'Derivatives' });
  await svc.addPrerequisite(main.id, prereq.id);
  const view = await svc.getUnitView(main.id);

  const base = (over: Partial<PipelineInput> = {}): PipelineInput => ({
    authenticated: true, authorized: true, unit: view!, settings: { language: 'en', accessibility: {} },
    signals: {}, variants: { translations: [], accessibility: [] } as VariantSet,
    masteryOf: () => 1, recent: { completions: 0, avgSeconds: 0 }, ...over,
  });

  console.log('\n== 1. starting a lesson runs the FULL ordered pipeline + a trace ==');
  const r1 = runPipeline(base());
  ok('trace has all 16 steps IN ORDER', JSON.stringify(r1.trace.steps.map((s) => s.step)) === JSON.stringify([...STEP_ORDER]), r1.trace.steps.map((s) => s.step));
  ok('last step is save_progress', r1.trace.steps[r1.trace.steps.length - 1].step === 'save_progress');
  ok('every step ok when served', r1.trace.steps.every((s) => s.ok) && r1.trace.outcome === 'served');
  ok('trace records served unit + tier', r1.trace.servedUnitId === main.id && !!r1.trace.tier);

  console.log('\n== 2. changing language changes the served variant ==');
  const variants: VariantSet = { translations: [{ lang: 'hi', id: koHi.id, title: 'Derivatives (Hindi)' }], accessibility: [] };
  ok('en serves the base unit', runPipeline(base({ variants })).assembled.servedUnitId === main.id);
  ok('hi serves the Hindi translation variant', runPipeline(base({ variants, settings: { language: 'hi', accessibility: {} } })).assembled.servedUnitId === koHi.id);

  console.log('\n== 3. a low-capability profile -> lite plan ==');
  ok('Save-Data -> lite', runPipeline(base({ signals: { saveData: true } })).assembled.renderPlan.tier === 'lite');
  ok('1GB device -> lite', runPipeline(base({ signals: { deviceMemory: 1 } })).assembled.renderPlan.tier === 'lite');
  ok('4g + 8GB -> rich', runPipeline(base({ signals: { deviceMemory: 8, effectiveType: '4g' } })).assembled.renderPlan.tier === 'rich');
  ok('reduceMotion caps rich to standard', runPipeline(base({ signals: { deviceMemory: 8, effectiveType: '4g' }, settings: { language: 'en', accessibility: { reduceMotion: true } } })).assembled.renderPlan.tier === 'standard');

  console.log('\n== 4. unmastered prerequisites are surfaced ==');
  const rNot = runPipeline(base({ masteryOf: () => 0 }));
  ok('notReady when the prerequisite is unmastered', rNot.assembled.notReady === true && rNot.trace.outcome === 'not-ready');
  ok('the unmet prerequisite is named', rNot.assembled.prerequisites.some((p) => p.title === 'Limits' && !p.mastered));
  ok('ready when the prerequisite is mastered', runPipeline(base({ masteryOf: () => 1 })).assembled.notReady === false);

  console.log('\n== 5. completing a lesson advances mastery ==');
  ok('first completion -> growing', applyCompletion(undefined).state === 'growing');
  ok('second completion -> mastered', applyCompletion({ state: 'growing' }).state === 'mastered');
  ok('completion records a resume marker', applyCompletion(undefined).resume === 'completed');

  console.log('\n== 6. runtime runs ONLY for KOs the student may see ==');
  const denied = runPipeline(base({ authorized: false }));
  ok('unauthorized -> denied, nothing served', denied.trace.outcome === 'denied' && denied.assembled.servedUnitId === null);
  ok('denied trace still records all 16 steps (rest skipped)', denied.trace.steps.length === STEP_ORDER.length && denied.trace.steps[0].ok === false);

  console.log('\n== estimators on real inputs ==');
  ok('old Android UA -> lite device', estimateDevice({ ua: 'Mozilla/5.0 (Linux; Android 4.4; ...)' }).tier === 'lite');
  ok('2g -> lite network', estimateNetwork({ effectiveType: '2g' }).tier === 'lite');
  ok('combinePlan takes the weaker of device/network', combinePlan('rich', 'lite', {}).tier === 'lite');

  console.log('\n== Part A: admin sidebar links exist + role-gated ==');
  const layout = readFileSync('src/layouts/AdminLayout.astro', 'utf8');
  ok('Knowledge link in navStructure', layout.includes("href: '/admin/knowledge'"));
  ok('Access / RBAC link in navStructure', layout.includes("href: '/admin/rbac'"));
  ok('both links are role-gated in NAV_SECTION', layout.includes("knowledge: 'lms'") && layout.includes("rbac: 'team_roles'"));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
