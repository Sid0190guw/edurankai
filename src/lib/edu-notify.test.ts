// src/lib/edu-notify.test.ts — run: npx tsx src/lib/edu-notify.test.ts
// Notifications (pure): preferences suppress a channel/type; email only when opted in.
import { shouldNotifyInApp, shouldEmail } from './edu-notify';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { console.log((c ? '  ok  ' : 'FAIL  ') + n); c ? pass++ : fail++; };

console.log('\n== preference suppression ==');
ok('results suppressed when results pref off', shouldNotifyInApp({ notifications: { results: false } }, 'result') === false);
ok('results shown by default', shouldNotifyInApp({}, 'result') === true);
ok('deadlines suppressed when off', shouldNotifyInApp({ notifications: { deadlines: false } }, 'deadline') === false);
ok('credential alerts always in-app (not suppressible)', shouldNotifyInApp({ notifications: { results: false, deadlines: false } }, 'credential') === true);
ok('admission alerts always in-app', shouldNotifyInApp({}, 'admission') === true);

console.log('\n== email channel opt-in ==');
ok('no email by default', shouldEmail({}) === false);
ok('email only when opted in', shouldEmail({ notifications: { email: true } }) === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
