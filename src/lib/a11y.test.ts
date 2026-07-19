// src/lib/a11y.test.ts — run: npx tsx src/lib/a11y.test.ts
// Accessibility (Prompt AP4): WCAG AA contrast checks on core UI colors; reduced-motion forces the
// animation engine to a STATIC render; text-scale is clamped; body classes reflect prefs. The engine
// assertion loads the real engine and confirms reduced-motion downshifts any tier to lite.
import { contrastRatio, meetsAA, reduceMotion, effectiveTier, clampTextScale, bodyA11yClasses } from './a11y';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== WCAG contrast ==');
ok('black on white is 21:1', contrastRatio('#000000', '#ffffff') === 21);
ok('core ink on sand meets AA for normal text', meetsAA('#1a1712', '#fbfaf4'));
ok('a low-contrast pair FAILS AA (caught, not hidden)', meetsAA('#bbbbbb', '#ffffff') === false);
ok('large-text threshold is looser (3:1)', meetsAA('#949494', '#ffffff', { large: true }) === true && meetsAA('#949494', '#ffffff') === false, contrastRatio('#949494', '#ffffff'));

console.log('\n== reduced motion ==');
ok('explicit setting suppresses motion', reduceMotion({ reduceMotion: true }) === true);
ok('OS signal suppresses motion', reduceMotion({}, true) === true);
ok('no preference -> motion allowed', reduceMotion({}) === false);
ok('effectiveTier downshifts rich -> lite under reduced motion', effectiveTier('rich', { reduceMotion: true }) === 'lite' && effectiveTier('rich', {}) === 'rich');

console.log('\n== text scale + body classes ==');
ok('text scale clamps to a layout-safe range', clampTextScale(9) === 1.6 && clampTextScale(0.1) === 0.9 && clampTextScale('x') === 1);
ok('body classes reflect prefs', bodyA11yClasses({ highContrast: true, reduceMotion: true, textScale: 1.3 }).split(' ').sort().join(',') === 'a11y-contrast,a11y-no-motion,a11y-text-lg');

console.log('\n== the real engine honors reduced-motion ==');
const g: any = globalThis as any; g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-scene-engine.js', 'utf8'));
const S = g.window.AquinScene;
ok('AquinScene.effectiveTier(rich, reduceMotion) === lite', S.effectiveTier('rich', true) === 'lite');
ok('render() under reduced-motion falls back to the static 2D path (no WebGL)', S.render(null, { objects: [{ id: 'a', type: 'sphere' }] }, 'rich', { reduceMotion: true }).renderer === 'svg2d');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
