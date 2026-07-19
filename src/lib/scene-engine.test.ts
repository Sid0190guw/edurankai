// src/lib/scene-engine.test.ts — run: npx tsx src/lib/scene-engine.test.ts
// The scene engine's PURE core (Prompt A3a): the primitive/motion/physics registries, the resolved
// scene model both renderers consume, the projectile parabola, and tier->renderer selection. The
// key A3a guarantee is asserted here: WebGL is used ONLY on rich/standard; lite renders the SAME
// spec via the 2D fallback and NEVER touches Three.js.
import { readFileSync } from 'node:fs';

const g: any = globalThis as any;
g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-scene-engine.js', 'utf8'));
const S = g.window.AquinScene;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== registries: base primitives + physics pack + motions ==');
const types = S.primitives().map((p: any) => p.type);
ok('base primitives present', ['sphere', 'box', 'cylinder', 'cone', 'torus', 'ring', 'plane', 'line', 'arrow', 'particles', 'label'].every((t) => types.includes(t)));
ok('physics pack registered as its own kind', S.primitives().filter((p: any) => p.kind === 'physics').map((p: any) => p.type).sort().join(',') === 'pendulum,projectile,spring');
ok('motion library has the parametric set', ['none', 'spin', 'orbit', 'oscillate', 'float', 'pulse', 'grow', 'flow', 'fall'].every((m) => S.motions().includes(m)));

console.log('\n== physics: projectile follows a correct parabola ==');
const pj = S.PHYSICS.projectile({ angle: 45, v0: 30, gravity: 9.8 });
ok('starts at origin, lands back at y=0', pj.point(0)[1] === 0 && Math.abs(pj.point(pj.duration)[1]) < 1e-6);
ok('apex height matches v^2 sin^2 / 2g', Math.abs(pj.apex - (30 * 30 * 0.5) / (2 * 9.8)) < 1e-6, pj.apex);
ok('45deg out-ranges 20deg (same speed)', pj.range > S.PHYSICS.projectile({ angle: 20, v0: 30, gravity: 9.8 }).range);
ok('trajectory() samples the path', S.trajectory('projectile', { angle: 45, v0: 30, gravity: 9.8 }, 40).length === 41);

console.log('\n== scene model: resolves defaults, parents, and physics paths ==');
const model = S.buildModel({ title: 'Solar', objects: [
  { id: 'sun', type: 'sphere', position: [0, 0, 0], size: 2, color: '#ffcc55' },
  { id: 'earth', type: 'sphere', position: [5, 0, 0], parent: 'sun', motion: { type: 'orbit', speed: 1 }, orbitCenter: [0, 0, 0] },
  { id: 'shot', type: 'projectile', motion: { type: 'flow', speed: 1, params: { angle: 45, v0: 20, gravity: 9.8 } } },
] });
ok('one node per object', model.nodes.length === 3);
ok('child inherits parent offset in world position', model.nodes[1].position[0] === 5);
ok('a physics node carries a computed path', Array.isArray(model.nodes[2].path) && model.nodes[2].path.length > 2);
const orbited = S.motionAt(model.nodes[1], Math.PI / 2);
ok('orbit motion moves the body off its start', Math.abs(orbited.position[2]) > 0.1);

console.log('\n== tier -> renderer: WebGL ONLY on rich/standard; lite = 2D ==');
ok('rich -> webgl', S.rendererFor('rich') === 'webgl' && S.usesWebGL('rich') === true);
ok('standard -> webgl', S.rendererFor('standard') === 'webgl');
ok('lite -> svg2d, never WebGL', S.rendererFor('lite') === 'svg2d' && S.usesWebGL('lite') === false);
ok('rich quality enables bloom + env + shadows; lite disables all', S.tierQuality('rich').bloom && S.tierQuality('rich').envMap && !S.tierQuality('lite').shadows && !S.tierQuality('lite').bloom);

console.log('\n== dispatch is safe headless (no DOM) and never calls WebGL on lite ==');
let glCalled = false; g.window.AquinSceneGL = { render() { glCalled = true; } };
const litOut = S.render(null, { objects: [{ id: 'a', type: 'sphere' }] }, 'lite');
ok('lite dispatch returns svg2d and did NOT call the WebGL adapter', litOut.renderer === 'svg2d' && glCalled === false, litOut);
const richOut = S.render(null, { objects: [{ id: 'a', type: 'sphere' }] }, 'rich');
ok('rich dispatch without DOM still falls back safely (no crash)', richOut.renderer === 'svg2d' && glCalled === false);   // container null -> safe 2D, no GL

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
