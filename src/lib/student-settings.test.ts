// src/lib/student-settings.test.ts — run: npx tsx src/lib/student-settings.test.ts
// Settings (pure): changing language takes effect via merge; accessibility flows through; a minor
// CANNOT change consent-gated settings but a guardian can; an adult edits freely.
import { canEditSetting, mergeProfile, DEFAULT_PROFILE } from './student-settings';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const adult = { isSelf: true, isMinor: false, isGuardianOfTarget: false };
const minor = { isSelf: true, isMinor: true, isGuardianOfTarget: false };
const guardian = { isSelf: false, isMinor: true, isGuardianOfTarget: true };

console.log('\n== edit authorization ==');
ok('adult edits their own language', canEditSetting('language', adult) === true);
ok('minor may edit language (not consent-gated)', canEditSetting('language', minor) === true);
ok('minor may NOT edit a consent-gated setting (aiTutor)', canEditSetting('aiTutor', minor) === false);
ok('guardian may edit a consent-gated setting for the minor', canEditSetting('aiTutor', guardian) === true);
ok('a stranger (not self, not guardian) may not edit', canEditSetting('language', { isSelf: false, isMinor: false, isGuardianOfTarget: false }) === false);

console.log('\n== changing language / accessibility takes effect (feeds the runtime) ==');
const m1 = mergeProfile(DEFAULT_PROFILE, { language: 'hi', accessibility: { reduceMotion: true } }, adult);
ok('language changed to hi', m1.language === 'hi');
ok('accessibility reduceMotion set', m1.accessibility.reduceMotion === true);
ok('invalid language ignored (no fabrication)', mergeProfile(DEFAULT_PROFILE, { language: 'zz' as any }, adult).language === 'en');

console.log('\n== consent gating enforced through merge ==');
const minorTry = mergeProfile({ ...DEFAULT_PROFILE, consent: { aiTutor: true } }, { consent: { aiTutor: false } }, minor);
ok('minor cannot flip a consent-gated setting via merge', minorTry.consent.aiTutor === true, minorTry.consent);
const guardianSet = mergeProfile({ ...DEFAULT_PROFILE, consent: { aiTutor: true } }, { consent: { aiTutor: false } }, guardian);
ok('guardian CAN flip it for the minor', guardianSet.consent.aiTutor === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
