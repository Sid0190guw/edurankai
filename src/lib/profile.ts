// src/lib/profile.ts — THE ONE PAGE AN EMPLOYEE OWNS ABOUT THEMSELVES.
//
// =================================================================================================
// EXISTING STORAGE FIRST. THIS FILE ADDS ONE TABLE, AND ONLY FOR WHAT HAD NOWHERE TO LIVE.
// =================================================================================================
//
// `hr_employees` already holds most of a person's record, and every HR screen already reads it. So
// this module WRITES BACK INTO IT rather than shadowing it:
//
//   personal          hr_employees.date_of_birth, nationality, phone, personal_email, address,
//                     city, state, country
//   emergency contact hr_employees.emergency_contact_name / _phone / _relation
//   bank              hr_employees.bank_name, bank_holder, bank_account_number, bank_ifsc, bank_branch
//   tax & statutory   hr_employees.pan_number, uan_number, pf_number, esic_number
//   photo             hr_employees.photo_url and users.photo_url, the same two columns the face
//                     enrolment path already writes (src/pages/api/auth/enroll-face-selfie.ts)
//
// A SECOND copy of any of those would be two answers to one question, and the one HR reads would be
// the stale one. There is exactly one new table, `hr_employee_profile`, and it holds only the things
// with no column anywhere: education, experience, skills, languages, certifications, achievements,
// social links, identity-document LINKS, additional emergency contacts, and the signature link.
//
// =================================================================================================
// MEDICAL INFORMATION IS NOT HERE, AND THAT IS THE POINT
// =================================================================================================
//
// THERE IS NO MEDICAL SECTION IN THIS MODULE AND THERE MUST NEVER BE ONE. No condition, no
// allergy list, no medication, no blood group, no disability disclosure — no field an administrator
// or the founder could open and read one person's health from. That is not an oversight to be tidied
// up later; individual health data is never visible to any admin on this platform, and the wellness
// system (src/lib/wellness.ts) is gated server-side for exactly this reason.
//
// `hr_employees.blood_group` EXISTS as a column and is deliberately NOT read, written or rendered by
// anything in this file. What an emergency actually needs is somebody to telephone, and that is what
// the emergency-contact section holds: a name, a number, a relationship — information the employee
// chooses to share, described on screen as exactly that.
//
// =================================================================================================
// WHOSE ROW, AND WHO MAY SEE IT
// =================================================================================================
//
// Every function here takes an `employeeId` and scopes the WHERE clause to it. The employee surface
// resolves that id from the SIGNED-IN SESSION through requireEmployee() and never from a form field,
// so a posted id cannot address somebody else's record.
//
// THIS MODULE WIDENS NOBODY'S VISIBILITY. HR already reads hr_employees on /admin/hr/employees and
// keeps doing so; the new table adds sections an employee wrote about themselves, and nothing here
// builds an admin screen over them. If a future surface wants one, it needs its own decision and its
// own gate — it does not get one by importing this file.
//
// =================================================================================================
// DOCUMENTS ARE LINKS. THE PHOTO IS THE ONE EXCEPTION, AND IT IS A SMALL ONE.
// =================================================================================================
//
// Identity documents, certificates and the signature are all LINKS to a shared document with view
// access. Nothing is uploaded, because an upload is storage cost, a retention question and a second
// place for a person's paperwork to live.
//
// The profile PHOTO is the single stored upload on this platform: captured live or chosen from the
// device, resized to a small JPEG in the browser, and saved through savePhoto() below — which reuses
// the EXACT path the face-enrolment endpoint already uses (a blob store when one is configured, and
// the inline image when one is not). No new upload infrastructure, no second storage decision.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. rows() normalises; `r.rows[0]` is always a bug.
//   - The real Postgres reason is `e.cause.message`; `e.message` is only the failed SQL.
//   - Every `const` is declared ABOVE its first use. `const` is not hoisted.
//   - NO WRITE PATH SWALLOWS AN EXCEPTION. Every catch logs the real cause and returns
//     { ok: false, error }, because a save that failed and said "Saved" is how a person discovers
//     six months later that their emergency contact was never recorded.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[profile] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const SCHEMA_FAILED = 'Your profile store is not ready yet, so nothing was saved. Try again in a moment.';

