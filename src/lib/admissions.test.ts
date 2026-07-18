// src/lib/admissions.test.ts — run: npx tsx src/lib/admissions.test.ts
// Admissions (pure): the interview scores to a rubric deterministically; a substantive answer scores
// higher than a blank one; only an ACCEPTED decision makes the applicant enrolment-eligible; a
// decision is only allowed from a pre-decision state.
import { scoreInterview, isEnrolmentEligible, canDecide, RUBRIC } from './admissions';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== interview scored to a rubric (deterministic) ==');
const full = scoreInterview([
  'I want to deepen my mathematics so I can build simulation software and eventually teach.',
  'I completed two online calculus courses and built a small physics engine in my spare time.',
  'I struggled with proofs at first; I formed a study group and practised daily until it clicked.',
  'I enjoy explaining ideas and would help peers in the discussion forum.',
]);
ok('a full interview scores across all rubric criteria', full.perCriterion.length === RUBRIC.length && full.score > 40, full);
ok('scoring is deterministic (same input -> same score)', scoreInterview(['abc def ghi jkl']).score === scoreInterview(['abc def ghi jkl']).score);
const blank = scoreInterview(['', '', '', '']);
ok('blank answers score 0 (no fabrication)', blank.score === 0 && blank.perCriterion.every((p) => p.score === 0));
ok('substantive answer outscores a one-word one', scoreInterview(['I have extensive relevant preparation across several projects.'])!.perCriterion[0].score > scoreInterview(['no'])!.perCriterion[0].score);

console.log('\n== decisions + enrolment eligibility ==');
ok('accepted -> enrolment eligible', isEnrolmentEligible('accepted') === true);
ok('waitlisted / rejected -> NOT eligible', !isEnrolmentEligible('waitlisted') && !isEnrolmentEligible('rejected'));
ok('can decide a submitted/interviewed application', canDecide('interviewed') === true && canDecide('submitted') === true);
ok('cannot re-decide an already-accepted application', canDecide('accepted') === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
