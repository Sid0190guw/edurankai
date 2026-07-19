// src/lib/huddle-anim.test.ts — run: npx tsx src/lib/huddle-anim.test.ts
// Animation board inside the huddle (Prompt H1): the broadcast is a SPEC (not pixels), every peer
// renders locally at their Prompt-5 tier, a non-presenter cannot fire, and a late-joiner requests
// the current board state which the presenter replies with.
import { readFileSync } from 'node:fs';
const g: any = globalThis as any; g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-huddle-anim.js', 'utf8'));
const H = g.window.AquinHuddleAnim;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== broadcast payload is a SPEC, not video ==');
const msg = H.buildAnimMsg('scene', { title: 'Atom', objects: [{ id: 'n', type: 'sphere' }] });
ok('an animation message carries kind + spec payload', msg.type === 'aquin-anim' && msg.kind === 'scene' && msg.payload.objects.length === 1);
ok('no video/stream/pixel field (not a screen-share)', !/"(video|stream|screen|pixels|dataUrl|track|mediaStream)"/.test(JSON.stringify(msg)));

console.log('\n== per-participant Prompt-5 tier ==');
ok('save-data / 2g -> lite', H.pickTier({ saveData: true }) === 'lite' && H.pickTier({ effectiveType: '2g' }) === 'lite');
ok('strong device + 4g -> rich', H.pickTier({ deviceMemory: 8, effectiveType: '4g' }) === 'rich');
ok('default -> standard', H.pickTier({ deviceMemory: 4, effectiveType: '3g' }) === 'standard');

console.log('\n== presenter fires -> all peers render locally from the spec ==');
const sent: any[] = []; const rendered: any[] = [];
const host = H.create({ canDrive: true, tier: 'rich', send: (m: any) => sent.push(m), render: (k: any, p: any, t: any) => rendered.push({ k, t }) });
ok('presenter fire broadcasts the spec + renders locally', host.fire('template', { templateId: 'projectile', params: {} }) === true && sent.length === 1 && rendered.length === 1 && rendered[0].t === 'rich');

const viewerSent: any[] = []; const viewerRendered: any[] = [];
const viewer = H.create({ canDrive: false, tier: 'lite', send: (m: any) => viewerSent.push(m), render: (k: any, p: any, t: any) => viewerRendered.push({ k, t }) });
ok('a non-presenter CANNOT fire (role-gated)', viewer.fire('scene', {}) === false && viewerSent.length === 0);
viewer.onMessage(sent[0]);
ok('a viewer renders the broadcast spec at ITS OWN tier (lite)', viewerRendered.length === 1 && viewerRendered[0].t === 'lite');

console.log('\n== late-joiner gets the current board state ==');
viewer.requestState();
ok('late-joiner broadcasts a state request', viewerSent.some((m) => m.type === 'aquin-anim-req'));
host.onMessage({ type: 'aquin-anim-req' });
ok('presenter replies with the current animation', sent.length === 2 && sent[1].type === 'aquin-anim' && sent[1].kind === 'template');
const freshViewer = H.create({ canDrive: false, tier: 'standard', send: () => {}, render: () => {} });
ok('a viewer with no state does NOT answer a request', freshViewer.onMessage({ type: 'aquin-anim-req' }) === true && freshViewer.getState() === null);

console.log('\n== H1b seam: presenter hand-off flips drive rights ==');
viewer.setCanDrive(true);
ok('granting presenter lets a former viewer fire', viewer.fire('template', { templateId: 'sine', params: {} }) === true);

console.log('\n== H1b: room-role drive gate (host OR granted presenter) ==');
ok('host can drive', H.canDriveInRoom({ isHost: true, userId: 'u1', presenters: [] }) === true);
ok('granted presenter can drive', H.canDriveInRoom({ isHost: false, userId: 'u2', presenters: ['u2'] }) === true);
ok('a plain participant cannot drive', H.canDriveInRoom({ isHost: false, userId: 'u3', presenters: ['u2'] }) === false);

console.log('\n== H1b class mode: a big room renders only a few cameras ==');
const room = [{ id: 'host', isHost: true }, { id: 'me', isLocal: true }, { id: 'spk', role: 'attendee' }, { id: 'pres', role: 'attendee' }];
for (let i = 0; i < 30; i++) room.push({ id: 's' + i, role: 'attendee' } as any);
const vis = H.classModeVisible(room, { classMode: true, activeSpeaker: 'spk', presenters: ['pres'], maxStudents: 0 });
ok('class mode keeps host + self + active speaker + presenter only', vis.length === 4 && vis.some((p: any) => p.id === 'host') && vis.some((p: any) => p.id === 'spk') && vis.some((p: any) => p.id === 'pres'), vis.length);
ok('a 34-person room does NOT render all 34 cameras', vis.length < room.length);
ok('class mode OFF renders everyone', H.classModeVisible(room, { classMode: false }).length === room.length);
ok('maxStudents cap admits a bounded number of extra student cams', H.classModeVisible(room, { classMode: true, activeSpeaker: 'spk', presenters: ['pres'], maxStudents: 3 }).length === 7);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
