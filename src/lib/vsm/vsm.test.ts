// src/lib/vsm/vsm.test.ts — run: npx tsx src/lib/vsm/vsm.test.ts
// Self-contained (no DB): pure keys/gate/policy/header functions + the read-through manager
// over an InMemoryKernelStore + memoryKv.
import { createKernel } from '@/lib/kernel';
import {
  objectCacheKey, objectEtag, scopeHash, canReadObject, isShareable, resolvePolicy,
  cacheControlFor, memoryKv, VirtualStorageManager, VsmForbiddenError, type Principal,
} from './index';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const P = (over: Partial<Principal> = {}): Principal => ({ userId: 'u1', roles: [], ...over });
const gate = (labels: string[], owner: string | null, state: string) => ({ securityLabels: labels as any, owner, lifecycleState: state as any });

async function main() {
  console.log('\n== keys ==');
  ok('a version bump changes the content key', objectCacheKey({ id: 'a', version: 1, view: 'envelope', scope: 'pub' }) !== objectCacheKey({ id: 'a', version: 2, view: 'envelope', scope: 'pub' }));
  ok('etag encodes id.version', objectEtag('a', 3) === '"a.3"');
  ok('shareable scope = pub', scopeHash(P(), true) === 'pub');
  ok('private scope includes userId (no cross-user reuse)', scopeHash(P({ userId: 'a' }), false) !== scopeHash(P({ userId: 'b' }), false));

  console.log('\n== Zero-Trust read gate (default deny) ==');
  ok('admin reads anything', canReadObject(gate(['exam-secure'], 'other', 'published'), P({ isAdmin: true })));
  ok('exam-secure: owner only', canReadObject(gate(['exam-secure'], 'u1', 'published'), P()) && !canReadObject(gate(['exam-secure'], 'other', 'published'), P()));
  ok('enrolled-only: needs an enrollment', !canReadObject(gate(['enrolled-only'], 'other', 'published'), P()) && canReadObject(gate(['enrolled-only'], 'other', 'published'), P({ enrolledCourseIds: ['c1'] })));
  ok('public+published: anyone', canReadObject(gate(['public'], 'other', 'published'), P()));
  ok('public+draft: only owner', !canReadObject(gate(['public'], 'other', 'created'), P()) && canReadObject(gate(['public'], 'u1', 'created'), P()));
  ok('unknown/no label: private to owner (default deny)', !canReadObject(gate([], 'other', 'published'), P()) && canReadObject(gate([], 'u1', 'published'), P()));
  ok('archived: denied to non-admin', !canReadObject(gate(['public'], 'u1', 'archived'), P()));

  console.log('\n== shareability + policy ==');
  ok('public+published is shareable', isShareable(gate(['public'], null, 'published')));
  ok('exam-secure is never shareable', !isShareable(gate(['public', 'exam-secure'], null, 'published')));
  ok('exam-secure policy = no cache / no share', (() => { const p = resolvePolicy(['exam-secure'], 'published'); return !p.shareable && p.kvSeconds === 0 && p.edgeSeconds === 0; })());
  ok('draft policy = no cache', resolvePolicy(['public'], 'created').kvSeconds === 0);
  ok('public+published policy = shareable + edge TTL', (() => { const p = resolvePolicy(['public'], 'published'); return p.shareable && p.edgeSeconds === 3600; })());
  ok('enrolled-only published = kv-scoped, not shareable', (() => { const p = resolvePolicy(['enrolled-only'], 'published'); return !p.shareable && p.kvSeconds === 60; })());

  console.log('\n== cache-control header ==');
  ok('shareable -> public s-maxage', cacheControlFor(resolvePolicy(['public'], 'published')).startsWith('public, max-age=60, s-maxage=3600'));
  ok('private kv -> private max-age', cacheControlFor(resolvePolicy(['enrolled-only'], 'published')) === 'private, max-age=60');
  ok('exam-secure -> no-store', cacheControlFor(resolvePolicy(['exam-secure'], 'published')) === 'no-store');

  console.log('\n== read-through manager (in-memory kernel + memory kv) ==');
  const repo = createKernel();
  const kv = memoryKv();
  const publish = async (id: string) => { await repo.validateObject(id); await repo.indexObject(id); await repo.publishObject(id); };

  const pub = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Open' }, owner: 'ownerA', securityLabels: ['public'] });
  await publish(pub.id);
  const anon = P({ userId: 'anon' });

  const vsm1 = new VirtualStorageManager(repo, kv);         // fresh memo
  const r1 = await vsm1.readObject(pub.id, 'envelope', anon);
  ok('first read served from db, shareable header', r1.hit === 'db' && r1.etag === objectEtag(pub.id, 1) && r1.cacheControl.startsWith('public'));
  const vsm2 = new VirtualStorageManager(repo, kv);         // new request, shared kv
  ok('second read (new request) served from kv', (await vsm2.readObject(pub.id, 'envelope', anon)).hit === 'kv');
  ok('same-request memo returns instantly', (await vsm1.readObject(pub.id, 'envelope', anon)) === r1);

  // version bump -> invalidate -> new etag. updateObject moves it to lifecycle 'updated', so a
  // public reader is (correctly) denied until it is re-published; republish keeps version at 2.
  await repo.updateObject(pub.id, { data: { title: 'Open v2' } });   // version -> 2, state 'updated'
  await repo.publishObject(pub.id);                                  // back to published (version still 2)
  await vsm2.invalidate(pub.id);
  const r3 = await (new VirtualStorageManager(repo, kv)).readObject(pub.id, 'envelope', anon);
  ok('after bump+invalidate, etag advances to v2 from db', r3.etag === objectEtag(pub.id, 2) && r3.hit === 'db');

  console.log('\n== exam-secure + private isolation ==');
  const exam = await repo.createObject({ type: 'AssessmentObject', data: { title: 'Final' }, owner: 'ownerA', securityLabels: ['exam-secure'] });
  await publish(exam.id);
  const vsmE = new VirtualStorageManager(repo, kv);
  ok('owner reads exam-secure, header no-store', (await vsmE.readObject(exam.id, 'envelope', P({ userId: 'ownerA' }))).cacheControl === 'no-store');
  let denied = false; try { await (new VirtualStorageManager(repo, kv)).readObject(exam.id, 'envelope', P({ userId: 'someoneElse' })); } catch (e) { denied = e instanceof VsmForbiddenError; }
  ok('non-owner read of exam-secure is forbidden', denied);

  const priv = await repo.createObject({ type: 'KnowledgeObject', data: { title: 'Secret' }, owner: 'ownerA', securityLabels: ['private'] });
  await publish(priv.id);
  await (new VirtualStorageManager(repo, kv)).readObject(priv.id, 'envelope', P({ userId: 'ownerA' }));   // owner populates kv under owner scope
  let leak = false; try { await (new VirtualStorageManager(repo, kv)).readObject(priv.id, 'envelope', P({ userId: 'intruder' })); } catch (e) { leak = !(e instanceof VsmForbiddenError); }
  ok('private object cannot leak to another user via kv scope', !leak);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
