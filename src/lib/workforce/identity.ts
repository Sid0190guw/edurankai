/**
 * src/lib/workforce/identity.ts — ONE ANSWER TO "WHICH EMPLOYEE RECORD IS THIS ACCOUNT?"
 *
 * =================================================================================================
 * WHY THIS EXISTS: NINE COPIES OF ONE LOOKUP, AND THEY DID NOT AGREE
 * =================================================================================================
 *
 * Nine pages under /portal/employee each opened with their own version of this block:
 *
 *     SELECT ... FROM hr_employees WHERE user_id = $1 AND is_active = true LIMIT 1
 *     -- and, if that missed --
 *     SELECT ... FROM hr_employees
 *      WHERE (work_email = $2 OR personal_email = $2 OR email = $2)
 *        AND is_active = true LIMIT 1
 *
 * Written independently, in good faith, and wrong in three ways that only show up on a real roll.
 *
 * 1. CASE-SENSITIVE. `work_email = $2` compares byte for byte. The canonical resolver in
 *    src/lib/auth/workspace-access.ts compares `lower(work_email) = lower($2)`, and says in its own
 *    comment why: "an address is the same address however it was typed into the HR form". So a
 *    person whose record reads `Priya.S@edurankai.in` and whose account reads `priya.s@edurankai.in`
 *    saw their workspace home page fine and was told "no employee record" on nine other pages. That
 *    is not a rare shape; HR forms are typed by hand.
 *
 * 2. IT PICKED WHEN IT SHOULD HAVE REFUSED. `LIMIT 1` over a three-column OR on columns with no
 *    unique constraint hands the first matching row to whoever signs in. workspace-access.ts takes
 *    LIMIT 2 precisely so it can DETECT that case and refuse it, and its comment spells out the
 *    consequence: "quietly hand whoever signs in first the other person's hours, leave, reviews,
 *    documents and credit position". Nine pages did not have that check. One of them —
 *    /portal/employee/wallet — read the matched row with `SELECT *`, which is PAN, Aadhaar, bank
 *    account number and base salary. A shared inbox typed into `email` on two records is all it took.
 *
 * 3. TWO SEQUENTIAL SCANS PER PAGE. Neither `lower(work_email)` nor its two siblings had an index,
 *    and the fallback ran on every load for anyone whose `user_id` link was never backfilled. At the
 *    roll size this portal is now written for, that is two full reads of hr_employees to render a
 *    page. db/hr-scale-indexes.sql creates the three functional indexes that make the fallback a
 *    bitmap of three index lookups instead.
 *
 * =================================================================================================
 * WHAT THIS MODULE IS, AND WHAT IT IS NOT
 * =================================================================================================
 *
 * It is a THIN, HONEST wrapper over requireEmployee() — the gate that already got all three of those
 * right — reshaped into the flat fields a self-service page renders. It adds no authorization of its
 * own: if requireEmployee() refuses, this refuses with the same code and the same sentence, and the
 * page renders that sentence instead of a record. It also adds NO QUERY of its own; every field
 * comes off the row the gate already read.
 *
 * IT IS NOT A PLACE TO ADD COLUMNS. `Workspace` omits gender, government ids, bank details and
 * salary on purpose, and so does this. A page that needs one of those asks the module that owns it
 * and enforces its own rule — payroll reads salary, hr-wallet reads bank details — never a shared
 * identity helper that every page imports. If a new field is genuinely identity, put it on
 * EMPLOYEE_COLUMNS so it rides the existing read, rather than adding a second SELECT here; that is
 * exactly what `currency` had to be moved out of.
 */
import {
  requireEmployee,
  type WorkspaceUser,
  type Workspace,
  type WorkspaceDenial,
} from '@/lib/auth/workspace-access';

/**
 * The identity a self-service page needs, and nothing else.
 *
 * `employeeId` is the value every hr_* table is keyed by, and the ONLY value a personal query may be
 * narrowed on. `userId` is a different id for a different question — write it to columns that hold
 * an account reference, never to an `employee_id`.
 */
