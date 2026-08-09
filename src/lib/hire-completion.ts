// src/lib/hire-completion.ts — THE MOMENT OF SIGNATURE, AS ONE HANDOFF THAT LEAVES A TRACE.
//
// -------------------------------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// -------------------------------------------------------------------------------------------------
// A person signed their offer on 23 July and was not an employee until 3 August. Nothing was broken
// loudly. The signing handler in src/pages/portal/offer/[token].astro wrote six things and triggered
// nothing: it flipped offer_letters.status to 'signed', flipped applications.status to 'hired' with a
// bare UPDATE, called transferApplicantToEmployee() inside `catch (_) {}` and discarded its return
// value, and printed "Offer accepted. You are officially part of EduRankAI." The transfer had thrown.
// Both layers had swallowed the reason. No screen in the product could answer the one question that
// would have found it: WHICH SIGNED OFFERS HAVE NO EMPLOYEE RECORD?
//
// This module is the answer to that. It does the whole handoff in one call, and — this is the part
// that matters — it WRITES DOWN WHAT HAPPENED, step by step, whether or not it worked. The row it
// writes is what /admin/hr/reconciliation lists. A step that fails does not stop the signature and
// does not stop the other steps; it leaves a durable, findable record saying which step, for whom,
// and the real Postgres reason.
//
//   EVERY HANDOFF EITHER HAPPENS OR IS VISIBLE AS NOT HAVING HAPPENED.
//
// -------------------------------------------------------------------------------------------------
// ONE DOOR, NOT TWO
// -------------------------------------------------------------------------------------------------
// Two engines used to create the employee, and the one candidates actually triggered was the poorer:
// hr/sync.ts (admin flips the dropdown to Hired) resolved the department from the role and minted the
// code through withEmployeeCode(); hire-transfer.ts (candidate signs) did neither. completeHire()
// routes an application-backed hire through hr/sync.ts — the same door, the same engine, whichever
// human or candidate set it in motion — and uses hire-transfer.ts only for a direct offer with no
// application row to read.
//
// -------------------------------------------------------------------------------------------------
// WHAT IT DOES NOT DO
// -------------------------------------------------------------------------------------------------
// It does not invent a salary. The offer letter carries compensation as free text ("Rs 45,000 per
// month", "stipend on completion", "unpaid"), and parsing that into hr_employees.base_salary would
// eventually pay somebody the wrong amount silently — which is worse than paying them nothing
// visibly. The agreed wording is RECORDED against the handoff instead, so the reconciliation screen
// can show "the letter says X; the employee record has no base salary" next to each other and a human
// decides. Same reasoning for the reporting manager: `reportingTo` on an offer is a typed name, not
// an identity, and the Organization Graph is the only thing allowed to answer who manages whom.
//
// HOUSE RULES OBSERVED: postgres-js returns PLAIN ARRAYS; the real Postgres reason is on e.cause;
// every const is declared before the function that reads it; DDL sits in one ensureOnce guard that is
// additive, never drops, and un-memoises itself on failure so it is retried; no write path swallows an
// exception; hr_employees uses full_name; no relationship is read from users.role.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}
function logFail(where: string, e: any) {
  console.error('[hire-completion] ' + where + ':', reasonOf(e));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: any): boolean { return UUID_RE.test(String(v || '')); }
function uuidOrNull(v: any): string | null { return isUuid(v) ? String(v) : null; }

// -------------------------------------------------------------------------------------------------
// VOCABULARY — declared before everything that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** The steps a signature has to set in motion, in the order they run. */
export const HANDOFF_STEPS = [
  { key: 'employee_record', label: 'Employee record created' },
  { key: 'employee_details', label: 'Offer terms carried onto the record' },
  { key: 'application_stage', label: 'Application tracker moved to Onboarded' },
  { key: 'onboarding_journey', label: 'Onboarding checklist started' },
  { key: 'joiner_told', label: 'The joiner told what happens next' },
] as const;
export type HandoffStepKey = (typeof HANDOFF_STEPS)[number]['key'];

export function handoffStepLabel(key: string): string {
  const s = HANDOFF_STEPS.find((x) => x.key === key);
  return s ? s.label : key;
}

/**
 * ONBOARDING HAS AN END NOW.
 *
 * hr_employees.onboarding_status was a one-way street: /portal/employee/onboarding wrote 'submitted'
 * and NOTHING anywhere in src/ ever wrote 'verified' or 'complete'. Two analytics modules count
 * `onboarding_status <> 'complete'` as "currently onboarding", so every person the company has ever
 * hired was counted as still onboarding, forever, with no action on any screen that could end it.
 * setOnboardingStatus() below is that action, and /admin/hr/reconciliation is where it is reachable.
 */
