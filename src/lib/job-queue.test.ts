// src/lib/job-queue.test.ts — run: npx tsx src/lib/job-queue.test.ts
// Background jobs (Prompt AP6), PURE: exponential backoff (capped), retry-until-max then fail, an
// idempotency key that prevents double sends, and the processed-job outcome. The DB queue is exercised
// at runtime; this guards the reliability logic.
import { backoffMs, shouldRetry, dedupKey, jobOutcome, rateLimited, digestSummary } from './job-queue';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== exponential backoff, capped ==');
ok('backoff grows: 1s, 2s, 4s, 8s', backoffMs(0) === 1000 && backoffMs(1) === 2000 && backoffMs(2) === 4000 && backoffMs(3) === 8000);
ok('backoff is capped at 5 minutes', backoffMs(20) === 300000);

console.log('\n== retry until max, then fail ==');
ok('retries while attempts < max', shouldRetry(1, 5) && shouldRetry(4, 5));
ok('stops retrying at max', shouldRetry(5, 5) === false);
ok('outcome: success -> done', jobOutcome(1, 5, true) === 'done');
ok('outcome: failure with budget -> retry', jobOutcome(2, 5, false) === 'retry');
ok('outcome: failure at max -> failed (no infinite retry)', jobOutcome(5, 5, false) === 'failed');

console.log('\n== idempotency key prevents double sends ==');
ok('dedup key is deterministic for the same event', dedupKey('notify', ['u1', 'result', 'a99']) === dedupKey('notify', ['u1', 'result', 'a99']));
ok('different events get different keys', dedupKey('notify', ['u1', 'result', 'a99']) !== dedupKey('notify', ['u1', 'result', 'b00']));

console.log('\n== AP6b: rate-limit + batch into a digest (no floods) ==');
ok('under the cap is allowed; at the cap is limited', rateLimited(3, 5) === false && rateLimited(5, 5) === true);
ok('a single item is passed through', digestSummary([{ title: 'One' }])!.title === 'One');
ok('many items collapse into one digest', digestSummary([{ title: 'a' }, { title: 'b' }, { title: 'c' }])!.title === '3 updates');
ok('an empty set produces nothing (no empty send)', digestSummary([]) === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
