// GET /api/portal/course-sessions/<sessionId>/join            -> the live join target
// GET /api/portal/course-sessions/<sessionId>/join?what=recording -> the recording, same rules
//
// THIS ENDPOINT IS THE LINK. No page anywhere renders a meeting address or a board session id into
// its HTML; they render a button pointing here, and the address is resolved — with entitlement — on
// the request that asks for it. That is not a stylistic preference:
//
//   * A link rendered into HTML and hidden with CSS is not hidden. It is in view-source, in the
//     browser cache, in any extension reading the DOM, and in whatever the page is saved as.
//   * A link rendered once is a link forever. Entitlement resolved at render time cannot notice a
//     refund, a cancellation, or an enrolment that was withdrawn ten minutes later. Resolved here, it
//     notices all three, because it is asked again every single time.
//   * The refusal can be a SENTENCE. A learner who is not enrolled is told what to do about it,
//     rather than finding a button that silently does nothing.
//
// It is deliberately a REDIRECT rather than a JSON payload: the address never enters a page's
// JavaScript, and "open in a new tab" is the browser's own behaviour rather than something a script
// has to be trusted to do.
import type { APIRoute } from 'astro';
import { canAccessSection } from '@/lib/auth/permissions';
import { resolveJoinTarget } from '@/lib/course-sessions';

export const prerender = false;

// Declared before the handler that uses them. `const` is not hoisted, and a handler reaching a later
// declaration throws on its first line — that has taken pages down on this project.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

const textReply = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any)?.user;
  const sessionId = String(params?.id || '');
  const url = new URL(request.url);
  const what = url.searchParams.get('what') === 'recording' ? 'recording' : 'join';
  // Where to send somebody whose answer is "no". Only a course SLUG is accepted and the path is
  // built here, so this can never be turned into an open redirect by a crafted parameter.
  const backSlug = String(url.searchParams.get('back') || '').toLowerCase();
  const back = SLUG_RE.test(backSlug) ? '/portal/courses/' + backSlug : '';

  if (!user) {
    const next = '/api/portal/course-sessions/' + encodeURIComponent(sessionId) + '/join';
    return new Response(null, {
      status: 302,
      headers: { Location: '/portal/login?next=' + encodeURIComponent(next), 'Cache-Control': 'no-store' },
    });
  }

  // An organiser may open the session they are responsible for without being enrolled on the course.
  // This is the SAME gate the admin schedule screen uses (section 'lms', action 'edit') — asked here
  // rather than trusted from a parameter. A failure inside it denies, because canAccessSection fails
  // closed by design.
  let isOrganiser = false;
  try {
    isOrganiser = await canAccessSection(user as any, 'lms', 'edit');
  } catch (e: any) {
    console.error('[course-sessions/join] organiser check failed -', e?.cause?.message || e?.message);
    isOrganiser = false;
  }

  const target = await resolveJoinTarget(user, sessionId, what as 'join' | 'recording', { isOrganiser });

  if (target.ok) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.url,
        // NEVER cached, by anything. A cached 302 is a join link that outlives the entitlement.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  if (back && what === 'join') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: back + '?sessionmsg=' + encodeURIComponent(target.reason),
        'Cache-Control': 'no-store',
      },
    });
  }

  return textReply(target.reason, target.status === 302 ? 403 : target.status);
};
