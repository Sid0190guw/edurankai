// src/lib/intelligence/reflection.ts — THE EMPLOYEE'S OWN WORDS, WHICH NOTHING IN THIS SYSTEM READS
// AS A SIGNAL.
//
// =================================================================================================
// THE ONE PROPERTY THIS FILE HAS TO KEEP
// =================================================================================================
//
// A reflection is written by a person about themselves, and it is worth writing only if writing it
// is safe. So:
//
//   NOTHING SCORES IT.        No function here or anywhere in this patch reads `body` and turns it
//                             into a number, a theme, a flag or a trend. The behavioural-trends
//                             section is composed from filed work and verified hours and does not
//                             touch this table. If a future patch wants to analyse these entries,
//                             that is a POLICY change and needs the person's explicit consent under
//                             a new named purpose — not a new query.
//   NOTHING SHARES IT.        shared_with_manager defaults false on every row. Two separate things
//                             have to be true before anybody else can see one: the person has
//                             turned the sharing purpose on, and they have marked that one entry.
//   IT IS THEIRS TO DELETE.   Not archived, not hidden — deleted, narrowed by their own employee id.
//
// The `period_word` column is the one piece of structure, and it is deliberately inert: a word the
// person picks for their own scanning. Nothing aggregates it. It exists so somebody looking back
// over eight months of entries can find the one they meant, not so a system can chart their mood.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { ensureIntelligenceSchema } from './schema';
import { hasConsent } from './consent';

const MOD = 'intelligence/reflection';
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
 * THE TOOLS
 * ============================================================================================= */

export interface ReflectionPrompt {
  key: string;
  question: string;
  /** Why this one is worth answering. Shown under the question, because a bare prompt gets skipped. */
  why: string;
}

/**
 * The prompts, and there are deliberately few.
 *
 * Each one asks about SOMETHING THAT HAPPENED rather than about the person. "What went well" has an
 * answer somebody can write on a bad week; "what are your weaknesses" does not, and a reflection
 * tool that is unpleasant to open is a reflection tool nobody opens twice.
 *
 * 'free' is first among equals: an empty box with no question is the right tool at least as often
 * as a prompt is, and burying it behind four questions would be a small piece of coercion.
 */
export const REFLECTION_PROMPTS: readonly ReflectionPrompt[] = Object.freeze([
  {
    key: 'free',
    question: 'Anything you want to write down',
    why: 'No prompt. Some weeks the useful thing to record does not answer any question in a list.',
  },
  {
    key: 'went_well',
    question: 'What went well, and what made it go well?',
    why: 'The second half is the part worth keeping. A thing that worked once usually worked for a reason you can use again.',
  },
  {
    key: 'harder_than_expected',
    question: 'What turned out harder than you expected?',
    why: 'Useful later, when the same shape of work comes round and the estimate is being made again.',
  },
  {
    key: 'learned',
    question: 'What did you learn, from anywhere — the work, a colleague, a mistake?',
    why: 'Learning that never got written down is learning nobody can point at when it matters.',
  },
  {
    key: 'want_next',
    question: 'What would you like to do more of, or try next?',
    why: 'This is the entry most worth having written when a conversation about your development happens.',
  },
  {
    key: 'support_needed',
    question: 'What would have made this easier?',
    why: 'A note to yourself, or something to raise. Writing it is not raising it — nobody sees this unless you share it.',
  },
]);

export function promptSpec(key: unknown): ReflectionPrompt | null {
  const k = clean(key, 48);
  return REFLECTION_PROMPTS.find((p) => p.key === k) || null;
}

/**
 * The words a person can tag an entry with.
 *
 * Neutral and non-clinical on purpose. None of these is a mood, a state of mind or anything that
 * could be read as a health observation — they describe the WEEK, not the writer, and this system
 * does not and must not form a view about anybody's health.
 */
export const PERIOD_WORDS: readonly string[] = Object.freeze([
  'steady', 'busy', 'stretched', 'focused', 'scattered', 'quiet', 'a turning point',
]);

export function isPeriodWord(v: unknown): boolean {
  const s = clean(v, 24);
  return s === '' || PERIOD_WORDS.indexOf(s) >= 0;
}

/* ================================================================================================
 * ROWS
 * ============================================================================================= */

