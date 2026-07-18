// src/lib/observability.test.ts — run: npx tsx src/lib/observability.test.ts
// Observability (pure): feature flags default ON until explicitly disabled; an explicit false
// disables the subsystem; a set flag overrides the default.
import { isEnabled, KNOWN_FEATURES } from './observability';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { console.log((c ? '  ok  ' : 'FAIL  ') + n); c ? pass++ : fail++; };

ok('unknown flag defaults ON', isEnabled([], 'community') === true);
ok('explicit false disables the subsystem', isEnabled([{ key: 'community', enabled: false }], 'community') === false);
ok('explicit true enables', isEnabled([{ key: 'community', enabled: true }], 'community') === true);
ok('one disabled flag does not affect another', isEnabled([{ key: 'community', enabled: false }], 'ai_tutor') === true);
ok('defaultOff respected when no flag', isEnabled([], 'beta', false) === false);
ok('known-feature list is non-empty + has community/ai_tutor', KNOWN_FEATURES.includes('community') && KNOWN_FEATURES.includes('ai_tutor'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
