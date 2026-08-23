// src/lib/intelligence/consent.ts — WHAT THE EMPLOYEE HAS AGREED TO, WHAT HAS BEEN RECORDED ABOUT
// THEM, AND HOW THEY SAY A RECORD IS WRONG.
//
// =================================================================================================
// THREE THINGS, ONE MODULE, BECAUSE THEY ARE ONE CONVERSATION
// =================================================================================================
//
//   CONSENT      a named purpose, a yes or no, and who said it. Append-only.
//   DATA USAGE   what has been recorded against their record, read from the audit log everyone
//                else already writes to. This module creates no second access log.
//   CORRECTION   their statement that something on file is wrong, routed to a person.
//
// A consent screen without the other two is a checkbox. What makes it mean anything is that the
// person can see what was actually done and can contest it in the same place.
//
// =================================================================================================
// APPEND-ONLY, AND WHY THAT IS NOT AN OPTIMISATION
// =================================================================================================
//
// emp_intel_consent never updates a row. Turning a consent off writes a new row saying so, and the
// old row stays. A consent table that overwrites cannot answer "was this person opted in on the day
// their record was used for that", which is the only question a consent record exists to answer.
// The latest row per purpose is resolved at read time by DISTINCT ON, which is one index scan.
//
// =================================================================================================
// UNDECIDED IS NOT CONSENT
// =================================================================================================
//
// Every purpose that lets anybody other than the employee see or use their record defaults to NOT
// GRANTED until they decide. There is no purpose here whose default is "yes because they have not
// said no". The one purpose that defaults on — development suggestions computed from their own
// records and shown only to them — is on because withholding it would mean showing a person a blank
// page about themselves, and nothing leaves their own screen.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { ensureIntelligenceSchema } from './schema';

const MOD = 'intelligence/consent';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message || e);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/* ================================================================================================
 * PURPOSES
 * ============================================================================================= */

export interface IntelligencePurpose {
  key: string;
  label: string;
  /** What is actually done. Written for the person deciding, not for the engineer implementing. */
  what: string;
  /** Who ends up able to see something as a result. "Only you" is a real and common answer. */
  whoSees: string;
  /**
   * What is true before they have decided. FALSE for every purpose that reaches another person.
   * The one TRUE is self-directed and leaves nothing on anybody else's screen.
   */
  defaultWhenUndecided: boolean;
  /** What stops happening the moment it is turned off. */
  onWithdrawal: string;
}

/**
 * THE CLOSED LIST. A purpose that is not here cannot be consented to, and a screen that wants a new
 * one adds it here first so that it appears on the employee's privacy tab with a written meaning.
 *
 * Deliberately NOT on this list: anything that would use a person's record to decide something
 * about them. There is no consent checkbox for that, because consent is not the control that would
 * make it acceptable — no automated output in this system decides a hiring, promotion, termination
 * or disciplinary outcome, with or without permission.
 */
export const INTELLIGENCE_PURPOSES: readonly IntelligencePurpose[] = Object.freeze([
  {
    key: 'development_suggestions',
    label: 'Suggest development from my own records',
    what:
      'Read the learning, goals and verified work already on your record and suggest what you might do next.',
    whoSees: 'Only you. Suggestions are shown on your own page and are not sent to your manager or to HR.',
    defaultWhenUndecided: true,
    onWithdrawal:
      'The development section stops making suggestions. Your learning and goals stay exactly where they are.',
  },
  {
    key: 'reflection_visible_to_manager',
    label: 'Let me share individual reflections with my manager',
    what:
      'Turns on the per-entry share control. Even with this on, no reflection is shared until you mark that one entry as shared.',
    whoSees: 'Your reporting manager, and only for the entries you mark yourself.',
    defaultWhenUndecided: false,
    onWithdrawal:
      'Sharing is switched off for every entry at once, including ones already marked, and the share control disappears.',
  },
  {
    key: 'internal_opportunity_matching',
    label: 'Consider my record for internal opportunities',
    what:
      'Allows your recorded, evidenced capabilities to be compared against requirements written down for internal roles when one opens.',
    whoSees: 'The people running that internal opening. A comparison is never a decision, and a person makes the call.',
    defaultWhenUndecided: false,
    onWithdrawal:
      'Your record stops being included in internal matching from that moment. Anything already under way is decided by the people running it.',
  },
  {
    key: 'aggregate_reporting',
    label: 'Include my record in aggregate reporting',
    what:
      'Allows your record to be counted in organisation-level totals — how many people hold a skill, how much learning was completed.',
    whoSees:
      'Nobody sees you. Group figures only, and a group too small to hide an individual is suppressed rather than shown.',
    defaultWhenUndecided: false,
    onWithdrawal: 'Your record stops being counted in new reporting.',
  },
]);

