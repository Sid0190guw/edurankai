// src/lib/auth/intern-guard.ts — keep interns out of the admin panel, and repair the ones already in.
//
// Accepting an offer used to run `UPDATE users SET role = 'editor'`. The editor role carries
// admin.access, so every intern who signed their offer letter could open /admin and read the
// applicant pipeline, employee records, HEI data and every candidate's name. The promotion is gone
// from the signing path, but the accounts it already created still hold the role.
//
// This guard does two things on every admin request, in this order:
//   1. BLOCKS. An intern is refused before the page renders, so exposure stops on the next click
//      rather than after a database migration someone has to remember to run.
//   2. REPAIRS. It demotes the row, so the account stops being an editor everywhere else too —
//      the notification fan-out, the permission matrix, anything that reads users.role.
//
// It is deliberately narrow: it only ever touches a user who is an 'editor' AND holds an
// internship HR record. A genuine editor, an HR user, an admin or the founder is never affected,
// because demoting the wrong person is its own outage.
//
// WHO IS AN INTERN IS NOT DECIDED IN THIS FILE ANY MORE. Both functions below call resolveIsIntern()
// from src/lib/auth/intern-signals.ts — the same function src/lib/auth/workspace-access.ts uses to
// hand an intern their own workspace. This guard used to carry its own copy of that rule: a substring
// test on employment_type and designation, under which "Internal Auditor" was demoted out of the
// editor role and locked out of /admin. The guard that closes a door and the gate that opens one are
// the same decision seen from opposite sides, and they now share the one implementation of it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { resolveIsIntern } from '@/lib/auth/intern-signals';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/**
 * One sweep reads at most this many pairs. `role = 'editor'` is a small, indexed slice, so this is a
 * ceiling rather than a page: a demoted account leaves the slice, so a hypothetical backlog larger
 * than the cap drains over the next visits to /admin/users instead of being read in one gulp.
 */
const CANDIDATE_LIMIT = 2000;

export interface InternCheck { isIntern: boolean; demoted: boolean }

/**
 * Every (editor account, employee record) pair, with whatever intern signals the database can answer.
 *
 * TWO-STEP ON PURPOSE. `classification`, `classification_reviewed_at` and `application_id` are
 * self-bootstrapped by other modules, so on a database where those have not run the enriched query
 * fails. Falling straight to "nobody is an intern" would silently switch the sweep off, so the
 * fallback re-asks with the two columns this function has always read — which makes resolveIsIntern()
 * collapse to its last arm, the substring test, i.e. exactly today's behaviour. If that fails too the
 * error propagates and the caller reports zero.
 *
 * Declared above its callers: `const` is not hoisted and a handler reaching a later declaration has
 * taken pages down on this project.
 */
async function internEditorPairs(): Promise<any[]> {
  const link = sql`(e.user_id = u.id OR e.email = u.email
                    OR e.work_email = u.email OR e.personal_email = u.email)`;
  try {
    return rows(await db.execute(sql`
      SELECT u.id AS user_id, e.employment_type, e.designation,
             e.classification, e.classification_reviewed_at, ro.level AS seniority
        FROM users u
        JOIN hr_employees e ON ${link}
        LEFT JOIN applications a ON a.id = e.application_id
        LEFT JOIN roles ro ON ro.id = a.role_id
       WHERE u.role = 'editor'
       LIMIT ${CANDIDATE_LIMIT}`));
  } catch (e: any) {
    console.warn('[intern-guard] structured intern signals unavailable', e?.cause?.message || e?.message);
    return rows(await db.execute(sql`
      SELECT u.id AS user_id, e.employment_type, e.designation
        FROM users u
        JOIN hr_employees e ON ${link}
       WHERE u.role = 'editor'
       LIMIT ${CANDIDATE_LIMIT}`));
  }
}

/**
 * Demote EVERY intern still holding the editor role.
 *
 * checkInternAccess() below only repairs a person at the moment they try to open /admin, which
 * leaves everyone who has not visited since the fix still sitting in the users list as an editor —
 * still carrying admin.access everywhere else that reads users.role, and still counted as staff by
 * anything that fans out notifications by role. Waiting for each of them to click is not a fix.
 *
 * Narrow in exactly the same way as the per-request guard: a row is touched only if it is 'editor'
 * AND joins to an hr_employees record that resolves to an internship. A real editor, HR, an admin or
 * the founder is never matched. Returns how many rows changed so the caller can report it honestly.
 *
 * The rule is applied in TypeScript rather than restated as SQL, deliberately: a second
 * implementation of an ordered rule is the drift this refactor exists to remove, and it would be the
 * copy nobody remembers to update. ANY matching employee record makes the person an intern — the
 * same semantics the EXISTS clause had, and it matters for somebody carrying a closed internship
 * alongside a current contract.
 */
