// src/lib/analytics.test.ts — run: npx tsx src/lib/analytics.test.ts
// Learning analytics (pure): aggregates reflect real inputs; empty input yields ZERO (never
// fabricated); role scoping — a student sees only their own; CSV escapes real values.
import { masterySummary, completionSummary, assessmentSummary, canViewAnalytics, toCsv } from './analytics';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== aggregates reflect real data ==');
ok('mastery counts mastered vs growing', JSON.stringify(masterySummary([{ state: 'mastered' }, { verified: true }, { state: 'growing' }])) === JSON.stringify({ mastered: 2, growing: 1, total: 3 }));
ok('completion rate is real', completionSummary([{ completed: true }, { completed: false }, { completed: true }, { completed: false }]).rate === 50);
const a = assessmentSummary([{ mode: 'official', pct: 80, passed: true }, { mode: 'official', pct: 40, passed: false }, { mode: 'practice', pct: 90 }]);
ok('official avg + pass rate computed from attempts', a.official.count === 2 && a.official.avgPct === 60 && a.official.passRate === 50, a.official);
ok('practice counted separately (not eligibility)', a.practice.count === 1);

console.log('\n== no fabricated numbers on empty input ==');
ok('empty mastery -> zeroes', JSON.stringify(masterySummary([])) === JSON.stringify({ mastered: 0, growing: 0, total: 0 }));
ok('empty completion -> 0% (not NaN/random)', completionSummary([]).rate === 0);
ok('empty assessments -> 0 avg/passRate', assessmentSummary([]).official.avgPct === 0 && assessmentSummary([]).official.passRate === 0);

console.log('\n== role scoping ==');
ok('a student can view their own analytics', canViewAnalytics({ id: 'u1', isStaff: false }, 'u1') === true);
ok('a student CANNOT view another student', canViewAnalytics({ id: 'u1', isStaff: false }, 'u2') === false);
ok('staff can view (aggregate)', canViewAnalytics({ id: 's1', isStaff: true }, 'u2') === true);

console.log('\n== CSV export escapes real values ==');
ok('csv quotes commas + escapes quotes', toCsv(['a', 'b'], [['x,y', 'he said "hi"']]) === 'a,b\n"x,y","he said ""hi"""');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
