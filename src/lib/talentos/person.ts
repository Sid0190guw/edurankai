// src/lib/talentos/person.ts — resolving a human to exactly one tos_person row.
//
// This is the module every other part of the Talent Operating System depends on being correct,
// because a person is the thing all of it hangs off: applications, selections, codes, onboarding
// records and organizational identities. Section 5 of docs/talent-os-spec.md is the specification.
//
// ================================================================================================
// THE ASYMMETRY THAT DECIDES EVERY RULE BELOW.
//
// Getting resolution wrong has two failure modes and they are NOT equally bad.
//
//   SPLITTING one human into two person rows is a nuisance. Their application history looks short,
//   a recruiter sees two candidates where there is one, and the fix is a merge that repoints the
//   child rows. Recoverable, cheap, visible.
//
//   FUSING two humans into one person row means one stranger can see another stranger's
//   application history, selection decisions and onboarding record. It is a data breach, and it is
//   NOT recoverable after the fact — the disclosure has already happened by the time anyone notices.
//
// So every rule here is biased toward splitting. We match on a verified email address and on
// nothing else. Names collide constantly. Phone numbers are reused, shared within families, and
// recycled by carriers. Dates of birth collide by the hundred in any population worth having a
// recruitment system for. None of them are identity.
// ================================================================================================
import { sql } from 'drizzle-orm';
import { nextPersonCode, withMintedCode } from './codes';
import { ensureTalentOsSchema } from './schema';

async function database(): Promise<any> {
  const { db } = await import('@/lib/db');
  return db;
}

/** postgres-js returns a plain array. `r.rows[0]` is undefined in production. */
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** The real Postgres reason lives on e.cause; e.message is only the failed statement. */
function reason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

export interface Person {
  id: string;
  personCode: string;
  displayName: string;
  primaryEmail: string;
  phone: string | null;
  userId: string | null;
  mergedIntoId: string | null;
  createdAt: string;
}

/** How a person was arrived at. Surfaced so callers can decide whether to demand verification. */
export type ResolveMethod = 'session' | 'verified_email' | 'unverified_email' | 'created';

export interface ResolveResult {
  person: Person;
  method: ResolveMethod;
  /**
   * TRUE when the caller MUST prove control of the address before anything consequential happens.
   *
   * Set for `unverified_email` and `created`. It is not an error and it does not block browsing;
   * it blocks selection, code redemption and every onboarding step. Redeeming an authorization code
   * against an unproven address is precisely the hole that binding a code to a person exists to
   * close.
   */
  requiresEmailVerification: boolean;
}

function normaliseEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function mapPerson(r: any): Person {
  return {
    id: r.id,
    personCode: r.person_code,
    displayName: r.display_name,
    primaryEmail: r.primary_email,
    phone: r.phone ?? null,
    userId: r.user_id ?? null,
    mergedIntoId: r.merged_into_id ?? null,
    createdAt: String(r.created_at),
  };
}

/**
 * Follow a merge pointer to the live person.
 *
 * Bounded to ten hops rather than looping until it finds a null. A cycle in merged_into_id should
 * be impossible — merges repoint to a LIVE row and db/talent-os-validate.sql checks for chains —
 * but "should be impossible" is not a reason to write a loop that hangs a request thread if it ever
 * happens. On exceeding the bound the last row reached is returned and the anomaly is logged,
 * because returning SOMETHING correct-ish beats a spinning request.
 */
async function followMerge(db: any, row: any): Promise<any> {
  let current = row;
  for (let hops = 0; hops < 10; hops++) {
    if (!current?.merged_into_id) return current;
    const r = await db.execute(sql`SELECT * FROM tos_person WHERE id = ${current.merged_into_id} LIMIT 1`);
    const next = rows(r)[0];
    if (!next) {
      console.error('[talentos/person] merge pointer goes nowhere:', current.person_code);
      return current;
    }
    current = next;
  }
  console.error('[talentos/person] merge chain exceeded 10 hops from:', row?.person_code);
  return current;
}

/** The live person for a given id, following any merge pointer. Null when there is no such row. */
export async function getPerson(personId: string): Promise<Person | null> {
  await ensureTalentOsSchema();
  const db = await database();
  const r = await db.execute(sql`SELECT * FROM tos_person WHERE id = ${personId} LIMIT 1`);
  const row = rows(r)[0];
  if (!row) return null;
  return mapPerson(await followMerge(db, row));
}

/** The live person for a signed-in auth account, if one has been linked. */
export async function personForUser(userId: string): Promise<Person | null> {
  await ensureTalentOsSchema();
  const db = await database();
  const r = await db.execute(sql`
    SELECT * FROM tos_person WHERE user_id = ${userId} AND merged_into_id IS NULL LIMIT 1`);
  const row = rows(r)[0];
  return row ? mapPerson(row) : null;
}

export interface ResolveInput {
  /** The signed-in auth account, when there is one. Checked first. */
  userId?: string | null;
  email?: string | null;
  /** Used only when a person is CREATED. Never overwrites an existing row. */
  displayName?: string | null;
  phone?: string | null;
}

