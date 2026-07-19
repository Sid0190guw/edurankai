// src/lib/breakout.test.ts — run: npx tsx src/lib/breakout.test.ts
// Breakout assignment lookup (Prompt H2): a participant resolves to their assigned small room (or the
// main room, -1). Pure — the DB persistence is exercised at runtime; this guards the placement logic
// a re-joiner and the host inspector both rely on.
import { indexOfUser, type BreakoutState } from './breakout';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const state: BreakoutState = { open: true, rooms: [['a', 'b'], ['c'], ['d', 'e', 'f']], labels: [], endsAt: null, announcement: null, closed: false };
ok('a participant resolves to their assigned breakout', indexOfUser(state, 'c') === 1 && indexOfUser(state, 'f') === 2 && indexOfUser(state, 'a') === 0);
ok('an unassigned participant stays in the main room (-1)', indexOfUser(state, 'z') === -1);
ok('ids compare as strings (uuid-safe)', indexOfUser({ ...state, rooms: [['123'], ['456']] }, 123 as any) === 0);
ok('no breakouts -> everyone in main room', indexOfUser({ open: false, rooms: [], labels: [], endsAt: null, announcement: null, closed: false }, 'a') === -1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
