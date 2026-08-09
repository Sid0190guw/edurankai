// src/lib/course-sessions.test.ts — run: npx tsx src/lib/course-sessions.test.ts
//
// The two things worth testing here without a database are the two that have already gone wrong in
// products like this one: TIME and STATE.
//
//   TIME — a session scheduled as "18:30 in Delhi" must be the same instant whichever server renders
//   it, and must survive a daylight-saving changeover in a zone that has one. The conversion is
//   hand-rolled (no date library in this project), so it is tested against zones on both sides of
//   UTC, with and without DST.
//
//   STATE — "not open yet / open now / happening now / finished" is drawn as a badge by the page AND
//   enforced by the endpoint that hands out the link. One function answers both; if it were two, the
//   badge and the door would disagree, which is the class of defect this repository keeps finding.
import {
  sessionState, joinableState, countdownLabel, stateLabel,
  zonedWallTimeToUtc, formatInZone, utcToZonedWallTime, isValidTimeZone,
  meetingUrlVerdict, JOIN_OPENS_MINUTES, JOIN_GRACE_MINUTES,
} from './course-sessions';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => {
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (!c && extra != null ? '  ' + JSON.stringify(extra) : ''));
  if (c) pass++; else fail++;
};

// -------------------------------------------------------------------------------------------
console.log('\n== a wall clock in a zone becomes one unambiguous instant ==');

const ist = zonedWallTimeToUtc('2026-08-14T18:30', 'Asia/Kolkata');
ok('IST 18:30 -> 13:00 UTC', ist.ok && ist.iso === '2026-08-14T13:00:00.000Z', ist);

const utc = zonedWallTimeToUtc('2026-08-14T18:30', 'UTC');
ok('UTC 18:30 -> 18:30 UTC', utc.ok && utc.iso === '2026-08-14T18:30:00.000Z', utc);

// New York in August is on daylight time (UTC-4); in January it is not (UTC-5). A single-pass
// conversion gets one of these two wrong, which is the whole reason the function makes two passes.
const nySummer = zonedWallTimeToUtc('2026-08-14T09:00', 'America/New_York');
ok('New York 09:00 in August -> 13:00 UTC (daylight time)', nySummer.ok && nySummer.iso === '2026-08-14T13:00:00.000Z', nySummer);
const nyWinter = zonedWallTimeToUtc('2026-01-14T09:00', 'America/New_York');
ok('New York 09:00 in January -> 14:00 UTC (standard time)', nyWinter.ok && nyWinter.iso === '2026-01-14T14:00:00.000Z', nyWinter);

// The hour immediately after a spring-forward transition: 03:00 on 8 March 2026 in New York. The
// clock has already jumped, so this is the -4 offset (07:00 UTC), not the -5 one the same wall clock
// carried an hour earlier. A single-pass conversion reads the offset at the naive instant and answers
// 08:00 here; the second pass is what corrects it.
const nyAfterJump = zonedWallTimeToUtc('2026-03-08T03:00', 'America/New_York');
ok('the hour after a spring-forward is on the new offset', nyAfterJump.ok && nyAfterJump.iso === '2026-03-08T07:00:00.000Z', nyAfterJump);

// Half-hour and three-quarter-hour offsets are where naive arithmetic quietly rounds.
const npt = zonedWallTimeToUtc('2026-08-14T18:45', 'Asia/Kathmandu');
ok('a 45-minute offset zone converts exactly', npt.ok && npt.iso === '2026-08-14T13:00:00.000Z', npt);

ok('an unknown zone is refused, not defaulted', zonedWallTimeToUtc('2026-08-14T18:30', 'Mars/Olympus').ok === false);
ok('an unreadable time is refused', zonedWallTimeToUtc('not a time', 'UTC').ok === false);
ok('a date with no time is refused', zonedWallTimeToUtc('2026-08-14', 'UTC').ok === false);
ok('isValidTimeZone accepts a real zone', isValidTimeZone('Europe/Zurich') === true);
ok('isValidTimeZone refuses an invented one', isValidTimeZone('Middle/Earth') === false);
ok('isValidTimeZone refuses an empty string', isValidTimeZone('') === false);

// -------------------------------------------------------------------------------------------
console.log('\n== the instant round-trips back to the organiser edit form ==');

for (const [wall, zone] of [
  ['2026-08-14T18:30', 'Asia/Kolkata'],
  ['2026-01-14T09:00', 'America/New_York'],
  ['2026-08-14T09:00', 'America/New_York'],
  ['2026-12-01T23:15', 'Pacific/Auckland'],
] as [string, string][]) {
  const there = zonedWallTimeToUtc(wall, zone);
  const back = there.ok ? utcToZonedWallTime(there.iso, zone) : '';
  ok('round trip ' + zone + ' ' + wall, back === wall, { there, back });
}

// -------------------------------------------------------------------------------------------
console.log('\n== the time a learner reads names its zone ==');

