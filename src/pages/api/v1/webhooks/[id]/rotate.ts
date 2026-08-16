// POST /api/v1/webhooks/:id/rotate — new signing secret, with an overlap window.
//
// Scope: events.read + email.send.
//
// BOTH SECRETS SIGN EVERY DELIVERY UNTIL THE OLD ONE EXPIRES. A rotation that took effect instantly
// would break every delivery between the click and the receiver's deploy — which is how "rotate your
// secrets regularly" turns into advice nobody follows. `overlap_minutes` (default 1440, max 20160)
// controls the window; pass 0 for an immediate cut when a secret is known to be compromised.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { rotateSecret, getEndpoint } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

export const POST: APIRoute = apiRoute({ endpoint: 'webhooks.rotate', scope: 'events.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const id = String(ctx.params.id || '');
  const existing = await getEndpoint(ctx.auth.orgId, id, ctx.auth.environment);
  if (!existing) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id in the ' + ctx.auth.environment + ' environment.');

  const body = await readJsonBody(ctx.request, 8 * 1024);
  const overlap = body.overlap_minutes != null ? Number(body.overlap_minutes) : 1440;
  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new ApiError('invalid_request', '`overlap_minutes` must be a number of minutes, 0 or more.', { param: 'overlap_minutes' });
  }

  const result = await rotateSecret(ctx.auth.orgId, id, Math.floor(overlap));
  if (!result) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id.');

  return ctx.json({
    id,
    object: 'webhook_endpoint',
    secret: result.secret,
    secret_note: 'Store this now. It is not retrievable later.',
    previous_secret_valid_until: result.previousExpiresAt,
    note: overlap === 0
      ? 'The previous secret stops signing immediately. Deliveries verified against it will start failing now.'
      : 'Both secrets sign every delivery until ' + result.previousExpiresAt + '. Deploy the new one before then; no delivery fails in the meantime.',
  });
});
