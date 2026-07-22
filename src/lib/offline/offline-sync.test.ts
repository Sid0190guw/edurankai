// src/lib/offline/offline-sync.test.ts — run: npx tsx src/lib/offline/offline-sync.test.ts
// Self-contained (no DB): manifest validation + the pure conflict/merge/delta logic.
import { parseManifest, safeParseManifest, type ProgressEntry } from './manifest-schema';
import { resolveConflictDecision, mergeProgress, reconcile, computeDelta, type LocalMeta, type ServerMeta } from '@/lib/knowledge-sync';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const U = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36);
const validManifest = {
  schemaVersion: 1, packageId: U(1), userId: null, tier: 'lite', createdAt: '2026-07-20T00:00:00.000Z',
  baseVersion: 5, budget: { maxBytes: 8_388_608 }, totalBytes: 1234, droppedIds: [], categories: {},
};

function main() {
  console.log('\n== manifest validation ==');
  const m = parseManifest(validManifest);
  ok('valid manifest parses; categories default to empty arrays', m.categories.notes.length === 0 && m.categories.studentProgress.length === 0);
  ok('safeParse returns null on a bad tier', safeParseManifest({ ...validManifest, tier: 'ultra' }) === null);
  ok('safeParse returns null on wrong schemaVersion', safeParseManifest({ ...validManifest, schemaVersion: 2 }) === null);
  let threw = false; try { parseManifest({ ...validManifest, packageId: 'not-a-uuid' }); } catch { threw = true; }
  ok('parseManifest throws on a malformed package', threw);
  ok('progress entry fills defaults', (() => {
    const withProg = parseManifest({ ...validManifest, categories: { studentProgress: [{ koId: U(2), updatedAt: '2026-07-20T00:00:00Z' }] } });
    const p = withProg.categories.studentProgress[0];
    return p.completed === false && p.timeSpentSec === 0;
  })());

  console.log('\n== conflict resolution policies ==');
  const local: LocalMeta & { updatedAt?: string } = { version: 5, baseVersion: 3, state: 'dirty', updatedAt: '2026-07-20T10:00:00Z' };
  const server: ServerMeta & { updatedAt?: string } = { version: 4, updatedAt: '2026-07-20T09:00:00Z' };
  ok('server-wins -> server', resolveConflictDecision(local, server, 'server-wins').winner === 'server');
  ok('local-wins -> local', resolveConflictDecision(local, server, 'local-wins').winner === 'local');
  ok('higher-version -> local (5>=4)', resolveConflictDecision(local, server, 'higher-version').winner === 'local');
  ok('last-writer-wins -> local (later clock)', resolveConflictDecision(local, server, 'last-writer-wins').winner === 'local');
  ok('last-writer-wins -> server when server is newer', resolveConflictDecision({ ...local, updatedAt: '2026-07-20T08:00:00Z' }, server, 'last-writer-wins').winner === 'server');
  ok('LWW falls back to higher-version without clocks', resolveConflictDecision({ version: 2, baseVersion: 1, state: 'dirty' }, { version: 7 }, 'last-writer-wins').winner === 'server');
  ok('resolution always bumps version to max+1', resolveConflictDecision(local, server, 'server-wins').newVersion === 6);

  console.log('\n== monotonic progress merge ==');
  const a: ProgressEntry = { koId: U(3), completed: false, timeSpentSec: 100, updatedAt: '2026-07-19T00:00:00Z' };
  const b: ProgressEntry = { koId: U(3), completed: true, score: 80, timeSpentSec: 50, updatedAt: '2026-07-20T00:00:00Z' };
  const merged = mergeProgress(a, b);
  ok('completed OR-merges to true', merged.completed === true);
  ok('score takes the max', merged.score === 80);
  ok('timeSpentSec takes max (idempotent under replay), not sum', merged.timeSpentSec === 100);
  ok('updatedAt takes the later clock', merged.updatedAt === b.updatedAt);
  ok('merge is idempotent: merge(a,a) preserves a', (() => { const r = mergeProgress(a, a); return r.timeSpentSec === 100 && r.completed === false; })());

  console.log('\n== dependency-aware delta (existing computeDelta) ==');
  // equation --references--> animation --assesses--> assessment ; changing the equation pulls both.
  const edges = [{ from: 'eq', to: 'anim', type: 'references' }, { from: 'anim', to: 'quiz', type: 'assesses' }];
  const delta = computeDelta(['eq'], edges as any);
  ok('changing the equation propagates to animation + assessment', delta.includes('anim') && delta.includes('quiz'), delta);
  ok('part_of siblings are NOT force-synced', !computeDelta(['u1'], [{ from: 'u1', to: 'u2', type: 'part_of' }] as any).includes('u2'));

  console.log('\n== reconcile decisions ==');
  ok('clean + server ahead -> pull', reconcile({ version: 3, baseVersion: 3, state: 'synced' }, { version: 5 }).action === 'pull');
  ok('dirty + only-local-changed -> push', reconcile({ version: 5, baseVersion: 4, state: 'dirty' }, { version: 4 }).action === 'push');
  ok('dirty + both-changed -> conflict', reconcile({ version: 5, baseVersion: 3, state: 'dirty' }, { version: 6 }).action === 'conflict');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
