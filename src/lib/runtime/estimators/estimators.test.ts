// src/lib/runtime/estimators/estimators.test.ts
// run: npx tsx src/lib/runtime/estimators/estimators.test.ts
// Self-contained: pure estimators + the orchestrator over an in-memory kernel store.
import { createKernel } from '@/lib/kernel';
import {
  DEFAULT_BKT, initMastery, bktUpdate, bktPredictCorrect, isMastered,
  estimateDevice, estimateNetwork, estimateAccessibility, estimateLanguage, estimateLoad,
  applyObservation, selectNextConcepts, loadLearnerState,
} from './index';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };
const now = '2026-07-20T00:00:00.000Z';

async function main() {
  console.log('\n== BKT update ==');
  const m0 = initMastery(now);
  ok('init uses DEFAULT_BKT pL', m0.pL === DEFAULT_BKT.pL);
  const c1 = bktUpdate(m0, true, now);
  ok('a correct answer raises pL', c1.pL > m0.pL, [m0.pL, c1.pL]);
  const w1 = bktUpdate(m0, false, now);
  ok('an incorrect answer lowers pL', w1.pL < m0.pL, [m0.pL, w1.pL]);
  ok('attempts increments', c1.attempts === 1 && c1.lastCorrect === true);
  // monotonic climb under repeated correct
  let m = m0; const seq: number[] = [];
  for (let i = 0; i < 4; i++) { m = bktUpdate(m, true, now); seq.push(m.pL); }
  ok('pL strictly increases under repeated correct', seq[0] < seq[1] && seq[1] < seq[2], seq.map((x) => +x.toFixed(3)));
  ok('mastery reached after enough correct (>=0.95)', isMastered(m), +m.pL.toFixed(3));
  ok('predictCorrect in [0,1] and high when mastered', bktPredictCorrect(m) > 0.8 && bktPredictCorrect(m) <= 1);
  ok('guess/slip clamped < 0.5 for identifiability', initMastery(now, { pG: 0.9, pS: 0.9 }).pG < 0.5 && initMastery(now, { pS: 0.9 }).pS < 0.5);

  console.log('\n== device tiering ==');
  ok('no webgl -> low tier, text render', (() => { const d = estimateDevice({ webgl: false }); return d.tier === 'low' && d.maxRender === 'text'; })());
  ok('8c/8gb/webgl -> high tier, 3d', (() => { const d = estimateDevice({ cores: 8, deviceMemoryGb: 8, webgl: true }); return d.tier === 'high' && d.maxRender === '3d'; })());
  ok('1 core -> low tier, 2d', (() => { const d = estimateDevice({ cores: 1, deviceMemoryGb: 4, webgl: true }); return d.tier === 'low' && d.maxRender === '2d'; })());
  ok('mid device -> 3d', estimateDevice({ cores: 4, deviceMemoryGb: 4, webgl: true }).maxRender === '3d');

  console.log('\n== network tiering ==');
  ok('2g -> slow, small budget', (() => { const n = estimateNetwork({ effectiveType: '2g' }); return n.tier === 'slow' && n.assetBudgetKb === 500; })());
  ok('4g/20mbps -> fast, big budget', (() => { const n = estimateNetwork({ effectiveType: '4g', downlinkMbps: 20 }); return n.tier === 'fast' && n.assetBudgetKb === 8000; })());
  ok('saveData caps budget to 300', estimateNetwork({ effectiveType: '4g', downlinkMbps: 20, saveData: true }).assetBudgetKb === 300);
  ok('3mbps -> moderate', estimateNetwork({ downlinkMbps: 3 }).tier === 'moderate');

  console.log('\n== accessibility & language ==');
  ok('screenReader -> text-only variant', estimateAccessibility({ screenReader: true }).variants.includes('text-only'));
  ok('language: explicit pref wins, needs translation', (() => { const l = estimateLanguage('en-US,en;q=0.9', ['hi-IN']); return l.preferred === 'hi-IN' && l.needsTranslation; })());
  ok('language: english accept-language -> no translation', estimateLanguage('en-GB', []).needsTranslation === false);

  console.log('\n== cognitive load banding ==');
  ok('idle -> low band', estimateLoad(0, 1, 0).band === 'low');
  ok('max signals -> high band', estimateLoad(1, 3, 1).band === 'high');
  ok('half error, normal latency -> optimal', estimateLoad(1, 1, 0).band === 'optimal');

  console.log('\n== orchestrator over in-memory kernel ==');
  const repo = createKernel();
  const student = await repo.createObject({ type: 'StudentObject', data: { displayName: 'Asha' } });
  const c = await repo.createObject({ type: 'ConceptObject', data: { name: 'Kinematics' } });
  const d = await repo.createObject({ type: 'ConceptObject', data: { name: 'Dynamics' } });
  await repo.addRelationship(c.id, 'prerequisite_of', d.id);   // Kinematics is a prereq of Dynamics

  // initially only the prereq-free concept is selectable
  const first = await selectNextConcepts(repo, student.id, [c.id, d.id]);
  ok('only the prereq-free concept is offered first', first.length === 1 && first[0] === c.id, first);

  // master Kinematics via correct observations
  for (let i = 0; i < 4; i++) await applyObservation(repo, student.id, { conceptId: c.id, correct: true });
  const st = await loadLearnerState(repo, student.id);
  ok('mastery persisted on the StudentObject', !!st.mastery[c.id] && isMastered(st.mastery[c.id]), +st.mastery[c.id].pL.toFixed(3));

  const next = await selectNextConcepts(repo, student.id, [c.id, d.id]);
  ok('once prereq mastered, Dynamics becomes selectable', next.includes(d.id) && !next.includes(c.id), next);

  const obs = await applyObservation(repo, student.id, { conceptId: d.id, correct: false, responseMs: 40000, hintsUsed: 3 });
  ok('an incorrect+slow+hinted attempt raises cognitive load', obs.cognitiveLoad.load > 0, obs.cognitiveLoad);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
