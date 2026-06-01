// GET /api/admin/search?q=<term>
// Searches applications, hr_employees, users, roles, and applications by
// number in parallel; returns the top hits across every entity for the
// admin top-bar global search.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);

  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ ok: true, results: [] });
  const term = '%' + q + '%';

  const out: any[] = [];
  // Applications
  try {
    const r = rows(await db.execute(sql`
      SELECT id, application_number, first_name, last_name, email, role_title_snapshot, status
      FROM applications
      WHERE lower(first_name) LIKE ${term} OR lower(last_name) LIKE ${term}
         OR lower(email) LIKE ${term} OR lower(application_number) LIKE ${term}
         OR lower(role_title_snapshot) LIKE ${term}
      ORDER BY created_at DESC LIMIT 8
    `));
    for (const a of r) out.push({
      kind: 'application',
      title: ((a.first_name || '') + ' ' + (a.last_name || '')).trim() || a.email,
      subtitle: a.role_title_snapshot + ' · ' + (a.application_number || '') + ' · ' + a.status,
      url: '/admin/applications/' + a.id,
    });
  } catch (_) {}
  // Employees
  try {
    const r = rows(await db.execute(sql`
      SELECT id, full_name, email, personal_email, employee_code, designation
      FROM hr_employees
      WHERE lower(full_name) LIKE ${term} OR lower(email) LIKE ${term}
         OR lower(personal_email) LIKE ${term} OR lower(employee_code) LIKE ${term}
      ORDER BY created_at DESC LIMIT 6
    `));
    for (const e of r) out.push({
      kind: 'employee',
      title: e.full_name,
      subtitle: (e.designation || '') + ' · ' + (e.employee_code || ''),
      url: '/admin/hr/employees/' + e.id,
    });
  } catch (_) {}
  // Users
  try {
    const r = rows(await db.execute(sql`
      SELECT id, name, email, role FROM users
      WHERE lower(name) LIKE ${term} OR lower(email) LIKE ${term}
      ORDER BY created_at DESC LIMIT 6
    `));
    for (const u of r) out.push({
      kind: 'user',
      title: u.name || u.email,
      subtitle: u.email + ' · ' + (u.role || ''),
      url: '/admin/users',
    });
  } catch (_) {}
  // Roles
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, level, function FROM roles
      WHERE lower(title) LIKE ${term} OR lower(function) LIKE ${term} OR lower(slug) LIKE ${term}
      ORDER BY sort_order ASC LIMIT 6
    `));
    for (const ro of r) out.push({
      kind: 'role',
      title: ro.title,
      subtitle: (ro.level || '') + ' · ' + (ro.function || ''),
      url: '/admin/roles',
    });
  } catch (_) {}

  return json({ ok: true, query: q, results: out });
};
