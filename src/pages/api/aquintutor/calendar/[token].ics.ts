// Private study-plan calendar feed, served as iCalendar (ICS) by feed token.
// No auth cookie (calendar apps can't send one) — the per-user token is the
// secret. Any calendar app can subscribe to this URL (Google "Add by URL",
// Apple, Outlook) and stay in sync.
import type { APIRoute } from 'astro';
import { userIdForToken, buildIcs } from '@/lib/aquintutor-calendar';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const token = (params.token || '').trim();
  const userId = await userIdForToken(token);
  if (!userId) {
    return new Response('Calendar feed not found.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  let ics: string;
  try {
    ics = await buildIcs(userId);
  } catch (e: any) {
    return new Response('Could not build calendar.', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="aquintutor-study-plan.ics"',
      'Cache-Control': 'public, max-age=1800',
    },
  });
};