export interface ReflectionRow {
  id: string;
  promptKey: string;
  /** The question that was on screen when it was written, resolved for display. */
  question: string;
  body: string;
  periodWord: string | null;
  sharedWithManager: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

const mapReflection = (r: any): ReflectionRow => {
  const key = String(r?.prompt_key || 'free');
  const spec = promptSpec(key);
  return {
    id: String(r?.id || ''),
    promptKey: key,
    // A prompt retired from the list still has entries written under it. Those keep their key and
    // get an honest label rather than being silently relabelled 'free'.
    question: spec ? spec.question : 'A question that is no longer offered',
    body: String(r?.body || ''),
    periodWord: r?.period_word ? String(r.period_word) : null,
    sharedWithManager: r?.shared_with_manager === true,
    createdAt: iso(r?.created_at),
    updatedAt: iso(r?.updated_at),
  };
};

export interface ReflectionListView {
  rows: ReflectionRow[];
  ok: boolean;
  sentence: string;
  /** Whether the share control may be offered at all. Read from consent, not assumed. */
  sharingEnabled: boolean;
}

/**
 * This person's own reflections, newest first.
 *
 * Narrowed by employee_id, which is the only value a personal query may be narrowed on. There is no
 * variant of this function that takes somebody else's id, and there is no manager-side reader in
 * this module at all — a patch that builds one has to write it, name it, and gate it, and doing
 * that deliberately is the point.
 */
export async function myReflections(employeeId: string, limit = 60): Promise<ReflectionListView> {
  if (!isUuid(employeeId)) {
    return { rows: [], ok: true, sharingEnabled: false, sentence: 'No employee record is linked to this account.' };
  }
  const lim = Math.min(Math.max(Number(limit) || 60, 1), 200);

  const sharingEnabled = await hasConsent(employeeId, 'reflection_visible_to_manager');

  try {
    await ensureIntelligenceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM emp_intel_reflection
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY created_at DESC
       LIMIT ${lim}`)).map(mapReflection);
    return {
      rows,
      ok: true,
      sharingEnabled,
      sentence: rows.length === 0
        ? 'Nothing written yet. These are yours, and nobody else sees them.'
        : rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + ', newest first. Yours alone unless you share one.',
    };
  } catch (e: any) {
    logFail('myReflections', e);
    return {
      rows: [], ok: false, sharingEnabled,
      sentence: 'Your reflections could not be read just now. They are not gone — the list could not be reached.',
    };
  }
}

export interface ReflectionSummary {
  ok: boolean;
  count: number;
  latestAt: string | null;
}

/**
 * How many entries there are and when the last one was — and NOT A WORD OF WHAT THEY SAY.
 *
 * This is what the personal intelligence view is given. It exists as its own function so that the
 * composer cannot be handed the bodies "just in case": the shape it receives has nowhere to put
 * them. COUNT and MAX in one round trip, which is also the cheap way to do it.
 */
export async function reflectionSummary(employeeId: string): Promise<ReflectionSummary> {
  if (!isUuid(employeeId)) return { ok: true, count: 0, latestAt: null };
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n, MAX(created_at) AS latest
        FROM emp_intel_reflection
       WHERE employee_id = ${employeeId}::uuid`))[0];
    return { ok: true, count: Number(r?.n) || 0, latestAt: iso(r?.latest) };
  } catch (e: any) {
    logFail('reflectionSummary', e);
    return { ok: false, count: 0, latestAt: null };
  }
}

export interface ReflectionWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  auditOk?: boolean;
}

