// src/lib/runtime/lesson-engine.test.ts — run: npx tsx src/lib/runtime/lesson-engine.test.ts
// Self-contained (no DB). Exercises the pure pipeline core (runPipeline) + this block's
// mapping/offline helpers across denied / not-ready / served + render-tier + offline cases.
import { runPipeline, applyCompletion } from '@/lib/edu-runtime';
import { toLessonRunResult, offlineTraceStep, type OfflineSummary } from './lesson-engine';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const unitView = (over: any = {}): any => ({
  unit: { id: 'ko-1', securityLabels: ['public'], data: { title: 'Bernoulli' }, learningMetadata: {}, metadata: {} },
  prerequisites: [], courses: [], ...over,
});
const baseInput = (over: any = {}): any => ({
  authenticated: true, authorized: true, unit: unitView(),
  settings: { language: 'en', accessibility: {} }, signals: {},
  variants: { translations: [], accessibility: [] },
  masteryOf: () => 1, recent: { completions: 0, avgSeconds: 0 }, ...over,
});
const run = (over: any = {}) => {
  const { trace, assembled } = runPipeline(baseInput(over));
  return toLessonRunResult('ko-1', assembled, trace, null);
};

function main() {
  console.log('\n== outcomes ==');
  const denied = run({ authorized: false });
  ok('unauthorized -> denied, fail-closed', denied.outcome === 'denied' && denied.servedUnitId === null && denied.prerequisites.length === 0, denied.outcome);
  ok('denied trace skips downstream steps', run({ authorized: false }).trace.steps.slice(1).every((s) => s.detail.includes('skipped')));

  const notReady = run({ unit: unitView({ prerequisites: [{ id: 'p1', title: 'Algebra', state: 'published' }] }), masteryOf: () => 0 });
  ok('unmastered prerequisite -> not-ready (still served)', notReady.outcome === 'not-ready' && notReady.notReady === true, notReady.outcome);
  ok('not-ready reports the prerequisite gap', notReady.prerequisites[0].mastered === false && notReady.prerequisites[0].mastery === 0);

  const served = run({ unit: unitView({ prerequisites: [{ id: 'p1', title: 'Algebra', state: 'published' }] }), masteryOf: () => 1 });
  ok('mastered prerequisites -> served', served.outcome === 'served' && served.notReady === false);

  console.log('\n== render plan (weakest-link + a11y) ==');
  const weak = run({ signals: { deviceMemory: 8, saveData: true } });   // device rich, network lite
  ok('weakest link wins: rich device + Save-Data -> lite', weak.renderPlan.tier === 'lite', weak.renderPlan.tier);
  const rich = run({ signals: { deviceMemory: 8, effectiveType: '4g' } });
  ok('rich device + 4g -> rich, hydrate interactive', rich.renderPlan.tier === 'rich' && rich.renderPlan.hydrate.includes('interactive'));
  const reduced = run({ signals: { deviceMemory: 8, effectiveType: '4g' }, settings: { language: 'en', accessibility: { reduceMotion: true } } });
  ok('reduce-motion demotes rich -> standard', reduced.renderPlan.tier === 'standard' && reduced.renderPlan.reduceMotion === true, reduced.renderPlan.tier);

  console.log('\n== build_lesson variant selection ==');
  const translated = run({
    settings: { language: 'hi', accessibility: {} },
    variants: { translations: [{ lang: 'hi', id: 'ko-hi', title: 'बर्नौली' }], accessibility: [] },
  });
  ok('language variant is served when available', translated.servedUnitId === 'ko-hi' && translated.language === 'hi', translated.servedUnitId);

  console.log('\n== offline trace step ==');
  const summary: OfflineSummary = { unitCount: 3, totalBytes: 12345, droppedUnitIds: [] };
  ok('requested + compiled -> ok with summary', (() => { const s = offlineTraceStep(summary, true); return s.ok && /3 units, 12345B/.test(s.detail); })());
  ok('not requested -> on-demand skip', offlineTraceStep(null, false).detail === 'skipped (on-demand)');
  ok('requested but failed -> not ok', offlineTraceStep(null, true, true).ok === false);
  ok('toLessonRunResult carries the offline summary', (() => {
    const { trace, assembled } = runPipeline(baseInput());
    return toLessonRunResult('ko-1', assembled, trace, summary).offline === summary;
  })());

  console.log('\n== forward-only completion (state normalization) ==');
  const norm = (s: string) => (s === 'mastered' ? 'mastered' : 'growing');
  ok('first completion -> growing', norm(applyCompletion(undefined).state) === 'growing');
  ok('second completion -> mastered', norm(applyCompletion({ state: 'growing' }).state) === 'mastered');
  ok('already mastered stays mastered', norm(applyCompletion({ state: 'mastered' }).state) === 'mastered');
  ok('verified counts as mastered', norm(applyCompletion({ verified: true }).state) === 'mastered');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
