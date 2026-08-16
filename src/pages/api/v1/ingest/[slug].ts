// POST /api/v1/ingest/:slug — the door an external or first-party system posts events to.
//
// This is the brief's diagram, executed end to end:
//
//     Integration -> Authentication -> Event Router -> Connector -> EduRankAI Mail
//
//   Authentication  the API key identifies the ORGANISATION (mailapi/keys.ts). For a third-party
//                   integration the connector then demands an HMAC signature over the exact bytes,
//                   verified against the stored webhook secret — because a bearer token pasted into
//                   somebody else's configuration screen is a token in somebody else's logs.
//   Connector       authenticate -> validate -> receive -> normalize -> emit, run by one shared
//                   pipeline so no connector can invent its own ordering.
//   Router          validates against the catalogue, DEDUPLICATES, then decides what the fact causes.
//
// STATUS CODES ARE INSTRUCTIONS TO THE SENDER, and the one that matters most is 202:
//
//   200  published
//   202  accepted, and some or all of it was not mapped — NOT an error, do not retry
//   401  the signature or key is wrong — fix it, do not retry
//   422  we understood the request and cannot use this payload — do not retry
//   503  our fault — retry
//
// A system that sends us its whole event stream must not be taught that most of it is a failure. A
// 400 for an unmapped event puts our error in their dead-letter queue forever and makes the
// integration look broken to its owner.
//
// THE RAW BYTES ARE READ ONCE AND PASSED THROUGH UNCHANGED. Signature verification must see exactly
// what was sent; verifying a re-serialised copy is the single most common reason a correct
// implementation on the other side fails against a correct one on ours.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { getIntegrationBySlug, handleInbound } from '@/lib/mailint/integrations';
import { clientIp } from '@/lib/mailapi/ratelimit';

export const OPTIONS = PREFLIGHT;

/** A payload larger than this is a mistake or an attack, and either way it is refused whole. */
const MAX_BYTES = 1024 * 1024;

export const POST: APIRoute = apiRoute({ endpoint: 'ingest', scope: 'events.write' }, async (ctx) => {
  const slug = String(ctx.params.slug || '').toLowerCase();
  const integration = await getIntegrationBySlug(ctx.auth.orgId, ctx.auth.environment, slug);
  if (!integration) {
    // Names the environment, because the commonest cause of this 404 is a production key posting to
    // an integration that only exists in development.
    throw new ApiError('not_found', 'No integration called "' + slug + '" in the ' + ctx.auth.environment + ' environment.');
  }

  const declared = Number(ctx.request.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) {
    throw new ApiError('payload_too_large', 'The body is larger than the ' + Math.floor(MAX_BYTES / 1024) + ' KB limit.');
  }
  let rawBody: string;
  try {
    rawBody = await ctx.request.text();
  } catch {
    throw new ApiError('invalid_request', 'The request body could not be read.');
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BYTES) {
    throw new ApiError('payload_too_large', 'The body is larger than the ' + Math.floor(MAX_BYTES / 1024) + ' KB limit.');
  }

  const headers: Record<string, string> = {};
  ctx.request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const outcome = await handleInbound({
    integration,
    requestId: ctx.requestId,
    request: {
      headers,
      rawBody,
      method: 'POST',
      ip: clientIp(ctx.request),
    },
  });

  return ctx.json(outcome.body, outcome.status);
});

// A GET here is somebody testing the URL in a browser, and the useful answer is what to do instead.
export const GET: APIRoute = apiRoute({ endpoint: 'ingest.get', scope: 'events.read' }, async (ctx) => {
  const slug = String(ctx.params.slug || '').toLowerCase();
  const integration = await getIntegrationBySlug(ctx.auth.orgId, ctx.auth.environment, slug);
  if (!integration) throw new ApiError('not_found', 'No integration called "' + slug + '" in the ' + ctx.auth.environment + ' environment.');
  return ctx.json({
    object: 'ingest_endpoint',
    integration: integration.name,
    slug: integration.slug,
    connector: integration.connector,
    environment: integration.environment,
    enabled: integration.isEnabled,
    method: 'POST',
    content_type: 'application/json',
    signature: {
      required: integration.connector === 'external-webhook',
      headers: ['Webhook-Id', 'Webhook-Timestamp', 'Webhook-Signature'],
      signed_string: 'id + "." + timestamp + "." + body',
      algorithm: 'HMAC-SHA256, header value `v1,<base64>`',
      tolerance_seconds: 300,
    },
  });
});
