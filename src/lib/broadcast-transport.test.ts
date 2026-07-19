// src/lib/broadcast-transport.test.ts — run: npx tsx src/lib/broadcast-transport.test.ts
// Mass broadcast transport (Prompt H3): one-to-many is a PULL fan-out of the SPEC + slides, not a
// WebRTC room. Payloads are specs/structured slides (never video); a viewer subscribes (does not
// publish); the fan-out rides the board channel keyed by the broadcast id.
import { readFileSync } from 'node:fs';
const g: any = globalThis as any; g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-broadcast-transport.js', 'utf8'));
const B = g.window.AquinBroadcast;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== payloads are SPEC/slide, never baked into video ==');
const specMsg = B.buildSpecMsg('scene', { title: 'Atom', objects: [{ id: 'n', type: 'sphere' }] });
ok('a scene spec rides under params.scene', specMsg.templateId === 'scene' && specMsg.params.scene.objects.length === 1);
ok('no video/frame/stream field', !/"(video|frame|stream|screen|hls|m3u8)"/.test(JSON.stringify(specMsg)));
const slide = B.buildSlide({ title: 'Newton', bullets: ['F = ma', 'inertia', 'x'.repeat(999)] });
ok('a slide is structured text (title + capped bullets)', slide.title === 'Newton' && slide.bullets.length === 3 && slide.bullets[2].length <= 200);

console.log('\n== classify inbound fires for the viewer renderer ==');
ok('scene / ink / slide / template classified', B.classifyFire({ templateId: 'scene' }) === 'scene' && B.classifyFire({ templateId: 'ink' }) === 'ink' && B.classifyFire({ templateId: 'slide' }) === 'slide' && B.classifyFire({ templateId: 'projectile' }) === 'template');
ok('the fan-out rides the board channel keyed by the broadcast id', B.sessionId('abc') === 'bcast-abc');

console.log('\n== the interface publishes over the fan-out (POST fire), not a peer connection ==');
const posted: any[] = [];
const T = B.createFanoutTransport({ fire: (session: string, body: any) => { posted.push({ session, body }); return Promise.resolve(); } });
ok('exposes the broadcast interface', ['publishSpec', 'publishSlide', 'viewerSubscribe'].every((m) => typeof T[m] === 'function') && T.kind === 'fanout');
T.publishSpec('room1', 'scene', { objects: [] });
ok('publishSpec fires a scene on the broadcast session', posted[0].session === 'bcast-room1' && posted[0].body.action === 'fire-scene');
T.publishSlide('room1', { title: 'Intro', bullets: ['a'] });
ok('publishSlide fires a structured slide (not an image)', posted[1].body.action === 'fire-slide' && posted[1].body.slide.title === 'Intro' && !/"(image|png|jpeg|url)"/.test(JSON.stringify(posted[1].body)));

console.log('\n== a viewer SUBSCRIBES (pull) — it is not a WebRTC publish peer ==');
let subUrl = '';
g.EventSource = function (url: string) { subUrl = url; return { addEventListener() {}, close() {}, onerror: null }; } as any;
const sub = T.viewerSubscribe('room1', { onSpec() {}, onSlide() {} });
ok('viewer opens the SSE stream on the broadcast session', /session=bcast-room1/.test(subUrl));
ok('viewer handle is a subscriber, not a peer (isPeer === false)', sub.isPeer === false && typeof sub.close === 'function');
ok('the transport exposes NO video-publish / peer method', !('publishVideo' in T) && !('addTrack' in T) && !('createOffer' in T));

console.log('\n== H3b: viewer interactions are cheap pub/sub (chat/reaction/hand/vote), not video ==');
ok('chat is capped structured text', B.buildChat('Ada', 'x'.repeat(999)).body.length <= 300 && B.buildChat('Ada', 'hi').kind === 'chat');
ok('reaction + hand + vote builders', B.buildReaction('clap').kind === 'reaction' && B.buildHand('Ada').kind === 'hand' && B.buildVote('p1', 2).option === 2);
ok('viewer messages carry no video/stream field', !/"(video|stream|track|camera)"/.test(JSON.stringify([B.buildChat('a', 'b'), B.buildReaction('clap'), B.buildHand('a')])));
ok('classifyViewerMsg tags bcast-msg fires only', B.classifyViewerMsg({ templateId: 'bcast-msg', params: { kind: 'chat' } }) === 'chat' && B.classifyViewerMsg({ templateId: 'scene' }) === null);
const posted2: any[] = [];
g.fetch = ((url: string, opts: any) => { posted2.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); }) as any;
const T2 = B.createFanoutTransport({});
T2.raiseHand('room1', 'Ada');
ok('raiseHand posts to the read-allowed say endpoint', /broadcast\/say/.test(posted2[0].url) && posted2[0].body.msg.kind === 'hand');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
