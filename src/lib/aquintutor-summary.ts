// AquinTutor verified-progress summary — the single aggregate the learner (and,
// later, a parent/teacher) sees. It reads every signal the eight tiers write and
// makes the core principle visible: VERIFIED vs merely done. Every query is
// guarded so a not-yet-created table simply contributes nothing. Reusable for a
// guardian view by passing any learner's userId.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { getProfile, TIERS } from '@/lib/aquintutor-learn';
import { THESIS_STEPS } from '@/lib/aquintutor-research';
import { TRACK_BY_ID } from '@/lib/aquintutor-atelier';

const asRows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function safeRows(q: any): Promise<any[]> { try { return asRows(await db.execute(q)); } catch { return []; } }

// Friendly label for a skill_id, by prefix (homework-add -> "Homework Helper").
export function skillLabel(id: string): string {
  if (!id) return 'Skill';
  if (id.startsWith('homework-')) return 'Homework Helper';
  if (id.startsWith('kg-mech-')) return 'Knowledge graph · Mechanics';
  if (id.startsWith('kg-')) return 'Knowledge graph';
  if (id.startsWith('backlog-')) return 'Backlog Recovery';
  if (id.startsWith('tots-')) return 'Little Ones';
  return id.replace(/[-_]/g, ' ');
}

export interface VerifiedSummary {
  profile: { tier: string; tierName: string; goal: string } | null;
  mastery: { total: number; verified: number; masteredUnverified: number; growing: number };
  verifyLog: { skillId: string; label: string; verified: boolean; at: string }[];
  teachback: { count: number; recent: { skillId: string; label: string; matched: number; total: number; at: string }[] };
  recall: { total: number; due: number; mature: number };
  research: { refs: number; byStatus: Record<string, number>; thesisDone: number; thesisTotal: number };
  credential: { tracks: { id: string; name: string; done: number; total: number }[] };
  hasAnything: boolean;
}

export async function getVerifiedSummary(userId: string): Promise<VerifiedSummary> {
  const profileRaw = await getProfile(userId).catch(() => null);
  const tierMeta = profileRaw ? TIERS.find((t) => t.id === profileRaw.tier) : null;

  const m = (await safeRows(sql`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE verified)::int AS verified,
      COUNT(*) FILTER (WHERE state = 'mastered' AND NOT verified)::int AS mastered_unverified,
      COUNT(*) FILTER (WHERE state = 'growing')::int AS growing
    FROM aq_mastery WHERE user_id = ${userId}`))[0] || {};

  const verifyLog = (await safeRows(sql`SELECT skill_id, verified, created_at FROM aq_verify_log WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 12`))
    .map((r: any) => ({ skillId: r.skill_id, label: skillLabel(r.skill_id), verified: !!r.verified, at: r.created_at }));

  const tbCount = Number(((await safeRows(sql`SELECT COUNT(*)::int AS n FROM aq_teachback_log WHERE user_id = ${userId}`))[0] || {}).n || 0);
  const tbRecent = (await safeRows(sql`SELECT skill_id, matched, total, created_at FROM aq_teachback_log WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 6`))
    .map((r: any) => ({ skillId: r.skill_id, label: skillLabel(r.skill_id), matched: Number(r.matched || 0), total: Number(r.total || 0), at: r.created_at }));

  const srs = (await safeRows(sql`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE due_at <= NOW())::int AS due,
      COUNT(*) FILTER (WHERE interval_days >= 21)::int AS mature
    FROM aq_srs_card WHERE user_id = ${userId}`))[0] || {};

  const byStatus: Record<string, number> = {};
  let refs = 0;
  (await safeRows(sql`SELECT status, COUNT(*)::int AS n FROM aq_ref WHERE user_id = ${userId} GROUP BY status`)).forEach((r: any) => { byStatus[r.status] = Number(r.n || 0); refs += Number(r.n || 0); });
  const thesisDone = Number(((await safeRows(sql`SELECT COUNT(*) FILTER (WHERE done)::int AS done FROM aq_thesis_step WHERE user_id = ${userId}`))[0] || {}).done || 0);

  const tracks = (await safeRows(sql`SELECT track, COUNT(*) FILTER (WHERE demonstrated)::int AS done FROM aq_atelier_evidence WHERE user_id = ${userId} GROUP BY track`))
    .map((r: any) => { const t = TRACK_BY_ID[r.track]; return { id: r.track, name: t?.name || r.track, done: Number(r.done || 0), total: t ? t.competencies.length : 0 }; })
    .filter((t) => t.done > 0);

  const mastery = { total: Number(m.total || 0), verified: Number(m.verified || 0), masteredUnverified: Number(m.mastered_unverified || 0), growing: Number(m.growing || 0) };
  const recall = { total: Number(srs.total || 0), due: Number(srs.due || 0), mature: Number(srs.mature || 0) };
  const hasAnything = !!profileRaw || mastery.total > 0 || verifyLog.length > 0 || tbCount > 0 || recall.total > 0 || refs > 0 || thesisDone > 0 || tracks.length > 0;

  return {
    profile: profileRaw ? { tier: profileRaw.tier, tierName: tierMeta?.name || profileRaw.tier, goal: profileRaw.goal } : null,
    mastery,
    verifyLog,
    teachback: { count: tbCount, recent: tbRecent },
    recall,
    research: { refs, byStatus, thesisDone, thesisTotal: THESIS_STEPS.length },
    credential: { tracks },
    hasAnything,
  };
}
