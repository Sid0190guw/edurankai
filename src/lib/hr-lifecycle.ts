// HR Employee Lifecycle — probation, KRA goals, PIP. Implements the gaps
// flagged in the v1.0 HR Employee Lifecycle Manual (June 2026) that cause
// the "can't remove an underperformer" problem when missing:
//   1. Written probation period with explicit confirmation requirement
//   2. KRAs / 30-60-90 plan acknowledged at onboarding
//   3. Documented Performance Improvement Plan with weekly check-ins
//
// All tables are self-bootstrapping; no separate migration required.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureLifecycleSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // -------- Probation tracking --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_probation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        scheduled_end_date DATE NOT NULL,
        duration_months INT NOT NULL DEFAULT 6,
        notice_days_during_probation INT NOT NULL DEFAULT 30,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
          -- active | confirmed | extended | terminated | resigned
        confirmation_letter_issued_at TIMESTAMPTZ,
        confirmation_letter_url TEXT,
        confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        extension_count INT NOT NULL DEFAULT 0,
        extended_to_date DATE,
        extension_reason TEXT,
        termination_reason TEXT,
        terminated_at TIMESTAMPTZ,
        clauses_acknowledged BOOLEAN NOT NULL DEFAULT false,
        clauses_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_probation_emp_idx ON hr_probation(employee_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_probation_status_idx ON hr_probation(status, scheduled_end_date)`);

      // -------- Probation reviews (30 / 60 / 90 day) --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_probation_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        probation_id UUID NOT NULL REFERENCES hr_probation(id) ON DELETE CASCADE,
        review_day INT NOT NULL,
          -- 30 | 60 | 90 (or custom milestone day)
        scheduled_at DATE NOT NULL,
        conducted_at TIMESTAMPTZ,
        rating VARCHAR(20),
          -- on_track | needs_improvement | at_risk | exceeds
        summary TEXT,
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_prob_reviews_idx ON hr_probation_reviews(probation_id, review_day)`);

      // -------- KRA / 30-60-90 plan --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_employee_goals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL DEFAULT 'kra',
          -- kra | 30_day | 60_day | 90_day | quarterly
        title VARCHAR(300) NOT NULL,
        description TEXT,
        success_metric TEXT,
        target_date DATE,
        weight_pct INT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
          -- open | met | partial | missed | dropped
        outcome_notes TEXT,
        set_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_goals_emp_idx ON hr_employee_goals(employee_id, kind, status)`);

      // -------- Performance Improvement Plan (PIP) --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_pips (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        opened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        opened_at DATE NOT NULL DEFAULT CURRENT_DATE,
        scheduled_end_date DATE NOT NULL,
        duration_weeks INT NOT NULL DEFAULT 2,
          -- Manual recommends 2 weeks with weekly check-ins
        reason TEXT NOT NULL,
          -- specific underperformance documented in writing
        expectations TEXT NOT NULL,
          -- specific measurable improvements required
        consequences TEXT,
          -- what happens if not met
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        outcome VARCHAR(20),
          -- met | not_met | extended | early_resolution
        outcome_notes TEXT,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_pip_emp_idx ON hr_pips(employee_id, opened_at DESC)`);

      // -------- PIP weekly check-ins --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_pip_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pip_id UUID NOT NULL REFERENCES hr_pips(id) ON DELETE CASCADE,
        week_number INT NOT NULL,
        check_date DATE NOT NULL,
        progress_summary TEXT NOT NULL,
        progress_rating VARCHAR(20),
          -- on_track | partial | not_met
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_pip_chk_idx ON hr_pip_checkins(pip_id, week_number)`);
    } catch (_) {}
  })();
  return ready;
}

// ============================== PROBATION ==============================

export async function openProbation(opts: {
  employeeId: string;
  startDate: string;
  durationMonths?: number;
  noticeDaysDuringProbation?: number;
}) {
  await ensureLifecycleSchema();
  const months = Math.max(1, Math.min(12, opts.durationMonths || 6));
  const start = new Date(opts.startDate);
  const scheduledEnd = new Date(start.getTime());
  scheduledEnd.setMonth(scheduledEnd.getMonth() + months);
  const endStr = scheduledEnd.toISOString().slice(0, 10);
  const r = rows(await db.execute(sql`
    INSERT INTO hr_probation (employee_id, start_date, scheduled_end_date, duration_months, notice_days_during_probation)
    VALUES (${opts.employeeId}, ${opts.startDate}, ${endStr}, ${months}, ${opts.noticeDaysDuringProbation || 30})
    RETURNING id, scheduled_end_date
  `));
  const probationId = r[0]?.id;

  // Auto-schedule 30 / 60 / 90 day reviews (capped at probation end).
  for (const day of [30, 60, 90]) {
    const reviewDate = new Date(start.getTime());
    reviewDate.setDate(reviewDate.getDate() + day);
    if (reviewDate > scheduledEnd) continue;
    await db.execute(sql`
      INSERT INTO hr_probation_reviews (probation_id, review_day, scheduled_at)
      VALUES (${probationId}, ${day}, ${reviewDate.toISOString().slice(0, 10)})
    `);
  }
  return { ok: true, probationId, scheduledEnd: endStr };
}

export async function getActiveProbation(employeeId: string) {
  await ensureLifecycleSchema();
  const r = rows(await db.execute(sql`
    SELECT * FROM hr_probation WHERE employee_id = ${employeeId} AND status IN ('active', 'extended')
    ORDER BY created_at DESC LIMIT 1
  `));
  return r[0] || null;
}

export async function listProbationReviews(probationId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`
    SELECT * FROM hr_probation_reviews WHERE probation_id = ${probationId}
    ORDER BY review_day ASC
  `));
}

export async function recordReview(opts: {
  reviewId: string;
  rating: 'on_track' | 'needs_improvement' | 'at_risk' | 'exceeds';
  summary: string;
  managerUserId?: string;
}) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation_reviews
    SET conducted_at = NOW(), rating = ${opts.rating}, summary = ${opts.summary}, manager_user_id = ${opts.managerUserId || null}
    WHERE id = ${opts.reviewId}
  `);
}

