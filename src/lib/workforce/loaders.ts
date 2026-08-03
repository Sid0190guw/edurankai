// src/lib/workforce/loaders.ts — the reads behind the widgets, lifted out of the page.
//
// WHY THIS FILE EXISTS. Every widget loader on /portal/employee was written inline in that page's
// frontmatter. That was fine while there was one workspace surface and fatal the moment there were
// two: the second surface copies the query, the two copies drift, and the one that drifts toward
// showing more is the one nobody reports. Everything here is a function so there is exactly one
// expression of each read, and so a loader can be unit-read without an Astro request.
//
// THE FOUR RULES EVERY LOADER IN THIS FILE OBEYS.
//
//   1. IT DECIDES NOTHING. A loader takes an ALREADY-RESOLVED scope key — an hr_employees id, a
//      users id, a department scope from src/lib/auth/workspace-access.ts — and never a role, never
//      a permission, never a request parameter. composeWorkspace() decides who may call it; calling
//      one is the consequence of that decision, not a second version of it. If a loader ever needs
//      to ask "is this person allowed", it is in the wrong file.
//
//   2. IT REPORTS WHETHER THE READ HAPPENED. Every return carries `ok`. An empty list with ok:true
//      means there is genuinely nothing; ok:false means the query did not run and the card must say
//      so. "Nothing is waiting on you" printed over a query that threw is the same lie as a green
//      flash over a write that never landed, and this project has shipped it twice.
//
//   3. IT NEVER TAKES THE PAGE DOWN. Every read is inside a try/catch that logs
//      e?.cause?.message || e?.message — the real Postgres reason lives on e.cause; e.message is
//      only the failed SQL — and returns ok:false. One broken card is a broken card.
//
//   4. IT SELECTS COLUMNS BY NAME. No SELECT * anywhere in this file. The 2026-08-02 exposure was a
//      SELECT * on hr_employees dragging `gender` into the render context of a page that displayed
//      none of it. Two of the readers below return rows belonging to OTHER people; both are narrowed
//      to a name and a designation, and neither may ever be widened.
//
// postgres-js resolves to a plain array, never a { rows } object.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { departmentFilter, type HasDepartmentScope } from '@/lib/auth/workspace-access';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[workforce/loaders] ' + tag, e?.cause?.message || e?.message);

const text = (v: any): string | null => (v === null || v === undefined ? null : String(v));
/** A DATE comes back from postgres-js as a Date at UTC midnight; local getters shift it by a day. */
const isoDay = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  /** notifications.action_url — where THIS row goes. There is no inbox page to fall back to. */
  actionUrl: string | null;
  isRead: boolean;
  at: string | null;
}

export interface NotificationsView {
  ok: boolean;
  items: NotificationRow[];
  unread: number;
}

/**
 * This person's own notifications, newest first.
 *
 * ROWS HAVE ALWAYS BEEN WRITTEN FOR EMPLOYEES; THE SURFACE IS NEW. src/lib/push.ts persists FIRST
 * and pushes second (push.ts:259), so the feed fills even with VAPID unset — what an employee never
 * had was a page. /portal/notifications.astro used to carry
 * `if (user.role !== 'applicant') return Astro.redirect('/admin')`, and middleware bounced anyone
 * without admin.access straight back: the ping-pong shape that took /portal down before. That is why
 * widgets.ts used to set href:null on notifications.unread. The role-name test is gone, the page
 * gates on "signed in" and narrows every read by user_id, and the widget now links to it. Each row
 * still carries its OWN action_url, which is what a row click follows — the widget href is only the
 * "see all" target, so a row never loses the thing it is about.
 *
 * Scoped in the WHERE clause by users.id. No ensure-DDL here on purpose, and the reason is now
 * stronger than "a read is not the place to discover a missing table": src/lib/notifications-schema.ts
 * is the SINGLE owner of that CREATE. push.ts and both notifications-recent endpoints each used to
 * carry their own copy in a NARROWER shape, and CREATE TABLE IF NOT EXISTS is a no-op on an existing
 * table — so whichever ran first decided whether `category` and `priority` existed at all, and every
 * later INSERT naming them threw forever. Adding a fourth CREATE here would put that back.
 * A missing table returns ok:false, which the card can state.
 */