export function purposeSpec(key: unknown): IntelligencePurpose | null {
  const k = clean(key, 64);
  return INTELLIGENCE_PURPOSES.find((p) => p.key === k) || null;
}

export interface ConsentState {
  purpose: IntelligencePurpose;
  /** Has the person actually answered? Distinct from what the answer defaults to. */
  decided: boolean;
  /** What applies right now: their decision, or the purpose default when they have not decided. */
  effective: boolean;
  decidedAt: string | null;
  /** False when somebody recorded the decision on their behalf. Shown on the screen when false. */
  bySelf: boolean;
  note: string | null;
}

export interface ConsentView {
  states: ConsentState[];
  /** False when the read failed. The page must not print "you have decided nothing" over this. */
  ok: boolean;
  sentence: string;
}

/**
 * Every purpose with its current answer.
 *
 * ONE QUERY. DISTINCT ON (purpose_key) over the employee's rows, newest first, which the
 * (employee_id, purpose_key, created_at DESC) index serves directly. A purpose with no row is
 * returned as undecided with its default, rather than omitted — the screen must list every purpose,
 * including the ones nobody has looked at yet.
 */
export async function consentState(employeeId: string): Promise<ConsentView> {
  const base = INTELLIGENCE_PURPOSES.map((p) => ({
    purpose: p,
    decided: false,
    effective: p.defaultWhenUndecided,
    decidedAt: null as string | null,
    bySelf: true,
    note: null as string | null,
  }));

  if (!isUuid(employeeId)) {
    return {
      states: base,
      ok: true,
      sentence: 'No employee record is linked to this account, so no decision has been recorded against one.',
    };
  }

  try {
    await ensureIntelligenceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT DISTINCT ON (purpose_key)
             purpose_key, granted, decided_by_self, note, created_at
        FROM emp_intel_consent
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY purpose_key, created_at DESC`));

    const byKey = new Map<string, any>();
    for (const r of rows) byKey.set(String(r?.purpose_key || ''), r);

    const states: ConsentState[] = base.map((s) => {
      const r = byKey.get(s.purpose.key);
      if (!r) return s;
      return {
        purpose: s.purpose,
        decided: true,
        effective: r.granted === true,
        decidedAt: iso(r.created_at),
        bySelf: r.decided_by_self !== false,
        note: r.note ? String(r.note) : null,
      };
    });

    const answered = states.filter((s) => s.decided).length;
    return {
      states,
      ok: true,
      sentence: answered === 0
        ? 'You have not answered any of these yet. Until you do, only the first one is on, and nothing about you reaches anybody else.'
        : 'You have answered ' + answered + ' of ' + states.length + '. You can change any of them at any time, and the change applies from that moment.',
    };
  } catch (e: any) {
    logFail('consentState', e);
    return {
      states: base,
      ok: false,
      sentence:
        'Your consent decisions could not be read just now, so what is shown is the default rather than your answer. Nothing was changed.',
    };
  }
}

/** Convenience for callers that need one answer and nothing else. */
export async function hasConsent(employeeId: string, purposeKey: string): Promise<boolean> {
  const spec = purposeSpec(purposeKey);
  if (!spec) return false;
  const view = await consentState(employeeId);
  // A FAILED READ IS NOT A GRANT. When ok is false the states carry defaults, and for every purpose
  // that reaches another person the default is false — so a database hiccup can only ever narrow
  // what happens, never widen it.
  const s = view.states.find((x) => x.purpose.key === spec.key);
  return !!s && s.effective === true;
}

export interface ConsentWriteResult {
  ok: boolean;
  error?: string;
  /** The consent row is the record; the audit entry is the second copy. Reported, never fatal. */
  auditOk?: boolean;
}

/**
 * Record a decision. Appends; never updates.
 *
 * `decidedBySelf` is not inferred from whether the ids match — a caller acting on somebody's behalf
 * has to say so. A decision recorded for a person and a decision made by a person are different
 * facts and the screen prints them differently.
 */
export async function recordConsentDecision(input: {
  employeeId: string;
  actorUserId: string | null;
  purposeKey: string;
  granted: boolean;
  note?: string | null;
  decidedBySelf: boolean;
}): Promise<ConsentWriteResult> {
  if (!isUuid(input.employeeId)) return { ok: false, error: 'No employee record is linked to this account.' };
  const spec = purposeSpec(input.purposeKey);
  if (!spec) return { ok: false, error: 'That is not a purpose this system asks about.' };

  try {
    await ensureIntelligenceSchema();
    await db.execute(sql`
      INSERT INTO emp_intel_consent (employee_id, purpose_key, granted, decided_by_user_id, decided_by_self, note)
      VALUES (${input.employeeId}::uuid, ${spec.key}, ${input.granted === true},
              ${isUuid(input.actorUserId) ? input.actorUserId : null},
              ${input.decidedBySelf === true},
              ${clean(input.note, 1000) || null})`);
  } catch (e: any) {
    logFail('recordConsentDecision', e);
    return { ok: false, error: 'That decision could not be saved: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  // The consent ROW is the durable evidence, so an audit hiccup must not undo a person's decision or
  // tell them it failed when it did not. Unlike a permission grant — where the audit entry IS the
  // control and registry.ts rolls back without it — the control here is the row we just wrote.
  const audit = await logAudit({
    userId: isUuid(input.actorUserId) ? input.actorUserId : null,
    action: input.granted ? 'intelligence.consent.granted' : 'intelligence.consent.withdrawn',
    entity: 'hr_employee',
    entityId: input.employeeId,
    diff: { purpose: spec.key, granted: input.granted === true, bySelf: input.decidedBySelf === true },
  });

  return { ok: true, auditOk: audit.ok };
}

/* ================================================================================================
 * WHAT HAS BEEN RECORDED ABOUT ME
 * ============================================================================================= */

export interface UsageEntry {
  at: string | null;
  action: string;
  /** Plain words for the action, so the list is readable without knowing the action vocabulary. */
  label: string;
  /** The person's own actions marked as theirs, so the list is not read as somebody else's. */
  byYou: boolean;
}

export interface UsageView {
  entries: UsageEntry[];
  ok: boolean;
  /** WHAT THIS LIST DOES AND DOES NOT COVER. Printed above it, always. */
  coverage: string;
  sentence: string;
}

/**
 * The audit trail as it applies to this person's own record.
 *
 * HONEST ABOUT ITS OWN COVERAGE, because the alternative is a screen that reads as a complete
 * surveillance ledger and is not one. audit_log rows are keyed by (entity, entity_id): entries
 * recorded against `hr_employee` with this employee's id resolve to this person and are shown.
 * Entries recorded against a review, a payslip or a learning assignment are keyed by THAT object's
 * id, and this table cannot join them back to a person — so they are outside this list, and the
 * coverage sentence says so rather than letting an empty list imply nothing happened.
 *
 * `byYou` is resolved by comparing the acting account to the reader's own. The acting person is NOT
 * named where it was somebody else: the entries this reaches are ordinary HR record maintenance,
 * and naming an individual colleague beside every one of them is a different disclosure from the
 * one this section is for. Where a named accessor IS the point — a legal-hold access — that is
 * recorded separately and surfaced at /portal/my-record-access, which does name them.
 */
export async function dataUsage(
  employeeId: string,
  viewerUserId: string | null,
  limit = 60,
): Promise<UsageView> {
  const coverage =
    'This lists changes and decisions recorded against your employee record, including your own. '
    + 'It is not a log of every time a page was opened: this platform records changes and specific '
    + 'sensitive accesses, not page views. Accesses under a legal hold are recorded separately and '
    + 'are shown, with the name of the person, on your record-access page.';

  if (!isUuid(employeeId)) {
    return {
      entries: [], ok: true, coverage,
      sentence: 'No employee record is linked to this account, so there is nothing recorded against one.',
    };
  }

  const lim = Math.min(Math.max(Number(limit) || 60, 1), 200);
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT action, user_id, created_at
        FROM audit_log
       WHERE entity = 'hr_employee' AND entity_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT ${lim}`));

    const entries: UsageEntry[] = rows.map((r: any) => {
      const action = String(r?.action || '');
      return {
        at: iso(r?.created_at),
        action,
        label: usageLabel(action),
        byYou: isUuid(viewerUserId) && String(r?.user_id || '') === String(viewerUserId),
      };
    });

    return {
      entries,
      ok: true,
      coverage,
      sentence: entries.length === 0
        ? 'Nothing has been recorded against your employee record in this log.'
        : entries.length + ' entr' + (entries.length === 1 ? 'y is' : 'ies are') + ' recorded against your employee record, newest first.',
    };
  } catch (e: any) {
    logFail('dataUsage', e);
    return {
      entries: [], ok: false, coverage,
      sentence:
        'The log could not be read just now. This is not a statement that nothing has been recorded — it means the log itself could not be reached.',
    };
  }
}