export async function confirmEmployee(opts: { probationId: string; confirmedByUserId: string; letterUrl?: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation SET status = 'confirmed', confirmation_letter_issued_at = NOW(),
      confirmation_letter_url = ${opts.letterUrl || null}, confirmed_by_user_id = ${opts.confirmedByUserId},
      updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
  // Update employee record's confirmation status if column present.
  try {
    await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS confirmation_date DATE`);
    await db.execute(sql`UPDATE hr_employees SET confirmation_date = CURRENT_DATE WHERE id IN (SELECT employee_id FROM hr_probation WHERE id = ${opts.probationId})`);
  } catch (_) {}
}

export async function extendProbation(opts: { probationId: string; months: number; reason: string }) {
  await ensureLifecycleSchema();
  const months = Math.max(1, Math.min(6, opts.months));
  const cur = rows(await db.execute(sql`SELECT scheduled_end_date, extension_count FROM hr_probation WHERE id = ${opts.probationId}`))[0] as any;
  if (!cur) return { ok: false, error: 'not found' };
  const newEnd = new Date(cur.scheduled_end_date);
  newEnd.setMonth(newEnd.getMonth() + months);
  await db.execute(sql`
    UPDATE hr_probation
    SET status = 'extended', extended_to_date = ${newEnd.toISOString().slice(0, 10)},
      extension_count = extension_count + 1, extension_reason = ${opts.reason}, updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
  return { ok: true, newEnd: newEnd.toISOString().slice(0, 10) };
}

export async function terminateOnProbation(opts: { probationId: string; reason: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation SET status = 'terminated', termination_reason = ${opts.reason},
      terminated_at = NOW(), updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
}

// ============================== KRA / GOALS ==============================

export async function setGoal(opts: {
  employeeId: string;
  kind: 'kra' | '30_day' | '60_day' | '90_day' | 'quarterly';
  title: string;
  description?: string;
  successMetric?: string;
  targetDate?: string;
  weightPct?: number;
  setByUserId?: string;
}) {
  await ensureLifecycleSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hr_employee_goals (employee_id, kind, title, description, success_metric, target_date, weight_pct, set_by_user_id)
    VALUES (${opts.employeeId}, ${opts.kind}, ${opts.title}, ${opts.description || null}, ${opts.successMetric || null},
      ${opts.targetDate || null}, ${opts.weightPct || null}, ${opts.setByUserId || null})
    RETURNING id
  `));
  return { ok: true, goalId: r[0]?.id };
}

export async function listGoals(employeeId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`
    SELECT * FROM hr_employee_goals WHERE employee_id = ${employeeId}
    ORDER BY CASE kind WHEN 'kra' THEN 1 WHEN '30_day' THEN 2 WHEN '60_day' THEN 3 WHEN '90_day' THEN 4 ELSE 5 END, created_at DESC
  `));
}

export async function closeGoal(goalId: string, status: 'met' | 'partial' | 'missed' | 'dropped', notes?: string) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_employee_goals SET status = ${status}, outcome_notes = ${notes || null}, updated_at = NOW()
    WHERE id = ${goalId}
  `);
}

// ============================== PIP ==============================

export async function openPip(opts: {
  employeeId: string;
  managerUserId?: string;
  openedByUserId: string;
  durationWeeks?: number;
  reason: string;
  expectations: string;
  consequences?: string;
}) {
  await ensureLifecycleSchema();
  const weeks = Math.max(1, Math.min(12, opts.durationWeeks || 2));
  const end = new Date(); end.setDate(end.getDate() + weeks * 7);
  const r = rows(await db.execute(sql`
    INSERT INTO hr_pips (employee_id, manager_user_id, opened_by_user_id, duration_weeks, scheduled_end_date,
      reason, expectations, consequences)
    VALUES (${opts.employeeId}, ${opts.managerUserId || null}, ${opts.openedByUserId}, ${weeks},
      ${end.toISOString().slice(0, 10)}, ${opts.reason}, ${opts.expectations}, ${opts.consequences || null})
    RETURNING id, scheduled_end_date
  `));
  return { ok: true, pipId: r[0]?.id, scheduledEnd: r[0]?.scheduled_end_date };
}

export async function listPips(employeeId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_pips WHERE employee_id = ${employeeId} ORDER BY opened_at DESC`));
}

export async function logPipCheckin(opts: {
  pipId: string;
  weekNumber: number;
  progressSummary: string;
  progressRating: 'on_track' | 'partial' | 'not_met';
  managerUserId?: string;
}) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    INSERT INTO hr_pip_checkins (pip_id, week_number, check_date, progress_summary, progress_rating, manager_user_id)
    VALUES (${opts.pipId}, ${opts.weekNumber}, CURRENT_DATE, ${opts.progressSummary}, ${opts.progressRating}, ${opts.managerUserId || null})
  `);
}

export async function listPipCheckins(pipId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_pip_checkins WHERE pip_id = ${pipId} ORDER BY week_number ASC`));
}

export async function closePip(opts: { pipId: string; outcome: 'met' | 'not_met' | 'extended' | 'early_resolution'; outcomeNotes: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_pips SET outcome = ${opts.outcome}, outcome_notes = ${opts.outcomeNotes},
      closed_at = NOW(), updated_at = NOW()
    WHERE id = ${opts.pipId}
  `);
}
