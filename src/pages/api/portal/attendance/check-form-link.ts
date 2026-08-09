// POST /api/portal/attendance/check-form-link
//
// The live check as somebody pastes a form-response link into the clock-out form.
//
// WHY THIS IS A ROUND TRIP AND NOT A REGEX IN THE PAGE. The rule that decides whether a link is a
// recognisable form response has to be the SAME rule on both sides, or the form starts accepting
// what the write path then refuses, and the person who pasted it gets a contradiction instead of an
// answer. checkFormResponseLink() is pure and lives in src/lib/attendance-verify-clockout.ts; this
// route is the one place it is reachable from the browser, so the hint under the field and the
// validation at submit are literally the same function.
//
// IT NAMES THE SERVICE IT RECOGNISED. "Accepted" with no name is indistinguishable from a random
// URL being waved through, which is exactly what this must not do.
//
// It touches NO database and reads NOTHING about the caller beyond whether they are signed in.
// Nothing here can block a clock-out: the page treats a failed call as an empty hint and the server
// decides at submit.
import type { APIRoute } from 'astro';
import { checkFormResponseLink, URL_CAP } from '@/lib/attendance-verify-clockout';

export const prerender = false;

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);

  let url = '';
  try {
    const body = await request.json().catch(() => null);
    url = typeof body?.url === 'string' ? body.url : '';
  } catch {
    url = '';
  }
  if (url.length > URL_CAP) {
    return json({
      ok: false,
      problem: 'That link is far longer than a form link. Copy it again from the confirmation page.',
      notes: [], service: null, serviceName: '', host: null, url: '',
    });
  }

  const check = checkFormResponseLink(url);
  return json({
    ok: check.ok,
    url: check.url,
    host: check.host,
    service: check.service,
    serviceName: check.serviceName,
    problem: check.problem,
    notes: check.notes,
  });
};
