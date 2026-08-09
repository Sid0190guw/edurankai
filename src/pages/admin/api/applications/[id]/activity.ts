// GET /admin/api/applications/:id/activity — the candidate-activity strip on /admin/applications/[id].
//
// TWO DEFECTS, BOTH OF THE CLASSES THIS CODEBASE HAS ALREADY SHIPPED ONCE.
//
// 1. THE GATE WAS WEAKER THAN THE PAGE IT SERVES. It tested `!user || user.role === 'applicant'` —
//    the exact test src/lib/auth/permissions.ts warns against, which every internal role passes,
//    including the `editor` that offer letters once handed to candidates, and `marketing` and
//    `editor`, neither of which holds the `applications` section. The page this feeds,
//    /admin/applications/[id], IS section-gated: src/middleware.ts maps '/admin/applications' to
//    the `applications` section. resolveAdminSection() matches by prefix on the REQUEST path, and
//    this URL is '/admin/api/applications/...', which that prefix does not cover — so the section
//    gate never reached here and a role bounced off the page could still read every candidate's
//    login times and IP ADDRESSES straight from this URL. denyAdminApi() asks the page's question:
//    canOpenAdmin plus `applications`/view, custom roles included, failing closed.
//
//    Authorization runs BEFORE any SELECT (docs/workforce-os/AUTHORIZATION_FIRST.md): a query that
//    ran for an unauthorised principal has already happened, whatever the response says.
//
// 2. A FAILED READ ANSWERED 200 WITH AN EMPTY LIST. `catch { events: [], error }` at status 200,
//    and the client renders "No activity yet. Appears when applicant opens their thread" whenever
//    `events` is empty. So "this candidate has never opened their thread" and "portal_activity
//    could not be read" were the same sentence on screen — and the first is the one a recruiter
//    acts on. It now answers 500 with `ok:false` and a reason, and the caller prints that it could
//    not read rather than inventing silence. The reason is taken off e.cause: on a drizzle error
//    e.message is only the SQL that failed.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { logEvent } from '@/lib/logger';

// Declared before the handler that uses them: `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down on this project.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
// postgres-js resolves execute() to a PLAIN ARRAY. `r.rows[0]` is always a bug here.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows || []);
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

export const GET: APIRoute = async ({ params, locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'applications',
    action: 'view',
    label: 'admin.api.applications.activity',
  });
  if (denied) return denied;

  const appId = params.id;
  if (!appId) return json({ ok: false, error: 'Missing ID' }, 400);

  try {
    const events = rowsOf(await db.execute(sql`SELECT event_type, ip_address, created_at, metadata FROM portal_activity WHERE application_id = ${appId} ORDER BY created_at DESC LIMIT 30`));
    const readRows = rowsOf(await db.execute(sql`SELECT MAX(read_at) as last_read FROM application_messages WHERE application_id = ${appId} AND read_by_applicant = true AND sender_role != 'applicant'`));
    const readAt = (readRows[0] as any)?.last_read || null;
    const appRows = rowsOf(await db.execute(sql`SELECT applicant_last_seen, thread_last_opened, thread_open_count FROM applications WHERE id = ${appId} LIMIT 1`));
    const appStats = (appRows[0] || {}) as any;
    return json({
      ok: true,
      events,
      readAt,
      lastSeen: appStats.applicant_last_seen,
      threadOpenCount: appStats.thread_open_count || 0,
      threadLastOpened: appStats.thread_last_opened,
    });
  } catch (e: any) {
    const reason = reasonOf(e);
    logEvent('error', 'admin.api.applications.activity.failed', { applicationId: appId, message: reason });
    return json({ ok: false, error: reason }, 500);
  }
};