export async function writeReflection(input: {
  employeeId: string;
  userId: string | null;
  promptKey: string;
  body: string;
  periodWord?: string | null;
}): Promise<ReflectionWriteResult> {
  if (!isUuid(input.employeeId)) return { ok: false, error: 'No employee record is linked to this account.' };

  const body = clean(input.body, 20000);
  if (!body) return { ok: false, error: 'There is nothing to save yet.' };

  const spec = promptSpec(input.promptKey);
  const promptKey = spec ? spec.key : 'free';
  const word = clean(input.periodWord, 24);
  if (!isPeriodWord(word)) return { ok: false, error: 'Pick one of the offered words, or leave it blank.' };

  let id = '';
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      INSERT INTO emp_intel_reflection (employee_id, user_id, prompt_key, body, period_word)
      VALUES (${input.employeeId}::uuid, ${isUuid(input.userId) ? input.userId : null},
              ${promptKey}, ${body}, ${word || null})
      RETURNING id`))[0];
    id = String(r?.id || '');
  } catch (e: any) {
    logFail('writeReflection', e);
    return { ok: false, error: 'That could not be saved: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  // THE ENTRY'S TEXT IS NOT IN THE AUDIT DIFF, and must never be. The audit row records that a
  // person wrote something private, which is all an audit trail needs; copying the words into a
  // second table with a wider read audience would undo the privacy the row itself is protecting.
  const audit = await logAudit({
    userId: isUuid(input.userId) ? input.userId : null,
    action: 'intelligence.reflection.written',
    entity: 'hr_employee',
    entityId: input.employeeId,
    diff: { prompt: promptKey },
  });

  return { ok: true, id, auditOk: audit.ok };
}

/** Edit your own entry. Narrowed by employee_id in the WHERE clause, not checked in application code. */
export async function editReflection(input: {
  id: string;
  employeeId: string;
  body: string;
  periodWord?: string | null;
}): Promise<ReflectionWriteResult> {
  if (!isUuid(input.id) || !isUuid(input.employeeId)) return { ok: false, error: 'That entry could not be found.' };
  const body = clean(input.body, 20000);
  if (!body) return { ok: false, error: 'An entry cannot be emptied. Delete it instead.' };
  const word = clean(input.periodWord, 24);
  if (!isPeriodWord(word)) return { ok: false, error: 'Pick one of the offered words, or leave it blank.' };

  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      UPDATE emp_intel_reflection
         SET body = ${body}, period_word = ${word || null}, updated_at = NOW()
       WHERE id = ${input.id}::uuid AND employee_id = ${input.employeeId}::uuid
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: 'That entry is not yours to edit.' };
    return { ok: true, id: input.id };
  } catch (e: any) {
    logFail('editReflection', e);
    return { ok: false, error: 'That could not be saved: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }
}

/** Delete your own entry. A real DELETE — a person's own words are not soft-deleted behind their back. */
export async function deleteReflection(input: { id: string; employeeId: string }): Promise<ReflectionWriteResult> {
  if (!isUuid(input.id) || !isUuid(input.employeeId)) return { ok: false, error: 'That entry could not be found.' };
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      DELETE FROM emp_intel_reflection
       WHERE id = ${input.id}::uuid AND employee_id = ${input.employeeId}::uuid
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: 'That entry is not yours to delete.' };
    return { ok: true, id: input.id };
  } catch (e: any) {
    logFail('deleteReflection', e);
    return { ok: false, error: 'That could not be deleted: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }
}

/**
 * Share, or stop sharing, one entry with the reporting manager.
 *
 * TWO GATES, AND THE CONSENT ONE IS CHECKED SERVER-SIDE ON EVERY CALL rather than trusted to the
 * absence of a control in the markup. A form that is not rendered is not a gate; a person with the
 * previous version of the page open, or anything posting directly, reaches this function, and this
 * function refuses.
 *
 * Turning sharing OFF is always allowed, whatever the consent says. A withdrawn consent must be able
 * to unshare what a granted one shared, and making the un-share depend on the same permission as
 * the share would trap entries in the shared state at exactly the moment somebody changed their
 * mind.
 */
export async function setReflectionShared(input: {
  id: string;
  employeeId: string;
  userId: string | null;
  shared: boolean;
}): Promise<ReflectionWriteResult> {
  if (!isUuid(input.id) || !isUuid(input.employeeId)) return { ok: false, error: 'That entry could not be found.' };

  if (input.shared === true) {
    const allowed = await hasConsent(input.employeeId, 'reflection_visible_to_manager');
    if (!allowed) {
      return {
        ok: false,
        error: 'Sharing is switched off for your account. Turn on "Let me share individual reflections with my manager" on the Privacy tab first.',
      };
    }
  }

  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      UPDATE emp_intel_reflection
         SET shared_with_manager = ${input.shared === true}, updated_at = NOW()
       WHERE id = ${input.id}::uuid AND employee_id = ${input.employeeId}::uuid
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: 'That entry is not yours to change.' };
  } catch (e: any) {
    logFail('setReflectionShared', e);
    return { ok: false, error: 'That could not be changed: ' + (e?.cause?.message || e?.message || 'unknown reason') };
  }

  const audit = await logAudit({
    userId: isUuid(input.userId) ? input.userId : null,
    action: 'intelligence.reflection.shared',
    entity: 'hr_employee',
    entityId: input.employeeId,
    diff: { reflectionId: input.id, shared: input.shared === true },
  });
  return { ok: true, id: input.id, auditOk: audit.ok };
}

/**
 * Un-share EVERY entry at once.
 *
 * Called when the sharing consent is withdrawn. Without this, withdrawing consent would hide the
 * control while leaving previously shared entries visible — a withdrawal that withdraws nothing,
 * which is the most common way a consent switch turns out to be decorative.
 */
export async function unshareAllReflections(employeeId: string): Promise<{ ok: boolean; changed: number }> {
  if (!isUuid(employeeId)) return { ok: false, changed: 0 };
  try {
    await ensureIntelligenceSchema();
    const r = rowsOf(await db.execute(sql`
      UPDATE emp_intel_reflection
         SET shared_with_manager = false, updated_at = NOW()
       WHERE employee_id = ${employeeId}::uuid AND shared_with_manager = true
      RETURNING id`));
    return { ok: true, changed: r.length };
  } catch (e: any) {
    logFail('unshareAllReflections', e);
    return { ok: false, changed: 0 };
  }
}
