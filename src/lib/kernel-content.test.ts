// src/lib/kernel-content.test.ts — run: npx tsx src/lib/kernel-content.test.ts
// Prompt 3 content feature, DB-free (in-memory kernel + pure RBAC engine + renderers).
// Covers the required scenarios: create a course + attach two ordered KnowledgeObjects
// (part_of); content_author DENIED publish while reviewer_examiner ALLOWED; a student sees
// only published + permitted units; a prerequisite link resolves to the right unit; markdown
// + LaTeX render; and every gated create/publish flows through can() -> an audit row.
import { ContentService } from './kernel-content';
import { createKernel } from '@/lib/kernel';
import { evaluate } from '@/lib/rbac/engine';
import { enforce, type AuditEntry } from '@/lib/rbac/guard';
import { resolveRoleCapabilities } from '@/lib/rbac/roles';
import type { Principal } from '@/lib/rbac/types';
import { mdLite, latexToHtml } from './content-render';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };
function principal(roles: string[]): Principal {
  const caps = new Set<any>(); for (const r of roles) for (const c of resolveRoleCapabilities(r)) caps.add(c);
  return { userId: 'u1', sessionValid: true, roles, capabilities: caps };
}

async function main() {
  const svc = new ContentService(createKernel());   // in-memory kernel

  console.log('\n== 1. create a course + attach two ordered KnowledgeObjects (part_of) ==');
  const course = await svc.createCourse('Foundations of Calculus', 'Limits to integrals', 'training-cs-101');
  const ko1 = await svc.createUnit({ title: 'Limits', body: 'A **limit** describes behaviour near a point.' });
  const ko2 = await svc.createUnit({ title: 'Derivatives', body: 'The derivative is a rate of change.' });
  await svc.attachUnit(course.id, ko2.id, 2);   // attach out of order on purpose
  await svc.attachUnit(course.id, ko1.id, 1);
  const units = await svc.listCourseUnits(course.id);
  ok('two units attached', units.length === 2, units.length);
  ok('units come back in ORDER (1 then 2)', (units[0].data as any).title === 'Limits' && (units[1].data as any).title === 'Derivatives', units.map((u) => (u.data as any).title));

  console.log('\n== 2. publish gate: content_author DENIED, reviewer_examiner ALLOWED ==');
  ok('content_author cannot execute(publish)', !evaluate(principal(['content_author']), 'execute', { type: 'KnowledgeObject' }).allow);
  ok('reviewer_examiner CAN execute(publish)', evaluate(principal(['reviewer_examiner']), 'execute', { type: 'KnowledgeObject' }).allow);
  ok('faculty CAN execute(publish)', evaluate(principal(['faculty']), 'execute', { type: 'KnowledgeObject' }).allow);

  console.log('\n== 3. a student sees only PUBLISHED + permitted units ==');
  await svc.publishUnit(ko1.id);   // publish only the first
  const published = await svc.listCourseUnits(course.id, true);
  ok('only the published unit is visible', published.length === 1 && (published[0].data as any).title === 'Limits', published.map((u) => (u.data as any).title));
  ok('published unit reached the published state', published[0].lifecycleState === 'published', published[0].lifecycleState);
  // securityLabel gating (what the main page enforces via can())
  ok('student denied an exam-secure unit', !evaluate(principal(['student']), 'read', { type: 'KnowledgeObject', securityLabels: ['exam-secure'] }).allow);
  ok('student allowed a public unit', evaluate(principal(['student']), 'read', { type: 'KnowledgeObject', securityLabels: ['public'] }).allow);

  console.log('\n== 4. a prerequisite link resolves to the right unit ==');
  await svc.addPrerequisite(ko2.id, ko1.id);   // Limits is a prerequisite of Derivatives
  const view = await svc.getUnitView(ko2.id);
  ok('derivatives view lists exactly one prerequisite', !!view && view.prerequisites.length === 1, view?.prerequisites);
  ok('prerequisite resolves to "Limits"', !!view && view.prerequisites[0].title === 'Limits', view?.prerequisites?.[0]);
  ok('unit view reports its course', !!view && view.courses.length === 1 && view.courses[0].trainingCourseId === 'training-cs-101');

  console.log('\n== 5. markdown body + LaTeX equations render (server-side) ==');
  const ko3 = await svc.createUnit({ title: 'Fundamental theorem', body: '# Key idea\n\nIntegration undoes differentiation.', equations: [{ latex: '\\int_a^b f(x)\\,dx = F(b) - F(a)' }] });
  const v3 = await svc.getUnitView(ko3.id);
  const bodyHtml = mdLite((v3!.unit.data as any).body);
  const eqHtml = latexToHtml((v3!.unit.data as any).equations[0].latex);
  ok('markdown body renders a heading', bodyHtml.includes('<h2>Key idea</h2>'), bodyHtml);
  ok('LaTeX equation renders sub/sup', eqHtml.includes('<sub>a</sub>') && eqHtml.includes('<sup>b</sup>'), eqHtml);

  console.log('\n== 6. every gated create/publish flows through can() -> an audit row ==');
  const log: AuditEntry[] = [];
  const sink = (e: AuditEntry) => { log.push(e); };
  await enforce(principal(['content_author']), 'create', { type: 'KnowledgeObject' }, {}, sink);   // authoring
  await enforce(principal(['reviewer_examiner']), 'execute', { type: 'KnowledgeObject' }, {}, sink); // publishing
  ok('two audit rows written', log.length === 2, log.length);
  ok('create decision audited (allow)', log[0].capability === 'create' && log[0].allow === true);
  ok('publish decision audited (allow) with timestamp', log[1].capability === 'execute' && log[1].allow === true && !!log[1].at);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
