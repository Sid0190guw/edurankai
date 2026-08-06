// POST /api/portal/reports/check-link
//
// The live check as somebody pastes a link into the daily-report form.
//
// WHY THIS IS A ROUND TRIP AND NOT A REGEX IN THE PAGE. The rule that decides whether a link is
// acceptable has to be the SAME rule on both sides, or the form starts accepting what the write path
// then refuses — and the person who typed it gets a contradiction instead of an answer. checkDriveLink()
// is pure and lives in src/lib/daily-report.ts; this route is the one place it is reachable from the
// browser, so the hint under the field and the validation at submit are literally the same function.
//
// It touches NO database and reads NOTHING about the caller beyond whether they are signed in. It
// exists so the sharing warning arrives at the moment of pasting, which is the only moment it can
// still prevent the failure it describes.
import type { APIRoute } from 'astro';
import { checkDriveLink } from '@/lib/daily-report';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);

  let url = '';
  try {
    const body = await request.json().catch(() => null);
    url = typeof body?.url === 'string' ? body.url : '';
  } catch {
    url = '';
  }
  // A link longer than this is not a Drive share link; refuse to spend anything parsing it.
  if (url.length > 2048) {
    return json({
      ok: false,
      problem: 'That link is far longer than a Drive share link. Copy it again from the Share dialog.',
      warning: '', notes: [], kind: 'unknown', host: null, url: '',
    });
  }

  const check = checkDriveLink(url);
  return json({
    ok: check.ok,
    url: check.url,
    host: check.host,
    kind: check.kind,
    problem: check.problem,
    warning: check.warning,
    notes: check.notes,
  });
};
