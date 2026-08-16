// POST /api/v1/webhooks/:id/test — send a signed verification event and report exactly what came back.
//
// Scope: events.read.
//
// THE TEST IS THE REAL THING. It signs the same way, sets the same headers and honours the same
// timeout, so a green test means the endpoint will accept genuine events — not that a simplified
// probe reached the host. A red one returns the HTTP status, the duration and the transport error,
// because "verification failed" without those three is a support ticket rather than an answer.
//
// A 2xx activates the endpoint (this is also the verification handshake).
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { verifyEndpoint, getEndpoint } from '@/lib/mailapi/webhooks';

export const OPTIONS = PREFLIGHT;

export const POST: APIRoute = apiRoute({ endpoint: 'webhooks.test', scope: 'events.read' }, async (ctx) => {
  const id = String(ctx.params.id || '');
  const existing = await getEndpoint(ctx.auth.orgId, id, ctx.auth.environment);
  if (!existing) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id in the ' + ctx.auth.environment + ' environment.');

  const result = await verifyEndpoint(ctx.auth.orgId, id);
  if (!result) throw new ApiError('webhook_not_found', 'No webhook endpoint with that id.');

  return ctx.json({
    id,
    object: 'webhook_test',
    ok: result.ok,
    response_status: result.status,
    duration_ms: result.durationMs,
    error: result.error,
    endpoint_status: result.ok ? 'active' : existing.status,
    note: result.ok
      ? 'The endpoint answered with a 2xx and is now active.'
      : 'The endpoint did not answer with a 2xx, so it stays ' + existing.status + '. Verify the signature check on your side against the documented signing string before assuming a network problem.',
  });
});