const MAX_LINE = 300;
const MAX_TEXT = 2000;
/** How many entries one list section holds. A person with sixty jobs has a CV, not a profile. */
const MAX_ITEMS = 40;
/** The largest profile photo we accept, as a data URL. A 320px JPEG is far under this. */
const MAX_PHOTO_BYTES = 900_000;

/**
 * THE LIST SECTIONS — the ones with no column anywhere, each an array of small objects.
 *
 * A closed list, checked at every write, because the section name reaches a SQL identifier. It never
 * reaches one by interpolation (see writeSection below — the column is chosen by an explicit branch,
 * never built from the string), and this set is the second lock on that door rather than the first.
 */
export const PROFILE_SECTIONS = [
  'education',
  'experience',
  'skills',
  'languages',
  'certifications',
  'achievements',
  'social_links',
  'identity_documents',
  'emergency_contacts',
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

const SECTION_SET = new Set<string>(PROFILE_SECTIONS);
export function isProfileSection(v: unknown): v is ProfileSection {
  return typeof v === 'string' && SECTION_SET.has(v);
}

export function sectionLabel(v: string): string {
  const key = String(v || '');
  if (key === 'education') return 'Education';
  if (key === 'experience') return 'Experience';
  if (key === 'skills') return 'Skills';
  if (key === 'languages') return 'Languages';
  if (key === 'certifications') return 'Certifications';
  if (key === 'achievements') return 'Achievements';
  if (key === 'social_links') return 'Links';
  if (key === 'identity_documents') return 'Identity documents';
  if (key === 'emergency_contacts') return 'Additional emergency contacts';
  return key;
}

// -------------------------------------------------------------------------------------------------
// STORAGE — one table, inside an ensureOnce guard.
// -------------------------------------------------------------------------------------------------

export function ensureProfileSchema(): Promise<void> {
  return ensureOnce('employee_profile_v1', async () => {
    try {
      await createProfileTable();
    } catch (e: any) {
      logFail('ensureProfileSchema', e);
      throw e;
    }
  });
}

/**
 * ensureOnce() hides the rejection from callers, so a write asks the database directly rather than
 * trusting that the ensure "returned". to_regclass answers NULL for a missing table instead of
 * throwing, which is exactly the question.
 */
async function schemaReady(): Promise<boolean> {
  try {
    await ensureProfileSchema();
    const r = rows(await db.execute(sql`
      SELECT to_regclass('public.hr_employee_profile') IS NOT NULL AS ok`));
    return r.length > 0 && r[0]?.ok === true;
  } catch (e: any) {
    logFail('schemaReady', e);
    return false;
  }
}

async function createProfileTable(): Promise<void> {
  // ONE ROW PER EMPLOYEE. employee_id is the PRIMARY KEY, so "two profiles for one person" is not a
  // state this table can be in — the upsert below has a conflict target that cannot be missing.
  //
  // JSONB per section rather than nine child tables: these are short, ordered, self-contained lists
  // that are always read together and never joined or aggregated. Nine tables would be nine
  // ensure-blocks, nine round trips per page load and nine chances for one of them to be absent.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_employee_profile (
    employee_id        UUID PRIMARY KEY,
    education          JSONB NOT NULL DEFAULT '[]'::jsonb,
    experience         JSONB NOT NULL DEFAULT '[]'::jsonb,
    skills             JSONB NOT NULL DEFAULT '[]'::jsonb,
    languages          JSONB NOT NULL DEFAULT '[]'::jsonb,
    certifications     JSONB NOT NULL DEFAULT '[]'::jsonb,
    achievements       JSONB NOT NULL DEFAULT '[]'::jsonb,
    social_links       JSONB NOT NULL DEFAULT '[]'::jsonb,
    identity_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
    emergency_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
    signature_url      TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // CREATE TABLE IF NOT EXISTS is a NO-OP on an existing table, including one missing columns — the
  // shape that locked every administrator out of /admin for a day when hr_employees.work_email was
  // declared in the schema file and absent from the live table. So every column is asserted again.
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS education JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS experience JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS languages JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS certifications JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS achievements JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS identity_documents JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS emergency_contacts JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS signature_url TEXT`);
  await db.execute(sql`ALTER TABLE hr_employee_profile ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // NO MEDICAL COLUMN. Stated in DDL as well as in prose, because a schema is where the next person
  // looks first: there is nowhere in this table to put one person's health, and adding one would
  // need a deliberate change that a reviewer would see.

  // The columns an employee edits on hr_employees. Asserted here so the profile page cannot 500 on a
  // database where the HR screens that usually add them have never been opened — the same reason
  // db/hr-schema.sql asserts them and /admin/hr/employees re-asserts them at page load.
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS nationality TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_relation TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS city TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS state TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS country TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pf_number TEXT`);
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT`);
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

/** One entry in a list section. Every field optional but `label`, so a half-filled row still saves. */
export interface ProfileEntry {
  label: string;
  detail?: string | null;
  /** Free text: a year, a range, a level. Not parsed, not sorted on, not validated into a date. */
  period?: string | null;
  /** A shared document link. Never an upload. */
  url?: string | null;
}

export interface PersonalDetails {
  fullName: string;
  employeeCode: string | null;
  designation: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  photoUrl: string | null;
}

export interface EmergencyContact {
  name: string | null;
  phone: string | null;
  relation: string | null;
}

export interface BankDetails {
  bankName: string | null;
  holder: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  branch: string | null;
}

export interface TaxDetails {
  pan: string | null;
  uan: string | null;
  pf: string | null;
  esic: string | null;
}

export interface EmployeeProfile {
  employeeId: string;
  personal: PersonalDetails;
  /** The primary emergency contact, on hr_employees where HR already reads it. */
  emergency: EmergencyContact;
  /** Extra people to call, in the profile table. Same shape, so a screen renders one list. */
  additionalEmergency: ProfileEntry[];
  bank: BankDetails;
  tax: TaxDetails;
  education: ProfileEntry[];
  experience: ProfileEntry[];
  skills: ProfileEntry[];
  languages: ProfileEntry[];
  certifications: ProfileEntry[];
  achievements: ProfileEntry[];
  socialLinks: ProfileEntry[];
  identityDocuments: ProfileEntry[];
  signatureUrl: string | null;
  updatedAt: string | null;
}

export interface WriteResult {
  ok: boolean;
  changed?: boolean;
  error?: string;
}

// -------------------------------------------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------------------------------------------

function text(v: unknown, max = MAX_LINE): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * A shared document link, or null. http(s) only, and never a data: or javascript: URL — those two
 * would render as a link on a page other people can be shown.
 */
export function normaliseLink(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  return s.slice(0, 1000);
}

/** Parse a JSONB column into entries, dropping anything that is not shaped like one. */
function entries(v: any): ProfileEntry[] {
  let list: any = v;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out: ProfileEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = text((item as any).label);
    if (!label) continue;
    out.push({
      label,
      detail: text((item as any).detail, MAX_TEXT),
      period: text((item as any).period, 80),
      url: normaliseLink((item as any).url),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// READ
// -------------------------------------------------------------------------------------------------

/**
 * The whole profile for ONE employee, in one object and two queries.
 *
 * Returns null when there is no employee row to build it from — the caller renders the honest "no
 * employee record is linked to this account" screen rather than an empty form that would silently
 * save nothing.
 *
 * A MISSING PROFILE ROW IS NOT AN ERROR. Everybody starts without one; the lists come back empty and
 * the first save creates the row. That is why this does not INSERT on read: a read that writes turns
 * every page view by a curious admin into a row somebody has to explain.
 */
export async function getProfile(employeeId: string): Promise<EmployeeProfile | null> {
  if (!isUuid(employeeId)) return null;
  try {
    await ensureProfileSchema();

    const er = rows(await db.execute(sql`
      SELECT id, full_name, employee_code, designation, work_email, personal_email, email, phone,
             date_of_birth, nationality, address, city, state, country, photo_url,
             emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
             bank_name, bank_holder, bank_account_number, bank_ifsc, bank_branch,
             pan_number, uan_number, pf_number, esic_number
        FROM hr_employees
       WHERE id = ${employeeId}::uuid
       LIMIT 1`));
    if (!er.length) return null;
    const e = er[0];

    const pr = rows(await db.execute(sql`
      SELECT * FROM hr_employee_profile WHERE employee_id = ${employeeId}::uuid LIMIT 1`));
    const p = pr.length ? pr[0] : {};

    return {
      employeeId,
      personal: {
        fullName: String(e.full_name || ''),
        employeeCode: e.employee_code ? String(e.employee_code) : null,
        designation: e.designation ? String(e.designation) : null,
        workEmail: e.work_email ? String(e.work_email) : (e.email ? String(e.email) : null),
        personalEmail: e.personal_email ? String(e.personal_email) : null,
        phone: e.phone ? String(e.phone) : null,
        dateOfBirth: e.date_of_birth ? String(e.date_of_birth).slice(0, 10) : null,
        nationality: e.nationality ? String(e.nationality) : null,
        address: e.address ? String(e.address) : null,
        city: e.city ? String(e.city) : null,
        state: e.state ? String(e.state) : null,
        country: e.country ? String(e.country) : null,
        photoUrl: e.photo_url ? String(e.photo_url) : null,
      },
      emergency: {
        name: e.emergency_contact_name ? String(e.emergency_contact_name) : null,
        phone: e.emergency_contact_phone ? String(e.emergency_contact_phone) : null,
        relation: e.emergency_contact_relation ? String(e.emergency_contact_relation) : null,
      },
      additionalEmergency: entries(p.emergency_contacts),
      bank: {
        bankName: e.bank_name ? String(e.bank_name) : null,
        holder: e.bank_holder ? String(e.bank_holder) : null,
        accountNumber: e.bank_account_number ? String(e.bank_account_number) : null,
        ifsc: e.bank_ifsc ? String(e.bank_ifsc) : null,
        branch: e.bank_branch ? String(e.bank_branch) : null,
      },
      tax: {
        pan: e.pan_number ? String(e.pan_number) : null,
        uan: e.uan_number ? String(e.uan_number) : null,
        pf: e.pf_number ? String(e.pf_number) : null,
        esic: e.esic_number ? String(e.esic_number) : null,
      },
      education: entries(p.education),
      experience: entries(p.experience),
      skills: entries(p.skills),
      languages: entries(p.languages),
      certifications: entries(p.certifications),
      achievements: entries(p.achievements),
      socialLinks: entries(p.social_links),
      identityDocuments: entries(p.identity_documents),
      signatureUrl: p.signature_url ? String(p.signature_url) : null,
      updatedAt: p.updated_at ? new Date(p.updated_at).toISOString() : null,
    };
  } catch (e: any) {
    logFail('getProfile', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// COMPLETION — what is still missing, said in words the person can act on.
// -------------------------------------------------------------------------------------------------

export interface CompletionItem {
  key: string;
  label: string;
  done: boolean;
  /** Optional sections count toward nothing. Bank details are OPTIONAL and never chase anybody. */
  optional: boolean;
}

export interface ProfileCompletion {
  percent: number;
  done: number;
  total: number;
  items: CompletionItem[];
}

/**
 * HOW COMPLETE IS THIS PROFILE?
 *
 * BANK DETAILS ARE OPTIONAL AND ARE EXCLUDED FROM THE PERCENTAGE. A progress bar that will not reach
 * 100% until somebody types their account number is a demand wearing the costume of a suggestion,
 * and this product does not require an employee to hand over a bank account to use their own
 * profile. The same is true of tax and identity documents: they are listed, they are marked
 * optional, and they do not move the number.
 *
 * NOTHING MEDICAL IS COUNTED, ASKED FOR, OR NAMED — there is no such section.
 */
export function profileCompletion(p: EmployeeProfile): ProfileCompletion {
  const has = (v: unknown) => String(v ?? '').trim().length > 0;
  const items: CompletionItem[] = [
    { key: 'photo', label: 'Profile photo', done: has(p.personal.photoUrl), optional: false },
    { key: 'contact', label: 'Phone number', done: has(p.personal.phone), optional: false },
    { key: 'address', label: 'Address', done: has(p.personal.address) || has(p.personal.city), optional: false },
    { key: 'emergency', label: 'Emergency contact', done: has(p.emergency.name) && has(p.emergency.phone), optional: false },
    { key: 'education', label: 'Education', done: p.education.length > 0, optional: false },
    { key: 'experience', label: 'Experience', done: p.experience.length > 0, optional: false },
    { key: 'skills', label: 'Skills', done: p.skills.length > 0, optional: false },
    { key: 'languages', label: 'Languages', done: p.languages.length > 0, optional: false },
    { key: 'certifications', label: 'Certifications', done: p.certifications.length > 0, optional: true },
    { key: 'achievements', label: 'Achievements', done: p.achievements.length > 0, optional: true },
    { key: 'links', label: 'Links', done: p.socialLinks.length > 0, optional: true },
    { key: 'identity', label: 'Identity documents', done: p.identityDocuments.length > 0, optional: true },
    { key: 'signature', label: 'Digital signature', done: has(p.signatureUrl), optional: true },
    { key: 'bank', label: 'Bank details', done: has(p.bank.accountNumber), optional: true },
    { key: 'tax', label: 'Tax and statutory', done: has(p.tax.pan) || has(p.tax.uan), optional: true },
  ];
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  const total = required.length;
  return {
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    done,
    total,
    items,
  };
}

// -------------------------------------------------------------------------------------------------
// WRITES — every one scoped to ONE employee id, resolved by the caller from the session.
// -------------------------------------------------------------------------------------------------

export interface PersonalInput {
  phone?: string | null;
  personalEmail?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

/**
 * The employee's own personal details.
 *
 * WHAT IS DELIBERATELY NOT WRITABLE HERE: full name, employee code, designation, department,
 * employment type, joining date, salary and the reporting line. Those are the EMPLOYMENT RECORD, HR
 * writes them on /admin/hr/employees, and a profile page that let a person change their own
 * designation would be an org chart anybody could edit.
 *
 * `gender` and `blood_group` are not written either. Nothing in this module reads or writes them.
 */
export async function savePersonal(
  employeeId: string,
  input: PersonalInput,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  const dob = text(input?.dateOfBirth, 10);
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return { ok: false, error: 'That date of birth is not a date we can read. Use the date picker.' };
  }

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees
         SET phone = ${text(input?.phone, 40)}::text,
             personal_email = ${text(input?.personalEmail)}::text,
             date_of_birth = ${dob}::date,
             nationality = ${text(input?.nationality, 80)}::text,
             address = ${text(input?.address, MAX_TEXT)}::text,
             city = ${text(input?.city, 120)}::text,
             state = ${text(input?.state, 120)}::text,
             country = ${text(input?.country, 120)}::text,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'That record is not available.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.personal.save',
      entity: 'hr_employee',
      entityId: employeeId,
      // WHAT CHANGED, NOT WHAT IT CHANGED TO. An audit row naming a person's home address and date
      // of birth turns the audit log into a second copy of the data it is supposed to be watching.
      diff: { fields: ['phone', 'personal_email', 'date_of_birth', 'nationality', 'address', 'city', 'state', 'country'] },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('savePersonal', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * The primary emergency contact — WHO TO TELEPHONE, and nothing else.
 *
 * This is the ONLY thing in this module that touches an emergency at all, and it is deliberately
 * contact information rather than health information. No condition, no allergy, no medication and no
 * blood group: an employer needs somebody to call, and the difference between those two is the
 * difference between help and a health record an administrator can read.
 */
export async function saveEmergency(
  employeeId: string,
  input: { name?: string | null; phone?: string | null; relation?: string | null },
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees
         SET emergency_contact_name = ${text(input?.name)}::text,
             emergency_contact_phone = ${text(input?.phone, 40)}::text,
             emergency_contact_relation = ${text(input?.relation, 80)}::text,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'That record is not available.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.emergency.save',
      entity: 'hr_employee',
      entityId: employeeId,
      diff: { fields: ['emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation'] },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('saveEmergency', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Bank details. OPTIONAL, ALWAYS — and every field may be blank.
 *
 * Nothing in this product refuses a person their profile, their leave or their work because they
 * have not handed over an account number, and profileCompletion() excludes this section from the
 * percentage for exactly that reason. Clearing the fields is a legitimate save, not an error.
 */
export async function saveBank(
  employeeId: string,
  input: Partial<BankDetails>,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees
         SET bank_name = ${text(input?.bankName, 160)}::text,
             bank_holder = ${text(input?.holder, 160)}::text,
             bank_account_number = ${text(input?.accountNumber, 40)}::text,
             bank_ifsc = ${text(input?.ifsc, 20)}::text,
             bank_branch = ${text(input?.branch, 160)}::text,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'That record is not available.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.bank.save',
      entity: 'hr_employee',
      entityId: employeeId,
      // NEVER the account number. An audit trail that copies the value defeats the point of guarding
      // the column it was copied from.
      diff: { fields: ['bank_name', 'bank_holder', 'bank_account_number', 'bank_ifsc', 'bank_branch'] },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('saveBank', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Tax and statutory numbers. Optional, like the bank section, and excluded from the percentage. */
export async function saveTax(
  employeeId: string,
  input: Partial<TaxDetails>,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees
         SET pan_number = ${text(input?.pan, 20)}::text,
             uan_number = ${text(input?.uan, 30)}::text,
             pf_number = ${text(input?.pf, 40)}::text,
             esic_number = ${text(input?.esic, 30)}::text,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'That record is not available.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.tax.save',
      entity: 'hr_employee',
      entityId: employeeId,
      diff: { fields: ['pan_number', 'uan_number', 'pf_number', 'esic_number'] },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('saveTax', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Replace one list section wholesale.
 *
 * THE COLUMN IS CHOSEN BY AN EXPLICIT BRANCH, NEVER BUILT FROM THE SECTION STRING. Nine short
 * statements instead of one clever one: an identifier assembled from a caller's string is an
 * injection the day the caller's source widens, and there is no parameter form for a column name to
 * make it safe. isProfileSection() is checked first as well, so the door has two locks.
 */
async function writeSection(employeeId: string, section: ProfileSection, list: ProfileEntry[]): Promise<boolean> {
  const payload = JSON.stringify(list);
  if (section === 'education') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, education) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET education = EXCLUDED.education, updated_at = NOW()`);
  } else if (section === 'experience') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, experience) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET experience = EXCLUDED.experience, updated_at = NOW()`);
  } else if (section === 'skills') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, skills) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET skills = EXCLUDED.skills, updated_at = NOW()`);
  } else if (section === 'languages') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, languages) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET languages = EXCLUDED.languages, updated_at = NOW()`);
  } else if (section === 'certifications') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, certifications) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET certifications = EXCLUDED.certifications, updated_at = NOW()`);
  } else if (section === 'achievements') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, achievements) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET achievements = EXCLUDED.achievements, updated_at = NOW()`);
  } else if (section === 'social_links') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, social_links) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET social_links = EXCLUDED.social_links, updated_at = NOW()`);
  } else if (section === 'identity_documents') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, identity_documents) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET identity_documents = EXCLUDED.identity_documents, updated_at = NOW()`);
  } else if (section === 'emergency_contacts') {
    await db.execute(sql`INSERT INTO hr_employee_profile (employee_id, emergency_contacts) VALUES (${employeeId}::uuid, ${payload}::jsonb)
      ON CONFLICT (employee_id) DO UPDATE SET emergency_contacts = EXCLUDED.emergency_contacts, updated_at = NOW()`);
  } else {
    return false;
  }
  return true;
}

/** The current contents of one section, so add/remove can work from what is actually stored. */
async function readSection(employeeId: string, section: ProfileSection): Promise<ProfileEntry[]> {
  const profile = await getProfile(employeeId);
  if (!profile) return [];
  if (section === 'education') return profile.education;
  if (section === 'experience') return profile.experience;
  if (section === 'skills') return profile.skills;
  if (section === 'languages') return profile.languages;
  if (section === 'certifications') return profile.certifications;
  if (section === 'achievements') return profile.achievements;
  if (section === 'social_links') return profile.socialLinks;
  if (section === 'identity_documents') return profile.identityDocuments;
  if (section === 'emergency_contacts') return profile.additionalEmergency;
  return [];
}

/**
 * Add one entry to a list section.
 *
 * Read-modify-write on a JSONB column, which is a race if two tabs add at the same second: the
 * loser's entry is overwritten. That is a lost line on a personal profile, added again in five
 * seconds by the person who is looking at the screen — not a lost approval or a lost payment — and
 * the alternative (a child table per section, nine of them) costs nine ensure-blocks and nine round
 * trips on every page load. The trade is stated rather than hidden.
 */
export async function addEntry(
  employeeId: string,
  section: string,
  entry: ProfileEntry,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!isProfileSection(section)) return { ok: false, error: 'That is not a section of your profile.' };

  const label = text(entry?.label);
  if (!label) return { ok: false, error: 'Give it a name — one line is enough.' };

  const url = entry?.url ? normaliseLink(entry.url) : null;
  if (entry?.url && !url) {
    return {
      ok: false,
      error: 'That link does not look like a link. Paste a shared document link starting with https:// '
        + 'and make sure anybody with the link can view it. Files are never uploaded here.',
    };
  }

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const list = await readSection(employeeId, section);
    if (list.length >= MAX_ITEMS) {
      return { ok: false, error: 'That section is full at ' + MAX_ITEMS + ' entries. Remove one first.' };
    }
    const next = list.concat([{
      label,
      detail: text(entry?.detail, MAX_TEXT),
      period: text(entry?.period, 80),
      url,
    }]);
    const wrote = await writeSection(employeeId, section, next);
    if (!wrote) return { ok: false, error: 'That is not a section of your profile.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.entry.add',
      entity: 'hr_employee_profile',
      entityId: employeeId,
      diff: { section, count: next.length },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('addEntry', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Remove one entry by its position in the section, as rendered. */
export async function removeEntry(
  employeeId: string,
  section: string,
  index: number,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  if (!isProfileSection(section)) return { ok: false, error: 'That is not a section of your profile.' };
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return { ok: false, error: 'That entry is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const list = await readSection(employeeId, section);
    if (i >= list.length) {
      return { ok: false, error: 'That entry is already gone. Reload the page to see the current list.' };
    }
    const next = list.slice(0, i).concat(list.slice(i + 1));
    const wrote = await writeSection(employeeId, section, next);
    if (!wrote) return { ok: false, error: 'That is not a section of your profile.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.entry.remove',
      entity: 'hr_employee_profile',
      entityId: employeeId,
      diff: { section, count: next.length },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('removeEntry', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * The digital signature — A LINK, like every other document on this platform.
 *
 * Not an upload and not a canvas drawing saved as an image: the standing rule here is that documents
 * of any kind are links, and the profile photo is the single exception. An empty value clears it.
 */
export async function saveSignature(
  employeeId: string,
  url: string | null,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  const link = url ? normaliseLink(url) : null;
  if (url && String(url).trim() && !link) {
    return { ok: false, error: 'That signature link does not look like a link. It should start with https://' };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    await db.execute(sql`
      INSERT INTO hr_employee_profile (employee_id, signature_url)
      VALUES (${employeeId}::uuid, ${link}::text)
      ON CONFLICT (employee_id) DO UPDATE SET signature_url = EXCLUDED.signature_url, updated_at = NOW()`);
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'profile.signature.save',
      entity: 'hr_employee_profile',
      entityId: employeeId,
      diff: { cleared: !link },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('saveSignature', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * THE PROFILE PHOTO — the ONE stored upload on this platform.
 *
 * The browser captures from the camera or reads a chosen file, draws it to a canvas at 320px on its
 * long edge and hands over a JPEG data URL. This function validates the shape and the size, then
 * saves it EXACTLY the way src/pages/api/auth/enroll-face-selfie.ts already does:
 *
 *   - a blob store when BLOB_READ_WRITE_TOKEN is configured (an optional connector, not a
 *     requirement — the product works without one);
 *   - the inline image when it is not.
 *
 * Reusing that path rather than inventing a second one is the point: two upload implementations mean
 * two answers to "where are employee photos", and the one nobody remembers is the one that leaks.
 *
 * Both columns are written, because both are read: users.photo_url by the account surfaces and
 * hr_employees.photo_url by the HR ones. A photo saved to one and not the other is a person whose
 * picture changes depending on which page you are looking at.
 */
export async function savePhoto(
  employeeId: string,
  userId: string | null,
  dataUrl: string,
): Promise<WriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That record is not available.' };
  const raw = String(dataUrl || '').trim();
  if (!raw) return { ok: false, error: 'No picture was sent. Take one, or choose a file.' };
  if (!/^data:image\/(jpeg|png);base64,/.test(raw)) {
    return { ok: false, error: 'That is not an image we can store. Use the camera button or choose a JPEG or PNG.' };
  }
  if (raw.length > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      error: 'That picture is too large. It is resized in the browser before sending, so if you are '
        + 'seeing this the resize did not run — reload the page and try again.',
    };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  let photoUrl = raw;
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import('@vercel/blob');
      const bin = Buffer.from(raw.split(',')[1], 'base64');
      const res = await put(
        'employee-photos/' + employeeId + '-' + Date.now() + '.jpg',
        bin,
        { access: 'public', contentType: 'image/jpeg', addRandomSuffix: false },
      );
      if ((res as any)?.url) photoUrl = String((res as any).url);
    }
  } catch (e: any) {
    // The blob store is an OPTIONAL connector. When it refuses, the inline image is still a real,
    // working photo — so this one failure degrades rather than refusing the save. Logged, never
    // silent: an inline image is measurably larger and somebody should know the store is down.
    logFail('savePhoto.blob', e);
    photoUrl = raw;
  }

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees SET photo_url = ${photoUrl}, updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id, user_id`));
    if (!wrote.length) return { ok: false, error: 'That record is not available.' };

    const linkedUser = wrote[0]?.user_id ? String(wrote[0].user_id) : (isUuid(userId) ? userId : '');
    if (isUuid(linkedUser)) {
      await db.execute(sql`UPDATE users SET photo_url = ${photoUrl} WHERE id = ${linkedUser}::uuid`);
    }

    await logAudit({
      userId: isUuid(userId) ? userId : null,
      action: 'profile.photo.save',
      entity: 'hr_employee',
      entityId: employeeId,
      diff: { stored: photoUrl.startsWith('data:') ? 'inline' : 'blob' },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('savePhoto', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// EQUIPMENT AND ASSETS — READ ONLY, and honest about what it can prove.
// -------------------------------------------------------------------------------------------------

export interface AssignedItem {
  label: string;
  /** The tag the asset register knows it by, when one was recorded. */
  assetTag: string | null;
  /** The purchase order it arrived on. */
  reference: string | null;
  receivedAt: string | null;
}

/**
 * EQUIPMENT THIS PERSON HAS, as far as this database can actually prove it.
 *
 * WHAT THIS IS: items bought on a purchase request THEY raised, where the order has been confirmed
 * received. Every field comes from procurement_orders and procurement_requests — real rows, written
 * by a person confirming that a thing arrived.
 *
 * WHAT THIS IS NOT: the asset register. The register is a separate module with its own storage and
 * its own assignment records, and this function does not read, guess at or invent it. When the
 * register exists, the tag recorded on the receipt is what matches the two; until then, this list is
 * the honest subset, and the surface says so in those words rather than implying it is everything.
 *
 * Returns an empty list — never a fabricated one — when procurement has never been used here.
 */
export async function assignedEquipment(employeeId: string): Promise<AssignedItem[]> {
  if (!isUuid(employeeId)) return [];
  try {
    const exists = rows(await db.execute(sql`
      SELECT to_regclass('public.procurement_orders') IS NOT NULL AS ok`));
    if (!exists.length || exists[0]?.ok !== true) return [];

    const r = rows(await db.execute(sql`
      SELECT o.po_number, o.asset_tag, o.received_at, r.item, r.quantity
        FROM procurement_orders o
        JOIN procurement_requests r ON r.id = o.request_id
       WHERE r.requester_employee_id = ${employeeId}::uuid
         AND o.status = 'received'
       ORDER BY o.received_at DESC NULLS LAST
       LIMIT 50`));

    return r.map((row: any) => ({
      label: String(row.item || 'Item') + (Number(row.quantity) > 1 ? ' x' + Number(row.quantity) : ''),
      assetTag: row.asset_tag ? String(row.asset_tag) : null,
      reference: row.po_number ? String(row.po_number) : null,
      receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail('assignedEquipment', e);
    return [];
  }
}