/**
 * Plain words for an audit action.
 *
 * Unknown actions are NOT hidden and NOT relabelled into something friendlier than they are: the
 * raw action is shown with a sentence saying it has no plain-words entry yet. A log that silently
 * drops what it does not recognise is a log that shrinks whenever somebody adds a feature.
 */
export function usageLabel(action: string): string {
  const a = clean(action, 100);
  const known: Record<string, string> = {
    'intelligence.consent.granted': 'You turned a data-use purpose on.',
    'intelligence.consent.withdrawn': 'You turned a data-use purpose off.',
    'intelligence.correction.requested': 'You asked for a record to be corrected.',
    'intelligence.correction.withdrawn': 'You withdrew a correction request.',
    'intelligence.correction.decided': 'Someone answered your correction request.',
    'intelligence.reflection.written': 'You saved a reflection.',
    'intelligence.reflection.shared': 'You changed who can see one of your reflections.',
    'hr_employee.update': 'Your employee record was updated.',
    'hr_employee.create': 'Your employee record was created.',
  };
  if (known[a]) return known[a];
  return a ? a + ' — this entry has no plain-words description yet.' : 'An unnamed entry.';
}

/* ================================================================================================
 * CORRECTION REQUESTS
 * ============================================================================================= */

export const CORRECTION_STATUSES = ['open', 'acknowledged', 'corrected', 'declined', 'withdrawn'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const CORRECTION_STATUS_LABELS: Record<CorrectionStatus, string> = {
  open: 'Waiting to be picked up',
  acknowledged: 'Someone is looking at it',
  corrected: 'The record was changed',
  declined: 'The record was left as it is',
  withdrawn: 'You withdrew this',
};

export interface CorrectionRow {
  id: string;
  targetSection: string;
  targetKey: string | null;
  recordSays: string;
  employeeSays: string;
  evidenceUrl: string | null;
  status: CorrectionStatus;
  statusLabel: string;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

const mapCorrection = (r: any): CorrectionRow => {
  const status = (CORRECTION_STATUSES as readonly string[]).indexOf(String(r?.status)) >= 0
    ? (String(r.status) as CorrectionStatus)
    : 'open';
  return {
    id: String(r?.id || ''),
    targetSection: String(r?.target_section || ''),
    targetKey: r?.target_key ? String(r.target_key) : null,
    recordSays: String(r?.record_says || ''),
    employeeSays: String(r?.employee_says || ''),
    evidenceUrl: r?.evidence_url ? String(r.evidence_url) : null,
    status,
    statusLabel: CORRECTION_STATUS_LABELS[status],
    decisionNote: r?.decision_note ? String(r.decision_note) : null,
    decidedAt: iso(r?.decided_at),
    createdAt: iso(r?.created_at),
  };
};

export interface CorrectionListView {
  rows: CorrectionRow[];
  ok: boolean;
  sentence: string;
}

export async function listCorrections(employeeId: string, limit = 40): Promise<CorrectionListView> {
  if (!isUuid(employeeId)) {
    return { rows: [], ok: true, sentence: 'No employee record is linked to this account.' };
  }
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
  try {
    await ensureIntelligenceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM emp_intel_correction
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY created_at DESC
       LIMIT ${lim}`)).map(mapCorrection);
    return {
      rows,
      ok: true,
      sentence: rows.length === 0
        ? 'You have not asked for anything to be corrected.'
        : rows.length + ' correction request' + (rows.length === 1 ? '' : 's') + ' on record.',
    };
  } catch (e: any) {
    logFail('listCorrections', e);
    return {
      rows: [], ok: false,
      sentence: 'Your correction requests could not be read just now, so this list is incomplete rather than empty.',
    };
  }
}

export interface CorrectionWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  auditOk?: boolean;
}

/**
 * File a correction request.
 *
 * IT GOES TO A PERSON. Nothing in this module changes the disputed record, and there is no path
 * from here that could: the tables the statement came from belong to other modules and this one
 * holds no write to any of them. What it creates is a queue item with the exact sentence the
 * employee read, so whoever picks it up is looking at what they were looking at.
 */
export async function requestCorrection(input: {
  employeeId: string;
  userId: string | null;
  targetSection: string;
  targetKey?: string | null;
  recordSays: string;
  employeeSays: string;
  evidenceUrl?: string | null;
}): Promise<CorrectionWriteResult> {
  if (!isUuid(input.employeeId)) return { ok: false, error: 'No employee record is linked to this account.' };

  const recordSays = clean(input.recordSays, 2000);
  const employeeSays = clean(input.employeeSays, 4000);
  if (!recordSays) return { ok: false, error: 'Say which statement is wrong, in its own words.' };
  if (!employeeSays) return { ok: false, error: 'Say what the record should say instead.' };

  const url = clean(input.evidenceUrl, 1000);
  if (url && !/^https:\/\//i.test(url)) {
    return { ok: false, error: 'A supporting link has to start with https://. Nothing is uploaded — share the link instead.' };
  }

  let id = '';
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      INSERT INTO emp_intel_correction
        (employee_id, user_id, target_section, target_key, record_says, employee_says, evidence_url)
      VALUES (${input.employeeId}::uuid, ${isUuid(input.userId) ? input.userId : null},
              ${clean(input.targetSection, 40)}, ${clean(input.targetKey, 120) || null},
              ${recordSays}, ${employeeSays}, ${url || null})
      RETURNING id`))[0];
    id = String(r?.id || '');
  } catch (e: any) {
    logFail('requestCorrection', e);
    return { ok: false, error: 'That could not be filed: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  const audit = await logAudit({
    userId: isUuid(input.userId) ? input.userId : null,
    action: 'intelligence.correction.requested',
    entity: 'hr_employee',
    entityId: input.employeeId,
    diff: { section: clean(input.targetSection, 40), correctionId: id },
  });

  return { ok: true, id, auditOk: audit.ok };
}

