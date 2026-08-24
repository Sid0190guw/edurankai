// src/lib/career-intel/store.ts — THE ONLY PLACE CAREER INTELLIGENCE TOUCHES THE DATABASE.
//
// =================================================================================================
// WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
// =================================================================================================
//
// AN ANONYMOUS VISITOR'S PERSONALISATION IS NOT STORED HERE. It lives in their own browser and is
// posted to the ranking endpoint with each request. That is not a shortcut — it is the design:
//
//   - It is the strongest honest privacy claim available. "We do not keep this unless you ask us
//     to" is a sentence the careers page can print because this module makes it true.
//   - It scales to any amount of public traffic without a row per visitor. A public marketing page
//     that writes to Postgres on every interaction is a page that takes the database down on the
//     day it succeeds.
//   - It makes /careers edge-cacheable, because the page is identical for everybody and the
//     personalisation happens after it loads.
//
// So there are exactly two things in here: a profile a SIGNED-IN person explicitly asked us to
// keep, and explicit feedback about a recommendation.
//
// =================================================================================================
// EVERY READ AND WRITE TOLERATES THE TABLES BEING ABSENT — AND SAYS SO
// =================================================================================================
//
// db/career-intel-schema.sql is run by hand. Until it has been, these functions must not throw and
// must not lie. `loadProfile` returns `{ profile: null, readable: false }` — readable:false meaning
// "we could not look", which is a different thing from "there is nothing saved" and is rendered
// differently. `saveProfile` returns false rather than reporting a save that did not happen. That
// distinction is the one this project keeps relearning: a swallowed read rendered as a confident
// empty state is the dominant defect class here.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import { MODEL_VERSION, PROFILE_VERSION, type CareerProfile } from './dimensions';
import { parseProfile } from './profile';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => e?.cause?.message || e?.message || String(e);

/**
 * Development-only convenience. In production this returns immediately without running anything —
 * ddlPermitted() is false there by design — which is exactly why db/career-intel-schema.sql exists
 * and why both tables are registered in BOOTSTRAP_MODULES so /api/health reports their absence.
 */
export function ensureCareerIntelSchema(): Promise<void> {
  return ensureBatch('career-intel', `
    CREATE TABLE IF NOT EXISTS career_profiles (
      user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      profile         JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_version   TEXT NOT NULL DEFAULT '',
      profile_version INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS career_feedback_events (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      role_id      UUID REFERENCES roles(id) ON DELETE CASCADE,
      event        TEXT NOT NULL,
      tier         TEXT,
      reason       TEXT,
      session_key  TEXT
    );
    CREATE INDEX IF NOT EXISTS career_feedback_role_idx  ON career_feedback_events (role_id);
    CREATE INDEX IF NOT EXISTS career_feedback_at_idx    ON career_feedback_events (at DESC);
    CREATE INDEX IF NOT EXISTS career_feedback_event_idx ON career_feedback_events (event);
  `);
}

/* ------------------------------------------------------------------------------- the profile */

export interface LoadedProfile {
  profile: CareerProfile | null;
  /** False means the read FAILED. It does not mean nothing is saved. The surfaces render these differently. */
  readable: boolean;
  updatedAt: string | null;
  /** The interpreter that produced what is stored. A mismatch means a re-read would improve it. */
  modelVersion: string | null;
}

export async function loadProfile(userId: string): Promise<LoadedProfile> {
  const empty: LoadedProfile = { profile: null, readable: true, updatedAt: null, modelVersion: null };
  if (!userId) return empty;
  try {
    await ensureCareerIntelSchema();
    const r = await db.execute(sql`
      SELECT profile, model_version, profile_version, updated_at
        FROM career_profiles WHERE user_id = ${userId} LIMIT 1`);
    const row = rowsOf(r)[0];
    if (!row) return empty;
    return {
      // parseProfile, not a cast. A stored document is untrusted input like any other: it may have
      // been written by an older shape of this code, and it becomes a database query downstream.
      profile: parseProfile(row.profile),
      readable: true,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      modelVersion: row.model_version ? String(row.model_version) : null,
    };
  } catch (e: any) {
    console.error('[career-intel/store] loadProfile failed:', reasonOf(e));
    return { profile: null, readable: false, updatedAt: null, modelVersion: null };
  }
}

