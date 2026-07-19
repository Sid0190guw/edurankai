// src/lib/room-transport.test.ts — run: npx tsx src/lib/room-transport.test.ts
// The pluggable room transport (Prompt H2): breakouts scale by MANY SMALL rooms. Assignment (even /
// by-size) + move are pure + tested; the MeshTransport implements the interface against the current
// transport (swap-ready for an SFU). Deterministic breakout sub-room ids let a re-joiner land back.
import { readFileSync } from 'node:fs';
const g: any = globalThis as any; g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-room-transport.js', 'utf8'));
const R = g.window.AquinRoomTransport;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== assignment: split participants into many small rooms ==');
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const even = R.assignParticipants(ids, 3, 'even');
ok('even split of 7 into 3 rooms -> [3,2,2], everyone placed', even.length === 3 && even.map((r: any) => r.length).join(',') === '3,2,2' && even.flat().length === 7, even.map((r: any) => r.length));
const bySize = R.assignParticipants(ids, 2, 'size');
ok('by-size (2 per room) -> 4 rooms, last has the remainder', bySize.length === 4 && bySize[0].length === 2 && bySize[3].length === 1, bySize.map((r: any) => r.length));
ok('no participant is dropped or duplicated', new Set(even.flat()).size === 7 && new Set(bySize.flat()).size === 7);

console.log('\n== move a participant between rooms ==');
const moved = R.moveParticipant(even, 'a', 2);
ok('a is now in room 2 and removed from its old room', R.roomOf(moved, 'a') === 2 && moved[0].indexOf('a') === -1);
ok('everyone still placed after a move', moved.flat().length === 7);

console.log('\n== deterministic breakout sub-room ids (re-join lands back) ==');
ok('breakoutRoomId is deterministic', R.breakoutRoomId('room-x', 1) === 'room-x__bo1' && R.breakoutRoomId('room-x', 1) === R.breakoutRoomId('room-x', 1));
ok('isBreakoutId + baseOf round-trip to the main room', R.isBreakoutId('room-x__bo2') && !R.isBreakoutId('room-x') && R.baseOf('room-x__bo2') === 'room-x');

console.log('\n== MeshTransport implements the interface (swap-ready) ==');
const joined: any[] = [];
const fakeMesh = { join: (o: any) => { joined.push(o.roomId); return { roomId: o.roomId, left: false, leave() { this.left = true; }, broadcast(m: any) { (this as any).last = m; } }; } };
const T = R.createMeshTransport(fakeMesh);
ok('exposes the full interface', ['createRoom', 'joinRoom', 'leaveRoom', 'moveParticipant', 'broadcast'].every((m) => typeof T[m] === 'function') && T.kind === 'mesh');
ok('createRoom builds main + breakout ids', T.createRoom('base') === 'base' && T.createRoom('base', 0) === 'base__bo0');
const h = T.joinRoom('base__bo0', { peerId: 'p1' });
ok('joinRoom joins that small room via the transport', joined[0] === 'base__bo0' && !h.left);
const h2 = T.moveParticipant(h, { peerId: 'p1' }, 'base__bo1');
ok('moveParticipant leaves one room and joins another', h.left === true && joined[1] === 'base__bo1' && !h2.left);
T.broadcast(h2, { type: 'aquin-anim', kind: 'template' });
ok('broadcast goes to that room only (spec, not pixels)', h2.last.type === 'aquin-anim' && !/"video"/.test(JSON.stringify(h2.last)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
