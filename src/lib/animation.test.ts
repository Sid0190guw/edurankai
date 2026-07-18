// src/lib/animation.test.ts — run: npx tsx src/lib/animation.test.ts
// Animation kernel linkage (Prompt A1a): templates + instances are AnimationObjects; a fired
// instance links to a KnowledgeObject via the `references` edge. In-memory kernel — no DB.
import { AnimationService, TEMPLATES, isTemplate } from './animation';
import { createKernel } from '@/lib/kernel';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

async function main() {
  const repo = createKernel();
  const svc = new AnimationService(repo);

  console.log('\n== templates are AnimationObjects (idempotent) ==');
  const map = await svc.ensureTemplates();
  ok('one AnimationObject per registry template', Object.keys(map).length === TEMPLATES.length && !!map['projectile']);
  const again = await svc.ensureTemplates();
  ok('ensureTemplates is idempotent (same ids)', again['projectile'] === map['projectile']);
  const all = await svc.listAll();
  ok('template objects are of type AnimationObject', all.every((o: any) => o.type === 'AnimationObject'));

  console.log('\n== a fired instance links to a KnowledgeObject via `references` ==');
  const ko = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Projectiles' } });
  const instId = await svc.createInstance('projectile', { angle: 45, v0: 30, gravity: 9.8 }, ko.id, null);
  const graph = await repo.getObjectGraph(ko.id);
  const refs = graph.outgoing.filter((e) => e.type === 'references').map((e) => e.toId);
  ok('the instance is referenced by the KnowledgeObject', refs.includes(instId), refs);
  const inst = await repo.getObject(instId);
  ok('the instance carries its template + params', (inst!.metadata as any).templateId === 'projectile' && (inst!.metadata as any).params.angle === 45);
  ok('an unknown template is rejected', await svc.createInstance('nope' as any, {}, null, null).then(() => false).catch(() => true));

  console.log('\n== registry guard ==');
  ok('isTemplate accepts registry ids only', isTemplate('sine') && !isTemplate('bogus'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
