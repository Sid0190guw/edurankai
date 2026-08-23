// src/lib/talent/onboarding.ts — DIRECT ONBOARDING, after a code has been redeemed at the gate.
//
// Spec sections 11 and 33. Backs tal_onboarding_application and tal_document_ref.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS HAS ITS OWN SESSION, WHEN THE GATE ALREADY ISSUED A PASS
// ---------------------------------------------------------------------------------------------
// The gate pass (src/lib/talent/gate-pass.ts) is stateless, signed, and deliberately short — 45
// minutes — because its job is to get somebody through a door, not to hold a form open. Filling in
// an onboarding form takes longer than that, and more importantly a stateless token CANNOT BE
// REVOKED: if the people desk withdraws a selection while somebody is mid-form, a signed pass keeps
// working until it expires.
//
// So tal_onboarding_application carries session_token_hash and session_expires_at, and this module
// uses them. The secret goes in an httpOnly cookie; only its sha256 is stored, exactly as
// src/lib/auth/session.ts treats session tokens. Revoking is then a single UPDATE.
//
// THE RAW CODE NEVER TRAVELS TWICE. It is typed once, at the gate. From there on the browser carries
// a session secret that is useless anywhere else, and the code itself is referenced only by id.
//
// ---------------------------------------------------------------------------------------------
// TWO RULES THAT ARE NOT NEGOTIABLE
// ---------------------------------------------------------------------------------------------
// 1. ORG-CONTROLLED FIELDS ARE NOT WRITABLE BY THE CANDIDATE — spec 11 rule 3. Position, department,
//    employment type, level, reporting manager, joining date, compensation and identity type come
//    from the selection record. They render read-only, and a POST that carries them is STRIPPED
//    server-side, not merely prevented by a disabled input. A disabled input is a suggestion.
// 2. DOCUMENTS ARE LINKS, NEVER UPLOADS. This platform does not accept document uploads of any kind:
//    a document is a Google Drive link shared "Anyone with the link - Viewer". The validators for
//    that already exist in src/lib/hr-onboarding.ts and are imported rather than restated.
import { createHash, randomBytes } from 'node:crypto';
import { ensureTalentSchema } from './schema';
import { consumeCode } from './codes';
import {
  rowsOf, reasonOf,
  ONBOARDING_SECTIONS, ORG_CONTROLLED_FIELDS, SENSITIVE_DOC_TYPES,
  type OnboardingApplication, type OnboardingStatus, type DocumentRef,
} from './types';
import { isDriveLink, linkProblem, DOC_TYPES, ACCESS_FORMAT, MAX_DOCS } from '@/lib/hr-onboarding';

export { ONBOARDING_SECTIONS, ORG_CONTROLLED_FIELDS, DOC_TYPES, ACCESS_FORMAT, MAX_DOCS };
export type { OnboardingApplication, OnboardingStatus, DocumentRef };

export const ONBOARDING_COOKIE = 'era_onboarding';
/** Long enough to fill in a real form, refreshed on every save. */
export const SESSION_TTL_MINUTES = 120;

function sha256(s: string): string {
  return createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ---------------------------------------------------------------------------------------------
// DECLARATIONS — pure, and honest about what this organisation actually asks.
// ---------------------------------------------------------------------------------------------

export interface DeclarationDef { key: string; label: string; required: boolean }

export const DECLARATIONS: readonly DeclarationDef[] = [
  { key: 'accuracy', required: true, label: 'The information and documents I have given here are accurate and mine.' },
  { key: 'verification', required: true, label: 'I consent to EduRankAI verifying the credentials and documents I have linked.' },
  { key: 'conduct', required: true, label: 'I have read and accept the code of conduct and the confidentiality undertaking.' },
  { key: 'right_to_work', required: true, label: 'I confirm I am entitled to take up this engagement in the country I will work from.' },
  // Stated as a declaration rather than buried in a letter, because it is the single fact people are
  // most often wrong about, and being wrong about it after joining is nobody's idea of a good day.
  { key: 'unpaid_unless_recorded', required: true, label: 'I understand that an internship is unpaid unless a stipend is explicitly recorded on my engagement.' },
  { key: 'contact', required: false, label: 'EduRankAI may contact me about other opportunities in future.' },
];

/** Which required declarations have not been accepted. PURE. */
export function missingDeclarations(submitted: Record<string, unknown>): string[] {
  const given = submitted || {};
  return DECLARATIONS.filter((d) => d.required && given[d.key] !== true).map((d) => d.label);
}

// ---------------------------------------------------------------------------------------------
// THE FORM — pure definitions, so the same shape drives rendering AND validation.
// ---------------------------------------------------------------------------------------------

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  kind: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select';
  section: string;
  options?: readonly string[];
  hint?: string;
}

