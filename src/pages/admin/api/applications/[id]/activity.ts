import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const appId = params.id;
  if (!appId) return new Response(JSON.stringify({ error: 'Missing ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const eventsResult = await db.execute(sql`SELECT event_type, ip_address, created_at, metadata FROM portal_activity WHERE application_id = ${appId} ORDER BY created_at DESC LIMIT 30`);
    const events = Array.isArray(eventsResult) ? eventsResult : (eventsResult?.rows || []);
    const readResult = await db.execute(sql`SELECT MAX(read_at) as last_read FROM application_messages WHERE application_id = ${appId} AND read_by_applicant = true AND sender_role != 'applicant'`);
    const readRows = Array.isArray(readResult) ? readResult : (readResult?.rows || []);
    const readAt = (readRows[0] as any)?.last_read || null;
    const appResult = await db.execute(sql`SELECT applicant_last_seen, thread_last_opened, thread_open_count FROM applications WHERE id = ${appId} LIMIT 1`);
    const appRows = Array.isArray(appResult) ? appResult : (appResult?.rows || []);
    const appStats = (appRows[0] || {}) as any;
    return new Response(JSON.stringify({ events, readAt, lastSeen: appStats.applicant_last_seen, threadOpenCount: appStats.thread_open_count || 0, threadLastOpened: appStats.thread_last_opened }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ events: [], error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