const shown = formatInZone('2026-08-14T13:00:00.000Z', 'Asia/Kolkata');
ok('renders the wall clock of the session zone', shown.indexOf('18:30') >= 0, shown);
ok('names the zone, so the number can be checked', /[A-Z]{2,5}|GMT|UTC/.test(shown), shown);
ok('an invalid stored zone still renders something honest', formatInZone('2026-08-14T13:00:00.000Z', 'Nowhere/Nothing').length > 0);
ok('an unreadable instant renders nothing rather than "Invalid Date"', formatInZone('rubbish', 'UTC') === '');

// -------------------------------------------------------------------------------------------
console.log('\n== state: not open yet / open now / happening now / finished ==');

const START = Date.parse('2026-08-14T13:00:00.000Z');
const s = (offsetMin: number, status?: string) =>
  sessionState({ startIso: '2026-08-14T13:00:00.000Z', durationMinutes: 60, status }, START + offsetMin * 60000);

ok('a day before -> scheduled', s(-1440) === 'scheduled');
ok('just outside the open window -> scheduled', s(-(JOIN_OPENS_MINUTES + 1)) === 'scheduled');
ok('exactly at the open window -> open', s(-JOIN_OPENS_MINUTES) === 'open');
ok('one minute before start -> open', s(-1) === 'open');
ok('at start -> live', s(0) === 'live');
ok('mid-session -> live', s(30) === 'live');
ok('at the scheduled end, inside the grace period -> live', s(60) === 'live');
ok('inside the over-run grace -> live', s(60 + JOIN_GRACE_MINUTES - 1) === 'live');
ok('past the grace -> ended', s(60 + JOIN_GRACE_MINUTES) === 'ended');
ok('a cancelled session is cancelled even mid-slot', s(30, 'cancelled') === 'cancelled');
ok('the American spelling of cancelled is honoured too', s(30, 'canceled') === 'cancelled');
ok('a host who ended it early -> ended', s(5, 'ended') === 'ended');
ok('an unreadable start does not become live', sessionState({ startIso: '', durationMinutes: 60 }) === 'scheduled');

ok('only open and live may hand out a link', joinableState('open') && joinableState('live'));
ok('scheduled may not', joinableState('scheduled') === false);
ok('ended may not', joinableState('ended') === false);
ok('cancelled may not', joinableState('cancelled') === false);

ok('every state has words for a person', ['scheduled', 'open', 'live', 'ended', 'cancelled']
  .every((x) => stateLabel(x as any).length > 0));

// -------------------------------------------------------------------------------------------
console.log('\n== the countdown ==');

ok('minutes away', countdownLabel('2026-08-14T13:00:00.000Z', START - 20 * 60000) === 'in 20 min');
ok('hours away', countdownLabel('2026-08-14T13:00:00.000Z', START - 190 * 60000) === 'in 3h 10m');
ok('days away, and one day is singular', countdownLabel('2026-08-14T13:00:00.000Z', START - 25 * 60 * 60000) === 'in 1 day');
ok('several days', countdownLabel('2026-08-14T13:00:00.000Z', START - 72 * 60 * 60000) === 'in 3 days');
ok('past the start it says so rather than counting negatively', countdownLabel('2026-08-14T13:00:00.000Z', START + 60000) === 'starting now');

// -------------------------------------------------------------------------------------------
console.log('\n== a meeting link is a link, and every product is welcome ==');

for (const good of [
  'https://meet.example.com/abc-defg-hij',
  'https://example-conferencing.com/j/1234567890?pwd=abc',
  'https://teams.example.com/l/meetup-join/19%3ameeting_abc',
  'https://rooms.example.org/room/physics-101',
]) {
  ok('accepted: ' + good.slice(0, 40), meetingUrlVerdict(good).ok === true, meetingUrlVerdict(good));
}

for (const bad of [
  'javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'http://meet.example.com/abc',
  'https://user:pass@meet.example.com/abc',
  'https://localhost/abc',
  'https://192.168.0.4/abc',
  '',
  'not a url at all',
]) {
  const v = meetingUrlVerdict(bad);
  ok('refused: ' + (bad || '(empty)').slice(0, 40), v.ok === false && v.reason.length > 0, v);
}

// A same-origin path is a real address but the wrong answer in this field: an external session is
// external by definition, and the organiser is told to pick the in-house mode instead.
const internalPath = meetingUrlVerdict('/portal/meet/123');
ok('a path on this platform is refused with the right advice', internalPath.ok === false && /in-house/.test(internalPath.reason), internalPath);

// The refusal a learner or an organiser reads must never name a company.
const BRANDS = /(zoom|teams|webex|meet\.google|jitsi|whereby|youtube|vimeo|skype)/i;
ok('refusal sentences are brand-free', [
  meetingUrlVerdict('javascript:alert(1)').reason,
  meetingUrlVerdict('http://meet.example.com/x').reason,
  internalPath.reason,
].every((r) => !BRANDS.test(r)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