const COMMON_FIELDS: readonly FieldDef[] = [
  { key: 'fullName', label: 'Full legal name', required: true, kind: 'text', section: 'personal', hint: 'As it appears on your government identification.' },
  { key: 'preferredName', label: 'Preferred name', required: false, kind: 'text', section: 'personal' },
  { key: 'personalEmail', label: 'Personal email', required: true, kind: 'email', section: 'personal' },
  { key: 'phone', label: 'Phone', required: true, kind: 'tel', section: 'personal' },
  { key: 'dateOfBirth', label: 'Date of birth', required: true, kind: 'date', section: 'personal' },
  { key: 'addressLine', label: 'Address', required: true, kind: 'textarea', section: 'personal' },
  { key: 'city', label: 'City', required: true, kind: 'text', section: 'personal' },
  { key: 'country', label: 'Country', required: true, kind: 'text', section: 'personal' },
  { key: 'emergencyContactName', label: 'Emergency contact name', required: true, kind: 'text', section: 'personal' },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone', required: true, kind: 'tel', section: 'personal' },
  { key: 'emergencyContactRelation', label: 'Relationship to you', required: true, kind: 'text', section: 'personal' },
  { key: 'highestQualification', label: 'Highest qualification', required: true, kind: 'text', section: 'academic' },
  { key: 'institution', label: 'Institution', required: true, kind: 'text', section: 'academic' },
  { key: 'yearCompleted', label: 'Year completed', required: false, kind: 'text', section: 'academic' },
];

/**
 * Fields that differ by what somebody is joining as, and ONLY where they honestly differ.
 *
 * An employee owes statutory identifiers and bank details because payroll cannot run without them.
 * An intern or fellow owes their institution and mentor, because that is the relationship the
 * engagement sits inside. Asking an intern for a PF number would be theatre.
 */
const BY_TYPE: ReadonlyArray<readonly [string, readonly FieldDef[]]> = [
  ['employee', [
    { key: 'panNumber', label: 'PAN', required: true, kind: 'text', section: 'identity' },
    { key: 'bankHolder', label: 'Bank account holder name', required: true, kind: 'text', section: 'identity' },
    { key: 'bankAccountNumber', label: 'Bank account number', required: true, kind: 'text', section: 'identity' },
    { key: 'bankIfsc', label: 'Bank IFSC', required: true, kind: 'text', section: 'identity' },
    { key: 'previousEmployer', label: 'Most recent employer', required: false, kind: 'text', section: 'professional' },
    { key: 'noticePeriodStatus', label: 'Notice period status', required: false, kind: 'text', section: 'professional' },
  ]],
  ['intern', [
    { key: 'currentInstitution', label: 'Institution you are currently enrolled at', required: true, kind: 'text', section: 'academic' },
    { key: 'courseAndYear', label: 'Course and year', required: true, kind: 'text', section: 'academic' },
    { key: 'facultyMentor', label: 'Faculty mentor (name and email)', required: false, kind: 'text', section: 'academic' },
  ]],
  ['fellow', [
    { key: 'currentInstitution', label: 'Institution or affiliation', required: true, kind: 'text', section: 'academic' },
    { key: 'researchArea', label: 'Research area', required: true, kind: 'text', section: 'professional' },
  ]],
  ['member', [
    { key: 'affiliation', label: 'Affiliation', required: false, kind: 'text', section: 'professional' },
  ]],
];

/**
 * Which identity type an engagement produces. PURE.
 *
 * tal_selection_decision records employment_type (what the engagement IS); tos identity types are
 * what somebody BECOMES. They are not the same vocabulary and the mapping is written down here once
 * rather than guessed at each call site. An unrecognised employment type resolves to 'employee',
 * which asks for MORE than the others rather than less — the safe direction to be wrong in, because
 * an unnecessary question is recoverable and a missing statutory identifier is not.
 */
