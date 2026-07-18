// src/lib/knowledge-sync.test.ts — run: npx tsx src/lib/knowledge-sync.test.ts
// Knowledge-Delta Sync pure core: a change propagates to ONLY its dependent chain (assessment,
// translation, referenced animation) and never to unrelated objects; two-way reconcile yields
// push / pull / conflict; conflict resolution is deterministic and bumps the version.
import { computeDelta, reconcile, resolveConflictDecision, type Edge } from './knowledge-sync';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== a change propagates to its dependent chain (assessment/translation/animation) ==');
const edges: Edge[] = [
  { from: 'assess1', to: 'ko1', type: 'assesses' },
  { from: 'trans1', to: 'ko1', type: 'translation_of' },
  { from: 'ko1', to: 'anim1', type: 'references' },
  { from: 'anim1', to: 'voice1', type: 'references' },     // chain continues: animation -> voice
  { from: 'ko1', to: 'ko2', type: 'part_of' },             // structural sibling — must NOT propagate
];
const delta = computeDelta(['ko1'], edges);
ok('delta includes the changed object', delta.includes('ko1'));
ok('delta includes its assessment', delta.includes('assess1'));
ok('delta includes its translation', delta.includes('trans1'));
ok('delta includes its referenced animation', delta.includes('anim1'));
ok('delta follows the chain to voice', delta.includes('voice1'), delta);
ok('delta EXCLUDES a part_of sibling (structural, not a dependency)', !delta.includes('ko2'), delta);

console.log('\n== nothing unaffected is synced ==');
const delta2 = computeDelta(['ko1'], edges.concat([{ from: 'ko9', to: 'ko8', type: 'references' }]));
ok('a disconnected object is NOT in the delta', !delta2.includes('ko9') && !delta2.includes('ko8'), delta2);
ok('delta only grows with connected objects', computeDelta(['isolated'], edges).length === 1);

console.log('\n== two-way reconcile: push / pull / conflict ==');
ok('not-dirty + server ahead -> pull', reconcile({ version: 2, baseVersion: 2, state: 'synced' }, { version: 5 }).action === 'pull');
ok('not-dirty + in sync -> none', reconcile({ version: 5, baseVersion: 5, state: 'synced' }, { version: 5 }).action === 'none');
ok('dirty + server unchanged since base -> push', reconcile({ version: 6, baseVersion: 5, state: 'dirty' }, { version: 5 }).action === 'push');
ok('dirty + server ALSO advanced -> conflict (no silent overwrite)', reconcile({ version: 6, baseVersion: 5, state: 'dirty' }, { version: 7 }).action === 'conflict');

console.log('\n== conflict resolution is deterministic + bumps the version ==');
const local = { version: 6, baseVersion: 5, state: 'conflict' as const };
const server = { version: 7 };
ok('server-wins picks server + bumps version', (() => { const r = resolveConflictDecision(local, server, 'server-wins'); return r.winner === 'server' && r.newVersion === 8; })());
ok('local-wins picks local + bumps version', resolveConflictDecision(local, server, 'local-wins').winner === 'local');
ok('higher-version picks the higher side', resolveConflictDecision(local, server, 'higher-version').winner === 'server');
ok('new version is strictly greater than both', resolveConflictDecision(local, server, 'server-wins').newVersion > Math.max(local.version, server.version));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
