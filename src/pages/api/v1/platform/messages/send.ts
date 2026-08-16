// POST /api/v1/messages/send — THE endpoint every EduRankAI product calls to send mail.
//
//   curl -X POST https://edurankai.in/api/v1/messages/send \
//     -H "x-api-key: erk_live_…" -H "Content-Type: application/json" \
//     -d '{"to":"candidate@example.com","template":"internship-stage-update",
//          "variables":{"candidate_name":"Candidate","stage":3,"role":"AI Engineering Intern"}}'
//
// Everything that makes a send safe — suppression, sending-identity verification, template
// resolution, delivery recording, the event stream — happens inside sendMessage(). This file is
// only the HTTP shell: authenticate, validate, delegate, translate the result into a status code.
// Business logic in a route handler is logic no other caller can reuse and no test can reach.

import type { APIRoute } from 'astro';
import { audit, error, json, ok, preflight, readJson, requirePrincipal, validate } from '@/lib/mailplatform/api';
import { sendMessage } from '@/lib/mailplatform/send';

// Declared ABOVE the handler, deliberately. `const` is not hoisted, and a const declared below a
// handler that uses it throws on the handler's first line — which has taken pages down in this
// repository before and is written up in CLAUDE.md.
const BODY_SPEC = {
  to: { required: true },
  subject: { type: 'string', maxLength: 500 },
  template: { type: 'string', maxLength: 120 },
  bodyHtml: { type: 'string' },
  bodyText: { type: 'string' },
  variables: { type: 'object' },
  metadata: { type: 'object' },
  headers: { type: 'object' },
  attachments: { type: 'array' },
} as const;

export const OPTIONS: APIRoute = () => preflight();

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.send');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const check = validate(body, BODY_SPEC as any);
  if (!check.ok) return check.response;

  if (!body.template && !body.bodyHtml && !body.bodyText) {
    return error('Supply a template, or a bodyHtml or bodyText.', 422, 'no_content');
  }

  const result = await sendMessage(
    {
      from: typeof body.from === 'string' ? body.from : undefined,
      fromName: typeof body.fromName === 'string' ? body.fromName : undefined,
      to: body.to as string | string[],
      cc: body.cc as string | string[] | undefined,
      bcc: body.bcc as string | string[] | undefined,
      replyTo: typeof body.replyTo === 'string' ? body.replyTo : undefined,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined,
      bodyText: typeof body.bodyText === 'string' ? body.bodyText : undefined,
      template: typeof body.template === 'string' ? body.template : undefined,
      variables: (body.variables as Record<string, unknown>) || {},
      attachments: Array.isArray(body.attachments) ? (body.attachments as any) : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : undefined,
      headers: (body.headers as Record<string, string>) || undefined,
      metadata: (body.metadata as Record<string, unknown>) || undefined,
      scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt : undefined,
      ignoreSuppression: body.ignoreSuppression === true,
    },
    { principal, fromUserId: principal.kind === 'user' ? principal.id : null },
  );

  await audit({
    principal,
    request: ctx.request,
    action: 'message.send',
    targetType: 'message',
    targetId: result.messageId,
    meta: { status: result.status, accepted: result.accepted.length, template: body.template || null },
  });

  if (!result.ok) {
    // 422 for "your request was understood and refused" (a suppressed recipient, a missing template
    // variable) and 502 for "we could not reach a mail server". A client can retry the second and
    // must not retry the first — collapsing them into one code makes that undecidable.
    const status =
      result.status === 'suppressed' ? 422
      : result.status === 'failed' && /transport|smtp|server/i.test(result.error || '') ? 502
      : 422;
    return json(
      {
        ok: false,
        error: result.error || 'The message was not sent.',
        code: result.status,
        messageId: result.messageId,
        suppressed: result.suppressed,
        rejected: result.rejected,
      },
      status,
    );
  }

  return ok({
    messageId: result.messageId,
    threadId: result.threadId,
    rfcMessageId: result.rfcMessageId,
    status: result.status,
    accepted: result.accepted,
    // Present even on success: a message that reached four of five intended people is a success
    // the caller still needs to know the shape of.
    suppressed: result.suppressed,
  }, 202);
};