/**
 * The employee takes their own request back.
 *
 * Narrowed by employee_id AND by a status that has not been decided yet, both in the WHERE clause,
 * so this can neither reach somebody else's request nor rewrite an answer that has already been
 * given.
 */
export async function withdrawCorrection(input: {
  id: string;
  employeeId: string;
  userId: string | null;
}): Promise<CorrectionWriteResult> {
  if (!isUuid(input.id) || !isUuid(input.employeeId)) return { ok: false, error: 'That request could not be found.' };
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      UPDATE emp_intel_correction
         SET status = 'withdrawn', updated_at = NOW()
       WHERE id = ${input.id}::uuid
         AND employee_id = ${input.employeeId}::uuid
         AND status IN ('open', 'acknowledged')
      RETURNING id`));
    if (r.length === 0) {
      return { ok: false, error: 'That request is not yours to withdraw, or it has already been answered.' };
    }
  } catch (e: any) {
    logFail('withdrawCorrection', e);
    return { ok: false, error: 'That could not be withdrawn: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  const audit = await logAudit({
    userId: isUuid(input.userId) ? input.userId : null,
    action: 'intelligence.correction.withdrawn',
    entity: 'hr_employee',
    entityId: input.employeeId,
    diff: { correctionId: input.id },
  });
  return { ok: true, id: input.id, auditOk: audit.ok };
}

/**
 * A NAMED HUMAN ANSWERS A CORRECTION REQUEST.
 *
 * EXPOSED FOR THE HR-SIDE PATCH, and it is the only way a request leaves 'open'. There is no
 * automatic transition anywhere in this module: nothing ages out, nothing is auto-declined, and no
 * derived signal closes one. Three things are required and none of them is optional — a decider, a
 * decision, and a written reason — because a correction answered with no reason is a record that
 * says a person was overruled and does not say why.
 *
 * This function does NOT edit the disputed record. Whoever answers 'corrected' has to make the
 * change in the module that owns it; this marks that they did. Keeping those separate is what stops
 * a correction queue from becoming a back door into every HR table.
 */
export async function decideCorrection(input: {
  id: string;
  deciderUserId: string;
  decision: 'acknowledged' | 'corrected' | 'declined';
  note: string;
}): Promise<CorrectionWriteResult> {
  if (!isUuid(input.id)) return { ok: false, error: 'That request could not be found.' };
  if (!isUuid(input.deciderUserId)) return { ok: false, error: 'A decision has to be recorded against a named account.' };
  if (['acknowledged', 'corrected', 'declined'].indexOf(input.decision) < 0) {
    return { ok: false, error: 'That is not a decision this queue accepts.' };
  }
  const note = clean(input.note, 4000);
  if (!note) return { ok: false, error: 'Say why. A decision with no reason is not an answer to the person who asked.' };

  let employeeId = '';
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      UPDATE emp_intel_correction
         SET status = ${input.decision},
             decided_by_user_id = ${input.deciderUserId}::uuid,
             decided_at = NOW(),
             decision_note = ${note},
             updated_at = NOW()
       WHERE id = ${input.id}::uuid
         AND status IN ('open', 'acknowledged')
      RETURNING employee_id`))[0];
    if (!r) return { ok: false, error: 'That request has already been answered or withdrawn.' };
    employeeId = String(r.employee_id || '');
  } catch (e: any) {
    logFail('decideCorrection', e);
    return { ok: false, error: 'That decision could not be saved: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  const audit = await logAudit({
    userId: input.deciderUserId,
    action: 'intelligence.correction.decided',
    entity: 'hr_employee',
    entityId: employeeId,
    diff: { correctionId: input.id, decision: input.decision },
  });
  return { ok: true, id: input.id, auditOk: audit.ok };
}

/**
 * The open queue, for whichever patch builds the HR-side screen.
 *
 * NO EMPLOYEE NAME IS JOINED HERE. This module holds the request, not the directory, and a caller
 * that needs names resolves them through the module that owns hr_employees — which is also the
 * module that enforces who is allowed to see them. Returning names from here would hand every
 * caller a roster read with no gate in front of it.
 */
export async function openCorrections(limit = 100): Promise<{ rows: (CorrectionRow & { employeeId: string })[]; ok: boolean }> {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  try {
    await ensureIntelligenceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM emp_intel_correction
       WHERE status IN ('open', 'acknowledged')
       ORDER BY created_at ASC
       LIMIT ${lim}`));
    return {
      ok: true,
      rows: rows.map((r: any) => ({ ...mapCorrection(r), employeeId: String(r?.employee_id || '') })),
    };
  } catch (e: any) {
    logFail('openCorrections', e);
    return { rows: [], ok: false };
  }
}