export async function myNotifications(userId: string, limit = 5): Promise<NotificationsView> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, items: [], unread: 0 };
  const cap = Math.min(Math.max(limit, 1), 20);
  try {
    const r = await db.execute(sql`
      SELECT id, title, body, action_url, is_read, created_at,
             (SELECT COUNT(*)::int FROM notifications u
               WHERE u.user_id = ${uid} AND u.is_read = false) AS unread
        FROM notifications
       WHERE user_id = ${uid}
       ORDER BY is_read ASC, created_at DESC
       LIMIT ${cap}`);
    const list = rows(r);
    // The correlated count rides on every row, so an empty result carries no total. Zero rows and
    // zero unread agree in that case, which is the only case where they can.
    const unread = Number(list[0]?.unread) || 0;
    return {
      ok: true,
      unread,
      items: list.map((n: any) => ({
        id: String(n.id),
        title: String(n.title || 'Notification'),
        body: text(n.body),
        actionUrl: text(n.action_url),
        isRead: n.is_read === true,
        at: n.created_at ? new Date(n.created_at).toISOString() : null,
      })),
    };
  } catch (e: any) {
    logFail('notifications', e);
    return { ok: false, items: [], unread: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// PEOPLE. Both readers below return rows about OTHER PEOPLE and are the narrowest queries in this
// file for that reason. A name and a designation, and nothing else, ever.
// ---------------------------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  designation: string | null;
}

export interface PeopleView {
  ok: boolean;
  people: PersonRow[];
  /** Rows beyond the cap, so a list can say "and N more" instead of quietly truncating. */
  more: number;
}

/**
 * The people who report to this account.
 *
 * THE FIRST READER OF THIS RELATION IN THE PRODUCT. ctx.managesPeople has been true for reporting
 * managers all along and the reports.direct widget has been registered all along, but nothing
 * anywhere loaded it — so a manager with direct reports had no way to see who they were.
 *
 * THE ID-SPACE TRAP: reporting_manager_id holds a USERS id. The comparison is against users.id and
 * is made as ::text, exactly as pendingLeaveForApprover() and approverRole() make it. Joining it to
 * hr_employees.id matches zero rows and reads as "nobody reports to you" rather than failing.
 *
 * The column is ALTERed in by only two admin pages at page load, so on a database where neither has
 * run it is absent entirely and this returns ok:false rather than an authoritative empty team.
 */
export async function directReportsFor(userId: string, limit = 8): Promise<PeopleView> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, people: [], more: 0 };
  const cap = Math.min(Math.max(limit, 1), 50);
  try {
    const r = await db.execute(sql`
      SELECT id, full_name, designation,
             COUNT(*) OVER ()::int AS total
        FROM hr_employees
       WHERE reporting_manager_id::text = ${uid}
         AND is_active = true
       ORDER BY full_name ASC
       LIMIT ${cap}`);
    const list = rows(r);
    const total = Number(list[0]?.total) || list.length;
    return {
      ok: true,
      more: Math.max(0, total - list.length),
      people: list.map((p: any) => ({
        id: String(p.id),
        name: String(p.full_name || 'Unnamed record'),
        designation: text(p.designation),
      })),
    };
  } catch (e: any) {
    logFail('direct reports', e);
    return { ok: false, people: [], more: 0 };
  }
}

/**
 * The department a LEAD may query — narrowed by departmentFilter(), which is the only sanctioned way
 * to scope this table.
 *
 * `scope` must be the resolved gate or Workspace, never anything derived from a query string:
 * departmentFilter reads `scopeDepartmentId`, which comes from users.assigned_department_id on the
 * SESSION, and returns sql`false` rather than sql`true` when nothing resolved — so the worst a
 * mistake here produces is an empty list, never the whole table.
 *
 * ctx.departmentId is NOT an acceptable argument. It is the person's OWN department, documented as
 * display-and-self-scope, and handing it to this function would manufacture a peer list for an
 * ordinary employee — a new authorisation decision smuggled in as a rendering one.
 *
 * Render DEPARTMENT_COVERAGE_NOTICE beside the result: hr_employees.department_id has exactly one
 * writer, so anyone HR added by hand is invisible here and a short list reads as a complete one.
 */
export async function departmentRoster(
  scope: HasDepartmentScope | null | undefined,
  limit = 8,
): Promise<PeopleView> {
  if (!String(scope?.scopeDepartmentId || '').trim()) return { ok: true, people: [], more: 0 };
  const cap = Math.min(Math.max(limit, 1), 60);
  try {
    const r = await db.execute(sql`
      SELECT e.id, e.full_name, e.designation,
             COUNT(*) OVER ()::int AS total
        FROM hr_employees e
       WHERE ${departmentFilter(scope)}
         AND e.is_active = true
       ORDER BY e.full_name ASC
       LIMIT ${cap}`);
    const list = rows(r);
    const total = Number(list[0]?.total) || list.length;
    return {
      ok: true,
      more: Math.max(0, total - list.length),
      people: list.map((p: any) => ({
        id: String(p.id),
        name: String(p.full_name || 'Unnamed record'),
        designation: text(p.designation),
      })),
    };
  } catch (e: any) {
    logFail('department roster', e);
    return { ok: false, people: [], more: 0 };
  }
}