export interface EmployeeIdentity {
  employeeId: string;
  userId: string;
  fullName: string;
  employeeCode: string | null;
  designation: string | null;
  /** Opaque. Slug or uuid depending on deployment — compare with idEq(), never cast to uuid. */
  departmentId: string | null;
  departmentName: string | null;
  /** ISO 4217, off the employee record. Null when HR never set one; a page must not assume INR. */
  currency: string | null;
  /** The full workspace, for anything that needs the engagement or the scope. */
  workspace: Workspace;
}

/**
 * THREE OUTCOMES, KEPT APART, because they are three different sentences to the person reading.
 *
 *   ok        — the record resolved.
 *   denied    — we know why there is no record, and `title`/`reason` say so in plain words. This
 *               covers "not signed in", "no record linked", "more than one record uses your
 *               address" and "your record is closed". The page RENDERS these; it does not treat
 *               them as an error.
 *   failed    — the read did not happen. Nothing is known. A page must not print "you have no
 *               expenses" over this, and that confusion is the whole reason the two are separate.
 *
 * `redirect` is set only for 'not-signed-in'. Every other denial is shown IN PLACE — four portal
 * pages once redirected to /admin and middleware bounced them straight back, which is the loop that
 * took /portal down, and it is why nothing here redirects anywhere but the login screen.
 */
export type IdentityResult =
  | { ok: true; identity: EmployeeIdentity; denial: null; failed: false }
  | {
      ok: false;
      identity: null;
      failed: boolean;
      denial: { code: WorkspaceDenial; title: string; reason: string; redirect: string | null };
    };

/**
 * Resolve the signed-in account to its employee record.
 *
 * NO ROUND TRIP OF ITS OWN. Everything it returns comes off the read requireEmployee() already made,
 * and lookupWorkspace() memoizes that per request — so a page that calls this after the composer has
 * run costs nothing at all. The per-page version it replaces did two unindexed reads of hr_employees.
 *
 * @param next where to return to after signing in, for the not-signed-in redirect.
 */
export async function resolveEmployeeIdentity(
  user: WorkspaceUser | null | undefined,
  next = '/portal/employee',
): Promise<IdentityResult> {
  const gate = await requireEmployee(user, next);
  if (!gate.ok) {
    return {
      ok: false,
      identity: null,
      // 'lookup-failed' is the only denial that means "we do not know"; every other one is a fact
      // about this account that the page can state.
      failed: gate.code === 'lookup-failed',
      denial: {
        code: gate.code as WorkspaceDenial,
        title: gate.title || 'Your record is not available',
        reason: gate.reason || 'Ask HR to check the record linked to the address you signed in with.',
        redirect: gate.redirect || null,
      },
    };
  }

  // ZERO EXTRA QUERIES. This used to run a second `SELECT currency FROM hr_employees WHERE id = $1`
  // right here — on every one of the nine pages that resolve identity through the gate, including
  // the six that never render an amount. That is a round trip per page load to fetch a column the
  // gate had ALREADY selected the row for. `currency` now rides on EMPLOYEE_COLUMNS in
  // workspace-access.ts, so it costs nothing and every caller gets it.
  //
  // Which is the same mistake, at a smaller scale, that this whole pass exists to remove: a read
  // that looks free because it is one statement, multiplied by every page and every person.
  const ws = gate.workspace;

  return {
    ok: true,
    denial: null,
    failed: false,
    identity: {
      employeeId: ws.employeeId,
      userId: String(user?.id || ''),
      fullName: ws.fullName,
      employeeCode: ws.employeeCode,
      designation: ws.designation,
      departmentId: ws.department?.id ?? null,
      departmentName: ws.department?.name ?? null,
      currency: ws.currency,
      workspace: ws,
    },
  };
}
