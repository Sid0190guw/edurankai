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
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export interface InternCheck { isIntern: boolean; demoted: boolean }

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
      SELECT employment_type, designation FROM hr_employees
       WHERE (user_id = ${user.id} OR email = ${user.email || ''}
              OR work_email = ${user.email || ''} OR personal_email = ${user.email || ''})
       LIMIT 1`);
    const emp = rows(r)[0];
    if (!emp) return { isIntern: false, demoted: false };

    const type = String(emp.employment_type || '').toLowerCase();
    const title = String(emp.designation || '').toLowerCase();
    // 'Internship' is the value the HR form writes; the designation is checked too because a role
    // titled "... Intern" is the same person regardless of how their employment type was recorded.
    const isIntern = type.includes('intern') || title.includes('intern');
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
