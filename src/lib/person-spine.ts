// src/lib/person-spine.ts — THE PERSON ROOT. One human, and the surfaces they occupy.
//
// =================================================================================================
// THE PROBLEM THIS EXISTS FOR
// =================================================================================================
//
// A human is up to three records here and the id does not survive between them:
//
//   users.id             the login. Carries `role`, which is an ACCOUNT TYPE mutated over a
//                        person's life, not a state of a person.
//   applications.id      the candidate. Carries the whole candidate story — education, experience,
//                        the problem-statement solution, the stage history, the interview scorecards.
//   hr_employees.id      the employee. Carries `user_id` and `application_id` as NULLABLE, UNENFORCED
//                        uuid columns: indexes, no foreign keys.
//
// At the hire, src/lib/hr/sync.ts and src/lib/hire-transfer.ts INSERT a new hr_employees row with a
// fresh gen_random_uuid() and copy fields across. hire-transfer.ts resolves whether this is the same
// human with `application_id = X OR user_id = Y OR lower(personal_email) = Z OR lower(email) = Z`.
// An email comparison inside an INSERT is an INFERENCE, it is made once, it is never written down,
// and nothing can ever disagree with it afterwards.
//
// The consequences are already real in this repository. A candidate's assessment attempts, work
// samples, interview scorecards and stage history are keyed to applications.id and no screen reads
// them from the employee record. A person who applied without an account is not de-duplicated at
// all. Deleting a login sets applications.applicant_user_id to NULL and orphans the candidate
// history permanently.
//
// =================================================================================================
// WHAT THIS MODULE DOES, AND THE ONE RULE IT IS BUILT AROUND
// =================================================================================================
//
// It adds a PERSON root and records each of the three surfaces as an IDENTITY ASSERTION about that
// person — with its assertion type, the sentence saying how it was established, who established it,
// and when. Identity resolution stops being an email comparison buried in an INSERT and becomes a
// record that can be read, disputed and withdrawn.
//
//   NOTHING IS LINKED AUTOMATICALLY.
//
// This module proposes links and never makes them. proposedLinks() computes candidates from stored
// pointers (assertion `calculated`) and from email equality (assertion `inferred`) and hands them to
// a screen, where a NAMED HUMAN confirms one. The confirmed row is `provided` — stated by that
// human — and it names them. An inferred link that silently became the spine of somebody's record is
// the precise failure the load-bearing rule forbids, and auto-linking on page load would be it.
//
// A LINK IS REVERSIBLE. unlinkIdentity() writes an end, a reason and an actor; it never deletes the
// row. "This was linked in error" has to be recordable, or the first mistake is permanent.
//
// =================================================================================================
// THREE ID SPACES, NOT FOUR. THE LEARNER IS THE LOGIN.
// =================================================================================================
//
// It is tempting to add a `learner` identity kind, because the learning modules talk about a learner
// account. They do not have one: src/lib/learning-progress.ts resolveLearnerUserId(employeeId) reads
// hr_employees.user_id and returns it. The learner IS users.id. Adding a fourth kind would create a
// second vocabulary for one thing, which is the failure this repository has already had with XP,
// course progress and chat_messages. There are three kinds and there is no fourth.
//
// =================================================================================================
// THE BOOTSTRAP DOES NOT TRUST ITSELF
// =================================================================================================
//
// src/lib/ensure-once.ts ends in `p.catch(() => {})`. A DDL failure inside it RESOLVES, and the
// caller reports success. Ten module tables were reported created on this project and none of them
// existed. So ensureSpineSchema() rethrows into the memo (which drops the failed run, so the next
// call retries), and — the part that matters — spineSchemaStatus() SELECTS against
// information_schema and reports what is ACTUALLY there. Every surface in the spine renders that
// status rather than assuming the ensure worked. A green message is not a table.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { rowsOf, logFail, isUuid, clean } from '@/lib/performance-scope';
import type { AssertionType } from '@/lib/person-assertions';

const MOD = 'person-spine';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// READ STATES — three sentences, never one
//
// "Nothing is set up yet", "there is genuinely nothing here", and "we could not read it" are three
// different facts about the world, and collapsing them is how a person gets sent to HR to be added
// to a register they are already on. Every reader in the spine returns one of these.
// -------------------------------------------------------------------------------------------------

