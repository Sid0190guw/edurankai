// Achievement / badge system. Stateless evaluator: compares user metrics
// (XP, streak, tests passed, courses completed) against a static catalog.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  category: 'streak' | 'xp' | 'tests' | 'courses' | 'practice' | 'social';
  threshold: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  // Streak
  { id: 'streak-3',   name: 'Three in a row',    description: 'Maintain a 3-day streak',  icon: 'flame', tier: 'bronze',   category: 'streak', threshold: 3 },
  { id: 'streak-7',   name: 'A full week',       description: 'Maintain a 7-day streak',  icon: 'flame', tier: 'silver',   category: 'streak', threshold: 7 },
  { id: 'streak-30',  name: 'A month strong',    description: 'Maintain a 30-day streak', icon: 'flame', tier: 'gold',     category: 'streak', threshold: 30 },
  { id: 'streak-100', name: 'A hundred days',    description: 'Maintain a 100-day streak',icon: 'flame', tier: 'platinum', category: 'streak', threshold: 100 },
  // XP
  { id: 'xp-100',     name: 'First hundred',     description: 'Earn 100 XP',              icon: 'zap', tier: 'bronze',   category: 'xp',     threshold: 100 },
  { id: 'xp-1000',    name: 'Centurion',         description: 'Earn 1,000 XP',            icon: 'zap', tier: 'silver',   category: 'xp',     threshold: 1000 },
  { id: 'xp-5000',    name: 'Scholar',           description: 'Earn 5,000 XP',            icon: 'zap', tier: 'gold',     category: 'xp',     threshold: 5000 },
  { id: 'xp-20000',   name: 'Master',            description: 'Earn 20,000 XP',           icon: 'zap', tier: 'platinum', category: 'xp',     threshold: 20000 },
  // Tests
  { id: 'test-1',     name: 'First test',        description: 'Submit your first official test', icon: 'filetext', tier: 'bronze', category: 'tests', threshold: 1 },
  { id: 'test-5',     name: 'Five tests',        description: 'Submit five official tests',      icon: 'filetext', tier: 'silver', category: 'tests', threshold: 5 },
  { id: 'test-passed-3', name: 'Triple pass',    description: 'Pass three tests with ≥60%',      icon: 'target', tier: 'silver', category: 'tests', threshold: 3 },
  { id: 'test-perfect',  name: 'Flawless',       description: 'Score 100% on any test',          icon: 'gem', tier: 'gold',   category: 'tests', threshold: 100 },
  // Practice
  { id: 'practice-10',  name: 'Limber',          description: 'Complete 10 practice rounds',     icon: 'trending', tier: 'bronze', category: 'practice', threshold: 10 },
  { id: 'practice-50',  name: 'Daily learner',   description: 'Complete 50 practice rounds',     icon: 'trending', tier: 'silver', category: 'practice', threshold: 50 },
  // Courses
  { id: 'course-1',  name: 'First completion',   description: 'Complete one course end-to-end',  icon: 'graduation', tier: 'silver', category: 'courses', threshold: 1 },
  { id: 'course-3',  name: 'Three courses',      description: 'Complete three courses',          icon: 'graduation', tier: 'gold',   category: 'courses', threshold: 3 },
  // Daily challenge perfect
  { id: 'daily-1',   name: 'First daily',        description: 'Complete one daily challenge',     icon: 'target', tier: 'bronze', category: 'practice', threshold: 1 },
  { id: 'daily-perfect-5', name: 'Sharp shooter', description: 'Hit 5 perfect daily challenges',  icon: 'target', tier: 'gold',   category: 'practice', threshold: 5 },
];

export interface UserAchievement extends Achievement { earned: boolean; progress: number }

export async function getUserAchievements(userId: string): Promise<UserAchievement[]> {
  if (!userId) return ACHIEVEMENTS.map(a => ({ ...a, earned: false, progress: 0 }));

  // Pull metrics in parallel
  let totalXp = 0, streakDays = 0, longestStreak = 0, testsSubmitted = 0, testsPassed = 0, hasPerfect = 0, practiceCount = 0, coursesDone = 0, dailyDone = 0, dailyPerfect = 0;
  try {
    const x = rows(await db.execute(sql`SELECT total_xp, streak_days, longest_streak FROM user_xp WHERE user_id = ${userId} LIMIT 1`))[0] as any;
    if (x) { totalXp = Number(x.total_xp || 0); streakDays = Number(x.streak_days || 0); longestStreak = Number(x.longest_streak || 0); }
  } catch (_) {}
  try {
    const t = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM test_attempts WHERE candidate_id = ${userId} AND status IN ('submitted','auto_submitted') AND COALESCE(mode,'official') = 'official'`))[0] as any;
    testsSubmitted = Number(t?.n || 0);
    const p = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM test_attempts WHERE candidate_id = ${userId} AND status IN ('submitted','auto_submitted') AND percentage >= 60 AND COALESCE(mode,'official') = 'official'`))[0] as any;
    testsPassed = Number(p?.n || 0);
    const pe = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM test_attempts WHERE candidate_id = ${userId} AND percentage >= 100`))[0] as any;
    hasPerfect = Number(pe?.n || 0) > 0 ? 100 : 0;
  } catch (_) {}
  try {
    const pr = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM practice_sessions WHERE user_id = ${userId} AND questions_attempted > 0`))[0] as any;
    practiceCount = Number(pr?.n || 0);
  } catch (_) {}
  try {
    const c = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM course_certificates WHERE user_id = ${userId}`))[0] as any;
    coursesDone = Number(c?.n || 0);
  } catch (_) {}
  try {
    const d = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM daily_challenge_attempts WHERE user_id = ${userId} AND completed_at IS NOT NULL`))[0] as any;
    dailyDone = Number(d?.n || 0);
    const dp = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM daily_challenge_attempts WHERE user_id = ${userId} AND questions_correct = 7`))[0] as any;
    dailyPerfect = Number(dp?.n || 0);
  } catch (_) {}

  return ACHIEVEMENTS.map(a => {
    let metric = 0;
    switch (a.id) {
      case 'streak-3': case 'streak-7': case 'streak-30': case 'streak-100': metric = Math.max(streakDays, longestStreak); break;
      case 'xp-100': case 'xp-1000': case 'xp-5000': case 'xp-20000': metric = totalXp; break;
      case 'test-1': case 'test-5': metric = testsSubmitted; break;
      case 'test-passed-3': metric = testsPassed; break;
      case 'test-perfect': metric = hasPerfect; break;
      case 'practice-10': case 'practice-50': metric = practiceCount; break;
      case 'course-1': case 'course-3': metric = coursesDone; break;
      case 'daily-1': metric = dailyDone; break;
      case 'daily-perfect-5': metric = dailyPerfect; break;
    }
    return { ...a, earned: metric >= a.threshold, progress: Math.min(1, metric / Math.max(1, a.threshold)) };
  });
}