/**
 * Keep this person's personalisation.
 *
 * RETURNS FALSE ON FAILURE, never throws and never pretends. The caller renders "we could not save
 * that" rather than a tick. Saving somebody's career profile and telling them it worked when it did
 * not is the kind of quiet failure that only surfaces when they come back and it is gone.
 */
export async function saveProfile(userId: string, profile: CareerProfile): Promise<boolean> {
  if (!userId) return false;
  try {
    await ensureCareerIntelSchema();
    await db.execute(sql`
      INSERT INTO career_profiles (user_id, profile, model_version, profile_version, updated_at)
      VALUES (${userId}, ${JSON.stringify(profile)}::jsonb, ${MODEL_VERSION}, ${PROFILE_VERSION}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        profile = EXCLUDED.profile,
        model_version = EXCLUDED.model_version,
        profile_version = EXCLUDED.profile_version,
        updated_at = NOW()`);
    return true;
  } catch (e: any) {
    console.error('[career-intel/store] saveProfile failed:', reasonOf(e));
    return false;
  }
}

/**
 * Forget everything. Section 22's "clear reset/delete personalisation flow", and it is a real
 * DELETE of the row rather than a flag — a profile marked deleted is a profile still there.
 */
export async function deleteProfile(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    await ensureCareerIntelSchema();
    await db.execute(sql`DELETE FROM career_profiles WHERE user_id = ${userId}`);
    return true;
  } catch (e: any) {
    console.error('[career-intel/store] deleteProfile failed:', reasonOf(e));
    return false;
  }
}

/* ------------------------------------------------------------------------------ the feedback */

/** Explicit acts only. There is no passive "viewed" event — see the note in the .sql file. */
export const FEEDBACK_EVENTS = ['saved', 'dismissed', 'not_interested', 'opened', 'helpful', 'not_helpful'] as const;
export type FeedbackEvent = typeof FEEDBACK_EVENTS[number];

/**
 * A FIXED vocabulary, not free text.
 *
 * The moment a dismissal has a text box on it, an analytics table becomes a place people type
 * things about themselves. These six cover what is actually actionable for ranking, and anything
 * else is better said to a person at /careers/hr-support than logged.
 */
export const FEEDBACK_REASONS = [
  'not_my_field', 'wrong_level', 'not_what_i_meant', 'already_applied', 'location', 'other',
] as const;
export type FeedbackReason = typeof FEEDBACK_REASONS[number];

export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  not_my_field: 'Not my field',
  wrong_level: 'Wrong level for me',
  not_what_i_meant: 'Not what I meant',
  already_applied: 'Already applied',
  location: 'Location does not work for me',
  other: 'Something else',
};

export interface FeedbackInput {
  roleId: string;
  event: FeedbackEvent;
  tier?: string | null;
  reason?: FeedbackReason | null;
  sessionKey?: string | null;
}

/**
 * Record one explicit reaction.
 *
 * BEST EFFORT, AND SILENT ON FAILURE BY DESIGN — this one genuinely is a case where a swallow is
 * right, because the person's action (dismissing a card) has already happened in their browser and
 * failing to log it must not undo it or interrupt them. It is still logged to the server console,
 * and the admin surface reports the table's absence rather than showing an empty chart.
 */
