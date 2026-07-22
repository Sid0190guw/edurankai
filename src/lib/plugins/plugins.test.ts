// src/lib/plugins/plugins.test.ts — run: npx tsx src/lib/plugins/plugins.test.ts
// Self-contained (no DB): registry bootstrap, dependency DAG, concept resolution, hydrate
// layering, scene-pack union, deterministic generators, and subtype payload validation.
import {
  bootstrapPlugins, topoSortPlugins, pluginForConcept, resolveAssessmentGenerator,
  resolveHydrate, scenePrimitiveTypes, getPlugin, allPlugins, type SubjectPlugin,
} from './index';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const mk = (id: string, dependsOn: string[] = []): SubjectPlugin => ({
  id, subject: id, version: '1.0.0', namespace: id, dependsOn,
  conceptDomains: [id], objectSubtypes: [], renderers: [], assessmentGenerators: [], requiredCapabilities: [],
});

function main() {
  console.log('\n== bootstrap ==');
  const boot = bootstrapPlugins();
  ok('catalog bootstraps without issues', boot.issues.length === 0, boot.issues);
  ok('all three plugins registered', allPlugins().map((p) => p.id).sort().join(',') === 'chemistry,physics,programming');

  console.log('\n== dependency DAG (topoSortPlugins) ==');
  ok('valid deps topo-order dep-first', topoSortPlugins([mk('a', ['b']), mk('b')]).order.join(',') === 'b,a');
  const cyc = topoSortPlugins([mk('a', ['b']), mk('b', ['a'])]);
  ok('a cycle aborts (order=[]) + reports issue', cyc.order.length === 0 && cyc.issues.some((i) => /cycle/.test(i)), cyc.issues);
  ok('missing dependency is reported', topoSortPlugins([mk('a', ['ghost'])]).issues.some((i) => /missing ghost/.test(i)));

  console.log('\n== pluginForConcept (longest-prefix) ==');
  ok('physics.fluids.bernoulli -> physics', pluginForConcept('physics.fluids.bernoulli')?.id === 'physics');
  ok('computer-science.algorithms -> programming', pluginForConcept('computer-science.algorithms')?.id === 'programming');
  ok('exact domain match', pluginForConcept('chemistry')?.id === 'chemistry');
  ok('unknown domain -> undefined', pluginForConcept('astrology.mars') === undefined);

  console.log('\n== resolveHydrate (base ∪ plugin) ==');
  ok('SimulationObject rich + physics adds phys-fluid-sim', resolveHydrate('SimulationObject', 'rich', 'physics').includes('phys-fluid-sim'));
  ok('lite tier gets no plugin hydrate', !resolveHydrate('SimulationObject', 'lite', 'physics').includes('phys-fluid-sim'));
  ok('no plugin id -> just the base directive', JSON.stringify(resolveHydrate('SimulationObject', 'rich')) === JSON.stringify(resolveHydrate('SimulationObject', 'rich', undefined)));

  console.log('\n== scenePrimitiveTypes union ==');
  const prims = scenePrimitiveTypes();
  ok('union covers physics + chemistry packs', ['projectile', 'pendulum', 'spring', 'atom', 'bond', 'beaker'].every((t) => prims.includes(t)), prims);

  console.log('\n== deterministic assessment generators ==');
  const gen = resolveAssessmentGenerator('physics')!;
  const runA = gen({ domain: 'physics', name: 'ko' }, { count: 3, seed: 42 });
  const runB = gen({ domain: 'physics', name: 'ko' }, { count: 3, seed: 42 });
  ok('same seed -> identical items', JSON.stringify(runA) === JSON.stringify(runB) && runA.length === 3);
  ok('different seed -> different items', JSON.stringify(gen({ domain: 'physics', name: 'ko' }, { count: 3, seed: 7 })) !== JSON.stringify(runA));
  ok('physics items are numeric with a value+tolerance answer', runA[0].type === 'numeric' && typeof (runA[0].answer as any).value === 'number');
  const chem = resolveAssessmentGenerator('chemistry')!({ domain: 'chemistry', name: 'ko' }, { count: 2, seed: 3 });
  ok('chemistry items are mcq with a correctIndex', chem[0].type === 'mcq' && typeof (chem[0].answer as any).correctIndex === 'number');

  console.log('\n== subtype payload validation ==');
  const physics = getPlugin('physics')!;
  const fluidSub = physics.objectSubtypes.find((s) => s.subtype === 'fluid-flow')!;
  ok('valid fluid-flow data passes schema', fluidSub.schema.safeParse({ title: 'Venturi', viscosity: 0.9 }).success);
  ok('missing required title rejected', !fluidSub.schema.safeParse({ viscosity: 0.9 }).success);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