const EMPLOYMENT_TO_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ['internship', 'intern'], ['intern', 'intern'],
  ['fellowship', 'fellow'], ['fellow', 'fellow'],
  ['membership', 'member'], ['member', 'member'],
  ['apprenticeship', 'intern'],
  ['full_time', 'employee'], ['part_time', 'employee'], ['contract', 'employee'],
];
export function identityTypeFromEmployment(employmentType: string | null | undefined): string {
  const key = String(employmentType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const hit = EMPLOYMENT_TO_IDENTITY.find((p) => p[0] === key);
  return hit ? hit[1] : 'employee';
}

/** The full field list for an identity type. PURE. */
export function requiredFormFields(identityType: string): readonly FieldDef[] {
  const extra = BY_TYPE.find((p) => p[0] === String(identityType || '').toLowerCase());
  return COMMON_FIELDS.concat(extra ? Array.from(extra[1]) : []);
}

/** Every problem at once, so a candidate is not sent round the loop one field at a time. PURE. */
export function formProblems(identityType: string, form: Record<string, unknown>): string[] {
  const data = form || {};
  const problems: string[] = [];
  for (const f of requiredFormFields(identityType)) {
    if (!f.required) continue;
    const v = data[f.key];
    if (v === null || v === undefined || String(v).trim() === '') problems.push(`${f.label} is required.`);
  }
  const email = String(data.personalEmail || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) problems.push('Personal email does not look like an email address.');
  return problems;
}

/**
 * Strip everything the organisation owns out of a candidate-supplied payload.
 *
 * PURE, and the reason it exists rather than a `disabled` attribute: a disabled input is a
 * suggestion to a browser, not a rule. A candidate who changes their own department in the request
 * body is the whole reason spec 11 rule 3 is written down.
 */
export function stripOrgControlled(form: Record<string, any>): { clean: Record<string, any>; rejected: string[] } {
  const clean: Record<string, any> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(form || {})) {
    if (ORG_CONTROLLED_FIELDS.includes(k)) { rejected.push(k); continue; }
    clean[k] = v;
  }
  return { clean, rejected };
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------------------------

const APP_COLUMNS = `id, onboarding_code_id, onboarding_code_ref, selection_id, person_id, status,
  form_data, sections_complete, declarations, submitted_at, reviewed_by, reviewed_at, review_note,
  approved_at, identity_id`;

function toApp(x: any): OnboardingApplication {
  return {
    id: String(x.id),
    onboardingCodeId: String(x.onboarding_code_id),
    onboardingCodeRef: String(x.onboarding_code_ref || ''),
    selectionId: String(x.selection_id),
    personId: String(x.person_id),
    status: String(x.status) as OnboardingStatus,
    formData: (x.form_data && typeof x.form_data === 'object') ? x.form_data : {},
    sectionsComplete: Array.isArray(x.sections_complete) ? x.sections_complete.map(String) : [],
    declarations: (x.declarations && typeof x.declarations === 'object') ? x.declarations : {},
    submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
    reviewedBy: x.reviewed_by ? String(x.reviewed_by) : null,
    reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
    reviewNote: x.review_note ? String(x.review_note) : null,
    approvedAt: x.approved_at ? new Date(x.approved_at).toISOString() : null,
    identityId: x.identity_id ? String(x.identity_id) : null,
  };
}

export interface StartResult { ok: boolean; error?: string; secret?: string; app?: OnboardingApplication }

/**
 * Begin or resume onboarding for a redeemed code, and issue a session.
 *
 * FIND-OR-CREATE, keyed on selection_id, which carries a unique index. Reopening must never reset a
 * submission that has already been sent for review back to 'in_progress' — somebody clicking their
 * emailed link a second time after submitting would otherwise silently undo their own submission.
 */
export async function startOrResume(args: {
  codeRowId: string; codeRef: string; selectionId: string; personId: string;
}): Promise<StartResult> {
  try {
    const { db, sql } = await ctx();
    const secret = randomBytes(32).toString('hex');

    const existing = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application
      WHERE selection_id = ${args.selectionId}::uuid LIMIT 1
    `));

    if (existing.length) {
      const app = toApp(existing[0]);
      // A finished application does not get a new session. Nothing about it is still editable, and
      // handing back a session would imply otherwise.
      if (app.status === 'approved' || app.status === 'rejected') {
        return { ok: true, app };
      }
      await db.execute(sql`
        UPDATE tal_onboarding_application
        SET session_token_hash = ${sha256(secret)},
            session_expires_at = NOW() + make_interval(mins => ${SESSION_TTL_MINUTES}),
            updated_at = NOW()
        WHERE id = ${app.id}::uuid
      `);
      return { ok: true, secret, app };
    }

    const ins = rowsOf(await db.execute(sql`
      INSERT INTO tal_onboarding_application (
        onboarding_code_id, onboarding_code_ref, selection_id, person_id, status,
        session_token_hash, session_expires_at
      ) VALUES (
        ${args.codeRowId}::uuid, ${args.codeRef}, ${args.selectionId}::uuid, ${args.personId}::uuid,
        'in_progress', ${sha256(secret)}, NOW() + make_interval(mins => ${SESSION_TTL_MINUTES})
      )
      ON CONFLICT (selection_id) DO UPDATE
        SET session_token_hash = EXCLUDED.session_token_hash,
            session_expires_at = EXCLUDED.session_expires_at,
            updated_at = NOW()
      RETURNING ${sql.raw(APP_COLUMNS)}
    `));
    if (!ins.length) return { ok: false, error: 'The onboarding record could not be created.' };
    return { ok: true, secret, app: toApp(ins[0]) };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

/**
 * Resolve a session cookie to its application.
 *
 * The expiry is checked IN THE QUERY, server-side. A cookie Max-Age is a request to a browser; it is
 * not a control, and a copied cookie value has no Max-Age at all.
 */
export async function resolveSession(secret: string | null | undefined): Promise<OnboardingApplication | null> {
  if (!secret) return null;
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application
      WHERE session_token_hash = ${sha256(secret)} AND session_expires_at > NOW() LIMIT 1
    `));
    return r.length ? toApp(r[0]) : null;
  } catch (e: any) {
    console.error('[talent-onboarding] resolveSession: ' + reasonOf(e));
    return null;
  }
}