/**
 * The name of the person this account reports to — ONE ROW, TWO DISPLAY COLUMNS.
 *
 * Reached solely through a pointer stored on the viewer's own record, which the composer has already
 * resolved onto ctx.reportingManagerUserId. That is what makes this the one row belonging to
 * somebody else a personal workspace may read.
 *
 * ORDER BY is load-bearing rather than tidiness: one human can hold several hr_employees rows (a
 * closed internship plus a current contract), so this can match more than one. Their current row is
 * the one to show.
 */
export async function managerNameFor(managerUserId: string | null): Promise<{ ok: boolean; person: PersonRow | null }> {
  const mid = String(managerUserId || '').trim();
  // Not an error and not a failed read: most people simply have no manager recorded. The caller
  // distinguishes this from ok:false, because the two lead to different sentences.
  if (!mid) return { ok: true, person: null };
  try {
    const r = await db.execute(sql`
      SELECT id, full_name, designation
        FROM hr_employees
       WHERE user_id = ${mid}
       ORDER BY is_active DESC, created_at DESC
       LIMIT 1`);
    const row = rows(r)[0];
    if (!row) return { ok: true, person: null };
    return {
      ok: true,
      person: { id: String(row.id), name: String(row.full_name || ''), designation: text(row.designation) },
    };
  } catch (e: any) {
    logFail('manager', e);
    return { ok: false, person: null };
  }
}

// ---------------------------------------------------------------------------------------------
// TIME
// ---------------------------------------------------------------------------------------------

export interface AttendanceMonthView {
  ok: boolean;
  /** Days with a row of each status this calendar month. Statuses are free text on the table, so
   *  this is what is RECORDED, grouped as-is, and never a completeness judgement. */
  present: number;
  leave: number;
  other: number;
  daysRecorded: number;
  /** Sum of hr_attendance.work_hours, rounded. Null when every row carries no hours. */
  hours: number | null;
}

/**
 * This month's attendance, as recorded.
 *
 * DAYS RECORDED, NOT A PERCENTAGE AND NOT A TARGET. The target framing belongs to credit.position,
 * which is internship-only, and putting a completion bar here is exactly the defect the widget
 * registry exists to fix — a founder being measured against an intern's requirement.
 *
 * ABSENCE IS NOT COMPUTED. It would have to be counted against calendar days, and there is no
 * holiday table anywhere in this codebase, so every weekend would land in it. What is not written
 * down is not reported.
 *
 * overtime_hours is deliberately not selected: it has zero writers, so any total is structurally 0
 * and would read as a real figure.
 *
 * The month boundary comes from Postgres (date_trunc on CURRENT_DATE), not from the render process,
 * so it agrees with ctx.today.
 */
