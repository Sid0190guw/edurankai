// GET /api/admin/search?q=<term>
// Searches every meaningful entity in parallel and merges. Each block is
// wrapped in try/catch so a missing table doesn't blank the whole result.
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

  // 1. Applications
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

  // 2. Application intents (unpaid pre-submissions)
  try {
    const r = rows(await db.execute(sql`
      SELECT i.id, i.email, i.first_name, i.last_name, i.role_title_snapshot
      FROM application_intents i
      WHERE lower(i.email) LIKE ${term} OR lower(i.first_name) LIKE ${term}
         OR lower(i.last_name) LIKE ${term} OR lower(i.role_title_snapshot) LIKE ${term}
      ORDER BY i.created_at DESC LIMIT 4
    `));
    for (const i of r) out.push({
      kind: 'intent',
      title: ((i.first_name || '') + ' ' + (i.last_name || '')).trim() || i.email,
      subtitle: 'Unpaid intent · ' + (i.role_title_snapshot || ''),
      url: '/admin/applications?intents=1',
    });
  } catch (_) {}

  // 3. Employees
  try {
    const r = rows(await db.execute(sql`
      SELECT id, full_name, email, personal_email, employee_code, designation
      FROM hr_employees
      WHERE lower(full_name) LIKE ${term} OR lower(email) LIKE ${term}
         OR lower(personal_email) LIKE ${term} OR lower(employee_code) LIKE ${term}
         OR lower(designation) LIKE ${term}
      ORDER BY created_at DESC LIMIT 6
    `));
    for (const e of r) out.push({
      kind: 'employee',
      title: e.full_name,
      subtitle: (e.designation || '') + ' · ' + (e.employee_code || ''),
      url: '/admin/hr/employees/' + e.id,
    });
  } catch (_) {}

  // 4. Users
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

  // 5. Roles
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, level, function, about FROM roles
      WHERE lower(title) LIKE ${term} OR lower(function) LIKE ${term}
         OR lower(slug) LIKE ${term} OR lower(about) LIKE ${term}
      ORDER BY sort_order ASC LIMIT 6
    `));
    for (const ro of r) out.push({
      kind: 'role',
      title: ro.title,
      subtitle: (ro.level || '') + ' · ' + (ro.function || ''),
      url: '/admin/roles',
    });
  } catch (_) {}

  // 6. Departments
  try {
    const r = rows(await db.execute(sql`
      SELECT id, name, description FROM departments
      WHERE lower(name) LIKE ${term} OR lower(description) LIKE ${term} OR lower(id) LIKE ${term}
      ORDER BY sort_order ASC LIMIT 4
    `));
    for (const d of r) out.push({
      kind: 'department',
      title: d.name,
      subtitle: (d.description || '').slice(0, 90),
      url: '/admin/departments',
    });
  } catch (_) {}

  // 7. Tests (this is also where "bootcamps" live — description tagged)
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, description, test_type, is_published FROM tests
      WHERE lower(title) LIKE ${term} OR lower(slug) LIKE ${term} OR lower(description) LIKE ${term}
      ORDER BY updated_at DESC NULLS LAST LIMIT 6
    `));
    for (const t of r) {
      const desc = (t.description || '').toString();
      const looksBootcamp = /bootcamp|cohort|intensive/i.test(desc + ' ' + t.title);
      out.push({
        kind: looksBootcamp ? 'bootcamp' : 'test',
        title: t.title,
        subtitle: (t.test_type || 'test') + (t.is_published ? '' : ' · DRAFT'),
        url: '/admin/tests/' + t.id + '/edit',
      });
    }
  } catch (_) {}

  // 8. Training courses
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, short_desc, category, level, is_published FROM training_courses
      WHERE lower(title) LIKE ${term} OR lower(slug) LIKE ${term}
         OR lower(short_desc) LIKE ${term} OR lower(category) LIKE ${term}
      ORDER BY updated_at DESC NULLS LAST LIMIT 6
    `));
    for (const c of r) out.push({
      kind: 'course',
      title: c.title,
      subtitle: (c.category || '') + (c.level ? ' · ' + c.level : '') + (c.is_published ? '' : ' · DRAFT'),
      url: '/admin/courses',
    });
  } catch (_) {}

  // 9. Events
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, description, mode, status, location FROM events
      WHERE lower(title) LIKE ${term} OR lower(slug) LIKE ${term}
         OR lower(description) LIKE ${term} OR lower(location) LIKE ${term}
      ORDER BY starts_at DESC NULLS LAST LIMIT 6
    `));
    for (const e of r) out.push({
      kind: 'event',
      title: e.title,
      subtitle: (e.mode || '') + ' · ' + (e.status || '') + (e.location ? ' · ' + e.location : ''),
      url: '/admin/events',
    });
  } catch (_) {}

  // 10. AI interview templates + sessions
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, description FROM ai_interview_templates
      WHERE lower(title) LIKE ${term} OR lower(slug) LIKE ${term} OR lower(description) LIKE ${term}
      LIMIT 4
    `));
    for (const t of r) out.push({
      kind: 'ai_template',
      title: t.title,
      subtitle: 'AI interview template · ' + t.slug,
      url: '/admin/ai-interview-templates',
    });
  } catch (_) {}
  try {
    const r = rows(await db.execute(sql`
      SELECT id, candidate_name, candidate_email, language, status FROM ai_interview_sessions
      WHERE lower(candidate_name) LIKE ${term} OR lower(candidate_email) LIKE ${term}
      ORDER BY started_at DESC NULLS LAST LIMIT 4
    `));
    for (const s of r) out.push({
      kind: 'ai_session',
      title: s.candidate_name || s.candidate_email,
      subtitle: 'AI session · ' + s.language + ' · ' + s.status,
      url: '/admin/interviews/ai/' + s.id,
    });
  } catch (_) {}

  // 11. Manual interviews
  try {
    const r = rows(await db.execute(sql`
      SELECT id, candidate_name, candidate_email, status FROM manual_interviews
      WHERE lower(candidate_name) LIKE ${term} OR lower(candidate_email) LIKE ${term}
      ORDER BY created_at DESC LIMIT 4
    `));
    for (const m of r) out.push({
      kind: 'interview',
      title: m.candidate_name || m.candidate_email,
      subtitle: 'Manual interview · ' + (m.status || ''),
      url: '/admin/interviews/manual',
    });
  } catch (_) {}

  // 12. Forms
  try {
    const r = rows(await db.execute(sql`
      SELECT id, slug, title, description FROM forms
      WHERE lower(title) LIKE ${term} OR lower(slug) LIKE ${term} OR lower(description) LIKE ${term}
      ORDER BY updated_at DESC NULLS LAST LIMIT 4
    `));
    for (const f of r) out.push({
      kind: 'form',
      title: f.title,
      subtitle: 'Form /f/' + f.slug,
      url: '/admin/forms',
    });
  } catch (_) {}

  // 13. Payments
  try {
    const r = rows(await db.execute(sql`
      SELECT id, order_id, email, purpose, status, amount_paise FROM payments
      WHERE lower(email) LIKE ${term} OR lower(order_id) LIKE ${term} OR lower(purpose) LIKE ${term}
      ORDER BY created_at DESC LIMIT 4
    `));
    for (const p of r) out.push({
      kind: 'payment',
      title: p.order_id,
      subtitle: (p.email || '') + ' · ' + (p.purpose || '') + ' · ' + (p.status || ''),
      url: '/admin/finance',
    });
  } catch (_) {}

  // 14. Visvambhara access requests
  try {
    const r = rows(await db.execute(sql`
      SELECT v.id, v.status, u.name, u.email FROM visvambhara_access_requests v
      LEFT JOIN users u ON v.user_id = u.id
      WHERE lower(u.name) LIKE ${term} OR lower(u.email) LIKE ${term}
      ORDER BY v.created_at DESC LIMIT 4
    `));
    for (const v of r) out.push({
      kind: 'visvambhara',
      title: v.name || v.email,
      subtitle: 'Viśvambhara access · ' + v.status,
      url: '/admin/visvambhara-access',
    });
  } catch (_) {}

  return json({ ok: true, query: q, results: out });
};
