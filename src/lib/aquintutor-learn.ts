// AquinTutor learning core (Phase 0 + Phase 1 of the PM spec):
//   - learner profile (tier + goal), the onboarding gate
//   - Mastery Tree progress: FORWARD-ONLY (never downgrades) per the spec
//   - exit-ticket verification log ("completed but unverified" is impossible
//     to fake) and teach-it-back audio-recall log
// Self-bootstrapping schema (ALTER/CREATE IF NOT EXISTS at runtime), no LLM.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// The eight learner tiers from the PM spec, each with its real JTBD-driven goals.
export const TIERS = [
  { id: 'tots', name: 'Aquin Tots', ages: '3-5', tag: 'Pre-KG · KG', goals: ['Phonics & first sounds', 'Numbers & counting', 'Big feelings & calm'] },
  { id: 'primary', name: 'Aquin Primary', ages: '6-10', tag: 'Grades 1-5', goals: ['Homework, without the battle', 'Stay on the curriculum', 'Reading & maths confidence'] },
  { id: 'subjunior', name: 'Aquin Sub-Juniors', ages: '11-13', tag: 'Grades 6-8', goals: ['Beat homework overload', 'Real understanding, not shortcuts', 'Learn to plan my work'] },
  { id: 'junior', name: 'Aquin Juniors', ages: '14-15', tag: 'Grades 9-10', goals: ['Board exams', 'JEE / NEET foundation', 'Both, merged into one path'] },
  { id: 'scholar', name: 'Aquin Scholars', ages: '15-18', tag: 'Grades 11-12', goals: ['Clear a backlog', 'JEE', 'NEET', 'Boards + a portfolio'] },
  { id: 'tutor', name: 'AquinTutor', ages: '18-22', tag: 'Undergraduate', goals: ['An employable degree', 'Coding mastery', 'Internships & experience'] },
  { id: 'research', name: 'AquinTutor Research', ages: '22+', tag: "Master's · PhD", goals: ['Manage my literature', 'Write my thesis faster', 'Get published'] },
  { id: 'atelier', name: 'AquinTutor Atelier', ages: 'Any age', tag: 'Vocational · Lifelong', goals: ['Switch careers', 'A hands-on trade skill', 'An industry credential'] },
];
export const TIER_IDS = TIERS.map((t) => t.id);

let ready: Promise<void> | null = null;
export function ensureLearnSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_learner_profile (
        user_id UUID PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'primary',
        goal TEXT,
        daily_limit_min INT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mastery (
        user_id UUID NOT NULL,
        skill_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'growing',
        verified BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, skill_id))`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_verify_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL, skill_id TEXT NOT NULL, verified BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_teachback_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL, skill_id TEXT NOT NULL,
        matched INT, total INT, transcript TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export interface LearnerProfile { tier: string; goal: string; dailyLimitMin: number | null; }

export async function getProfile(userId: string): Promise<LearnerProfile | null> {
  try {
    await ensureLearnSchema();
    const r = rows(await db.execute(sql`SELECT tier, goal, daily_limit_min FROM aq_learner_profile WHERE user_id = ${userId} LIMIT 1`))[0];
    if (!r) return null;
    return { tier: r.tier || 'primary', goal: r.goal || '', dailyLimitMin: r.daily_limit_min != null ? Number(r.daily_limit_min) : null };
  } catch { return null; }
}

export async function saveProfile(userId: string, p: { tier: string; goal?: string; dailyLimitMin?: number | null }): Promise<void> {
  await ensureLearnSchema();
  const tier = TIER_IDS.includes(p.tier) ? p.tier : 'primary';
  await db.execute(sql`
    INSERT INTO aq_learner_profile (user_id, tier, goal, daily_limit_min)
    VALUES (${userId}, ${tier}, ${p.goal || null}, ${p.dailyLimitMin ?? null})
    ON CONFLICT (user_id) DO UPDATE SET tier = ${tier}, goal = ${p.goal || null}, daily_limit_min = ${p.dailyLimitMin ?? null}, updated_at = NOW()`);
}

export async function getMastery(userId: string): Promise<Record<string, { state: string; verified: boolean }>> {
  try {
    await ensureLearnSchema();
    const out: Record<string, { state: string; verified: boolean }> = {};
    rows(await db.execute(sql`SELECT skill_id, state, verified FROM aq_mastery WHERE user_id = ${userId}`)).forEach((r: any) => {
      out[r.skill_id] = { state: r.state, verified: !!r.verified };
    });
    return out;
  } catch { return {}; }
}

// FORWARD-ONLY: 'mastered' never drops back to 'growing'; verified never unsets.
const RANK: Record<string, number> = { growing: 1, mastered: 2 };
export async function setMastery(userId: string, skillId: string, state: string, verified: boolean): Promise<void> {
  await ensureLearnSchema();
  const st = RANK[state] ? state : 'growing';
  await db.execute(sql`
    INSERT INTO aq_mastery (user_id, skill_id, state, verified) VALUES (${userId}, ${skillId}, ${st}, ${verified})
    ON CONFLICT (user_id, skill_id) DO UPDATE SET
      state = CASE WHEN ${RANK[st]} > (CASE aq_mastery.state WHEN 'mastered' THEN 2 ELSE 1 END) THEN ${st} ELSE aq_mastery.state END,
      verified = aq_mastery.verified OR ${verified},
      updated_at = NOW()`);
}

export async function logVerify(userId: string, skillId: string, verified: boolean): Promise<void> {
  await ensureLearnSchema();
  await db.execute(sql`INSERT INTO aq_verify_log (user_id, skill_id, verified) VALUES (${userId}, ${skillId}, ${verified})`).catch(() => {});
}
export async function logTeachback(userId: string, skillId: string, matched: number, total: number, transcript: string): Promise<void> {
  await ensureLearnSchema();
  await db.execute(sql`INSERT INTO aq_teachback_log (user_id, skill_id, matched, total, transcript) VALUES (${userId}, ${skillId}, ${matched}, ${total}, ${transcript.slice(0, 2000)})`).catch(() => {});
}
