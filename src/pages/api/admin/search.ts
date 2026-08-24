// GET /api/admin/search?q=<term>
// Searches every meaningful entity in parallel and merges. Each block is
// wrapped in try/catch so a missing table doesn't blank the whole result.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { canOpenAdmin } from '@/lib/auth/admin-access';
import { withDbTimeout, withDbRetry, isDbUnavailable } from '@/lib/db-timeout';

// =================================================================================================
// THIS ENDPOINT WAS THE POOL HOG, AND IT RAN ON EVERY KEYSTROKE
// =================================================================================================
//
// The header above says the entities are searched "in parallel". They are not, and never were:
// what follows is fifteen sequential `await db.execute` calls, none of them bounded, every one a
// leading-wildcard `lower(col) LIKE '%term%'` that cannot use an index and therefore scans the
// table. Warm, the whole request held one pool slot for well over two seconds.
//
// AdminLayout.astro fires it from the search box on a 180ms debounce, so typing an eight-character
// name starts several of these. src/lib/db/index.ts sets POOL_MAX = 5. Two or three overlapping
// searches take most of the instance's connections, everything else queues, the queued reads blow
// their five-second fuse, and three consecutive timeouts open the PROCESS-GLOBAL breaker in
// src/lib/db-timeout.ts. From that moment every read on that instance is refused without waiting —
// including the middleware session gate on the next request, which has no way to degrade and
// answers "We cannot reach the database right now" instead.
//
// That is the reported failure, exactly: an admin typing a name into the search box, whose
// /admin/applications page had already rendered, opening one more thing and being told the database
// was unreachable — while the database was answering /api/health in 130ms throughout.
//
// TWO BOUNDS, AND THE COSMETIC FLAG, WHICH IS THE PART THAT MATTERS.
//
// A search suggestion dropdown failing changes nothing a reader depends on; the middleware session
// gate failing takes the whole console down. `cosmetic: true` is documented in db-timeout.ts for
// exactly this asymmetry: bound it, log it, hand the caller its error, and do NOT count it as
// evidence about the database. A slow search can no longer refuse anybody's sign-in.
//
// The per-query bound stops one scan holding a slot; the whole-request budget stops fifteen short
// ones adding up to the same thing. Blocks skipped by the budget are reported as `partial`, because
// a shortened result list rendered as a complete one is the defect this codebase keeps finding.

/** No single block may hold a pool slot longer than this. */
const SEARCH_QUERY_MS = Number(process.env.ADMIN_SEARCH_QUERY_MS) > 0
  ? Number(process.env.ADMIN_SEARCH_QUERY_MS) : 700;
/** And no request may hold one longer than this in total, however many blocks it has left. */
const SEARCH_BUDGET_MS = Number(process.env.ADMIN_SEARCH_BUDGET_MS) > 0
  ? Number(process.env.ADMIN_SEARCH_BUDGET_MS) : 1800;

/** Thrown to skip a block once the budget is spent. Every block already has `catch (_) {}`. */
class SearchBudgetSpent extends Error {
  constructor() { super('admin search budget spent'); this.name = 'SearchBudgetSpent'; }
}

/**
 * A TYPED CHARACTER MUST NOT BECOME A WILDCARD.
 *
 * The term went into the pattern as `'%' + q + '%'` with nothing escaped. In a LIKE pattern `%`
 * matches any run of characters and `_` matches exactly one, so a single per-cent sign typed into
 * the admin search box turned all fifteen predicates into "match every row" — and this endpoint's
 * queries are already unindexed table scans. The most expensive request this endpoint can make was
 * one keystroke away, on the surface whose cost is the whole reason for the bounds above.
 *
 * The backslash is escaped FIRST. Doing it last would re-escape the backslashes just added for the
 * other two and turn `%` into a literal backslash followed by a wildcard, which is the bug this is
 * fixing, restored. Postgres reads a backslash in a LIKE pattern as the escape character by default,
 * and the term is a bind parameter rather than inlined SQL, so no ESCAPE clause is needed.
 */
export function likeTerm(q: string): string {
  return '%' + q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
}

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  // THE SAME ANSWER AS THE ADMIN PANEL ITSELF, and not a weaker one.
  //
  // This endpoint returns applicant names, email addresses and application numbers — the exact data
  // the 2026 escalation exposed — and its only caller is the search box in AdminLayout, i.e. someone
  // who has already passed the /admin gate. It previously admitted anyone who was merely NOT an
  // applicant, which is the test src/lib/auth/permissions.ts explicitly warns against: every
  // internal role passes it, including the `editor` that offer signing used to hand out, and
  // including the partner / teacher / moderator scopes the middleware bounces off /admin entirely.
  // /api/* is not matched by isAdminPath in src/middleware.ts, so the structural gate does not cover
  // this URL and it has to ask the same question for itself.
  // Bounded and retried, like the middleware gates it duplicates: this is an AUTH check, so it is
  // deliberately NOT cosmetic — a failure here must refuse, not degrade. It runs on every keystroke,
  // so leaving it unbounded made the authorisation check itself part of the pile-up it is now
  // measured against.
  let verdict: Awaited<ReturnType<typeof canOpenAdmin>>;
  try {
    verdict = await withDbRetry(() => canOpenAdmin(user), 'adminSearch.canOpenAdmin');
  } catch (e: any) {
    if (isDbUnavailable(e)) return json({ ok: false, error: 'unavailable' }, 503);
    throw e;
  }
  if (!verdict.allowed) {
    return json({ ok: false, error: 'unauthorized' }, verdict.reason === 'not-signed-in' ? 401 : 403);
  }

  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ ok: true, results: [] });
  const term = likeTerm(q);
  const out: any[] = [];

  // The budget starts when the searching does, not when the request arrived: the authorisation
  // check above is not part of what this is protecting the pool from.
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let truncated = false;

  /**
   * Every block's read goes through here instead of straight to db.execute.
   *
   * It throws SearchBudgetSpent once the budget is gone, and each block's existing `catch (_) {}`
   * swallows it — so the remaining blocks are skipped without a line of change inside any of them,
   * and no statement is sent for them at all.
   */
  const searchQuery = async (statement: any): Promise<any> => {
    if (Date.now() >= deadline) { truncated = true; throw new SearchBudgetSpent(); }
    try {
      return await withDbTimeout(db.execute(statement), 'adminSearch', SEARCH_QUERY_MS, { cosmetic: true });
    } catch (e: any) {
      // A bound that was hit, or a circuit that is open, means this block has no answer — which is
      // not the same as having none to give. Both are reported rather than rendered as emptiness.
      if (isDbUnavailable(e)) truncated = true;
      throw e;
    }
  };

  // 1. Applications
  try {
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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
    const r = rows(await searchQuery(sql`
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

  // `partial` is the honest half of this endpoint. A dropdown that shows four results out of a
  // search that only got through six of its fifteen sources looks identical to a complete answer,
  // and this project has repeatedly shipped a swallowed read rendered as a confident claim.
  return json({ ok: true, query: q, results: out, partial: truncated });
};