/** End a session server-side. What makes an in-flight onboarding revocable at all. */
export async function endSession(applicationId: string): Promise<void> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      UPDATE tal_onboarding_application SET session_token_hash = NULL, session_expires_at = NULL, updated_at = NOW()
      WHERE id = ${applicationId}::uuid
    `);
  } catch (e: any) {
    console.error('[talent-onboarding] endSession: ' + reasonOf(e));
  }
}

/**
 * Everything the form should show, pre-populated from what the database ACTUALLY holds.
 *
 * Never invents a value. A blank field is the honest answer when nothing is on record — a plausible
 * guess in a legal-name box is worse than an empty one, because people do not re-read what looks
 * already-filled.
 */
export async function prefillFor(app: OnboardingApplication): Promise<{
  person: Record<string, any>; org: Record<string, any>;
}> {
  const blank = { person: {}, org: {} };
  try {
    const { db, sql } = await ctx();
    const per = rowsOf(await db.execute(sql`
      SELECT display_name, preferred_name, primary_email, primary_phone, country
      FROM tal_person WHERE id = ${app.personId}::uuid LIMIT 1
    `));
    const sel = rowsOf(await db.execute(sql`
      SELECT s.employment_type, s.department_id, s.level, s.proposed_joining_date,
             s.position_id, s.compensation_note, s.reporting_manager_user_id,
             o.title AS opportunity_title
      FROM tal_selection_decision s
      LEFT JOIN tal_opportunity o ON o.id = s.opportunity_id
      WHERE s.id = ${app.selectionId}::uuid LIMIT 1
    `));
    const p = (per[0] || {}) as any;
    const s = (sel[0] || {}) as any;
    return {
      person: {
        fullName: p.display_name || '',
        preferredName: p.preferred_name || '',
        personalEmail: p.primary_email || '',
        phone: p.primary_phone || '',
        country: p.country || '',
      },
      // ORG-CONTROLLED. Rendered read-only and stripped from any POST — see stripOrgControlled().
      org: {
        position: s.opportunity_title || '',
        positionId: s.position_id || null,
        departmentId: s.department_id || null,
        employmentType: s.employment_type || '',
        level: s.level || '',
        joiningDate: s.proposed_joining_date || null,
        compensation: s.compensation_note || '',
        reportingManagerUserId: s.reporting_manager_user_id || null,
      },
    };
  } catch (e: any) {
    console.error('[talent-onboarding] prefillFor: ' + reasonOf(e));
    return blank;
  }
}

/** Save progress. Refreshes the session, so a long form does not expire under somebody working on it. */
export async function saveDraft(applicationId: string, form: Record<string, any>, sectionsComplete: string[]): Promise<{ ok: boolean; error?: string; rejected?: string[] }> {
  try {
    const { db, sql } = await ctx();
    const { clean, rejected } = stripOrgControlled(form || {});
    const validSections = (sectionsComplete || []).filter((k) => ONBOARDING_SECTIONS.some((s) => s.key === k));
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_application
      SET form_data = form_data || ${JSON.stringify(clean)}::jsonb,
          sections_complete = ${JSON.stringify(validSections)}::jsonb,
          session_expires_at = NOW() + make_interval(mins => ${SESSION_TTL_MINUTES}),
          updated_at = NOW()
      WHERE id = ${applicationId}::uuid AND status IN ('in_progress', 'changes_requested')
      RETURNING id
    `));
    if (!r.length) return { ok: false, error: 'This onboarding is no longer open for editing.' };
    return { ok: true, rejected };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// DOCUMENTS — links, never uploads.
