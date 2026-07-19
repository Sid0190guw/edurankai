// src/lib/kernel/kernel.test.ts — run: npx tsx src/lib/kernel/kernel.test.ts
// Self-contained (in-memory store, no DB). Proves creation of every type, every valid
// lifecycle transition, invalid transitions throwing, version bump, validation gating, and
// a KnowledgeObject composition round-trip with relationships intact.
import { KernelRepository, StaleWriteError } from './repository';
import { InMemoryKernelStore } from './store';
import { OBJECT_TYPES, type ObjectType, type ObjectDataMap } from './types';
import { LifecycleError } from './lifecycle';
import { ValidationError, EdgeGrammarError, validateEnvelope } from './validation';
import { topoOrder, wouldCycle, CycleError } from './graph';
import { can } from './access';

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

  console.log('\n== discard transition (Block 08) ==');
  const draft = await repo.createObject({ type: 'ConceptObject', data: { name: 'Draft' } });
  const discarded = await repo.archiveObject(draft.id);
  ok('created -> archived (discard) is legal', discarded.lifecycleState === 'archived' && !!discarded.archivedAt);
  const draft2 = await repo.createObject({ type: 'ConceptObject', data: { name: 'D2' } });
  await throws('created -> published still rejected (no skip to publish)', () => repo.publishObject(draft2.id), LifecycleError);

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

  // ======================================================================
  // Block 01 additions (T1–T8)
  // ======================================================================

  console.log('\n== T1: envelope validation ==');
  const env0 = await repo.createObject({ type: 'ConceptObject', data: { name: 'Env' }, owner: null });
  let envThrew = false; try { validateEnvelope(env0); } catch { envThrew = true; }
  ok('valid envelope passes', !envThrew);
  await throws('version 0 rejected', async () => validateEnvelope({ ...env0, version: 0 }), ValidationError);
  await throws('unknown type rejected', async () => validateEnvelope({ ...env0, type: 'NotAType' }), ValidationError);

  console.log('\n== T2: edge grammar ==');
  const stu = await repo.createObject({ type: 'StudentObject', data: { displayName: 'S' } });
  const crs = await repo.createObject({ type: 'CourseObject', data: { title: 'C' } });
  await throws('illegal edge Student -prerequisite_of-> Course rejected', () => repo.addRelationship(stu.id, 'prerequisite_of', crs.id), EdgeGrammarError);

  console.log('\n== T3: prerequisite DAG (topoOrder / wouldCycle) ==');
  const chain = [
    { id: 'a', fromId: 'A', toId: 'B', type: 'prerequisite_of', createdAt: '' },
    { id: 'b', fromId: 'B', toId: 'C', type: 'prerequisite_of', createdAt: '' },
  ] as any;
  const lin = topoOrder(['A', 'B', 'C'], chain);
  ok('linear chain sorts A,B,C', lin.cycle === null && lin.order.join(',') === 'A,B,C', lin.order);
  const cyc = topoOrder(['A', 'B', 'C'], [...chain, { id: 'c', fromId: 'C', toId: 'A', type: 'prerequisite_of', createdAt: '' }] as any);
  ok('cycle detected; residual = the 3 cycle nodes', cyc.cycle !== null && cyc.cycle!.length === 3, cyc.cycle);
  ok('wouldCycle true for C->A', wouldCycle('C', 'A', chain));
  ok('wouldCycle false for A->C', !wouldCycle('A', 'C', chain));
  const kA = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'KA' } });
  const kB = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'KB' } });
  await repo.addRelationship(kA.id, 'prerequisite_of', kB.id);
  await throws('cycle-creating edge rejected by addRelationship', () => repo.addRelationship(kB.id, 'prerequisite_of', kA.id), CycleError);

  console.log('\n== T4: validate gate rejects a KO already in a cycle ==');
  const cyStore = new InMemoryKernelStore();
  const repo2 = new KernelRepository(cyStore);
  const c1 = await repo2.createObject({ type: 'KnowledgeObject', data: { title: 'C1' } });
  const c2 = await repo2.createObject({ type: 'KnowledgeObject', data: { title: 'C2' } });
  await cyStore.insertEdge({ id: 'e1', fromId: c1.id, toId: c2.id, type: 'prerequisite_of', createdAt: nowStr() });   // force a cycle
  await cyStore.insertEdge({ id: 'e2', fromId: c2.id, toId: c1.id, type: 'prerequisite_of', createdAt: nowStr() });   // bypassing the guard
  await throws('validateObject rejects KO in a prerequisite cycle', () => repo2.validateObject(c1.id), CycleError);

  console.log('\n== T5/T6: version history + optimistic update ==');
  const doc = await repo.createObject({ type: 'CourseObject', data: { title: 'V0' } });
  await repo.validateObject(doc.id); await repo.indexObject(doc.id); await repo.publishObject(doc.id);   // v1 published
  await repo.updateObject(doc.id, { data: { summary: 's1' } });   // v2 (snapshot v1)
  await repo.publishObject(doc.id);
  await repo.updateObject(doc.id, { data: { summary: 's2' } });   // v3 (snapshot v2)
  const vers = await repo.listVersions(doc.id);
  ok('two snapshots retained (v1,v2)', vers.length === 2 && vers[0].version === 1 && vers[1].version === 2, vers);
  await throws('stale expectedVersion rejected', () => repo.updateObject(doc.id, { data: { summary: 'x' } }, 999), StaleWriteError);
  ok('stale write flags sync conflict', (await repo.getObject(doc.id))?.synchronizationState === 'conflict');

  console.log('\n== T7: rollback + merge ==');
  const rb0 = await repo.createObject({ type: 'ConceptObject', data: { name: 'Orig' } });
  await repo.validateObject(rb0.id); await repo.indexObject(rb0.id); await repo.publishObject(rb0.id);   // v1
  await repo.updateObject(rb0.id, { data: { description: 'edited' } });   // v2 (snapshot v1 = {name:Orig})
  const rb = await repo.rollbackObject(rb0.id, 1);
  ok('rollback restores payload', (rb.data as any).name === 'Orig' && (rb.data as any).description === undefined, rb.data);
  ok('rollback moves version FORWARD (never rewinds)', rb.version === 3, rb.version);

  const m0 = await repo.createObject({ type: 'CourseObject', data: { title: 'Base', summary: 'base-sum' } });
  await repo.validateObject(m0.id); await repo.indexObject(m0.id); await repo.publishObject(m0.id);   // v1 = base
  await repo.updateObject(m0.id, { data: { summary: 'local-sum' } });   // local: v2
  const mDisjoint = await repo.mergeObject(m0.id, { data: { title: 'Remote', summary: 'base-sum' } }, 1);
  ok('merge applies non-conflicting remote change (title)', (mDisjoint.merged.data as any).title === 'Remote', mDisjoint.merged.data);
  ok('merge keeps local non-conflicting change (summary)', (mDisjoint.merged.data as any).summary === 'local-sum');
  ok('disjoint field changes => no conflicts', mDisjoint.conflicts.length === 0, mDisjoint.conflicts);
  const mConflict = await repo.mergeObject(m0.id, { data: { title: 'Base', summary: 'remote-sum' } }, 1);
  ok('both sides changed same field => conflict on that path', mConflict.conflicts.includes('summary'), mConflict.conflicts);

  console.log('\n== T8: capability check (access.can) ==');
  const OWNER = 'owner-1';
  const secret = await repo.createObject({ type: 'AssessmentObject', data: { title: 'Final' }, owner: OWNER, securityLabels: ['exam-secure'], permissions: [{ subject: 'role:faculty', roles: ['read', 'write'] }] });
  ok('owner can do anything', can({ id: OWNER }, secret, 'write'));
  ok('faculty token reads exam-secure via grant', can({ id: 'u2', roleTokens: ['role:faculty'] }, secret, 'read'));
  ok('stranger cannot read exam-secure', !can({ id: 'u3' }, secret, 'read'));
  ok('stranger cannot write', !can({ id: 'u3' }, secret, 'write'));
  const pub = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Open' }, owner: OWNER, securityLabels: ['public'] });
  ok('anyone reads public', can({ id: 'anon' }, pub, 'read'));
  ok('public read does not imply write', !can({ id: 'anon' }, pub, 'write'));
  const course = await repo.createObject({ type: 'CourseObject', data: { title: 'Course X' }, owner: OWNER, securityLabels: ['enrolled-only'] });
  ok('enrolled student reads enrolled-only', can({ id: 's1', enrolledObjectIds: [course.id] }, course, 'read'));
  ok('non-enrolled cannot read enrolled-only', !can({ id: 's2' }, course, 'read'));
  const gone = await repo.createObject({ type: 'ConceptObject', data: { name: 'Gone' }, owner: OWNER, securityLabels: ['public'] });
  await repo.validateObject(gone.id); await repo.indexObject(gone.id); await repo.publishObject(gone.id); await repo.archiveObject(gone.id); await repo.deleteObject(gone.id);
  const goneFinal = (await repo.getObject(gone.id))!;   // re-load: the local `gone` ref is a pre-delete snapshot
  ok('deleted object denies even owner', !can({ id: OWNER }, goneFinal, 'read'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

function nowStr(): string { return new Date().toISOString(); }
main().catch((e) => { console.error(e); process.exit(1); });
