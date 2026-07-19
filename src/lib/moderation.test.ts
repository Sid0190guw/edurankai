// src/lib/moderation.test.ts — run: npx tsx src/lib/moderation.test.ts
// Real-time moderation (Prompt AP2), PURE screen: clean passes, coarse language is flagged, harassment
// is blocked; a MINOR room (strict) additionally blocks mild language + unmoderated contact attempts
// and a reframe can't lower that; safety events (severe / contact at a minor) are surfaced.
import { screenMessage, isSafetyEvent } from './moderation';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== clean message passes ==');
const clean = screenMessage('Great question, thanks!');
ok('clean -> allowed, not flagged', clean.allowed && !clean.flagged && clean.severity === 'clean');

console.log('\n== coarse language: flagged, allowed in adult rooms, BLOCKED for minors ==');
const mild = screenMessage('this is stupid and it sucks');
ok('adult room: flagged but allowed', mild.severity === 'mild' && mild.flagged && mild.allowed);
ok('categories name it profanity', mild.categories.includes('profanity'));
ok('minor room (strict): the SAME message is blocked', screenMessage('this is stupid and it sucks', { strict: true }).allowed === false);
ok('the redaction masks the words', /st\*+/.test(mild.redacted) || /s\*+/.test(mild.redacted), mild.redacted);

console.log('\n== harassment / self-harm is blocked everywhere ==');
const severe = screenMessage('you are worthless, kill yourself');
ok('severe -> blocked in an adult room too', severe.severity === 'severe' && severe.allowed === false && severe.categories.includes('harassment'));

console.log('\n== unmoderated contact attempt: blocked for minors ==');
const contact = screenMessage('add me on whatsapp 9876543210');
ok('contact detected', contact.categories.includes('contact'));
ok('adult room allows (flagged); minor room BLOCKS', contact.allowed === true && screenMessage('add me on whatsapp 9876543210', { strict: true }).allowed === false);
ok('an email/handle is also caught', screenMessage('dm me at kid@mail.com', { strict: true }).allowed === false);

console.log('\n== safety events surface for guardian alerts ==');
ok('severe at a minor is a safety event', isSafetyEvent(severe, true) === true);
ok('a contact attempt at a minor is a safety event', isSafetyEvent(contact, true) === true);
ok('the same for an adult is NOT auto-escalated to a guardian', isSafetyEvent(severe, false) === false);
ok('a clean minor message is not a safety event', isSafetyEvent(clean, true) === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
