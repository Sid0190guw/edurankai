// src/lib/knowledge-graph.test.ts — run: npx tsx src/lib/knowledge-graph.test.ts
// Self-contained (no DB). Covers the pure graph algorithms: topo order, cycle detection,
// would-create-cycle guard, closure, ready frontier, and learning path.
import {
  topoSort, findCycle, wouldCreateCycle, prerequisiteClosure, readyFrontier, learningPath,
  type Dag,
} from './knowledge-graph';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

// a -> b -> c -> d  (linear); e is disconnected
const linear: Dag = { nodes: ['a', 'b', 'c', 'd', 'e'], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] };
// diamond: a -> b, a -> c, b -> d, c -> d
const diamond: Dag = { nodes: ['a', 'b', 'c', 'd'], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }] };
// 3-cycle: x -> y -> z -> x
const cyclic: Dag = { nodes: ['x', 'y', 'z'], edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }, { from: 'z', to: 'x' }] };

function main() {
  console.log('\n== topoSort ==');
  const t1 = topoSort(linear);
  ok('linear order respects prereqs', t1.cycle === null && t1.order.indexOf('a') < t1.order.indexOf('b') && t1.order.indexOf('c') < t1.order.indexOf('d'), t1.order);
  ok('disconnected node still included', t1.order.includes('e'));
  ok('deterministic on re-run', JSON.stringify(topoSort(linear)) === JSON.stringify(topoSort(linear)));
  const t2 = topoSort(diamond);
  ok('diamond: a first, d last', t2.cycle === null && t2.order[0] === 'a' && t2.order[t2.order.length - 1] === 'd', t2.order);

  console.log('\n== cycle detection ==');
  const c = topoSort(cyclic);
  ok('cyclic graph reports a cycle', c.cycle !== null, c.cycle);
  const fc = findCycle(cyclic);
  ok('findCycle returns a closed loop', !!fc && fc[0] === fc[fc.length - 1] && fc.length === 4, fc);
  ok('acyclic graph -> no cycle', findCycle(diamond) === null);
  ok('self-loop is a cycle', findCycle({ nodes: ['a'], edges: [{ from: 'a', to: 'a' }] }) !== null);

  console.log('\n== wouldCreateCycle ==');
  ok('adding d->a closes the linear chain', wouldCreateCycle(linear, 'd', 'a'));
  ok('adding a->d is safe (already ordered)', !wouldCreateCycle(linear, 'a', 'd'));
  ok('self prerequisite is a cycle', wouldCreateCycle(linear, 'a', 'a'));
  ok('adding e->a is safe (disconnected)', !wouldCreateCycle(linear, 'e', 'a'));

  console.log('\n== prerequisiteClosure ==');
  ok('closure of d = {a,b,c}', prerequisiteClosure(linear, 'd').join(',') === 'a,b,c', prerequisiteClosure(linear, 'd'));
  ok('closure of a = {} (no prereqs)', prerequisiteClosure(linear, 'a').length === 0);
  ok('diamond closure of d = {a,b,c}', prerequisiteClosure(diamond, 'd').join(',') === 'a,b,c');

  console.log('\n== readyFrontier ==');
  ok('nothing mastered -> only a is ready (linear)', readyFrontier(linear, new Set()).join(',') === 'a,e', readyFrontier(linear, new Set()));
  ok('a mastered -> b ready', readyFrontier(linear, new Set(['a'])).includes('b'));
  ok('a,b,c mastered -> d ready (e also ready: no prereqs)', JSON.stringify(readyFrontier(linear, new Set(['a', 'b', 'c']))) === JSON.stringify(['d', 'e']));
  ok('diamond: a mastered -> b and c both ready', readyFrontier(diamond, new Set(['a'])).join(',') === 'b,c');

  console.log('\n== learningPath ==');
  ok('path to d = a,b,c,d', learningPath(linear, 'd').join(',') === 'a,b,c,d', learningPath(linear, 'd'));
  ok('path to d with a,b mastered = c,d', learningPath(linear, 'd', new Set(['a', 'b'])).join(',') === 'c,d');
  ok('diamond path to d has a first, d last, len 4', (() => { const p = learningPath(diamond, 'd'); return p[0] === 'a' && p[p.length - 1] === 'd' && p.length === 4; })());
  let threw = false; try { learningPath(cyclic, 'x'); } catch { threw = true; }
  ok('learningPath throws on a cyclic target', threw);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
