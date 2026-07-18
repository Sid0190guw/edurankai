// src/lib/kernel/kernel.test.ts — run: npx tsx src/lib/kernel/kernel.test.ts
// Self-contained (in-memory store, no DB). Proves creation of every type, every valid
// lifecycle transition, invalid transitions throwing, version bump, validation gating, and
// a KnowledgeObject composition round-trip with relationships intact.
import { KernelRepository } from './repository';
import { InMemoryKernelStore } from './store';
import { OBJECT_TYPES, type ObjectType, type ObjectDataMap } from './types';
import { LifecycleError } from './lifecycle';
import { ValidationError } from './validation';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  console.log((cond ? '  ok  ' : 'FAIL  ') + name + (extra != null ? '  ' + JSON.stringify(extra) : ''));
  cond ? pass++ : fail++;
}
async function throws(name: string, fn: () => Promise<unknown>, Type?: any) {
  try { await fn(); ok(name + ' (should throw)', false); }
  catch (e) { ok(name, !Type || e instanceof Type, (e as Error).constructor.name); }
}

// sample payloads for each type
const SAMPLE: { [K in ObjectType]: ObjectDataMap[K] } = {
  KnowledgeObject: { title: 'Bernoulli', equations: [{ latex: 'P + \\tfrac12\\rho v^2 = C' }] },
  StudentObject: { displayName: 'A. Learner' },
  FacultyObject: { displayName: 'Dr. Iyer' },
  CourseObject: { title: 'Fluid Mechanics' },
  ConceptObject: { name: 'Continuity' },
  LaboratoryObject: { title: 'Venturi lab' },
  SimulationObject: { title: 'CFD' },
  AnimationObject: { title: 'Streamlines' },
  AssessmentObject: { title: 'Quiz 6.2', kind: 'quiz', questionCount: 10 },
  UniversityObject: { name: 'Partner University', partner: true },
  PlacementObject: { role: 'Intern' },
  ResearchObject: { title: 'On lift' },
};

async function main() {
  const repo = new KernelRepository(new InMemoryKernelStore());

  console.log('\n== create every object type ==');
  for (const t of OBJECT_TYPES) {
    const o = await repo.createObject({ type: t, data: SAMPLE[t] as any });
    ok(`create ${t}`, o.type === t && o.lifecycleState === 'created' && o.version === 1 && !!o.id);
  }

  console.log('\n== full valid lifecycle chain ==');
  const c = await repo.createObject({ type: 'ConceptObject', data: { name: 'Wave' } });
  const s1 = await repo.validateObject(c.id); ok('created -> validated', s1.lifecycleState === 'validated');
  const s2 = await repo.indexObject(c.id);    ok('validated -> indexed', s2.lifecycleState === 'indexed');
  const s3 = await repo.publishObject(c.id);  ok('indexed -> published', s3.lifecycleState === 'published');
  const s4 = await repo.markReferenced(c.id); ok('published -> referenced', s4.lifecycleState === 'referenced');
  const s5 = await repo.updateObject(c.id, { data: { description: 'x' } }); ok('referenced -> updated', s5.lifecycleState === 'updated');
  const s6 = await repo.publishObject(c.id);  ok('updated -> published', s6.lifecycleState === 'published');
  const s7 = await repo.archiveObject(c.id);  ok('published -> archived', s7.lifecycleState === 'archived' && !!s7.archivedAt);
  const s8 = await repo.deleteObject(c.id);   ok('archived -> deleted (soft)', s8.lifecycleState === 'deleted');
  ok('soft delete keeps the row', (await repo.getObject(c.id))?.lifecycleState === 'deleted');

  console.log('\n== invalid transitions must throw ==');
  const inv1 = await repo.createObject({ type: 'ConceptObject', data: { name: 'A' } });
  await throws('created -> published (skips validated/indexed) rejected', () => repo.publishObject(inv1.id), LifecycleError);
  const inv2 = await repo.createObject({ type: 'ConceptObject', data: { name: 'B' } });
  await repo.validateObject(inv2.id);
  await throws('validated -> published (skips indexed) rejected', () => repo.publishObject(inv2.id), LifecycleError);
  const inv3 = await repo.createObject({ type: 'ConceptObject', data: { name: 'C' } });
  await throws('created -> deleted rejected', () => repo.deleteObject(inv3.id), LifecycleError);

  console.log('\n== version bump on update ==');
  const v = await repo.createObject({ type: 'CourseObject', data: { title: 'C' } });
  await repo.validateObject(v.id); await repo.indexObject(v.id); await repo.publishObject(v.id);
  const vu = await repo.updateObject(v.id, { data: { summary: 'now with summary' } });
  ok('version 1 -> 2 on update', vu.version === 2, vu.version);
  ok('synchronizationState becomes dirty', vu.synchronizationState === 'dirty');
  ok('patch merged into data', (vu.data as any).title === 'C' && (vu.data as any).summary === 'now with summary');

  console.log('\n== validation gate (Created -> Validated) ==');
  const bad = await repo.createObject({ type: 'AssessmentObject', data: { title: '' } as any });   // title min(1) fails
  await throws('empty required field rejected at validate', () => repo.validateObject(bad.id), ValidationError);

  console.log('\n== KnowledgeObject composition round-trip ==');
  const pre1 = await repo.createObject({ type: 'ConceptObject', data: { name: 'Algebra' } });
  const pre2 = await repo.createObject({ type: 'ConceptObject', data: { name: 'Calculus' } });
  const asm  = await repo.createObject({ type: 'AssessmentObject', data: { title: 'Check', kind: 'quiz' } });
  const anim = await repo.createObject({ type: 'AnimationObject', data: { title: 'Flow' } });
  const concept = await repo.createObject({ type: 'ConceptObject', data: { name: 'Bernoulli' } });
  const ko = await repo.buildKnowledgeObject({
    data: { title: 'Bernoulli in practice', body: '...', equations: [{ latex: 'P+\\tfrac12\\rho v^2=C' }], examples: [{ prompt: 'venturi', solution: 'v up, P down' }] },
    prerequisites: [pre1.id, pre2.id],
    assessments: [asm.id],
    references: [anim.id],
    conceptId: concept.id,
  });
  // advance it through the pipeline
  await repo.validateObject(ko.id); await repo.indexObject(ko.id); await repo.publishObject(ko.id);

  const g = await repo.getObjectGraph(ko.id);
  ok('KO published', g.object.lifecycleState === 'published');
  ok('inline equations survive round-trip', (g.object.data as any).equations?.[0]?.latex.includes('rho'));
  ok('inline examples survive round-trip', (g.object.data as any).examples?.length === 1);
  const inPre = g.incoming.filter((e) => e.type === 'prerequisite_of');
  ok('2 prerequisite edges intact (incoming)', inPre.length === 2, inPre.map((e) => e.fromId));
  ok('1 assesses edge intact (incoming)', g.incoming.filter((e) => e.type === 'assesses').length === 1);
  ok('1 references edge intact (outgoing)', g.outgoing.filter((e) => e.type === 'references').length === 1);
  ok('1 part_of (concept) edge intact (outgoing)', g.outgoing.filter((e) => e.type === 'part_of' && e.toId === concept.id).length === 1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