export type ReadState = 'ok' | 'not_configured' | 'empty' | 'unreadable';

export interface Read<T> {
  state: ReadState;
  /** The sentence the screen prints. Never invented at the call site. */
  sentence: string;
  data: T;
}

export function readSentence(state: ReadState, what: string): string {
  switch (state) {
    case 'not_configured':
      return 'The ' + what + ' has not been set up yet, so there is nothing to show. This is not a statement that there is nothing.';
    case 'empty':
      return 'There is genuinely nothing recorded in the ' + what + ' yet.';
    case 'unreadable':
      return 'We could not read the ' + what + ' just now, so this shows nothing rather than guessing. Try again in a moment.';
    default:
      return '';
  }
}

// -------------------------------------------------------------------------------------------------
// THE SCHEMA
// -------------------------------------------------------------------------------------------------

/** Every table this module owns. spineSchemaStatus() checks these names against information_schema. */
export const SPINE_TABLES = [
  'hr_persons',
  'hr_person_identities',
  'hr_skill_relations',
  'hr_role_requirements',
  'hr_match_decisions',
] as const;

/**
 * Create everything the spine owns. Additive only: CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT
 * EXISTS, never a DROP.
 *
 * A FRESH ensureOnce KEY. The memo is in-memory per process and its keys are not persisted, so a key
 * reused from another module would make this block a no-op behind that module's earlier run.
 *
 * IT RETHROWS. ensureOnce drops a failed run from its cache and then swallows the rejection for the
 * caller, which keeps the tolerate-missing-schema behaviour every reader below is built on — but the
 * throw is what causes the drop, so without it a failure would be cached as success for the life of
 * the process. This is the same shape src/lib/application-stages.ts and src/lib/aquin-competencies.ts
 * already use, and it is not enough on its own: see spineSchemaStatus().
 */
