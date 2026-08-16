// GET /api/v1/events — the organization's delivery event feed. Scope: events.read
//
// The same events that go out over webhooks, readable by poll. Webhooks are the right integration
// for most products, but a feed matters for two cases the push model handles badly: backfilling
// after an endpoint was down longer than the retry window, and reconciling a report where the
// customer needs to be sure they saw everything.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows, ensureMailApiSchema } from '@/lib/mailapi/schema';
import { EVENT_TYPES } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'events.list', scope: 'events.read' }, async (ctx) => {
  await ensureMailApiSchema();
  const q = ctx.url.searchParams;
  const type = q.get('type');
  if (type && !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new ApiError('invalid_request', '`type` must be one of: ' + EVENT_TYPES.join(', ') + '.', { param: 'type' });
  }
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
  const messageId = q.get('message_id');
  const before = q.get('before');

  const data = rows(await db.execute(sql`
    SELECT e.id, e.type, e.recipient, e.data, e.occurred_at, e.message_id,
           m.subject, m.status, m.template_key, m.metadata, m.tags
    FROM mailapi_message_events e JOIN mailapi_messages m ON m.id = e.message_id
    WHERE e.org_id = ${ctx.auth.orgId} AND e.environment = ${ctx.auth.environment}
      AND (${type || null}::text IS NULL OR e.type = ${type || null})
      AND (${messageId || null}::uuid IS NULL OR e.message_id = ${messageId || null}::uuid)
      AND (${before || null}::timestamptz IS NULL OR e.occurred_at < ${before || null}::timestamptz)
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${limit}`));

  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: data.length,
    next_before: data.length === limit ? data[data.length - 1].occurred_at : null,
    data: data.map((e: any) => ({
      id: 'evt_' + String(e.id).replace(/-/g, '').slice(0, 24),
      object: 'event',
      type: e.type,
      occurred_at: e.occurred_at,
      message_id: e.message_id,
      recipient: e.recipient,
      subject: e.subject,
      message_status: e.status,
      template: e.template_key || undefined,
      tags: Array.isArray(e.tags) && e.tags.length ? e.tags : undefined,
      metadata: e.metadata && Object.keys(e.metadata).length ? e.metadata : undefined,
      data: e.data,
    })),
  });
});