export async function recordFeedback(input: FeedbackInput): Promise<boolean> {
  const event = String(input.event || '') as FeedbackEvent;
  if (!input.roleId || !FEEDBACK_EVENTS.includes(event)) return false;
  const reason = input.reason && FEEDBACK_REASONS.includes(input.reason) ? input.reason : null;
  const tier = input.tier ? String(input.tier).slice(0, 20) : null;
  const key = input.sessionKey ? String(input.sessionKey).slice(0, 64) : null;
  try {
    await ensureCareerIntelSchema();
    await db.execute(sql`
      INSERT INTO career_feedback_events (role_id, event, tier, reason, session_key)
      VALUES (${input.roleId}::uuid, ${event}, ${tier}, ${reason}, ${key})`);
    return true;
  } catch (e: any) {
    console.error('[career-intel/store] recordFeedback failed:', reasonOf(e));
    return false;
  }
}

/* ----------------------------------------------------------------------------- the governance */

export interface FeedbackSummary {
  /** False means the read failed — the admin surface says "could not read", never "no feedback". */
  readable: boolean;
  windowDays: number;
  totals: { event: string; n: number }[];
  /** Where dismissals are coming from. A dismissal out of the top tier is the interesting one. */
  byTier: { tier: string; event: string; n: number }[];
  reasons: { reason: string; n: number }[];
  /** Postings dismissed most often out of a personalised list. A ranking problem, not a role problem. */
  dismissed: { roleId: string; title: string; n: number }[];
}

/**
 * What the recommendations are doing, for the governance surface.
 *
 * ONE ROUND TRIP FOR THREE AGGREGATES via GROUPING SETS rather than three separate queries; the
 * fourth needs the join to roles and is its own statement. This project's own note is that the
 * round-trip count is the lever, and an admin page is not exempt from it.
 */
export async function feedbackSummary(windowDays = 30): Promise<FeedbackSummary> {
  const days = Math.max(1, Math.min(365, Math.floor(windowDays)));
  const empty: FeedbackSummary = { readable: false, windowDays: days, totals: [], byTier: [], reasons: [], dismissed: [] };
  try {
    await ensureCareerIntelSchema();
    const since = sql`NOW() - (${days}::text || ' days')::interval`;

    const agg = await db.execute(sql`
      SELECT event, tier, reason, COUNT(*)::int AS n
        FROM career_feedback_events
       WHERE at >= ${since}
       GROUP BY GROUPING SETS ((event), (event, tier), (reason))`);
    const rows = rowsOf(agg);

    const totals = rows
      .filter((r) => r.event && !r.tier && !r.reason)
      .map((r) => ({ event: String(r.event), n: Number(r.n) || 0 }))
      .sort((a, b) => b.n - a.n);
    const byTier = rows
      .filter((r) => r.event && r.tier)
      .map((r) => ({ tier: String(r.tier), event: String(r.event), n: Number(r.n) || 0 }))
      .sort((a, b) => b.n - a.n);
    const reasons = rows
      .filter((r) => r.reason && !r.event)
      .map((r) => ({ reason: String(r.reason), n: Number(r.n) || 0 }))
      .sort((a, b) => b.n - a.n);

    const dis = await db.execute(sql`
      SELECT f.role_id, r.title, COUNT(*)::int AS n
        FROM career_feedback_events f
        JOIN roles r ON r.id = f.role_id
       WHERE f.at >= ${since} AND f.event IN ('dismissed', 'not_interested')
       GROUP BY f.role_id, r.title
       ORDER BY COUNT(*) DESC
       LIMIT 12`);
    const dismissed = rowsOf(dis).map((r) => ({ roleId: String(r.role_id), title: String(r.title), n: Number(r.n) || 0 }));

    return { readable: true, windowDays: days, totals, byTier, reasons, dismissed };
  } catch (e: any) {
    console.error('[career-intel/store] feedbackSummary failed:', reasonOf(e));
    return empty;
  }
}

/** How many people have chosen to keep a profile. Null when the table cannot be read. */
export async function savedProfileCount(): Promise<number | null> {
  try {
    await ensureCareerIntelSchema();
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM career_profiles`);
    return Number(rowsOf(r)[0]?.n ?? 0);
  } catch (e: any) {
    console.error('[career-intel/store] savedProfileCount failed:', reasonOf(e));
    return null;
  }
}
