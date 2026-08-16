// src/lib/notify.ts
// Creates in-app notification records for admin users

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { roleCanReceive } from '@/lib/notify-audience';

interface NotifyOptions {
  title: string;
  body?: string;
  type?: 'application' | 'hire' | 'leave' | 'message' | 'offer' | 'payroll' | 'system' | 'info';
  actionUrl?: string;
  entityType?: string;
  entityId?: string;
  // Optional audience key (a push.ts notification type). When given, only the
  // roles responsible for that event type receive it. Falls back to mapping the
  // coarse `type` below.
  audience?: string;
}

// Map the coarse in-app `type` to an audience key when no explicit one is given.
const TYPE_TO_AUDIENCE: Record<string, string> = {
  application: 'new_application',
  hire: 'new_application',
  leave: 'leave_request',
  message: 'help_message',
  offer: 'offer_signed',
  payroll: 'payroll_run',
};

// Insert one in-app notification per recipient, skipping an identical one from the last 2
// minutes (kills retry/double-fire duplicates without dropping distinct msgs).
//
// ONE STATEMENT, NOT ONE PER RECIPIENT. This used to be a single-user insert called from a
// `for (const admin of rows) await insertOnce(...)` loop inside notifyAllAdmins — so every
// application submitted, every hire, every leave request paid ONE database round-trip PER member of
// staff, serially, inside the request the applicant was waiting on. At 60 staff that is 60
// sequential round-trips on a write path. The recipient list is now unrolled INSIDE Postgres, so
// the cost is one statement whatever the headcount is.
//
// The id list is passed as a JSON string and unpacked by jsonb_array_elements_text, which is the
// pattern src/lib/pg-array.ts documents: interpolating a JS array into a drizzle template and
// casting it (`${ids}::uuid[]`) does NOT work — postgres-js serialises it as a record literal and
// Postgres rejects the cast. notifications.user_id is UUID, hence the per-element ::uuid cast.
//
// The de-dupe predicate is unchanged, only correlated to the unrolled id instead of a bound one.
async function insertOnceMany(userIds: string[], opts: NotifyOptions) {
  const ids = (userIds || []).filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) return;
  await db.execute(sql`
    INSERT INTO notifications (user_id, title, body, type, action_url, entity_type, entity_id)
    SELECT t.x::uuid, ${opts.title}, ${opts.body || null}, ${opts.type || 'info'},
           ${opts.actionUrl || null}, ${opts.entityType || null}, ${opts.entityId || null}
      FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = t.x::uuid
        AND n.title = ${opts.title}
        AND COALESCE(n.body, '') = COALESCE(${opts.body || null}, '')
        AND COALESCE(n.entity_id, '') = COALESCE(${opts.entityId || null}, '')
        AND n.created_at > NOW() - INTERVAL '2 minutes'
    )
  `);
}

// Send notification to the admin users RESPONSIBLE for this event (role-scoped).
export async function notifyAllAdmins(opts: NotifyOptions) {
  try {
    const audienceKey = opts.audience || TYPE_TO_AUDIENCE[opts.type || ''] || '';
    const admins = await db.execute(sql`
      SELECT id, role FROM users WHERE role != 'applicant' AND is_active = true
    `);
    const rows = Array.isArray(admins) ? admins : (admins?.rows || []);
    // roleCanReceive is a pure in-memory test, so the audience is narrowed here and the whole
    // narrowed list goes to the database once. Deliberately NOT capped with a LIMIT: dropping a
    // recipient would silently stop notifying a real member of staff, which is a correctness
    // regression, not a performance win. The row count is bounded by headcount, not by traffic.
    const recipients = (rows as any[])
      .filter((admin) => !audienceKey || roleCanReceive(admin.role, audienceKey))
      .map((admin) => String(admin.id));
    await insertOnceMany(recipients, opts);
  } catch(e: any) {
    console.error('[notify] Failed:', e.cause?.message || e.message);
  }
}

// Send notification to a specific user
export async function notifyUser(userId: string, opts: NotifyOptions) {
  try {
    await insertOnceMany([userId], opts);
  } catch(e: any) {
    console.error('[notify] Failed:', e.cause?.message || e.message);
  }
}

// Shorthand helpers
export const notify = {
  newApplication: (name: string, role: string, appId: string) =>
    notifyAllAdmins({
      title: `New application: ${name}`,
      body: `Applied for ${role}`,
      type: 'application',
      actionUrl: `/admin/applications/${appId}`,
      entityType: 'application',
      entityId: appId,
    }),

  statusChange: (name: string, newStatus: string, appId: string) =>
    notifyAllAdmins({
      title: `${name} → ${newStatus}`,
      body: `Application status updated`,
      type: 'application',
      actionUrl: `/admin/applications/${appId}`,
      entityType: 'application',
      entityId: appId,
    }),

  hired: (name: string, appId: string) =>
    notifyAllAdmins({
      title: `${name} hired!`,
      body: `Employee record created automatically`,
      type: 'hire',
      actionUrl: `/admin/hr/employees`,
      entityType: 'application',
      entityId: appId,
    }),

  // THE LEAVE TYPE IS NOT PUT IN THE BODY, because this fans out to notifyAllAdmins().
  //
  // It read `${days} day(s) ${leaveType}`, which pushed "3 day(s) sick" and "90 day(s) maternity"
  // — named in the title — to EVERY administrator, not to the people who decide leave. A leave type
  // is health information about an identified person, and a notification is the worst possible
  // carrier for it: it is duplicated per recipient, it lands outside any authorization check, and it
  // survives in a table nobody reviews. Whoever is entitled to act on the request opens it and sees
  // the type there, behind the gate that surface already applies.
  //
  // The parameter stays on the signature so no caller breaks and so this decision is legible at the
  // call sites that pass it. AUDIENCE IS A SEPARATE, UNRESOLVED QUESTION: notifyAllAdmins() is
  // broader than "the people who decide leave", and narrowing it to the HR desk is a policy change
  // recorded for the owner rather than made here.
  leaveRequest: (empName: string, _leaveType: string, days: number) =>
    notifyAllAdmins({
      title: `Leave request: ${empName}`,
      body: `${days} day(s)`,
      type: 'leave',
      actionUrl: `/admin/hr/leave`,
      entityType: 'leave',
    }),

  offerSigned: (name: string, role: string, offerId: string) =>
    notifyAllAdmins({
      title: `Offer signed: ${name}`,
      body: `Accepted offer for ${role}`,
      type: 'offer',
      actionUrl: `/admin/offers`,
      entityType: 'offer',
      entityId: offerId,
    }),
};