// ---------------------------------------------------------------------------------------------

export async function listDocuments(applicationId: string): Promise<DocumentRef[]> {
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT id, subject_kind, subject_id, person_id, doc_type, title, drive_url, is_sensitive,
             status, version, replaces_id, expires_on, review_note, reviewed_by, reviewed_at
      FROM tal_document_ref
      WHERE subject_kind = 'onboarding' AND subject_id = ${applicationId}::uuid AND status <> 'replaced'
      ORDER BY created_at ASC
    `));
    return r.map((x: any) => ({
      id: String(x.id), subjectKind: 'onboarding', subjectId: String(x.subject_id),
      personId: String(x.person_id), docType: String(x.doc_type), title: String(x.title || ''),
      driveUrl: String(x.drive_url), isSensitive: x.is_sensitive === true,
      status: String(x.status) as DocumentRef['status'], version: Number(x.version || 1),
      replacesId: x.replaces_id ? String(x.replaces_id) : null,
      expiresOn: x.expires_on ? String(x.expires_on) : null,
      reviewNote: x.review_note ? String(x.review_note) : null,
      reviewedBy: x.reviewed_by ? String(x.reviewed_by) : null,
      reviewedAt: x.reviewed_at ? new Date(x.reviewed_at).toISOString() : null,
    }));
  } catch (e: any) {
    console.error('[talent-onboarding] listDocuments: ' + reasonOf(e));
    return [];
  }
}

export async function addDocument(args: {
  applicationId: string; personId: string; docType: string; title: string; driveUrl: string;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const url = String(args.driveUrl || '').trim();
    const problem = linkProblem(url);
    if (problem) return { ok: false, error: problem };
    if (!isDriveLink(url)) return { ok: false, error: `Share the document from Google Drive, set to "${ACCESS_FORMAT}".` };
    if (!DOC_TYPES.some((d) => d.key === args.docType)) return { ok: false, error: 'Choose what kind of document this is.' };

    const { db, sql } = await ctx();
    const existing = await listDocuments(args.applicationId);
    if (existing.length >= MAX_DOCS) {
      return { ok: false, error: `You can link up to ${MAX_DOCS} documents. Remove one before adding another.` };
    }

    // Identity-class documents are flagged on WRITE, so a reviewer needs document.view_sensitive and
    // the read is audited before the link is revealed. Flagging at read time would mean the first
    // reader saw it unflagged.
    const isSensitive = SENSITIVE_DOC_TYPES.includes(args.docType);

    const r = rowsOf(await db.execute(sql`
      INSERT INTO tal_document_ref (subject_kind, subject_id, person_id, doc_type, title, drive_url, is_sensitive, status, version)
      VALUES ('onboarding', ${args.applicationId}::uuid, ${args.personId}::uuid, ${args.docType},
              ${String(args.title || '').slice(0, 200)}, ${url}, ${isSensitive}, 'submitted', 1)
      RETURNING id
    `));
    return { ok: true, id: String((r[0] as any)?.id || '') };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

export async function removeDocument(documentId: string, applicationId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    // Scoped to the application. An id in a request body is a request, never a permission — without
    // the subject_id clause this deletes any document in the system by guessing a uuid.
    const r = rowsOf(await db.execute(sql`
      DELETE FROM tal_document_ref
      WHERE id = ${documentId}::uuid AND subject_kind = 'onboarding' AND subject_id = ${applicationId}::uuid
        AND status = 'submitted'
      RETURNING id
    `));
    if (!r.length) return { ok: false, error: 'That document could not be removed.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// SUBMISSION
// ---------------------------------------------------------------------------------------------

export interface SubmitResult { ok: boolean; error?: string; problems?: string[] }

/**
 * Submit for review, and spend the code.
 *
 * THE ORDER HERE IS THE RACE FIX. Everything that can be validated is validated FIRST, then the code
 * is consumed ATOMICALLY, and only if that consume returns ok does the application move to
 * 'submitted'. consumeCode() re-asserts every precondition inside its own WHERE clause, so of two
 * simultaneous submissions of one single-use code exactly one wins — and the loser is told nothing
 * was started twice rather than being handed a second onboarding.
 *
 * Consuming BEFORE validating would burn a code on a form with a missing phone number.
 */
export async function submitOnboarding(args: {
  applicationId: string; identityType: string; form: Record<string, any>;
  declarations: Record<string, any>; ip: string | null;
}): Promise<SubmitResult> {
  try {
    const { db, sql } = await ctx();

    const cur = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application WHERE id = ${args.applicationId}::uuid LIMIT 1
    `));
    if (!cur.length) return { ok: false, error: 'This onboarding record could not be read.' };
    const app = toApp(cur[0]);
    if (app.status !== 'in_progress' && app.status !== 'changes_requested') {
      return { ok: false, error: 'This onboarding has already been submitted.' };
    }

    const { clean } = stripOrgControlled(args.form || {});
    const merged = { ...app.formData, ...clean };

    const problems = formProblems(args.identityType, merged);
    for (const label of missingDeclarations(args.declarations || {})) problems.push(label);

    const docs = await listDocuments(args.applicationId);
    if (!docs.length) problems.push('Link at least one document before submitting.');

    if (problems.length) return { ok: false, problems, error: 'Some answers still need attention.' };

    // SPEND THE CODE. Nothing below this line runs if it fails.
    const spent = await consumeCode(app.onboardingCodeId, args.ip);
    if (!spent.ok) return { ok: false, error: spent.error || 'That code could not be used.' };

    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_application
      SET form_data = ${JSON.stringify(merged)}::jsonb,
          declarations = ${JSON.stringify(args.declarations || {})}::jsonb,
          status = 'submitted', submitted_at = NOW(),
          session_token_hash = NULL, session_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${args.applicationId}::uuid AND status IN ('in_progress', 'changes_requested')
      RETURNING id
    `));
    if (!r.length) {
      // The code IS spent at this point and the row did not move. That is a genuine inconsistency and
      // it is reported rather than swallowed, because a candidate whose code is gone and whose
      // application says in-progress needs a human, immediately.
      return { ok: false, error: 'Your code was accepted but the submission did not save. Contact the people desk quoting your onboarding reference; do not re-enter your code.' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

export async function applicationById(id: string): Promise<OnboardingApplication | null> {
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application WHERE id = ${id}::uuid LIMIT 1
    `));
    return r.length ? toApp(r[0]) : null;
  } catch (e: any) {
    console.error('[talent-onboarding] applicationById: ' + reasonOf(e));
    return null;
  }
}