/**
 * Resolve a human to exactly one tos_person, creating one only when nothing matches.
 *
 * THE ORDER IS THE SPECIFICATION (section 5.3) AND IT STOPS AT THE FIRST MATCH:
 *
 *   1. Session      — the signed-in users.id already has a person.
 *   2. Verified     — an address proven to belong to a person.
 *   3. Unverified   — an address recorded but not proven. Matches, but flags that it must be
 *                     proven before anything consequential happens.
 *   4. Create       — nothing matched.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: match on name, phone or date of birth, at any rung, ever.
 */
export async function resolvePerson(input: ResolveInput): Promise<ResolveResult> {
  await ensureTalentOsSchema();
  const db = await database();

  // ---- Rung 1: the session ----------------------------------------------------------------
  if (input.userId) {
    const existing = await personForUser(input.userId);
    if (existing) return { person: existing, method: 'session', requiresEmailVerification: false };
  }

  const email = normaliseEmail(input.email || '');

  // ---- Rungs 2 and 3: the address -----------------------------------------------------------
  if (email) {
    const r = await db.execute(sql`
      SELECT p.*, e.is_verified
      FROM tos_person_email e
      JOIN tos_person p ON p.id = e.person_id
      WHERE lower(e.email) = ${email}
      LIMIT 1`);
    const row = rows(r)[0];
    if (row) {
      const live = await followMerge(db, row);
      const verified = row.is_verified === true;
      // ADOPT THE ACCOUNT IF THIS PERSON HAS NONE. Someone who applied by email and later created
      // an account must not become a second person the next time they sign in. Guarded by a
      // conditional UPDATE rather than a read-then-write, because tos_person_user_idx is UNIQUE
      // over live rows and two requests can race here.
      if (input.userId && !live.user_id) {
        try {
          await db.execute(sql`
            UPDATE tos_person SET user_id = ${input.userId}, updated_at = NOW()
            WHERE id = ${live.id} AND user_id IS NULL AND merged_into_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM tos_person o
                WHERE o.user_id = ${input.userId} AND o.merged_into_id IS NULL)`);
          live.user_id = input.userId;
        } catch (e: any) {
          // Losing this race is harmless: the other writer linked the same account to the same
          // person. It is logged rather than swallowed because if it happens often, something is
          // wrong upstream.
          console.error('[talentos/person] account adoption skipped:', reason(e));
        }
      }
      return {
        person: mapPerson(live),
        method: verified ? 'verified_email' : 'unverified_email',
        requiresEmailVerification: !verified,
      };
    }
  }

  // ---- Rung 4: create ------------------------------------------------------------------------
  if (!email) {
    throw new Error('resolvePerson needs an email address when there is no linked session');
  }

  const displayName = String(input.displayName || '').trim() || email;
  const person = await withMintedCode(nextPersonCode, async (code) => {
    const r = await db.execute(sql`
      INSERT INTO tos_person (person_code, display_name, primary_email, phone, user_id)
      VALUES (${code}, ${displayName}, ${email}, ${input.phone || null}, ${input.userId || null})
      RETURNING *`);
    return rows(r)[0];
  });

  // The address is recorded UNVERIFIED. It is the only claim we have and nothing has proven it yet.
  // ON CONFLICT DO NOTHING covers the race where two requests create the same address at once; the
  // unique index on lower(email) is what actually decides the winner.
  try {
    await db.execute(sql`
      INSERT INTO tos_person_email (person_id, email, is_verified, is_official)
      VALUES (${person.id}, ${email}, FALSE, ${email.endsWith('@edurankai.in')})
      ON CONFLICT DO NOTHING`);
  } catch (e: any) {
    console.error('[talentos/person] email row not written for', person.person_code, reason(e));
    throw e;
  }

  return { person: mapPerson(person), method: 'created', requiresEmailVerification: true };
}

/**
 * Mark an address proven. Called only by a flow that has actually verified control of it — a
 * click-through token or a one-time code delivered to that address.
 *
 * `is_official` is recomputed here rather than trusted from the caller, and it still grants nothing.
 * An @edurankai.in address is an authentication convenience and a display fact. Authorization comes
 * from tos_identity, which is a grant with a lifetime and a status.
 */
export async function markEmailVerified(personId: string, email: string): Promise<boolean> {
  await ensureTalentOsSchema();
  const db = await database();
  const e = normaliseEmail(email);
  const r = await db.execute(sql`
    UPDATE tos_person_email
       SET is_verified = TRUE, verified_at = NOW(), is_official = ${e.endsWith('@edurankai.in')}
     WHERE person_id = ${personId} AND lower(email) = ${e}
     RETURNING id`);
  return rows(r).length > 0;
}

/** Every address on file for a person, verified or not. */
export async function listEmails(personId: string): Promise<
  Array<{ email: string; isVerified: boolean; isOfficial: boolean }>
