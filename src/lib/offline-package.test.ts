// src/lib/offline-package.test.ts — run: npx tsx src/lib/offline-package.test.ts
// Offline Runtime pure core: budget planner drops lowest-priority over budget; a compiled
// manifest is pre-rendered so a unit renders from the LOCAL store (no network); reconnect
// marks changed objects dirty + dedupes for the sync queue.
import { planPackage, buildManifest, renderOfflineUnit, dirtyOnReconnect, byteLen, type PlanItem } from './offline-package';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== planner respects a storage budget (drops lowest-priority over budget) ==');
const items: PlanItem[] = [
  { id: 'a', title: 'A', bytes: 400, priority: 5 },
  { id: 'b', title: 'B', bytes: 400, priority: 4 },
  { id: 'c', title: 'C', bytes: 400, priority: 1 },   // lowest priority
];
const plan = planPackage(items, { maxBytes: 900 });
ok('total stays within budget', plan.totalBytes <= 900, plan.totalBytes);
ok('keeps the two highest-priority units', plan.included.includes('a') && plan.included.includes('b'));
ok('drops the lowest-priority unit over budget', plan.dropped.includes('c') && !plan.included.includes('c'), plan);
ok('maxUnits cap is honoured', planPackage(items, { maxBytes: 99999, maxUnits: 1 }).included.length === 1);

console.log('\n== a compiled manifest is pre-rendered -> renders from the local store offline ==');
const manifest = buildManifest({
  units: [
    { id: 'u1', data: { title: 'Limits', body: '# Idea\n\nLimits **matter**.', equations: [{ latex: 'x^2' }], examples: [{ prompt: 'p', solution: 's' }] }, securityLabels: ['public'] },
    { id: 'u2', data: { title: 'Derivatives', body: 'Rate of change.' }, securityLabels: ['public'] },
  ],
  edges: [{ from: 'u1', to: 'u2', type: 'prerequisite_of' }],
  progress: [{ koId: 'u1', completed: true }],
  tier: 'lite', budget: { maxBytes: 5_000_000 },
});
ok('both units packaged', manifest.unitCount === 2);
ok('body is PRE-RENDERED html (offline, no renderer needed)', manifest.units[0].bodyHtml.includes('<h2>Idea</h2>') && manifest.units[0].bodyHtml.includes('<strong>matter</strong>'), manifest.units[0].bodyHtml);
ok('equation pre-rendered', manifest.units[0].equations[0].html.includes('<sup>2</sup>'));
ok('knowledge-graph subset carried', manifest.edges.length === 1 && manifest.edges[0].type === 'prerequisite_of');
ok('progress carried into the package', manifest.progress.length === 1 && manifest.progress[0].completed === true);
const off = renderOfflineUnit(manifest, 'u2');
ok('renderOfflineUnit serves a unit from the local manifest', !!off && off.title === 'Derivatives', off?.title);

console.log('\n== budget drops the lowest-priority unit at compile time ==');
const tight = buildManifest({
  units: [{ id: 'x', data: { title: 'Big', body: 'X'.repeat(2000) } }, { id: 'y', data: { title: 'Small', body: 'Y' } }],
  edges: [], progress: [], tier: 'lite', budget: { maxBytes: byteLen(JSON.stringify({})) + 400 },
});
ok('over-budget compile keeps the higher-priority unit only', tight.unitCount === 1 && tight.droppedUnitIds.length === 1, { kept: tight.units.map((u) => u.id), dropped: tight.droppedUnitIds });

console.log('\n== reconnect marks changed objects dirty (deduped) for the sync queue ==');
const dirty = dirtyOnReconnect([{ objectId: 'u1', kind: 'progress', at: '' }, { objectId: 'u1', kind: 'progress', at: '' }, { objectId: 'u2', kind: 'content', at: '' }]);
ok('deduped to two objects', dirty.length === 2, dirty);
ok('each marked dirty (not silently synced)', dirty.every((d) => d.state === 'dirty'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
