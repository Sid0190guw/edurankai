// THE SKILLS A PERSON'S ROLE ASKED FOR, read from the job description they were hired against.
//
// Used to pre-fill a certificate's "Skills demonstrated" row and the list a graduate copies into
// LinkedIn. It is a STARTING POINT the issuer edits, never a claim made on its own: a JD lists what
// the role needed, and the person issuing the certificate decides which of those were shown.
//
// Path: hr_employees.application_id -> applications.role_id -> roles.skills. When the person was
// added by hand with no application, the role is matched on the designation instead. Fails closed to
// an empty list.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function clean(list: unknown): string[] {
  let v: any = list;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.split(/[,\n]/); } }
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    const s = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.slice(0, 12);
}

/** Split what an operator typed (commas or new lines) into a clean list. */
export function parseSkills(text: unknown): string[] {
  return clean(String(text ?? '').split(/[,\n]/));
}

export async function skillsForEmployee(employeeId: string): Promise<string[]> {
  try {
    const viaApp = rows(await db.execute(sql`
      SELECT r.skills FROM hr_employees e
        JOIN applications a ON a.id = e.application_id
        JOIN roles r ON r.id = a.role_id
       WHERE e.id = ${employeeId}::uuid LIMIT 1`));
    const a = clean(viaApp[0]?.skills);
    if (a.length) return a;
    const viaTitle = rows(await db.execute(sql`
      SELECT r.skills FROM hr_employees e
        JOIN roles r ON lower(r.title) = lower(e.designation)
       WHERE e.id = ${employeeId}::uuid LIMIT 1`));
    return clean(viaTitle[0]?.skills);
  } catch (e: any) {
    console.error('[hr/role-skills]', e?.cause?.message || e?.message);
    return [];
  }
}
