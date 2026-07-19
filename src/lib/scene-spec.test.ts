// src/lib/scene-spec.test.ts — run: npx tsx src/lib/scene-spec.test.ts
// The canonical scene spec (Prompt A3a): every input is validated + REPAIRED (never throws), so a
// bad/hallucinated spec can't crash a render; object count is capped; a spec persists as a kernel
// AnimationObject linked to a KnowledgeObject.
import { normalizeScene, SceneService, MAX_OBJECTS, SCENE_VERSION, OBJECT_TYPES } from './scene-spec';
import { createKernel } from '@/lib/kernel';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== repair: out-of-range + unknown values are fixed, not thrown ==');
const r = normalizeScene({ title: 'Atom', objects: [
  { id: 'nucleus', type: 'blackhole', position: [0, 0, 0], material: { metalness: 5, roughness: -2, opacity: 9 }, motion: { type: 'warp', speed: 999 } },
  { type: 'sphere', size: -3, color: '00ffcc' },
] });
ok('unknown object type -> box (+issue)', r.spec.objects[0].type === 'box' && r.issues.some((i) => /unknown type/.test(i)));
ok('material clamped to [0,1] / emissive range', r.spec.objects[0].material.metalness === 1 && r.spec.objects[0].material.roughness === 0 && r.spec.objects[0].material.opacity === 1);
ok('unknown motion -> none, speed clamped', r.spec.objects[0].motion.type === 'none' && r.spec.objects[0].motion.speed === 20);
ok('size < min repaired to a positive number', typeof r.spec.objects[1].size === 'number' && (r.spec.objects[1].size as number) > 0);
ok('bare hex color gets a # prefix', r.spec.objects[1].color === '#00ffcc');
ok('every object type is in the registry', r.spec.objects.every((o) => (OBJECT_TYPES as readonly string[]).includes(o.type)));

console.log('\n== reject: non-object input becomes a blank valid scene ==');
const bad = normalizeScene('not a scene');
ok('string input -> blank scene + issue', bad.spec.version === SCENE_VERSION && bad.spec.objects.length === 0 && bad.issues.length > 0);
ok('objects-not-array is dropped with an issue', normalizeScene({ objects: 'nope' }).issues.some((i) => /not an array/.test(i)));

console.log('\n== cap: object count is bounded ==');
const many = normalizeScene({ objects: Array.from({ length: MAX_OBJECTS + 50 }, () => ({ type: 'sphere' })) });
ok('objects capped at MAX_OBJECTS', many.spec.objects.length === MAX_OBJECTS && many.issues.some((i) => /exceeded cap/.test(i)));

console.log('\n== a valid spec passes through intact ==');
const good = normalizeScene({ title: 'Solar', objects: [{ id: 'sun', type: 'sphere', position: [0, 0, 0], size: 2, color: '#ffcc55', motion: { type: 'spin', speed: 0.5 } }], camera: { autoRotate: true, distance: 20, target: [0, 0, 0] } });
ok('title + object preserved, camera distance kept', good.spec.title === 'Solar' && good.spec.objects[0].id === 'sun' && good.spec.camera.distance === 20 && good.issues.length === 0);

console.log('\n== persistence: a spec is an AnimationObject linked to a KnowledgeObject ==');
(async () => {
  const repo = createKernel();
  const svc = new SceneService(repo);
  const ko = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Atomic structure' } });
  const id = await svc.saveScene(good.spec, ko.id, null);
  const graph = await repo.getObjectGraph(ko.id);
  ok('KO -references-> the saved scene', graph.outgoing.filter((e) => e.type === 'references').map((e) => e.toId).includes(id));
  const obj = await repo.getObject(id);
  ok('saved as an AnimationObject flagged sceneSpec', obj!.type === 'AnimationObject' && (obj!.metadata as any).sceneSpec === true);
  const round = await svc.getScene(id);
  ok('getScene round-trips the spec', round!.title === 'Solar' && round!.objects[0].id === 'sun');
  ok('listScenes returns only scene specs', (await svc.listScenes()).length === 1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