export async function demoteAllInternEditors(): Promise<number> {
  try {
    const pairs = await internEditorPairs();

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const p of pairs) {
      const id = String(p.user_id || '').trim();
      if (!id || seen.has(id)) continue;
      const isIntern = resolveIsIntern({
        classification: p.classification,
        classificationReviewedAt: p.classification_reviewed_at,
        seniority: p.seniority,
        employmentType: p.employment_type,
        designation: p.designation,
      });
      if (!isIntern) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length === 0) return 0;

    // Re-tested in the WHERE clause, so a role changed between the read and the write is not
    // overwritten by a decision made against stale data.
    const r = await db.execute(sql`
      UPDATE users SET role = 'applicant', updated_at = NOW()
       WHERE role = 'editor'
         AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       RETURNING id`);
    const n = rows(r).length;
    if (n > 0) console.warn('[intern-guard] bulk demoted intern editors', { count: n });
    return n;
  } catch (e: any) {
    console.error('[intern-guard] bulk demote failed', e?.cause?.message || e?.message);
    return 0;
  }
}

/**
 * Is this person an intern who should not be in the admin panel?
 *
 * FAILS OPEN on error, and that is the right direction here: this guard's job is to remove access
 * that was granted by mistake, not to become a new way for the admin panel to lock out the people
 * who run it. A database blip must not bar HR from their own console. The narrow scope above is
 * what makes failing open safe.
 */
export async function checkInternAccess(user: { id?: string; email?: string; role?: string } | null | undefined): Promise<InternCheck> {
  if (!user?.id) return { isIntern: false, demoted: false };
  // Only the role the faulty promotion produced is ever considered.
  if (user.role !== 'editor') return { isIntern: false, demoted: false };

  try {
    // Matches on every identity column, because the user -> employee link is not guaranteed:
    // some records join by user_id, others only by one of the three email columns.
    const r = await db.execute(sql`
      SELECT id, employment_type, designation FROM hr_employees
       WHERE (user_id = ${user.id} OR email = ${user.email || ''}
              OR work_email = ${user.email || ''} OR personal_email = ${user.email || ''})
       LIMIT 1`);
    const emp = rows(r)[0];
    if (!emp) return { isIntern: false, demoted: false };

    // The structured signals, on the row just matched, in their own try: the columns are
    // self-bootstrapped elsewhere, and a missing one must cost the two structured arms rather than
    // the whole check. Losing them leaves resolveIsIntern() with the substring test — today's answer,
    // and the strict direction — whereas letting this throw would land in the outer catch, which
    // FAILS OPEN and would stop blocking interns altogether.
    let classification: any = null;
    let classificationReviewedAt: any = null;
    let seniority: any = null;
    try {
      const sig = rows(await db.execute(sql`
        SELECT e.classification, e.classification_reviewed_at, ro.level AS seniority
          FROM hr_employees e
          LEFT JOIN applications a ON a.id = e.application_id
          LEFT JOIN roles ro ON ro.id = a.role_id
         WHERE e.id = ${String(emp.id)}
         LIMIT 1`))[0];
      classification = sig?.classification ?? null;
      classificationReviewedAt = sig?.classification_reviewed_at ?? null;
      seniority = sig?.seniority ?? null;
    } catch (e: any) {
      console.warn('[intern-guard] structured intern signals unavailable', e?.cause?.message || e?.message);
    }

    // ONE RULE, SHARED WITH THE WORKSPACE GATE. 'Internship' is the value the HR form writes and
    // 'full_time' is what the auto-hire path writes for everyone, which is why designation is read
    // too — and why the register's classification and the hired role's level are read first.
    const isIntern = resolveIsIntern({
      classification,
      classificationReviewedAt,
      seniority,
      employmentType: emp.employment_type,
      designation: emp.designation,
    });
    if (!isIntern) return { isIntern: false, demoted: false };

    // Repair the row so the escalation ends here rather than on every future request.
    let demoted = false;
    try {
      await db.execute(sql`
        UPDATE users SET role = 'applicant', updated_at = NOW()
         WHERE id = ${user.id}::uuid AND role = 'editor'`);
      demoted = true;
      console.warn('[intern-guard] demoted intern account out of editor', { email: user.email });
    } catch (e: any) {
      // Blocking still happens even if the write fails — the refusal below does not depend on it.
      console.error('[intern-guard] demote failed', e?.cause?.message || e?.message);
    }

    return { isIntern: true, demoted };
  } catch (e: any) {
    console.error('[intern-guard]', e?.cause?.message || e?.message);
    return { isIntern: false, demoted: false };
  }
}
