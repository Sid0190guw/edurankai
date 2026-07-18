// src/lib/hub.test.ts — run: npx tsx src/lib/hub.test.ts
// Campus hub (pure): role changes which dashboard sections show; no fabricated/immersive sections.
import { visibleSections, ALL_SECTIONS } from './hub';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const student = visibleSections(['student']);
ok('a student sees learning sections', student.includes('continue') && student.includes('progress') && student.includes('credentials'));
ok('a student does NOT see the admin section', !student.includes('admin'));
ok('a guardian sees the guardian section', visibleSections(['guardian']).includes('guardian'));
ok('a student does NOT get the guardian section', !student.includes('guardian'));
ok('staff (faculty) get the admin section', visibleSections(['faculty']).includes('admin'));
ok('registrar (admin role) gets the admin section', visibleSections(['registrar']).includes('admin'));
ok('every section is from the known set (no fabricated/immersive stubs)', visibleSections(['student', 'guardian', 'faculty']).every((s) => (ALL_SECTIONS as readonly string[]).includes(s)));
ok('no "xr"/"3d"/"immersive" section exists', !(ALL_SECTIONS as readonly string[]).some((s) => /xr|3d|immersive|holo/i.test(s)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