export function ensureSpineSchema(): Promise<void> {
  return ensureOnce('spine_person_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_persons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name TEXT NOT NULL,
        note TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // THE IDENTITY ASSERTION. `ref_id` is TEXT rather than UUID on purpose: every id space here is
      // a uuid today, and casting would be tidier, but a spine that cannot record an identity in a
      // space that keys differently is a spine that gets forked the first time one appears.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_person_identities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id UUID NOT NULL REFERENCES hr_persons(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        assertion_type TEXT NOT NULL DEFAULT 'explicitly_provided',
        basis TEXT NOT NULL,
        linked_by_user_id UUID,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unlinked_at TIMESTAMPTZ,
        unlinked_by_user_id UUID,
        unlink_reason TEXT
      )`);
      // One LIVE link per (kind, ref_id): one employee record belongs to one person. A withdrawn
      // link keeps its row, so the partial index is on the live ones only and history survives.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_person_identities_live_key
        ON hr_person_identities (kind, ref_id) WHERE unlinked_at IS NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_person_identities_person_idx
        ON hr_person_identities (person_id, kind)`);

      // THE SKILL GRAPH. Edges beside hr_skills, never a second catalogue. Owned here so the whole
      // spine bootstraps in one place and one status check covers all of it.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_skill_relations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
        to_skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        note TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hr_skill_relations_key UNIQUE (from_skill_id, to_skill_id, relation)
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_skill_relations_from_idx
        ON hr_skill_relations (from_skill_id, relation)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_skill_relations_to_idx
        ON hr_skill_relations (to_skill_id, relation)`);

      // WHAT A JOB ASKS FOR, IN THE SAME VOCABULARY AS WHAT A PERSON HAS EVIDENCED.
      // roles.skills is a jsonb array of free strings and hr_skills is a uuid catalogue; they have
      // never been joined, which is why no honest comparison between a person and a job has been
      // possible. This is that join, and it is authored by a human rather than guessed.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_role_requirements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_id UUID NOT NULL,
        skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
        necessity TEXT NOT NULL DEFAULT 'important',
        min_level INT,
        source_text TEXT,
        assertion_type TEXT NOT NULL DEFAULT 'explicitly_provided',
        basis TEXT NOT NULL,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hr_role_requirements_key UNIQUE (role_id, skill_id)
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_role_requirements_role_idx
        ON hr_role_requirements (role_id)`);

      // THE HUMAN'S DECISION, RECORDED. Append-only.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_match_decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_id UUID NOT NULL,
        person_id UUID,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        coverage_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        decided_by_user_id UUID,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_match_decisions_role_idx
        ON hr_match_decisions (role_id, decided_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_match_decisions_subject_idx
        ON hr_match_decisions (subject_kind, subject_id, decided_at DESC)`);
    } catch (e: any) {
      logFail(MOD, 'ensureSpineSchema', e);
      throw e;
    }
  });
}

export interface TablePresence {
  table: string;
  present: boolean;
  /** Column count, so "the table exists but is the wrong shape" is visible rather than assumed. */
  columns: number;
}

export interface SpineSchemaStatus {
  /** Did the information_schema read itself succeed? False means we know nothing, not that nothing is there. */
  read: boolean;
  tables: TablePresence[];
  missing: string[];
  /** The sentence a screen prints. It never says "created" — only what was found. */
  sentence: string;
  /** Present only when the ensure threw, so a screen can show the real Postgres reason. */
  ensureError: string | null;
}

/**
 * WHAT IS ACTUALLY IN THE DATABASE.
 *
 * Read the header: the ensure helper swallows failures, so calling it and reporting success is a lie
 * this project has already told at production scale. This asks information_schema directly and
 * reports what it FOUND. It never reports what it created, because it created nothing.
 *
 * It runs the ensure first and keeps the error rather than discarding it, so a screen can print the
 * real Postgres reason (e.cause.message) beside the list of missing tables instead of an empty page.
 */
export async function spineSchemaStatus(): Promise<SpineSchemaStatus> {
  let ensureError: string | null = null;
  try {
    await ensureSpineSchema();
  } catch (e: any) {
    ensureError = String(e?.cause?.message || e?.message || 'unknown error');
  }

  const names = SPINE_TABLES.map((t) => String(t));
  try {
    const found = rowsOf(await db.execute(sql`
      SELECT c.table_name, COUNT(*)::int AS columns
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
       GROUP BY c.table_name`));
    const byName = new Map<string, number>();
    for (const r of found) byName.set(String(r.table_name), Number(r.columns) || 0);
    const tables: TablePresence[] = names.map((n) => ({
      table: n,
      present: byName.has(n),
      columns: byName.get(n) || 0,
    }));
    const missing = tables.filter((t) => !t.present).map((t) => t.table);
    return {
      read: true,
      tables,
      missing,
      sentence: missing.length === 0
        ? 'All ' + tables.length + ' spine tables were found in the database. This is what information_schema '
          + 'reports, not what a bootstrap claimed.'
        : missing.length + ' of ' + tables.length + ' spine tables are NOT in the database: ' + missing.join(', ')
          + '. Nothing on the screens behind them will work until they exist, and they will not appear by '
          + 'themselves if the bootstrap is failing.',
      ensureError,
    };
  } catch (e: any) {
    logFail(MOD, 'spineSchemaStatus', e);
    return {
      read: false,
      tables: names.map((n) => ({ table: n, present: false, columns: 0 })),
      missing: [],
      sentence: 'We could not read information_schema, so we do not know which spine tables exist. This is not '
        + 'a report that they are missing.',
      ensureError,
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE PERSON AND THEIR SURFACES
// -------------------------------------------------------------------------------------------------

export const IDENTITY_KINDS = ['user', 'employee', 'application'] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export function isIdentityKind(v: unknown): v is IdentityKind {
  return typeof v === 'string' && (IDENTITY_KINDS as readonly string[]).indexOf(v) >= 0;
}

export const IDENTITY_KIND_LABELS: Record<string, string> = {
  user: 'Login account',
  employee: 'Employee record',
  application: 'Application',
};

export interface PersonIdentity {
  id: string;
  personId: string;
  kind: IdentityKind;
  refId: string;
  assertion: AssertionType;
  /** How this link was established, in a sentence written when it was made. */
  basis: string;
  linkedByUserId: string | null;
  linkedAt: string | null;
  unlinkedAt: string | null;
  unlinkReason: string | null;
  /** A label for the thing on the other end, when it could be read. */
  display: string | null;
}

export interface Person {
  id: string;
  displayName: string;
  note: string | null;
  createdAt: string | null;
}

function mapIdentity(r: any): PersonIdentity {
  return {
    id: String(r?.id ?? ''),
    personId: String(r?.person_id ?? ''),
    kind: (isIdentityKind(r?.kind) ? r.kind : 'user') as IdentityKind,
    refId: String(r?.ref_id ?? ''),
    assertion: (String(r?.assertion_type || 'explicitly_provided') as AssertionType),
    basis: r?.basis ? String(r.basis) : 'No basis was recorded for this link.',
    linkedByUserId: r?.linked_by_user_id ? String(r.linked_by_user_id) : null,
    linkedAt: r?.linked_at ? new Date(r.linked_at).toISOString() : null,
    unlinkedAt: r?.unlinked_at ? new Date(r.unlinked_at).toISOString() : null,
    unlinkReason: r?.unlink_reason ? String(r.unlink_reason) : null,
    display: r?.display ? String(r.display) : null,
  };
}

/**
 * The person this record belongs to, if a human has said so.
 *
 * Returns null when no LIVE identity row names one. Null means "nobody has linked this yet", and the
 * caller must not treat it as "this person does not exist" — proposedLinks() is the next call, and a
 * screen shows what it found rather than inventing a root.
 */
export async function personFor(kind: IdentityKind, refId: string): Promise<Read<Person | null>> {
  if (!isIdentityKind(kind) || !String(refId || '').trim()) {
    return { state: 'unreadable', sentence: 'That record was not named properly, so nothing was looked up.', data: null };
  }
  try {
    await ensureSpineSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT p.id, p.display_name, p.note, p.created_at
        FROM hr_person_identities i
        JOIN hr_persons p ON p.id = i.person_id
       WHERE i.kind = ${String(kind)} AND i.ref_id = ${String(refId)} AND i.unlinked_at IS NULL
       LIMIT 1`));
    if (!r.length) {
      return {
        state: 'empty',
        sentence: 'No person record has been linked to this yet. Nothing links it automatically: an identity '
          + 'link is something a named human states.',
        data: null,
      };
    }
    return {
      state: 'ok',
      sentence: '',
      data: {
        id: String(r[0].id),
        displayName: String(r[0].display_name || 'Unnamed person'),
        note: r[0].note ? String(r[0].note) : null,
        createdAt: r[0].created_at ? new Date(r[0].created_at).toISOString() : null,
      },
    };
  } catch (e: any) {
    logFail(MOD, 'personFor', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'person record'), data: null };
  }
}

