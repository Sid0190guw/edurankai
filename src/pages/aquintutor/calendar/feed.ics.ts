// GET /aquintutor/calendar/feed.ics?u=<userId>&t=<token> — a genuine iCalendar feed a student can
// subscribe to in Google/Apple/Outlook (Prompt 19). Token-signed, so no login is needed for the feed.
import type { APIRoute } from 'astro';
import { verifyCalToken, studentCalendar, toICS } from '@/lib/calendar';
export const prerender = false;
export const GET: APIRoute = async ({ url }) => {
  const u = (url.searchParams.get('u') || '').trim();
  const t = (url.searchParams.get('t') || '').trim();
  if (!u || !verifyCalToken(u, t)) return new Response('invalid feed token', { status: 403 });
  const rows = await studentCalendar(u).catch(() => []);
  const ics = toICS(rows.map((r: any) => ({ uid: r.id, title: r.title + (r.course_title ? ' — ' + r.course_title : ''), start: new Date(r.due_at).toISOString(), kind: r.kind })), 'AquinTutor deadlines');
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="aquintutor.ics"' } });
};
