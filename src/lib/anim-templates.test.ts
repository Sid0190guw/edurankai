// src/lib/anim-templates.test.ts — run: npx tsx src/lib/anim-templates.test.ts
// Parametric animation engine (Prompt A1a). Loads the browser engine via the repo's eval pattern and
// tests the PURE math: each template renders geometry from params; changing a param changes output;
// the broadcast spec carries template id + params (NOT pixels); tiers change sample density.
import { readFileSync } from 'node:fs';

const g: any = globalThis as any;
g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-anim-templates.js', 'utf8'));
const A = g.window.AquinAnim;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== registry + 3 real templates ==');
const ids = A.list().map((t: any) => t.id);
ok('registry has projectile, sine, sortbars', ids.includes('projectile') && ids.includes('sine') && ids.includes('sortbars'), ids);
ok('each template declares a parameter schema', A.list().every((t: any) => Array.isArray(t.schema) && t.schema.length > 0));

console.log('\n== projectile: renders from params + apex correct ==');
const proj = A.get('projectile');
const p45 = { angle: 45, v0: 30, gravity: 9.8 };
const path = proj.path(p45, 40);
ok('path is a series of {x,y} points', path.length === 41 && typeof path[0].x === 'number');
ok('trajectory starts and lands at y=0', Math.abs(path[0].y) < 1e-6 && Math.abs(path[path.length - 1].y) < 1e-6);
const apex = Math.max(...path.map((pt: any) => pt.y));
ok('changing the angle changes the trajectory (45 apex > 20 apex)', apex > Math.max(...proj.path({ angle: 20, v0: 30, gravity: 9.8 }, 40).map((pt: any) => pt.y)));

console.log('\n== sine: amplitude/frequency drive the curve ==');
const sine = A.get('sine');
const s = sine.sample({ amplitude: 3, frequency: 1, phase: 0 }, 60);
ok('peak magnitude respects amplitude', Math.max(...s.map((pt: any) => Math.abs(pt.y))) <= 3 + 1e-9 && Math.max(...s.map((pt: any) => pt.y)) > 2.9);
ok('changing amplitude changes output', sine.sample({ amplitude: 5, frequency: 1, phase: 0 }, 60)[15].y !== s[15].y);

console.log('\n== sortbars: steps end sorted ==');
const sb = A.get('sortbars');
const snaps = sb.steps([5, 2, 8, 1, 9, 3]);
const last = snaps[snaps.length - 1];
ok('final snapshot is fully sorted', JSON.stringify(last) === JSON.stringify([1, 2, 3, 5, 8, 9]), last);
ok('intermediate snapshots exist (a timeline to scrub)', snaps.length > 1);

console.log('\n== broadcast spec carries a SPEC, not pixels ==');
const spec = A.buildSpec('projectile', { angle: 45 }, 'playing', 0.5);
ok('spec has templateId + params + playState + timelinePos', spec.templateId === 'projectile' && spec.params.angle === 45 && spec.playState === 'playing');
ok('spec is small structured data — no frame/image/video field', !('frame' in spec) && !('image' in spec) && !('video' in spec) && JSON.stringify(spec).length < 300);
ok('clampParams clamps out-of-range (angle 999 -> 90)', A.clampParams('projectile', { angle: 999 }).angle === 90);

console.log('\n== adaptive tier (Prompt 5) ==');
ok('lite has fewer samples than rich', A.tierSamples('lite') < A.tierSamples('rich'));
ok('lite is not animated (static keyframe), rich is', A.tierAnimated('lite') === false && A.tierAnimated('rich') === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
