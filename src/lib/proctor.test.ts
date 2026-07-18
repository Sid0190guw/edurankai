// src/lib/proctor.test.ts — run: npx tsx src/lib/proctor.test.ts
// ATLAS proctoring (pure): the sanitizer guarantees NO media bytes are ever accepted (only
// {type, at} survive); focus-loss / multiple-faces raise the advisory risk; a disabled event type
// is ignored (policy toggle). Advisory only — nothing here penalizes; a human reviews.
import { sanitizeEvents, riskSummary, EVENT_TYPES } from './proctor';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== NO media bytes are ever accepted (privacy contract) ==');
const raw = [
  { type: 'focus_lost', at: 1000, frame: 'data:image/png;base64,AAAAA', video: 'blob:...' },   // media MUST be dropped
  { type: 'multiple_faces', at: 1001, snapshot: new Array(1000).fill(0) },
  { type: 'video_frame', at: 1002, data: 'xxxx' },   // unknown type -> dropped entirely
  { type: 'paste', at: 1003 },
];
const clean = sanitizeEvents(raw);
ok('unknown media-carrying event type is dropped', !clean.some((e) => (e.type as string) === 'video_frame'), clean.map((e) => e.type));
ok('only known event types remain', clean.every((e) => (EVENT_TYPES as readonly string[]).includes(e.type)));
ok('each sanitized event has ONLY type + at (no media keys)', clean.every((e) => Object.keys(e).sort().join(',') === 'at,type'), Object.keys(clean[0]));
ok('the image/video payloads are gone', JSON.stringify(clean).indexOf('data:image') === -1 && JSON.stringify(clean).indexOf('blob:') === -1);

console.log('\n== risk summary is advisory + weighted ==');
const events = sanitizeEvents([{ type: 'face_present', at: 1 }, { type: 'focus_lost', at: 2 }, { type: 'multiple_faces', at: 3 }, { type: 'copy', at: 4 }]);
const r = riskSummary(events);
ok('multiple_faces + focus-loss raise the score', r.score >= 5 && (r.level === 'elevated' || r.level === 'high'), r);
ok('counts are per-type', r.counts['multiple_faces'] === 1 && r.counts['focus_lost'] === 1);
ok('a clean session is low risk', riskSummary(sanitizeEvents([{ type: 'face_present', at: 1 }])).level === 'low');

console.log('\n== policy toggle disables an event type ==');
const withMulti = riskSummary(events);                                   // multiple_faces enabled
const withoutMulti = riskSummary(events, EVENT_TYPES.filter((t) => t !== 'multiple_faces'));
ok('disabling multiple_faces lowers the score', withoutMulti.score < withMulti.score, { on: withMulti.score, off: withoutMulti.score });
ok('the disabled type is not counted', !withoutMulti.counts['multiple_faces']);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
