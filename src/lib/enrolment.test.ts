// src/lib/enrolment.test.ts — run: npx tsx src/lib/enrolment.test.ts
// Enrolment (pure): course enrolment respects prerequisites (a prereq met by holding its credential)
// and capacity (uncapped when null/0).
import { meetsPrereqs, capacityOk } from './enrolment';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== prerequisites ==');
ok('all prereq courses credentialed -> allowed', meetsPrereqs(['c1', 'c2'], ['c1', 'c2', 'c3']) === true);
ok('a missing prereq -> blocked', meetsPrereqs(['c1', 'c2'], ['c1']) === false);
ok('no prereqs -> allowed', meetsPrereqs([], []) === true);

console.log('\n== capacity ==');
ok('under capacity -> allowed', capacityOk(9, 10) === true);
ok('at capacity -> blocked', capacityOk(10, 10) === false);
ok('null capacity -> uncapped', capacityOk(9999, null) === true);
ok('0 capacity -> uncapped', capacityOk(9999, 0) === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