/** The review queue. Admin-side; the caller gates it. */
export async function listSubmissions(filter: { status?: string; limit?: number; offset?: number } = {}): Promise<OnboardingApplication[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const r = filter.status
      ? rowsOf(await db.execute(sql`SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application WHERE status = ${filter.status} ORDER BY submitted_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`))
      : rowsOf(await db.execute(sql`SELECT ${sql.raw(APP_COLUMNS)} FROM tal_onboarding_application ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`));
    return r.map(toApp);
  } catch (e: any) {
    console.error('[talent-onboarding] listSubmissions: ' + reasonOf(e));
    return [];
  }
}

/** Send it back for changes. Reopens editing and issues no session — the candidate starts a new one. */
export async function requestChanges(id: string, reviewerUserId: string, note: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const why = String(note || '').trim();
    if (!why) return { ok: false, error: 'Say what needs changing. A bare rejection is not reviewable.' };
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_application
      SET status = 'changes_requested', reviewed_by = ${reviewerUserId}::uuid, reviewed_at = NOW(),
          review_note = ${why.slice(0, 2000)}, updated_at = NOW()
      WHERE id = ${id}::uuid AND status = 'submitted' RETURNING id
    `));
    if (!r.length) return { ok: false, error: 'Only a submitted onboarding can be sent back.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}
