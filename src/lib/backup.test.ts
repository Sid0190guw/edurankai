// src/lib/backup.test.ts — run: npx tsx src/lib/backup.test.ts
// Backup/restore (pure): a package round-trips + validates; a dry-run reports before applying and
// BLOCKS on an integrity failure; the consistency check detects a deliberately orphaned edge.
import { makePackage, validatePackage, consistencyCheck, planRestore } from './backup';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const objects = [{ id: 'o1', type: 'CourseObject', lifecycle_state: 'published' }, { id: 'o2', type: 'KnowledgeObject', lifecycle_state: 'published' }];
const edges = [{ id: 'e1', from_id: 'o2', to_id: 'o1', type: 'part_of' }];

console.log('\n== export package + validation ==');
const pkg = makePackage(objects, edges, 'full');
ok('package has version + objects + edges', pkg.version === 1 && pkg.objects.length === 2 && pkg.edges.length === 1);
ok('valid package passes validation', validatePackage(pkg).ok === true);
ok('a wrong-version package is rejected', validatePackage({ ...pkg, version: 99 }).ok === false);
ok('an object without id is rejected', validatePackage({ version: 1, objects: [{ type: 'x' }], edges: [] }).ok === false);

console.log('\n== consistency check ==');
ok('a clean graph is consistent', consistencyCheck(objects, edges).ok === true);
const orphan = consistencyCheck(objects, [{ id: 'e9', from_id: 'o2', to_id: 'GHOST', type: 'part_of' }]);
ok('a deliberately orphaned edge is detected', orphan.ok === false && orphan.orphanEdges.length === 1, orphan.orphanEdges.length);
ok('an invalid lifecycle state is detected', consistencyCheck([{ id: 'o3', lifecycle_state: 'wat' }], []).badLifecycle.length === 1);

console.log('\n== dry-run restore ==');
const plan = planRestore(pkg, ['o1']);   // o1 already exists
ok('dry-run reports create/skip counts', plan.blocked === false && plan.toCreate === 1 && plan.toSkip === 1, plan);
const blocked = planRestore({ version: 1, objects, edges: [{ id: 'e9', from_id: 'o2', to_id: 'GHOST', type: 'part_of' }] }, []);
ok('dry-run BLOCKS on an integrity failure (no write)', blocked.blocked === true && /integrity/.test(blocked.reason || ''), blocked.reason);
ok('dry-run BLOCKS an invalid package', planRestore({ version: 99 }, []).blocked === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
