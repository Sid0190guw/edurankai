// src/lib/assessment.test.ts — run: npx tsx src/lib/assessment.test.ts
// Assessment engine: objective items auto-grade; short-answer routes to the manual queue; scoring
// + pass; only OFFICIAL passes affect eligibility (practice never does); an assessment attaches to
// a KnowledgeObject via the `assesses` edge (in-memory kernel).
import { gradeItem, gradeAttempt, scorePct, passed, affectsEligibility, type Item } from './assessment';
import { createKernel } from '@/lib/kernel';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const items: Item[] = [
  { id: 'q1', type: 'mcq', prompt: '2+2?', options: ['3', '4', '5'], answer: { correctIndex: 1 }, points: 2 },
  { id: 'q2', type: 'true_false', prompt: 'Sky is green', answer: { value: false }, points: 1 },
  { id: 'q3', type: 'numeric', prompt: 'pi to 2dp', answer: { value: 3.14, tolerance: 0.01 }, points: 2 },
  { id: 'q4', type: 'short_answer', prompt: 'Explain limits', answer: {}, points: 5 },
];

console.log('\n== objective items auto-grade ==');
ok('mcq correct choice scores full', gradeItem(items[0], { choice: 1 }).correct === true && gradeItem(items[0], { choice: 1 }).points === 2);
ok('mcq wrong choice scores 0', gradeItem(items[0], { choice: 0 }).points === 0);
ok('true_false graded', gradeItem(items[1], { value: false }).correct === true);
ok('numeric within tolerance correct', gradeItem(items[2], { value: 3.15 }).correct === true);
ok('numeric outside tolerance wrong', gradeItem(items[2], { value: 3.5 }).correct === false);

console.log('\n== short-answer routes to the manual queue (never auto-graded) ==');
ok('short_answer needs manual', gradeItem(items[3], { text: 'a limit is...' }).needsManual === true && gradeItem(items[3], {}).objective === false);

console.log('\n== whole-attempt grading ==');
const g = gradeAttempt(items, { q1: { choice: 1 }, q2: { value: false }, q3: { value: 3.14 }, q4: { text: 'words' } });
ok('auto score sums objective points (2+1+2=5)', g.autoScore === 5, g.autoScore);
ok('max score is total (10)', g.maxScore === 10, g.maxScore);
ok('manual item flagged', g.needsManual === true && g.manualItemIds.includes('q4'), g.manualItemIds);
ok('pct on auto only = 50%', scorePct(g.autoScore, 0, g.maxScore) === 50, scorePct(g.autoScore, 0, g.maxScore));
ok('with 5 manual points -> 100% pass', passed(scorePct(g.autoScore, 5, g.maxScore), 60) === true);

console.log('\n== practice never affects eligibility; official pass does ==');
ok('practice pass does NOT affect eligibility', affectsEligibility('practice', true) === false);
ok('official pass affects eligibility', affectsEligibility('official', true) === true);
ok('official fail does not', affectsEligibility('official', false) === false);

async function edgeTest() {
  console.log('\n== an assessment attaches to a KnowledgeObject via `assesses` ==');
  const repo = createKernel();
  const ko = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Limits' } });
  const a = await repo.createObject({ type: 'AssessmentObject', data: { title: 'Limits quiz', kind: 'quiz' } });
  await repo.addRelationship(a.id, 'assesses', ko.id);
  const g2 = await repo.getObjectGraph(a.id);
  const assessed = g2.outgoing.filter((e) => e.type === 'assesses').map((e) => e.toId);
  ok('assessment assesses the KO', assessed.length === 1 && assessed[0] === ko.id, assessed);
  const gk = await repo.getObjectGraph(ko.id);
  ok('KO reports the incoming assessment', gk.incoming.some((e) => e.type === 'assesses' && e.fromId === a.id));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
edgeTest().catch((e) => { console.error(e); process.exit(1); });