export const ONBOARDING_STATUSES = [
  { key: 'pending', label: 'Not started', blurb: 'The joining form has not been submitted yet.' },
  { key: 'submitted', label: 'Submitted', blurb: 'The joiner has sent their details; HR has not checked them.' },
  { key: 'verified', label: 'Checked', blurb: 'HR has read the bank, identity and emergency details and they are right.' },
  { key: 'complete', label: 'Complete', blurb: 'Onboarding is finished. They stop counting as onboarding anywhere.' },
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]['key'];

export function onboardingStatusLabel(key: string): string {
  const s = ONBOARDING_STATUSES.find((x) => x.key === key);
  return s ? s.label : (key || 'Not started');
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — one table, additive, never dropped.
// -------------------------------------------------------------------------------------------------
//
// hr_hire_handoffs is a LEDGER OF HANDOFFS, not a queue somebody has to drain. One row per signed
// offer (or per hired application where there is no offer). It carries the outcome of every step, so
// the reconciliation screen can say "employee record created, checklist NOT started because <reason>"
// rather than the two facts every screen could show before: "signed" and "hired".
//
// The name does not exist anywhere else in the repo — checked before writing, because two CREATE
// TABLE statements for one name with different shapes silently break every write for whichever module
// loses the race.
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS hr_hire_handoffs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id         uuid,
    application_id   uuid,
    user_id          uuid,
    employee_id      uuid,
    candidate_name   text NOT NULL DEFAULT '',
    candidate_email  text NOT NULL DEFAULT '',
    role_title       text NOT NULL DEFAULT '',
    source           text NOT NULL DEFAULT 'candidate_signature',
    state            text NOT NULL DEFAULT 'incomplete',
    steps            jsonb NOT NULL DEFAULT '[]'::jsonb,
    gaps             jsonb NOT NULL DEFAULT '[]'::jsonb,
    agreed_pay       text,
    last_error       text,
    attempts         integer NOT NULL DEFAULT 0,
    first_seen_at    timestamptz NOT NULL DEFAULT NOW(),
    updated_at       timestamptz NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS hr_hire_handoffs_offer_uniq
     ON hr_hire_handoffs (offer_id) WHERE offer_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS hr_hire_handoffs_app_uniq
     ON hr_hire_handoffs (application_id) WHERE application_id IS NOT NULL AND offer_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS hr_hire_handoffs_state_idx
     ON hr_hire_handoffs (state, updated_at DESC)`,
];

let _schema: Promise<void> | null = null;

/**
 * ONE GUARD, AND IT UN-MEMOISES ITSELF ON FAILURE.
 *
 * src/lib/application-stages.ts memoised a promise that swallowed its own failure, so one bad ALTER
 * at boot meant every stage read and write for the life of the process failed against a column that
 * did not exist, with nothing anywhere saying why. A failed ensure here throws (the caller decides
 * whether that is fatal) AND clears the memo, so the next call tries again.
 */
export function ensureHireHandoffSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    try {
      for (const stmt of DDL) await db.execute(sql.raw(stmt));
    } catch (e: any) {
      _schema = null;
      logFail('ensureHireHandoffSchema', e);
      throw e;
    }
  })();
  return _schema;
}

// -------------------------------------------------------------------------------------------------
// THE RESULT SHAPE
// -------------------------------------------------------------------------------------------------

export interface HandoffStepResult {
  key: HandoffStepKey;
  label: string;
  /** true when the step did its work OR was correctly not needed. */
  ok: boolean;
  /** true when it was deliberately not attempted — say so rather than reporting a false success. */
  skipped: boolean;
  /** One sentence a person can read. Always populated. */
  detail: string;
}

export interface HireCompletion {
  /** true only when the employee record exists. The other steps report themselves individually. */
  ok: boolean;
  employeeId: string | null;
  employeeCode: string | null;
  steps: HandoffStepResult[];
  /** Things that are missing from the record and that only a human can fill in. Never silent. */
  gaps: string[];
  /** The blocking reason, when the employee record could not be created. */
  error: string | null;
  /** id of the hr_hire_handoffs row, when one could be written. */
  handoffId: string | null;
}

export interface CompleteHireInput {
  /** The offer_letters row (drizzle camelCase or raw snake_case — both are read). */
  offer?: any;
  /** Used when there is no offer, e.g. an admin marking an application Hired. */
  applicationId?: string | null;
  /** Who caused this. May be the candidate themselves. */
  actorUserId?: string | null;
  source?: 'candidate_signature' | 'admin_status' | 'repair';
}

// -------------------------------------------------------------------------------------------------
// THE HANDOFF
// -------------------------------------------------------------------------------------------------

/**
 * Complete a hire: record, details, tracker, checklist, and telling the person.
 *
 * SAFE TO CALL AGAIN. Every step is idempotent — the employee lookup returns the existing row, the
 * enrichment only fills empty columns, startJourney() tops a checklist up without resetting anything
 * anybody has completed, and the handoff row is updated in place. That is what makes the "Try this
 * hire again" button on the reconciliation screen safe to press.
 *
 * IT NEVER THROWS. A signature must not be refused because a downstream step failed — but the reason
 * is returned, recorded on the handoff row, and pushed to the people desk.
 */
export async function completeHire(input: CompleteHireInput): Promise<HireCompletion> {
  const offer = input?.offer || null;
  const content = (offer?.content || {}) as Record<string, any>;
  const offerId = uuidOrNull(offer?.id);
  const applicationId = uuidOrNull(offer?.applicationId ?? offer?.application_id ?? input?.applicationId);
  const actor = uuidOrNull(input?.actorUserId);
  const source = input?.source || 'candidate_signature';

  let candidateName = String(content.candidateName || offer?.candidateName || offer?.candidate_name || '').trim();
  let candidateEmail = String(content.candidateEmail || offer?.candidateEmail || offer?.candidate_email || '').trim();
  let roleTitle = String(content.roleTitle || offer?.roleTitle || offer?.role_title || '').trim();
  const agreedPay = String(content.compensation || '').trim();

  const out: HireCompletion = {
    ok: false, employeeId: null, employeeCode: null, steps: [], gaps: [], error: null, handoffId: null,
  };
  const step = (key: HandoffStepKey, ok: boolean, detail: string, skipped = false) => {
    out.steps.push({ key, label: handoffStepLabel(key), ok, skipped, detail });
  };

  // The account the joiner will sign in with. The offer creates one on send; an applicant who applied
  // through the portal already had one. Preferring the offer's account matches which credentials the
  // letter told them to use.
  let joinerUserId: string | null = uuidOrNull(offer?.createdUserId ?? offer?.created_user_id);

  // WHO THIS IS, WHEN THERE IS NO OFFER TO READ IT FROM. An admin flipping the dropdown to Hired has
  // an application and nothing else, and a handoff row with a blank name is a row nobody can act on.
  try {
    if (applicationId && (!joinerUserId || !candidateName || !candidateEmail || !roleTitle)) {
      const a = rows(await db.execute(sql`
        SELECT applicant_user_id, first_name, last_name, email, role_title_snapshot
          FROM applications WHERE id = ${applicationId}::uuid LIMIT 1`))[0] || {};
      if (!joinerUserId) joinerUserId = uuidOrNull(a.applicant_user_id);
      if (!candidateName) candidateName = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
      if (!candidateEmail) candidateEmail = String(a.email || '').trim();
      if (!roleTitle) roleTitle = String(a.role_title_snapshot || '').trim();
    }
  } catch (e: any) {
    logFail('completeHire.applicationFacts', e);
  }

  // ---------------------------------------------------------------------------------------------
  // STEP 1 — THE EMPLOYEE RECORD
  // ---------------------------------------------------------------------------------------------
  try {
    const existing = rows(await db.execute(sql`
      SELECT id, employee_code FROM hr_employees
       WHERE (${applicationId}::uuid IS NOT NULL AND application_id = ${applicationId}::uuid)
          OR (${joinerUserId}::uuid IS NOT NULL AND user_id = ${joinerUserId}::uuid)
          OR (${candidateEmail} <> '' AND lower(COALESCE(personal_email, '')) = lower(${candidateEmail}))
          OR (${candidateEmail} <> '' AND lower(COALESCE(email, '')) = lower(${candidateEmail}))
       LIMIT 1`));

    if (existing.length) {
      out.employeeId = String(existing[0].id);
      out.employeeCode = existing[0].employee_code ? String(existing[0].employee_code) : null;
      out.ok = true;
      step('employee_record', true, 'Already on the employee register'
        + (out.employeeCode ? ' as ' + out.employeeCode : '') + '; no second record was created.');
    } else if (applicationId) {
      // THROUGH THE SAME DOOR AS AN ADMIN HIRE. hr/sync.ts sets department_id from the role and mints
      // the code with a collision retry; a candidate signing their own offer used to bypass it.
      const prevRows = rows(await db.execute(sql`
        SELECT status FROM applications WHERE id = ${applicationId}::uuid LIMIT 1`));
      const prevStatus = String(prevRows[0]?.status || '');

      if (prevStatus !== 'hired') {
        await db.execute(sql`
          UPDATE applications SET status = 'hired', updated_at = NOW()
           WHERE id = ${applicationId}::uuid`);
      }

      // 'unsynced' is deliberately not one of the application statuses. It is the truthful answer to
      // what hr/sync is really asking — has this hire already been carried across to HR? — in the case
      // this branch is only ever reached in: the column says hired and no employee row exists. Passing
      // 'hired' here would make it return "nothing to do" and a repair would do nothing, silently.
      const { onApplicationStatusChange } = await import('@/lib/hr/sync');
      const sync = await onApplicationStatusChange(
        applicationId, 'hired', prevStatus === 'hired' ? 'unsynced' : prevStatus, actor || '',
      );

      const made = rows(await db.execute(sql`
        SELECT id, employee_code FROM hr_employees
         WHERE application_id = ${applicationId}::uuid LIMIT 1`));
      if (made.length) {
        out.employeeId = String(made[0].id);
        out.employeeCode = made[0].employee_code ? String(made[0].employee_code) : null;
        out.ok = true;
        step('employee_record', true, 'Employee record created'
          + (out.employeeCode ? ' as ' + out.employeeCode : '') + '.');
      } else if (offer) {
        // hr/sync could not read the application. The offer still carries everything needed, so try
        // the direct path rather than leaving a signed hire with no record.
        const fallback = await transferFromOffer(offer);
        if (fallback.employeeId) {
          out.employeeId = fallback.employeeId;
          out.ok = true;
          step('employee_record', true, 'Employee record created from the signed offer'
            + (sync.error ? ' after the application-based path failed: ' + sync.error : '') + '.');
        } else {
          out.error = fallback.error || sync.error || 'The employee record could not be created.';
          step('employee_record', false, 'NO EMPLOYEE RECORD EXISTS FOR THIS SIGNED OFFER: ' + out.error);
        }
      } else {
        out.error = sync.error || 'The employee record could not be created.';
        step('employee_record', false, 'NO EMPLOYEE RECORD EXISTS FOR THIS HIRE: ' + out.error);
      }
    } else if (offer) {
      const fallback = await transferFromOffer(offer);
      if (fallback.employeeId) {
        out.employeeId = fallback.employeeId;
        out.ok = true;
        step('employee_record', true, 'Employee record created from the offer.');
      } else {
        out.error = fallback.error || 'The employee record could not be created.';
        step('employee_record', false, 'NO EMPLOYEE RECORD EXISTS FOR THIS SIGNED OFFER: ' + out.error);
      }
    } else {
      out.error = 'This hire has neither an application nor an offer to build an employee record from.';
      step('employee_record', false, out.error);
    }
  } catch (e: any) {
    logFail('completeHire.employee_record', e);
    out.error = reasonOf(e);
    step('employee_record', false, 'NO EMPLOYEE RECORD EXISTS FOR THIS HIRE: ' + out.error);
  }

  // ---------------------------------------------------------------------------------------------
  // STEP 2 — THE TERMS THAT WERE ACTUALLY AGREED, ONTO THE RECORD
  // ---------------------------------------------------------------------------------------------
  // Only ever FILLS BLANKS. `COALESCE(NULLIF(col, ''), new)` means a value HR has already typed wins
  // over the letter, so re-running a repair can never overwrite a correction somebody made by hand.
  if (out.employeeId && offer) {
    try {
      const joining = String(content.joiningDate || offer?.joiningDate || offer?.joining_date || '').trim();
      const joiningDate = /^\d{4}-\d{2}-\d{2}/.test(joining) ? joining.slice(0, 10) : null;
      await db.execute(sql`
        UPDATE hr_employees SET
          user_id         = COALESCE(user_id, ${joinerUserId}::uuid),
          joining_date    = COALESCE(joining_date, ${joiningDate}::date),
          designation     = COALESCE(NULLIF(designation, ''), ${roleTitle || null}),
          employment_type = COALESCE(NULLIF(employment_type, ''), ${String(content.employmentType || '') || null}),
          phone           = COALESCE(NULLIF(phone, ''), ${String(content.candidatePhone || '') || null}),
          personal_email  = COALESCE(NULLIF(personal_email, ''), ${candidateEmail || null}),
          updated_at      = NOW()
        WHERE id = ${out.employeeId}::uuid`);
      step('employee_details', true, 'Joining date, engagement type and title taken from the signed letter '
        + '(anything already recorded by HR was left alone).');
    } catch (e: any) {
      logFail('completeHire.employee_details', e);
      step('employee_details', false, 'The terms on the signed letter were not copied onto the employee record: ' + reasonOf(e));
    }
  } else if (out.employeeId) {
    step('employee_details', true, 'No offer letter to read terms from; the record keeps what HR entered.', true);
  } else {
    step('employee_details', false, 'Not attempted — there is no employee record to write to.', true);
  }

  // WHAT IS STILL MISSING, SAID OUT LOUD.
  if (out.employeeId) {
    try {
      const e = rows(await db.execute(sql`
        SELECT department_id, reporting_manager_id, base_salary, joining_date
          FROM hr_employees WHERE id = ${out.employeeId}::uuid LIMIT 1`))[0] || {};
      if (!e.department_id) {
        out.gaps.push('No department is recorded. Until one is, nobody can assign them work and no '
          + 'department-owned onboarding step can find an owner.');
      }
      if (!e.reporting_manager_id) {
        out.gaps.push('No reporting manager is recorded. Their leave, timesheets and expenses have '
          + 'nobody to route to.');
      }
      if (e.base_salary === null || e.base_salary === undefined || Number(e.base_salary) === 0) {
        out.gaps.push('No base salary is recorded'
          + (agreedPay ? ', although the signed letter says: ' + agreedPay : '')
          + '. A payroll run would compute their pay as zero.');
      }
      if (!e.joining_date) out.gaps.push('No joining date is recorded.');
    } catch (e: any) {
      logFail('completeHire.gaps', e);
      out.gaps.push('The employee record could not be read back to check what is missing: ' + reasonOf(e));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // STEP 3 — THE CANDIDATE'S OWN TRACKER
  // ---------------------------------------------------------------------------------------------
  // applications.stage never reached 'onboarded' anywhere in the product: STAGES[5] existed, its blurb
  // promised "Offer signed ... day one scheduled", and only a human choosing it on an admin dropdown
  // ever wrote it. A person who had already started work still saw step 05 on their tracker.
  if (applicationId) {
    try {
      const { advanceStage } = await import('@/lib/application-stages');
      // ITS ANSWER IS READ. advanceStage() returns a result rather than throwing when it refuses a
      // move, so `await` on its own would have recorded this step as done against a tracker that had
      // not moved — the exact shape this module exists to remove.
      const moved = await advanceStage({
        applicationId,
        toStage: 'onboarded',
        actorUserId: actor,
        actorName: source === 'candidate_signature' ? (candidateName || 'Candidate') : 'People desk',
        note: source === 'candidate_signature' ? 'Offer signed by the candidate.' : 'Hire completed.',
      });
      if (moved.ok) {
        step('application_stage', true, 'Their application tracker now reads 06 · Onboarded.');
      } else {
        step('application_stage', false, 'Their application tracker still shows the previous step: ' + (moved.error || 'unknown reason'));
      }
    } catch (e: any) {
      logFail('completeHire.application_stage', e);
      step('application_stage', false, 'Their application tracker still shows the previous step: ' + reasonOf(e));
    }
  } else {
    step('application_stage', true, 'No application to track — this hire did not come through the funnel.', true);
  }

  // ---------------------------------------------------------------------------------------------
  // STEP 4 — THE ONBOARDING CHECKLIST
  // ---------------------------------------------------------------------------------------------
  // startJourney() had exactly ONE caller in the whole repo: a manual button on an admin page. So a
  // person could sign on Monday and by Friday nobody owned their laptop, their accounts, their
  // introductions or their policy acknowledgement — and no owner was notified, because there were no
  // items to notify about. The module's own header says "a step nobody owns is the step that never
  // happens"; the whole checklist was that step.
  if (out.employeeId) {
    try {
      const { listTemplateSteps, startJourney } = await import('@/lib/onboarding-journey');
      const template = await listTemplateSteps();
      if (template.length === 0) {
        // NOT a failure of this hire, and not silence either. The company has not written down what it
        // does for a joiner yet. /admin/hr/reconciliation lists everyone with no checklist, so this
        // person is still findable.
        step('onboarding_journey', true,
          'No checklist was started because the onboarding template is empty. Add the steps this '
          + 'company does for a joiner at /admin/hr/onboarding/journey, then start theirs.', true);
      } else {
        const j = await startJourney(out.employeeId, actor);
        if (j.ok) {
          step('onboarding_journey', true, 'Onboarding checklist started'
            + (j.unowned ? '; ' + j.unowned + ' step' + (j.unowned === 1 ? '' : 's')
              + ' could not resolve an owner yet and each says why.' : ', and every step has an owner.'));
        } else {
          step('onboarding_journey', false, 'NO ONBOARDING CHECKLIST EXISTS FOR THEM: ' + (j.error || 'unknown reason'));
        }
      }
    } catch (e: any) {
      logFail('completeHire.onboarding_journey', e);
      step('onboarding_journey', false, 'NO ONBOARDING CHECKLIST EXISTS FOR THEM: ' + reasonOf(e));
    }
  } else {
    step('onboarding_journey', false, 'Not attempted — there is no employee record to attach a checklist to.', true);
  }

  // ---------------------------------------------------------------------------------------------
  // STEP 5 — TELL THE PERSON
  // ---------------------------------------------------------------------------------------------
  // The signing handler notified ADMINS and nobody else. The one person with same-day obligations —
  // documents, the reading, the policy acknowledgement — was told nothing beyond a sentence on a page
  // they were about to navigate away from.
  if (joinerUserId) {
    try {
      const { notifyUser } = await import('@/lib/notify');
      await notifyUser(joinerUserId, {
        title: 'Welcome to EduRankAI' + (candidateName ? ', ' + candidateName.split(' ')[0] : ''),
        body: out.employeeId
          ? 'Your offer is signed. Next: share your certificates and complete your joining details.'
          : 'Your offer is signed. The people desk is finishing your record and will be in touch.',
        type: 'hire',
        actionUrl: '/portal/employee/onboarding',
        entityType: 'hr_employee',
        entityId: out.employeeId || (offerId || ''),
      });
      step('joiner_told', true, 'They have been told what happens next, pointing at /portal/employee/onboarding.');
    } catch (e: any) {
      logFail('completeHire.joiner_told', e);
      step('joiner_told', false, 'The joiner was NOT told what happens next: ' + reasonOf(e));
    }
  } else {
    step('joiner_told', false, 'The joiner has no account on this offer, so nothing could be sent to them.', true);
  }

  // ---------------------------------------------------------------------------------------------
  // THE RECORD OF THE HANDOFF
  // ---------------------------------------------------------------------------------------------
  const unresolved = out.steps.filter((s) => !s.ok && !s.skipped);
  const state = out.ok && unresolved.length === 0 ? 'complete' : 'incomplete';
  out.handoffId = await recordHandoff({
    offerId, applicationId, userId: joinerUserId, employeeId: out.employeeId,
    candidateName, candidateEmail, roleTitle, agreedPay, source, state,
    steps: out.steps, gaps: out.gaps,
    lastError: out.error || (unresolved[0] ? unresolved[0].detail : null),
  });

  // A HANDOFF THAT DID NOT COMPLETE IS PUSHED, NOT LEFT FOR SOMEBODY TO NOTICE. The last time a hire
  // failed, the only trace was one row in the last-50 error tail on /admin/hardening, which any busy
  // day scrolls off.
  if (state !== 'complete') {
    try {
      const { notifyAllAdmins } = await import('@/lib/notify');
      await notifyAllAdmins({
        title: 'Hire needs finishing: ' + (candidateName || 'a new joiner'),
        body: out.ok
          ? unresolved.length + ' step' + (unresolved.length === 1 ? '' : 's') + ' of their handoff did not complete.'
          : 'They signed, and NO employee record exists for them.',
        type: 'hire',
        actionUrl: '/admin/hr/reconciliation',
        entityType: 'hr_hire_handoff',
        entityId: out.handoffId || '',
      });
    } catch (e: any) {
      logFail('completeHire.notifyAdmins', e);
    }
  }

  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: actor, action: 'hire.completed', entity: 'hr_hire_handoff',
      entityId: out.handoffId || offerId || applicationId || '',
      diff: {
        source, state, employeeId: out.employeeId, employeeCode: out.employeeCode,
        steps: out.steps.map((s) => s.key + ': ' + (s.skipped ? 'skipped' : s.ok ? 'ok' : 'FAILED')),
        gaps: out.gaps,
      },
    });
  } catch (e: any) {
    logFail('completeHire.audit', e);
  }

  return out;
}

/** The direct path, for an offer with no application row to read. */
async function transferFromOffer(offer: any): Promise<{ employeeId: string | null; error: string | null }> {
  try {
    const { transferApplicantToEmployee } = await import('@/lib/hire-transfer');
    const r = await transferApplicantToEmployee(offer);
    return { employeeId: r.employeeId ? String(r.employeeId) : null, error: r.error || null };
  } catch (e: any) {
    logFail('transferFromOffer', e);
    return { employeeId: null, error: reasonOf(e) };
  }
}

/**
 * Write (or update) the ledger row. Never throws: the handoff has already happened by the time this
 * runs, and losing the note must not be reported as losing the hire. It IS logged loudly, because
 * this row is the only thing that makes an incomplete handoff findable.
 */
async function recordHandoff(o: {
  offerId: string | null; applicationId: string | null; userId: string | null; employeeId: string | null;
  candidateName: string; candidateEmail: string; roleTitle: string; agreedPay: string;
  source: string; state: string; steps: HandoffStepResult[]; gaps: string[]; lastError: string | null;
}): Promise<string | null> {
  try {
    await ensureHireHandoffSchema();
    const stepsJson = JSON.stringify(o.steps);
    const gapsJson = JSON.stringify(o.gaps);

    const existing = rows(await db.execute(sql`
      SELECT id FROM hr_hire_handoffs
       WHERE (${o.offerId}::uuid IS NOT NULL AND offer_id = ${o.offerId}::uuid)
          OR (${o.offerId}::uuid IS NULL AND ${o.applicationId}::uuid IS NOT NULL
              AND offer_id IS NULL AND application_id = ${o.applicationId}::uuid)
       LIMIT 1`));

    if (existing.length) {
      const id = String(existing[0].id);
      await db.execute(sql`
        UPDATE hr_hire_handoffs SET
          application_id = COALESCE(application_id, ${o.applicationId}::uuid),
          user_id        = COALESCE(${o.userId}::uuid, user_id),
          employee_id    = COALESCE(${o.employeeId}::uuid, employee_id),
          state          = ${o.state},
          steps          = ${stepsJson}::jsonb,
          gaps           = ${gapsJson}::jsonb,
          agreed_pay     = COALESCE(NULLIF(${o.agreedPay}, ''), agreed_pay),
          last_error     = ${o.lastError},
          attempts       = attempts + 1,
          updated_at     = NOW()
        WHERE id = ${id}::uuid`);
      return id;
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_hire_handoffs
        (offer_id, application_id, user_id, employee_id, candidate_name, candidate_email, role_title,
         source, state, steps, gaps, agreed_pay, last_error, attempts)
      VALUES
        (${o.offerId}::uuid, ${o.applicationId}::uuid, ${o.userId}::uuid, ${o.employeeId}::uuid,
         ${o.candidateName}, ${o.candidateEmail}, ${o.roleTitle},
         ${o.source}, ${o.state}, ${stepsJson}::jsonb, ${gapsJson}::jsonb,
         ${o.agreedPay || null}, ${o.lastError}, 1)
      RETURNING id`));
    return ins.length ? String(ins[0].id) : null;
  } catch (e: any) {
    logFail('recordHandoff', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// REPAIR ACTIONS — every state gets an exit, and the exit is reachable
// -------------------------------------------------------------------------------------------------

/**
 * Run the handoff again for one signed offer. This is the button on /admin/hr/reconciliation next to
 * "signed, no employee record" — the row that could not be produced at all before this module existed.
 */
export async function retryHire(offerId: string, actorUserId: string | null): Promise<HireCompletion> {
  const id = uuidOrNull(offerId);
  if (!id) {
    return {
      ok: false, employeeId: null, employeeCode: null, steps: [], gaps: [],
      error: 'That offer could not be identified.', handoffId: null,
    };
  }
  try {
    const r = rows(await db.execute(sql`SELECT * FROM offer_letters WHERE id = ${id}::uuid LIMIT 1`));
    if (!r.length) {
      return {
        ok: false, employeeId: null, employeeCode: null, steps: [], gaps: [],
        error: 'That offer could not be found.', handoffId: null,
      };
    }
    const raw = r[0] as any;
    // Raw snake_case from db.execute; the readers below accept either shape, and `content` is jsonb so
    // it arrives as an object already.
    const offer = {
      id: raw.id,
      applicationId: raw.application_id,
      createdUserId: raw.created_user_id,
      content: raw.content || {},
      candidateName: raw.candidate_name,
      candidateEmail: raw.candidate_email,
      roleTitle: raw.role_title,
      joiningDate: raw.joining_date,
      status: raw.status,
    };
    return await completeHire({ offer, actorUserId, source: 'repair' });
  } catch (e: any) {
    logFail('retryHire', e);
    return {
      ok: false, employeeId: null, employeeCode: null, steps: [], gaps: [],
      error: reasonOf(e), handoffId: null,
    };
  }
}

/**
 * MOVE ONBOARDING FORWARD — OR FINISH IT.
 *
 * The exit from a state that had none. Writes the status, tells the person when it is finished (they
 * are the one waiting to hear it), and audits who decided.
 */
export async function setOnboardingStatus(
  employeeId: string,
  status: string,
  actorUserId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const id = uuidOrNull(employeeId);
  if (!id) return { ok: false, error: 'That employee could not be identified.' };
  if (!ONBOARDING_STATUSES.some((s) => s.key === status)) {
    return { ok: false, error: 'That is not a state onboarding records.' };
  }
  const actor = uuidOrNull(actorUserId);
  try {
    const updated = rows(await db.execute(sql`
      UPDATE hr_employees
         SET onboarding_status = ${status}, updated_at = NOW()
       WHERE id = ${id}::uuid
       RETURNING id, user_id, full_name, onboarding_status`));
    if (!updated.length) return { ok: false, error: 'No employee record was changed.' };
    const row = updated[0] as any;

    // BOTH SETTLED STATES ARE TOLD TO THE PERSON IN THEM, not only the last one.
    //
    // 'verified' is a decision about somebody's bank, identity and emergency details that they
    // submitted and are waiting on — being checked is the thing they cannot see from their side. It
    // notified nothing, so a joiner whose details HR had read and accepted was left in exactly the
    // silence 'complete' was built to end, one step earlier.
    if ((status === 'complete' || status === 'verified') && row.user_id) {
      try {
        const { notifyUser } = await import('@/lib/notify');
        await notifyUser(String(row.user_id), {
          title: status === 'complete' ? 'Onboarding complete' : 'Your joining details have been checked',
          body: status === 'complete'
            ? 'The people desk has signed off your joining details. Nothing further is outstanding.'
            : 'The people desk has read your bank, identity and emergency details and they are right. '
              + 'Anything still outstanding is on your onboarding checklist.',
          type: 'hire',
          actionUrl: status === 'complete' ? '/portal/employee' : '/portal/employee/onboarding',
          entityType: 'hr_employee',
          entityId: id,
        });
      } catch (e: any) {
        // The status is already committed; the person simply has not been told yet, and that is worth
        // knowing about rather than hiding.
        logFail('setOnboardingStatus.notify', e);
      }
    }

    try {
      const { logAudit } = await import('@/lib/audit');
      await logAudit({
        userId: actor, action: 'hr.onboarding_status', entity: 'hr_employee', entityId: id,
        diff: { onboardingStatus: status, employee: String(row.full_name || '') },
      });
    } catch (e: any) {
      logFail('setOnboardingStatus.audit', e);
    }
    return { ok: true };
  } catch (e: any) {
    logFail('setOnboardingStatus', e);
    return { ok: false, error: 'The status was not changed: ' + reasonOf(e) };
  }
}

/**
 * AN OFFER THAT LAPSED SHOULD SAY SO.
 *
 * offer_letters.status stayed 'sent' forever past the expiry date: expiry was derived per page load
 * and never persisted, so a lapsed offer was indistinguishable from a live one in every count, export
 * and "awaiting signature" widget. This is the transition that state never had. It refuses anything
 * that is not still 'sent', and it refuses an offer that has not actually expired — a person's live
 * offer must not be closable by pressing a repair button.
 */
export async function expireOffer(offerId: string, actorUserId: string | null): Promise<{ ok: boolean; error?: string }> {
  const id = uuidOrNull(offerId);
  if (!id) return { ok: false, error: 'That offer could not be identified.' };
  try {
    const updated = rows(await db.execute(sql`
      UPDATE offer_letters
         SET status = 'expired', updated_at = NOW()
       WHERE id = ${id}::uuid
         AND status = 'sent'
         AND expiry_date IS NOT NULL
         AND substring(expiry_date from 1 for 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND substring(expiry_date from 1 for 10) < to_char(CURRENT_DATE, 'YYYY-MM-DD')
       RETURNING id, candidate_name`));
    if (!updated.length) {
      return { ok: false, error: 'Nothing was changed — that offer is either not lapsed yet or no longer waiting for a signature.' };
    }
    try {
      const { logAudit } = await import('@/lib/audit');
      await logAudit({
        userId: uuidOrNull(actorUserId), action: 'offer.expired', entity: 'offer_letter', entityId: id,
        diff: { candidate: String((updated[0] as any).candidate_name || ''), by: 'reconciliation screen' },
      });
    } catch (e: any) {
      logFail('expireOffer.audit', e);
    }
    return { ok: true };
  } catch (e: any) {
    logFail('expireOffer', e);
    return { ok: false, error: 'The offer was not marked expired: ' + reasonOf(e) };
  }
}
