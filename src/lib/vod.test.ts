// src/lib/vod.test.ts — run: npx tsx src/lib/vod.test.ts
// Recording & VOD (Prompt AP1): a recording captures the ordered SPEC timeline (never baked pixels),
// so replay re-renders at the viewer's tier; a VOD asset is a kernel object linked to a course +
// access-gated by securityLabels; the storage interface is swap-ready with a dev fallback.
import { buildTimeline, labelAllows, VodService, broadcastSession } from './vod';
import { memoryStore, storageKey, getStore } from './storage';
import { createKernel } from '@/lib/kernel';
import type { BoardEvent } from './board-session';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const ev = (seq: number, templateId: string, params: any, at: string): BoardEvent => ({ seq, sessionId: 'bcast-x', templateId, params, playState: 'playing', timelinePos: 0, actor: null, at });

console.log('\n== timeline capture: ordered SPEC events, relative offsets, NO pixels ==');
const events = [
  ev(1, 'slide', { slide: { title: 'Intro', bullets: ['a'] } }, '2026-07-19T00:00:00Z'),
  ev(3, 'scene', { scene: { title: 'Atom', objects: [{ id: 'n', type: 'sphere' }] } }, '2026-07-19T00:00:10Z'),
  ev(2, 'bcast-msg', { kind: 'chat', body: 'hi' }, '2026-07-19T00:00:05Z'),   // ephemeral -> dropped
  ev(4, 'projectile', { angle: 45 }, '2026-07-19T00:00:20Z'),
];
const tl = buildTimeline(events);
ok('events sorted by seq + ephemeral chat dropped', tl.timeline.length === 3 && tl.timeline.map((e) => e.kind).join(',') === 'slide,scene,template');
ok('relative offsets from the first event', tl.timeline[0].tMs === 0 && tl.timeline[1].tMs === 10000 && tl.timeline[2].tMs === 20000, tl.timeline.map((e) => e.tMs));
ok('duration = last offset', tl.durationMs === 20000);
ok('chapters at scene/slide changes', tl.chapters.length === 2 && tl.chapters[0].label === 'Intro' && tl.chapters[1].label === 'Atom');
ok('the timeline is SPEC, not pixels (no frame/video/image field)', !/"(frame|video|image|pixels|dataUrl|mp4)"/.test(JSON.stringify(tl.timeline)));

console.log('\n== securityLabels gate access (pure) ==');
ok('public/unlabelled is visible', labelAllows([], {}) && labelAllows(['public'], {}));
ok('enrolled-only blocks a non-enrolled viewer', labelAllows(['enrolled-only'], { enrolled: false }) === false && labelAllows(['enrolled-only'], { enrolled: true }) === true);
ok('exam-secure requires exam context', labelAllows(['exam-secure'], { examMode: false }) === false && labelAllows(['exam-secure'], { examMode: true }) === true);

console.log('\n== storage interface is swap-ready with a dev fallback ==');
ok('storageKey is filesystem-safe + kinded', /^vod\/abc-\d+\.webm$/.test(storageKey('vod', 'abc!!', 'webm')));
(async () => {
  const store = memoryStore();
  const put = await store.put('vod/x.webm', new Uint8Array([1, 2, 3]), 'video/webm');
  ok('memory store put returns a url + key round-trips', !!put && put!.url === 'mem://vod/x.webm' && store.url('vod/x.webm') === 'mem://vod/x.webm');
  ok('getStore() selects a working store even with no blob token', !!getStore() && typeof getStore().put === 'function');

  console.log('\n== a VOD is a kernel object linked to a course + label-gated ==');
  const repo = createKernel();
  const svc = new VodService(repo);
  // seed the broadcast session timeline into the in-memory kernel-independent board channel: buildTimeline
  // is what record() stores; here we exercise record() end-to-end by stubbing eventsSince via a direct call.
  const course = await repo.createObject({ type: 'CourseObject', data: { title: 'Physics' } });
  // record() reads eventsSince from the DB; with the in-memory kernel there are no board events, so the
  // timeline is empty — we still assert the ASSET shape, linkage, and label gating (the timeline path is
  // covered by buildTimeline above).
  const id = await svc.record(broadcastSession('bc1'), { title: 'Lecture 1', linkId: course.id, owner: null, labels: ['enrolled-only'] });
  const graph = await repo.getObjectGraph(course.id);
  ok('Course -references-> the VOD asset', graph.outgoing.filter((e) => e.type === 'references').map((e) => e.toId).includes(id));
  const got = await svc.get(id);
  ok('VOD carries securityLabels (enrolled-only) + title', !!got && got!.labels.includes('enrolled-only') && got!.title === 'Lecture 1');
  ok('the stored asset is a kernel AnimationObject flagged vod', (await repo.getObject(id))!.type === 'AnimationObject' && ((await repo.getObject(id))!.metadata as any).vod === true);
  await svc.setPublished(id, true);
  ok('publish toggles the flag; list(published) surfaces it', (await svc.get(id))!.published === true && (await svc.list(true)).some((v) => v.id === id));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