/**
 * Every surface linked to this person, live and withdrawn.
 *
 * WITHDRAWN ROWS ARE RETURNED. A link that was made and taken back is part of the record of how this
 * person's identity was decided, and hiding it would leave a screen unable to explain why a record
 * that obviously belongs here is not attached.
 */
export async function identitiesFor(personId: string): Promise<Read<PersonIdentity[]>> {
  if (!isUuid(personId)) {
    return { state: 'unreadable', sentence: 'That person was not named properly.', data: [] };
  }
  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT i.*,
             COALESCE(
               e.full_name,
               u.name,
               NULLIF(TRIM(COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')), '')
             ) AS display
        FROM hr_person_identities i
        LEFT JOIN hr_employees e ON i.kind = 'employee' AND e.id::text = i.ref_id
        LEFT JOIN users u ON i.kind = 'user' AND u.id::text = i.ref_id
        LEFT JOIN applications a ON i.kind = 'application' AND a.id::text = i.ref_id
       WHERE i.person_id = ${personId}::uuid
       ORDER BY i.unlinked_at NULLS FIRST, i.linked_at ASC
       LIMIT 100`));
    const data = rows.map(mapIdentity);
    return {
      state: data.length ? 'ok' : 'empty',
      sentence: data.length ? '' : 'This person has no linked records at all, which should not happen — a person '
        + 'root is created from a record.',
      data,
    };
  } catch (e: any) {
    logFail(MOD, 'identitiesFor', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'linked records'), data: [] };
  }
}

// -------------------------------------------------------------------------------------------------
// PROPOSALS — computed, never applied
// -------------------------------------------------------------------------------------------------

export interface IdentityProposal {
  kind: IdentityKind;
  refId: string;
  display: string;
  assertion: AssertionType;
  /** The sentence explaining how this candidate was found, printed on the button that confirms it. */
  basis: string;
  /** True when a live link already exists for this record, possibly to a different person. */
  alreadyLinked: boolean;
  alreadyLinkedTo: string | null;
}

/**
 * Records that MIGHT be the same human as the one named, with how each was found.
 *
 * TWO KINDS OF CANDIDATE, AND THEY ARE NOT THE SAME STRENGTH:
 *
 *   calculated  a pointer already stored by a function — hr_employees.user_id,
 *               hr_employees.application_id, applications.applicant_user_id. Deterministic to
 *               follow, but nobody checked that the function that wrote it was right.
 *   inferred    an email comparison. This is exactly what hire-transfer.ts does inside an INSERT
 *               today, and doing it here at least makes it VISIBLE and refusable. Two people share
 *               an address more often than anybody expects, and a shared family address is the
 *               common case, not the exotic one.
 *
 * NOTHING HERE WRITES. The caller renders these and a human picks.
 */
export async function proposedLinks(kind: IdentityKind, refId: string): Promise<Read<IdentityProposal[]>> {
  if (!isIdentityKind(kind) || !isUuid(refId)) {
    return { state: 'unreadable', sentence: 'That record was not named properly, so nothing was proposed.', data: [] };
  }
  try {
    await ensureSpineSchema();
    const out: IdentityProposal[] = [];
    const seen = new Set<string>();
    const push = (p: IdentityProposal) => {
      const key = p.kind + ':' + p.refId;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };

    // The record itself is always the first proposal: linking starts somewhere.
    if (kind === 'employee') {
      const r = rowsOf(await db.execute(sql`
        SELECT id::text AS id, full_name, user_id::text AS user_id, application_id::text AS application_id,
               lower(COALESCE(NULLIF(personal_email, ''), NULLIF(work_email, ''), email, '')) AS mail
          FROM hr_employees WHERE id = ${refId}::uuid LIMIT 1`));
      if (!r.length) {
        return { state: 'empty', sentence: 'That employee record does not exist.', data: [] };
      }
      const row = r[0];
      push({
        kind: 'employee', refId: String(row.id), display: String(row.full_name || 'Unnamed record'),
        assertion: 'factual',
        basis: 'This is the employee record the page was opened on.',
        alreadyLinked: false, alreadyLinkedTo: null,
      });
      if (row.user_id) {
        const u = rowsOf(await db.execute(sql`SELECT id::text AS id, name, email FROM users WHERE id = ${String(row.user_id)}::uuid LIMIT 1`));
        if (u.length) {
          push({
            kind: 'user', refId: String(u[0].id), display: String(u[0].name || u[0].email || 'Account'),
            assertion: 'calculated',
            basis: 'hr_employees.user_id on this record points at this login account. That column has no foreign '
              + 'key and was written once at hire; following it is deterministic, but nothing has checked it.',
            alreadyLinked: false, alreadyLinkedTo: null,
          });
        }
      }
      if (row.application_id) {
        const a = rowsOf(await db.execute(sql`
          SELECT id::text AS id, first_name, last_name, application_number
            FROM applications WHERE id = ${String(row.application_id)}::uuid LIMIT 1`));
        if (a.length) {
          push({
            kind: 'application', refId: String(a[0].id),
            display: String((a[0].first_name || '') + ' ' + (a[0].last_name || '')).trim() + (a[0].application_number ? ' (' + a[0].application_number + ')' : ''),
            assertion: 'calculated',
            basis: 'hr_employees.application_id on this record points at this application. It is a back-pointer '
              + 'written at hire, with no foreign key behind it.',
            alreadyLinked: false, alreadyLinkedTo: null,
          });
        }
      }
      if (row.mail) {
        const m = rowsOf(await db.execute(sql`
          SELECT id::text AS id, first_name, last_name, application_number
            FROM applications
           WHERE lower(email) = ${String(row.mail)}
           ORDER BY created_at DESC LIMIT 10`));
        for (const a of m) {
          push({
            kind: 'application', refId: String(a.id),
            display: String((a.first_name || '') + ' ' + (a.last_name || '')).trim() + (a.application_number ? ' (' + a.application_number + ')' : ''),
            assertion: 'inferred',
            basis: 'The email address on this application is the same as the one on the employee record. That is '
              + 'an inference and not a fact: people share addresses, and one person often uses several.',
            alreadyLinked: false, alreadyLinkedTo: null,
          });
        }
      }
    } else if (kind === 'application') {
      const r = rowsOf(await db.execute(sql`
        SELECT id::text AS id, first_name, last_name, application_number, lower(email) AS mail,
               applicant_user_id::text AS applicant_user_id
          FROM applications WHERE id = ${refId}::uuid LIMIT 1`));
      if (!r.length) return { state: 'empty', sentence: 'That application does not exist.', data: [] };
      const row = r[0];
      push({
        kind: 'application', refId: String(row.id),
        display: String((row.first_name || '') + ' ' + (row.last_name || '')).trim() || 'Unnamed application',
        assertion: 'factual',
        basis: 'This is the application the page was opened on.',
        alreadyLinked: false, alreadyLinkedTo: null,
      });
      if (row.applicant_user_id) {
        const u = rowsOf(await db.execute(sql`SELECT id::text AS id, name, email FROM users WHERE id = ${String(row.applicant_user_id)}::uuid LIMIT 1`));
        if (u.length) {
          push({
            kind: 'user', refId: String(u[0].id), display: String(u[0].name || u[0].email || 'Account'),
            assertion: 'calculated',
            basis: 'applications.applicant_user_id points at this login. It is nullable and ON DELETE SET NULL, '
              + 'so deleting the login would erase this pointer permanently.',
            alreadyLinked: false, alreadyLinkedTo: null,
          });
        }
      }
      if (row.mail) {
        const e = rowsOf(await db.execute(sql`
          SELECT id::text AS id, full_name FROM hr_employees
           WHERE lower(COALESCE(NULLIF(personal_email, ''), NULLIF(work_email, ''), email, '')) = ${String(row.mail)}
           LIMIT 10`));
        for (const emp of e) {
          push({
            kind: 'employee', refId: String(emp.id), display: String(emp.full_name || 'Unnamed record'),
            assertion: 'inferred',
            basis: 'An employee record carries the same email address. This is the same comparison the hire '
              + 'handoff makes silently inside an INSERT; here it is a proposal somebody can refuse.',
            alreadyLinked: false, alreadyLinkedTo: null,
          });
        }
      }
    } else {
      const u = rowsOf(await db.execute(sql`SELECT id::text AS id, name, lower(email) AS mail FROM users WHERE id = ${refId}::uuid LIMIT 1`));
      if (!u.length) return { state: 'empty', sentence: 'That account does not exist.', data: [] };
      push({
        kind: 'user', refId: String(u[0].id), display: String(u[0].name || u[0].mail || 'Account'),
        assertion: 'factual',
        basis: 'This is the account the page was opened on.',
        alreadyLinked: false, alreadyLinkedTo: null,
      });
      const e = rowsOf(await db.execute(sql`SELECT id::text AS id, full_name FROM hr_employees WHERE user_id = ${refId}::uuid LIMIT 5`));
      for (const emp of e) {
        push({
          kind: 'employee', refId: String(emp.id), display: String(emp.full_name || 'Unnamed record'),
          assertion: 'calculated',
          basis: 'hr_employees.user_id points at this account.',
          alreadyLinked: false, alreadyLinkedTo: null,
        });
      }
      const a = rowsOf(await db.execute(sql`
        SELECT id::text AS id, first_name, last_name FROM applications WHERE applicant_user_id = ${refId}::uuid LIMIT 10`));
      for (const app of a) {
        push({
          kind: 'application', refId: String(app.id),
          display: String((app.first_name || '') + ' ' + (app.last_name || '')).trim() || 'Application',
          assertion: 'calculated',
          basis: 'applications.applicant_user_id points at this account.',
          alreadyLinked: false, alreadyLinkedTo: null,
        });
      }
    }

    // Which of these are already spoken for, and by whom. A screen that offers to link a record that
    // already belongs to somebody else is a screen that merges two humans by accident.
    if (out.length) {
      const pairs = out.map((p) => sql`(${p.kind}, ${p.refId})`);
      const taken = rowsOf(await db.execute(sql`
        SELECT i.kind, i.ref_id, p.display_name
          FROM hr_person_identities i
          JOIN hr_persons p ON p.id = i.person_id
         WHERE i.unlinked_at IS NULL
           AND (i.kind, i.ref_id) IN (${sql.join(pairs, sql`, `)})`));
      for (const t of taken) {
        const hit = out.find((p) => p.kind === String(t.kind) && p.refId === String(t.ref_id));
        if (hit) {
          hit.alreadyLinked = true;
          hit.alreadyLinkedTo = String(t.display_name || 'another person record');
        }
      }
    }

    return { state: out.length ? 'ok' : 'empty', sentence: out.length ? '' : 'Nothing was found that could be the same person.', data: out };
  } catch (e: any) {
    logFail(MOD, 'proposedLinks', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'identity proposals'), data: [] };
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES — each one is a named human's statement
// -------------------------------------------------------------------------------------------------

export interface SpineWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Create the person root, from the record the caller is looking at, and link that record.
 *
 * The FIRST link is `provided`: a human opened a record and said "this is a person". It is not
 * `factual` even though the underlying record obviously exists, because the assertion being made is
 * not "this employee record exists" — it is "this record is a human, and this is their root".
 */
export async function createPersonFrom(input: {
  kind: IdentityKind;
  refId: string;
  displayName: string;
  actorUserId: string;
}): Promise<SpineWriteResult> {
  const kind = input?.kind;
  const refId = String(input?.refId || '');
  const displayName = clean(input?.displayName, 200);
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!isIdentityKind(kind) || !isUuid(refId)) return { ok: false, error: 'Choose a record to start from.' };
  if (!displayName) return { ok: false, error: 'A person record needs a name on it.' };
  if (!actor) return { ok: false, error: 'We could not tell who is making this statement, so nothing was written.' };

  try {
    await ensureSpineSchema();
    const existing = rowsOf(await db.execute(sql`
      SELECT person_id::text AS person_id FROM hr_person_identities
       WHERE kind = ${String(kind)} AND ref_id = ${refId} AND unlinked_at IS NULL LIMIT 1`));
    if (existing.length) {
      return { ok: false, id: String(existing[0].person_id), error: 'That record already belongs to a person here.' };
    }

    const p = rowsOf(await db.execute(sql`
      INSERT INTO hr_persons (display_name, created_by_user_id)
      VALUES (${displayName}, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!p.length) return { ok: false, error: WRITE_FAILED };
    const personId = String(p[0].id);

    await db.execute(sql`
      INSERT INTO hr_person_identities (person_id, kind, ref_id, assertion_type, basis, linked_by_user_id)
      VALUES (${personId}::uuid, ${String(kind)}, ${refId}, 'explicitly_provided',
              ${'A person record was opened from this ' + (IDENTITY_KIND_LABELS[kind] || kind).toLowerCase() + '.'},
              ${actor}::uuid)`);

    await logAudit({
      userId: actor,
      action: 'person.create',
      entity: 'hr_persons',
      entityId: personId,
      diff: { kind, refId, displayName },
    });
    return { ok: true, id: personId };
  } catch (e: any) {
    // NEVER SWALLOWED. A write path that reports success on a failure is the failure this whole
    // module exists to stop being possible.
    logFail(MOD, 'createPersonFrom', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * State that a record belongs to a person.
 *
 * REFUSES A RECORD THAT IS ALREADY SPOKEN FOR. Linking a record that lives under another person is
 * a merge of two humans, and a merge is not something that happens as a side effect of a link
 * button. The refusal names the other person so the human can go and look.
 */
export async function linkIdentity(input: {
  personId: string;
  kind: IdentityKind;
  refId: string;
  /** How the human says they know. Recorded verbatim. */
  basis: string;
  actorUserId: string;
}): Promise<SpineWriteResult> {
  const personId = String(input?.personId || '');
  const kind = input?.kind;
  const refId = String(input?.refId || '');
  const basis = clean(input?.basis, 1000);
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!isUuid(personId) || !isIdentityKind(kind) || !isUuid(refId)) {
    return { ok: false, error: 'Choose a person and a record.' };
  }
  if (!basis) {
    return { ok: false, error: 'Say how you know these are the same person. An identity link with no stated basis '
      + 'is exactly the kind of assertion this system refuses to make silently.' };
  }
  if (!actor) return { ok: false, error: 'We could not tell who is making this statement, so nothing was written.' };

  try {
    await ensureSpineSchema();
    const taken = rowsOf(await db.execute(sql`
      SELECT p.id::text AS id, p.display_name FROM hr_person_identities i
        JOIN hr_persons p ON p.id = i.person_id
       WHERE i.kind = ${String(kind)} AND i.ref_id = ${refId} AND i.unlinked_at IS NULL LIMIT 1`));
    if (taken.length) {
      const who = String(taken[0].display_name || 'another person record');
      return taken[0].id === personId
        ? { ok: false, error: 'That record is already linked to this person.' }
        : { ok: false, error: 'That record already belongs to ' + who + '. Withdraw that link first if it is wrong. '
            + 'Nothing here moves a record between two people in one step.' };
    }
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_person_identities (person_id, kind, ref_id, assertion_type, basis, linked_by_user_id)
      VALUES (${personId}::uuid, ${String(kind)}, ${refId}, 'explicitly_provided', ${basis}, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'person.identity.link',
      entity: 'hr_person_identities',
      entityId: String(rows[0].id),
      diff: { personId, kind, refId, basis },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'linkIdentity', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Withdraw an identity link.
 *
 * NOT A DELETE. The row keeps its place with an end, a reason and an actor, because "this was linked
 * in error" is itself part of how this person's identity was decided, and a screen has to be able to
 * explain why an obviously-related record is not attached.
 */
export async function unlinkIdentity(input: {
  identityId: string;
  reason: string;
  actorUserId: string;
}): Promise<SpineWriteResult> {
  const identityId = String(input?.identityId || '');
  const reason = clean(input?.reason, 1000);
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!isUuid(identityId)) return { ok: false, error: 'That link does not exist.' };
  if (!reason) return { ok: false, error: 'Say why this link is being withdrawn. It stays on the record.' };
  if (!actor) return { ok: false, error: 'We could not tell who is making this statement, so nothing was written.' };
  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_person_identities
         SET unlinked_at = NOW(), unlinked_by_user_id = ${actor}::uuid, unlink_reason = ${reason}
       WHERE id = ${identityId}::uuid AND unlinked_at IS NULL
       RETURNING id::text AS id, person_id::text AS person_id, kind, ref_id`));
    if (!rows.length) return { ok: false, error: 'That link does not exist, or it has already been withdrawn.' };
    await logAudit({
      userId: actor,
      action: 'person.identity.unlink',
      entity: 'hr_person_identities',
      entityId: identityId,
      diff: { personId: String(rows[0].person_id), kind: String(rows[0].kind), refId: String(rows[0].ref_id), reason },
    });
    return { ok: true, id: identityId };
  } catch (e: any) {
    logFail(MOD, 'unlinkIdentity', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * The employee id behind a person, when there is one.
 *
 * Most of the existing HR engine is keyed on hr_employees.id, so this is the adapter between the
 * spine and everything already built. It returns null rather than guessing, and a null here means
 * "no employee record is linked", never "this person is not an employee".
 */
export async function employeeIdForPerson(personId: string): Promise<string | null> {
  if (!isUuid(personId)) return null;
  try {
    await ensureSpineSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT ref_id FROM hr_person_identities
       WHERE person_id = ${personId}::uuid AND kind = 'employee' AND unlinked_at IS NULL
       ORDER BY linked_at DESC LIMIT 1`));
    return r.length && r[0].ref_id ? String(r[0].ref_id) : null;
  } catch (e: any) {
    logFail(MOD, 'employeeIdForPerson', e);
    return null;
  }
}
