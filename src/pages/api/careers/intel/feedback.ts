// POST /api/careers/intel/feedback — WHAT THE RECOMMENDATION GOT WRONG.
//
// EXPLICIT ACTS ONLY. Saving a posting, dismissing one, saying an explanation helped or did not.
// There is no "viewed" event and no passive tracking: a view is already counted on roles.view_count
// by the posting's own page, and a second per-person copy of it would be surveillance dressed as
// analytics.
//
// WHAT IT IMPROVES, AND WHAT IT MUST NEVER BECOME. These rows are about the RECOMMENDATION — "this
// was dismissed out of the top tier" is a fact about the ranking. They are not a record of a
// person's judgement, they are not joined to an account, and nothing in this codebase reads them
// when assessing an application. src/lib/ai-boundary.ts is the standing rule here: a machine may
// recommend, summarise and rank; hiring, rejection and the other four decisions belong to a named
// human being, and no feedback loop is allowed to quietly become one of them.
//
// THE SESSION KEY IS NOT AN IDENTITY. The browser generates a random string and keeps it with the
// personalisation. It exists so a hundred reactions from one person are not read as a hundred
// people agreeing. Clearing the personalisation gets a new one, and nothing joins it to a user, an
// address or a device.

import type { APIRoute } from 'astro';
import { json } from '@/lib/career-intel/wire';
import { recordFeedback, FEEDBACK_EVENTS, FEEDBACK_REASONS, type FeedbackEvent, type FeedbackReason } from '@/lib/career-intel/store';
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that request.' }, 400);
  }

  const roleId = String(body?.roleId || '');
  const event = String(body?.event || '') as FeedbackEvent;

  // Validated before the limiter runs, so a malformed request does not consume somebody's quota.
  if (!UUID.test(roleId)) return json({ ok: false, error: 'Unknown posting.' }, 400);
  if (!FEEDBACK_EVENTS.includes(event)) return json({ ok: false, error: 'Unknown reaction.' }, 400);

  // AN UNAUTHENTICATED WRITER WITH NO CEILING IS AN UNAUTHENTICATED WRITER WITH NO CEILING — the
  // exact wording in src/lib/public-form-limit.ts, written after ordinary traffic against one open
  // form took the whole site down. This endpoint INSERTs, so it gets the ceiling.
  //
  // 'allow' when the limiter itself is unreadable: the cost of a lost dismissal is a slightly worse
  // recommendation, and refusing on a counter outage would break a control the person already
  // clicked. That is the trade-off the contact form makes, for the same reason.
  const ip = clientIp(request.headers);
  const verdict = await overPublicFormLimit('careers-feedback', ip, { whenUnavailable: 'allow', max: 120 });
  if (verdict.blocked) {
    return json({ ok: false, error: 'That is a lot of reactions in an hour. Try again later.' }, 429);
  }

  const reasonRaw = String(body?.reason || '');
  const reason = FEEDBACK_REASONS.includes(reasonRaw as FeedbackReason) ? (reasonRaw as FeedbackReason) : null;

  const stored = await recordFeedback({
    roleId,
    event,
    tier: typeof body?.tier === 'string' ? body.tier : null,
    reason,
    sessionKey: typeof body?.sessionKey === 'string' ? body.sessionKey : null,
  });

  // `stored` is reported honestly. The client does not undo the person's click on a false — the
  // action already happened in their browser — but it must not claim a record that was not made.
  return json({ ok: true, stored }, 200);
};