> {
  await ensureTalentOsSchema();
  const db = await database();
  const r = await db.execute(sql`
    SELECT email, is_verified, is_official FROM tos_person_email
     WHERE person_id = ${personId} ORDER BY is_verified DESC, created_at ASC`);
  return rows(r).map((x: any) => ({
    email: x.email,
    isVerified: x.is_verified === true,
    isOfficial: x.is_official === true,
  }));
}

export interface MergeResult {
  ok: boolean;
  error?: string;
  moved?: Record<string, number>;
}

/**
 * Merge `loserId` into `winnerId`. NOTHING IS DELETED.
 *
 * The loser row stays, carrying merged_into_id, so that every historical reference to it still
 * resolves — a printed selection reference, an audit entry, a link in an old email. Its children
 * are repointed at the winner.
 *
 * WHY DELETION IS NOT AN OPTION HERE. A merge is a judgement call made by a person looking at two
 * records, and judgement calls are sometimes wrong. A merge that repoints rows can be reasoned
 * about and, if it was wrong, split again from the audit trail. A merge that deletes a row destroys
 * the evidence needed to tell that it was wrong.
 *
 * `actorUserId` is required. A merge changes who can see whose application history, so an anonymous
 * one is not a thing this function will perform.
 */
export async function mergePersons(
  winnerId: string,
  loserId: string,
  actorUserId: string,
  note: string,
): Promise<MergeResult> {
  await ensureTalentOsSchema();
  const db = await database();

  if (!actorUserId) return { ok: false, error: 'a merge must record who performed it' };
  if (winnerId === loserId) return { ok: false, error: 'cannot merge a person into themselves' };
  if (String(note || '').trim().length < 10) {
    return { ok: false, error: 'a merge must record why, in a sentence' };
  }

  const w = await getPerson(winnerId);
  const l = await getPerson(loserId);
  if (!w) return { ok: false, error: 'winner not found' };
  if (!l) return { ok: false, error: 'loser not found' };
  if (w.id === l.id) return { ok: false, error: 'both ids resolve to the same live person' };
  if (l.mergedIntoId) return { ok: false, error: 'that person has already been merged' };

  const moved: Record<string, number> = {};
  try {
    // Repoint the children first, then set the pointer. In that order a failure part-way leaves
    // rows on a person who is still live and still reachable, rather than on one that now claims to
    // have been merged away.
    const steps: Array<[string, any]> = [
      ['tos_person_email', sql`UPDATE tos_person_email SET person_id = ${w.id} WHERE person_id = ${l.id} RETURNING id`],
      ['tos_application_link', sql`UPDATE tos_application_link SET person_id = ${w.id} WHERE person_id = ${l.id} RETURNING application_id`],
      ['tos_selection', sql`UPDATE tos_selection SET person_id = ${w.id}, updated_at = NOW() WHERE person_id = ${l.id} RETURNING id`],
      ['tos_auth_code', sql`UPDATE tos_auth_code SET person_id = ${w.id} WHERE person_id = ${l.id} RETURNING id`],
      ['tos_onboarding', sql`UPDATE tos_onboarding SET person_id = ${w.id}, updated_at = NOW() WHERE person_id = ${l.id} RETURNING id`],
      ['tos_onboarding_grant', sql`UPDATE tos_onboarding_grant SET person_id = ${w.id} WHERE person_id = ${l.id} RETURNING id`],
      ['tos_identity', sql`UPDATE tos_identity SET person_id = ${w.id}, updated_at = NOW() WHERE person_id = ${l.id} RETURNING id`],
    ];
    for (const [name, stmt] of steps) {
      const r = await db.execute(stmt);
      moved[name] = rows(r).length;
    }

    // THE ONE-PRIMARY INVARIANT SURVIVES A MERGE. Both people may have held an active primary
    // identity; after repointing, the winner would hold two, which tos_identity_one_primary makes
    // illegal. The winner's own earlier identity keeps the primary slot and the arrival is demoted
    // for a human to date correctly, rather than the merge failing outright at the index.
    await db.execute(sql`
      UPDATE tos_identity SET is_primary = FALSE, updated_at = NOW()
       WHERE person_id = ${w.id} AND is_primary AND status = 'active'
         AND id <> (
           SELECT id FROM tos_identity
            WHERE person_id = ${w.id} AND is_primary AND status = 'active'
            ORDER BY started_on NULLS LAST, created_at ASC LIMIT 1)`);

    await db.execute(sql`
      UPDATE tos_person SET merged_into_id = ${w.id}, updated_at = NOW() WHERE id = ${l.id}`);
  } catch (e: any) {
    console.error('[talentos/person] merge failed:', reason(e));
    return { ok: false, error: reason(e), moved };
  }

  // AUDITED, and the failure of the audit is not swallowed. A merge changes who can see whose
  // records; if it cannot be recorded, the operator needs to know that it happened unrecorded.
  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: actorUserId,
      action: 'person.merged',
      entity: 'tos_person',
      entityId: l.id,
      diff: { winner: w.personCode, loser: l.personCode, note: String(note).trim(), moved },
    });
  } catch (e: any) {
    console.error('[talentos/person] merge completed but was NOT audited:', reason(e));
  }

  return { ok: true, moved };
}
