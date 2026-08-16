// GET /api/v1/messages — list messages in the key's environment. Scope: email.read
//
// THIS IS THE CORRELATION ENDPOINT. Filtering by `metadata_key`/`metadata_value` is what turns
// "EduRankAI application -> email -> delivery -> recipient event" into one call: send with
// `metadata: { application_id: "..." }`, then ask for every message carrying that id. Without it a
// product would have to keep its own copy of our message ids to answer a support question.
//
// Filters: status, tag, recipient, metadata_key + metadata_value, before (cursor), limit.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { listMessages, messageStats, publicMessage } from '@/lib/mailapi/messages';

export const OPTIONS = PREFLIGHT;

const STATUSES = ['queued', 'processing', 'sent', 'delivered', 'deferred', 'bounced', 'failed', 'cancelled'];

export const GET: APIRoute = apiRoute({ endpoint: 'messages.list', scope: 'email.read' }, async (ctx) => {
  const q = ctx.url.searchParams;
  const status = q.get('status');
  if (status && !STATUSES.includes(status)) {
    throw new ApiError('invalid_request', '`status` must be one of: ' + STATUSES.join(', ') + '.', { param: 'status' });
  }
  const metadataKey = q.get('metadata_key');
  const metadataValue = q.get('metadata_value');
  if ((metadataKey && !metadataValue) || (!metadataKey && metadataValue)) {
    throw new ApiError('invalid_request', '`metadata_key` and `metadata_value` must be used together.', { param: 'metadata_key' });
  }

  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
  const messages = await listMessages({
    orgId: ctx.auth.orgId,
    environment: ctx.auth.environment,
    status: status || undefined,
    tag: q.get('tag') || undefined,
    recipient: q.get('recipient') || undefined,
    metadataKey: metadataKey || undefined,
    metadataValue: metadataValue || undefined,
    before: q.get('before') || undefined,
    limit,
  });

  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: messages.length,
    // The cursor is the oldest created_at in this page: pass it back as `before` for the next one.
    next_before: messages.length === limit ? messages[messages.length - 1].createdAt : null,
    data: messages.map((m) => publicMessage(m)),
    stats: q.get('include_stats') === 'true' ? await messageStats(ctx.auth.orgId, ctx.auth.environment, Number(q.get('stats_days')) || 7) : undefined,
  });
});
