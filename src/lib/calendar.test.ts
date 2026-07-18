// src/lib/calendar.test.ts — run: npx tsx src/lib/calendar.test.ts
// Calendar (pure): the ICS document is valid iCalendar; the feed token verifies + rejects forgery;
// due-soon selection picks only upcoming deadlines in the window.
import { toICS, calToken, verifyCalToken, dueSoon } from './calendar';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== valid iCalendar ==');
const ics = toICS([{ uid: 'd1', title: 'Calculus quiz', start: '2026-07-25T09:00:00.000Z', kind: 'assessment' }]);
ok('has VCALENDAR + VERSION + VEVENT', ics.includes('BEGIN:VCALENDAR') && ics.includes('VERSION:2.0') && ics.includes('BEGIN:VEVENT') && ics.includes('END:VCALENDAR'));
ok('event has UID, DTSTART, SUMMARY', ics.includes('UID:d1@edurankai.in') && ics.includes('DTSTART:20260725T090000Z') && ics.includes('SUMMARY:[assessment] Calculus quiz'));
ok('uses CRLF line endings (iCal requirement)', ics.includes('\r\n'));
ok('escapes commas in summary', toICS([{ uid: 'x', title: 'A, B', start: '2026-07-25T09:00:00Z' }]).includes('SUMMARY:A\\, B'));

console.log('\n== feed token (subscribe without login) ==');
const t = calToken('user-1');
ok('token verifies for its user', verifyCalToken('user-1', t) === true);
ok('token does NOT verify for another user', verifyCalToken('user-2', t) === false);
ok('garbage token rejected, no throw', verifyCalToken('user-1', 'nope') === false);

console.log('\n== due-soon selection ==');
const now = new Date('2026-07-19T00:00:00Z');
const deadlines = [
  { due_at: '2026-07-19T12:00:00Z' },   // in 12h -> included
  { due_at: '2026-07-25T00:00:00Z' },   // in 6 days -> excluded (48h window)
  { due_at: '2026-07-18T00:00:00Z' },   // past -> excluded
];
const soon = dueSoon(deadlines, now, 48);
ok('picks only upcoming deadlines within the window', soon.length === 1 && soon[0].due_at === '2026-07-19T12:00:00Z', soon);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
