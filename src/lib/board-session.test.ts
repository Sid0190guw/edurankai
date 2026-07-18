// src/lib/board-session.test.ts — run: npx tsx src/lib/board-session.test.ts
// Live-board broadcast (Prompt A1b), PURE helpers (no DB): the adaptive tier for a joining student
// is decided by the REAL Prompt-5 engine (weak device/network -> lite/static, strong -> rich/animated
// with physics); a DB row normalizes to a compact broadcast (spec, not pixels); heartbeat decides
// who is still online.
import { resolveBroadcastTier, toBroadcast, participantView } from './board-session';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== adaptive tier reuses the real Prompt-5 policy ==');
const weak = resolveBroadcastTier({ deviceMemory: 1, effectiveType: '2g', saveData: true });
ok('a weak/save-data device gets lite + a STATIC keyframe (no animation)', weak.tier === 'lite' && weak.animate === false, weak.tier);
const strong = resolveBroadcastTier({ deviceMemory: 8, effectiveType: '4g' });
ok('a strong device gets rich + animation + physics', strong.tier === 'rich' && strong.animate === true && strong.directive.physics === true, strong.tier);
ok('reduce-motion downshifts rich away from full animation', resolveBroadcastTier({ deviceMemory: 8, effectiveType: '4g' }, true).tier !== 'rich');

console.log('\n== a DB row becomes a compact broadcast (spec, not pixels) ==');
const b = toBroadcast({ seq: '7', session_id: 'board-x', template_id: 'projectile', params: { angle: 45 }, play_state: 'playing', timeline_pos: 0.5, actor: 'u1', created_at: new Date('2026-07-19T00:00:00Z') });
ok('carries seq + template + params + playState + timelinePos', b.seq === 7 && b.templateId === 'projectile' && b.params.angle === 45 && b.playState === 'playing' && b.timelinePos === 0.5);
ok('the broadcast has no frame/image/video field, and is small', !('frame' in b) && !('image' in b) && !('video' in b) && JSON.stringify(b).length < 300);
ok('params survive whether stored as jsonb object or text', toBroadcast({ seq: 1, session_id: 's', template_id: 'sine', params: '{"amplitude":3}', timeline_pos: 0 }).params.amplitude === 3);

console.log('\n== heartbeat -> online roster (for the session inspector) ==');
const now = Date.parse('2026-07-19T00:00:30Z');
const view = participantView([
  { user_id: 'a', tier: 'rich', last_seen: new Date('2026-07-19T00:00:20Z') },   // 10s ago
  { user_id: 'b', tier: 'lite', last_seen: new Date('2026-07-19T00:00:00Z') },   // 30s ago -> stale
], now, 30000);
ok('recent heartbeat is online, stale one is offline', view[0].online === true && view[1].online === false, view.map((v) => v.online));
ok('each participant carries the tier they were served', view[0].tier === 'rich' && view[1].tier === 'lite');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
