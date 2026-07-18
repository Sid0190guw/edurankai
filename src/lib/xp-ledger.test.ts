// src/lib/xp-ledger.test.ts — run: npx tsx src/lib/xp-ledger.test.ts
// Gamification (pure): idempotency key prevents double-award; streak increments consecutively and
// resets on a gap; badges unlock on real criteria; leaderboard ranks by XP + honors opt-out; league
// promotes top / relegates bottom on weekly XP.
import { awardKey, nextStreak, evaluateBadges, rankLeaderboard, leagueResult, DEFAULT_XP, type GamerStats } from './xp-ledger';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== award key -> no double-award ==');
ok('same user+action+object -> identical key (dedupe target)', awardKey('u1', 'lesson_complete', 'ko1') === awardKey('u1', 'lesson_complete', 'ko1'));
ok('different object -> different key', awardKey('u1', 'lesson_complete', 'ko1') !== awardKey('u1', 'lesson_complete', 'ko2'));
ok('lesson XP is a fixed configured value (not inflated)', DEFAULT_XP.lesson_complete === 10 && DEFAULT_XP.assessment_pass === 25);

console.log('\n== streaks ==');
ok('first activity -> streak 1', nextStreak({ streak: 0, lastDay: null }, '2026-07-19').streak === 1);
ok('same day -> unchanged', nextStreak({ streak: 3, lastDay: '2026-07-19' }, '2026-07-19').streak === 3);
ok('consecutive day -> +1', nextStreak({ streak: 3, lastDay: '2026-07-18' }, '2026-07-19').streak === 4);
ok('a gap resets to 1', nextStreak({ streak: 9, lastDay: '2026-07-15' }, '2026-07-19').streak === 1);

console.log('\n== badges from real stats ==');
const s: GamerStats = { lessons: 12, mastered: 10, streak: 8, perfectPass: true, xp: 300 };
const badges = evaluateBadges(s);
ok('unlocks earned badges', badges.includes('ten_lessons') && badges.includes('ten_mastered') && badges.includes('week_streak') && badges.includes('perfect_pass'));
ok('does NOT unlock unearned (xp_500 at 300 XP)', !badges.includes('xp_500'));
ok('no lessons -> no first_steps', !evaluateBadges({ lessons: 0, mastered: 0, streak: 0, perfectPass: false, xp: 0 }).includes('first_steps'));

console.log('\n== leaderboard + league ==');
const entries = [{ userId: 'a', name: 'A', xp: 90 }, { userId: 'b', name: 'B', xp: 120 }, { userId: 'c', name: 'C', xp: 50, optOut: true }, { userId: 'd', name: 'D', xp: 30 }];
const lb = rankLeaderboard(entries);
ok('ranked by real XP', lb[0].userId === 'b' && lb[1].userId === 'a');
ok('opt-out excluded from the board', !lb.some((e) => e.userId === 'c'), lb.map((e) => e.userId));
const lg = leagueResult(entries, 1, 1);
ok('top by weekly XP promoted', lg.promoted[0] === 'b');
ok('bottom relegated', lg.relegated.includes('d'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