export async function attendanceMonth(employeeId: string): Promise<AttendanceMonthView> {
  const empty: AttendanceMonthView = { ok: false, present: 0, leave: 0, other: 0, daysRecorded: 0, hours: null };
  const id = String(employeeId || '').trim();
  if (!id) return empty;
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS days,
             COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) = 'present')::int AS present,
             COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) IN ('leave','on_leave'))::int AS leave,
             COALESCE(SUM(work_hours), 0)::float AS hours
        FROM hr_attendance
       WHERE employee_id::text = ${id}
         AND date >= date_trunc('month', CURRENT_DATE)
         AND date <= CURRENT_DATE`);
    const row = rows(r)[0] || {};
    const days = Number(row.days) || 0;
    const present = Number(row.present) || 0;
    const leave = Number(row.leave) || 0;
    const hours = Number(row.hours);
    return {
      ok: true,
      daysRecorded: days,
      present,
      leave,
      other: Math.max(0, days - present - leave),
      hours: Number.isFinite(hours) && hours > 0 ? Math.round(hours * 10) / 10 : null,
    };
  } catch (e: any) {
    logFail('attendance month', e);
    return empty;
  }
}

export interface LeaveDayRow {
  type: string;
  start: string;
  end: string;
  status: string;
}

/**
 * Approved leave covering a given day, for this person.
 *
 * Reads through listLeave({ employeeId }) rather than a new query — that function owns the table's
 * ensure-DDL and is already the "my leave" reader. Its NO-ARGUMENT form returns EVERYBODY joined to
 * their names and must never be called from a portal page; the employeeId form is scoped in its own
 * WHERE clause.
 *
 * It swallows its own errors and returns [] either way (hr-leave.ts safe()), so the ok flag here
 * reports only whether the CALL completed — an empty result cannot be distinguished from a failed
 * one inside that module, and this comment is the honest statement of that limit.
 */
export async function leaveCovering(
  employeeId: string,
  dayIso: string | null,
): Promise<{ ok: boolean; days: LeaveDayRow[] }> {
  const id = String(employeeId || '').trim();
  const day = String(dayIso || '').slice(0, 10);
  // No day resolved means no day-partitioned claim. Withheld, never guessed from the process clock.
  if (!id || !day) return { ok: false, days: [] };
  try {
    const { listLeave } = await import('@/lib/hr-leave');
    const all = await listLeave({ employeeId: id });
    const covering = (all as any[]).filter((l: any) => {
      if (String(l.status || '').toLowerCase() !== 'approved') return false;
      const s = isoDay(l.start_date);
      const e = isoDay(l.end_date) || s;
      return !!s && s <= day && day <= e;
    });
    return {
      ok: true,
      days: covering.map((l: any) => ({
        type: String(l.leave_type || 'leave'),
        start: isoDay(l.start_date),
        end: isoDay(l.end_date),
        status: String(l.status || ''),
      })),
    };
  } catch (e: any) {
    logFail('leave covering today', e);
    return { ok: false, days: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// ACTIVITY
// ---------------------------------------------------------------------------------------------

export interface ActivityRow {
  taskId: string;
  taskTitle: string;
  actor: string;
  actorRole: string | null;
  action: string;
  from: string | null;
  to: string | null;
  kind: 'status' | 'text';
  note: string | null;
  at: string;
}

export interface ActivityView {
  ok: boolean;
  entries: ActivityRow[];
  /** True when the trail was assembled from only SOME of the person's tasks — see the cap below. */
  partial: boolean;
}

/**
 * Recent activity on the tasks this person already has open, newest first.
 *
 * THE HARD LIMIT IS THE WHOLE DESIGN. listTaskActivity() is PER TASK — there is no cross-task
 * personal activity reader in this codebase, and inventing one means exporting visibleToSql() from
 * employee-tasks.ts, which is a change to a security-critical query and not something a dashboard
 * card should force. So this calls it for a handful of tasks the caller has ALREADY READ and
 * ALREADY been authorised for, and reports `partial` whenever there were more.
 *
 * Never widen the cap into "read the whole board": that is N queries in a page render, and the
 * honest answer to "what happened everywhere" is that this database cannot say.
 *
 * Visibility is re-derived IN SQL inside listTaskActivity for every row, against the viewer's USERS
 * id — so passing a task id the viewer cannot see returns nothing rather than leaking it.
 */
export async function recentTaskActivity(
  viewerUserId: string,
  tasks: { id: string; title: string }[],
  opts: { taskCap?: number; entryCap?: number } = {},
): Promise<ActivityView> {
  const viewer = String(viewerUserId || '').trim();
  const taskCap = Math.min(Math.max(opts.taskCap ?? 4, 1), 6);
  const entryCap = Math.min(Math.max(opts.entryCap ?? 6, 1), 20);
  const list = (tasks || []).filter((t) => t && t.id).slice(0, taskCap);
  if (!viewer || list.length === 0) return { ok: true, entries: [], partial: false };

  try {
    const { listTaskActivity } = await import('@/lib/employee-tasks');
    const views = await Promise.all(
      list.map(async (t) => {
        const v = await listTaskActivity(String(t.id), viewer, 40);
        return { task: t, view: v };
      }),
    );

    // One task's trail failing does not invalidate the others, but it does mean the list is not the
    // whole story — so it is reported as partial rather than presented as complete.
    let anyFailed = false;
    const merged: ActivityRow[] = [];
    for (const { task, view } of views) {
      if (!view?.ok) { anyFailed = true; continue; }
      for (const e of view.entries || []) {
        merged.push({
          taskId: String(task.id),
          taskTitle: String(task.title || 'Untitled task'),
          actor: String(e.actorName || 'Someone'),
          actorRole: e.actorRole ?? null,
          action: String(e.action || 'made a change'),
          from: e.from ?? null,
          to: e.to ?? null,
          kind: e.kind === 'text' ? 'text' : 'status',
          note: e.note ?? null,
          at: String(e.at || ''),
        });
      }
    }

    merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return {
      ok: !anyFailed || merged.length > 0,
      entries: merged.slice(0, entryCap),
      partial: anyFailed || (tasks || []).length > list.length || merged.length > entryCap,
    };
  } catch (e: any) {
    logFail('task activity', e);
    return { ok: false, entries: [], partial: false };
  }
}
