// POST /api/v1/email/send — the transactional send endpoint.
//
// Auth:  Authorization: Bearer erm_live_… (or x-api-key). Scope: email.send.
// Idempotency: Idempotency-Key header, or `idempotency_key` in the body.
//
// THE IDEMPOTENCY CLAIM WRAPS THE WHOLE HANDLER, INCLUDING THE FAILURES. A validation error releases
// the claim, so the caller's corrected retry with the same key is not refused as a conflict. A
// successful send stores the exact response body, so a client that retried because IT timed out gets
// the original message id back rather than a second message.
import { apiRoute, OPTIONS as PREFLIGHT, methodNotAllowed } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { sendNow } from '@/lib/mailapi/send';
import { assertIdempotencyKey, claim, complete, release, requestHash } from '@/lib/mailapi/idempotency';
import { readJsonBody } from '@/lib/mailapi/errors';
import { LIMITS } from '@/lib/mailapi/validate';
import { consume, DEFAULT_LIMITS, rateLimitHeaders } from '@/lib/mailapi/ratelimit';

export const OPTIONS = PREFLIGHT;
export const GET = methodNotAllowed(['POST', 'OPTIONS']);

export const POST = apiRoute({ endpoint: 'email.send', scope: 'email.send' }, async (ctx) => {
  const body = await readJsonBody(ctx.request, LIMITS.maxBodyBytes);

  // The sending-identity dimension needs the From address, which is only known once the body is
  // parsed — so it is counted here rather than in the shared guard.
  const fromAddress = String(body?.from || '').replace(/^.*<|>.*$/g, '').trim().toLowerCase();
  if (fromAddress) {
    const identity = await consume('identity', ctx.auth.orgId + '|' + fromAddress, DEFAULT_LIMITS.identity);
    Object.assign(ctx.headers, rateLimitHeaders(identity));
    if (!identity.allowed) {
      throw new ApiError('rate_limit_exceeded', 'Too many messages from ' + fromAddress + '. Retry in ' + identity.resetSec + ' seconds.');
    }
  }

  const headerKey = ctx.request.headers.get('idempotency-key');
  const rawKey = headerKey && headerKey.trim() ? headerKey.trim() : (body?.idempotency_key ? String(body.idempotency_key) : '');

  if (!rawKey) {
    const outcome = await sendNow(ctx.auth, body, {});
    return ctx.json(outcome.response, 202);
  }

  const key = assertIdempotencyKey(rawKey);
  const hash = requestHash({ body, environment: ctx.auth.environment });
  const claimed = await claim({ orgId: ctx.auth.orgId, environment: ctx.auth.environment, key, hash });

  if (claimed.outcome === 'replay') {
    // The original response, byte for byte, with a header saying so. A client that cannot tell a
    // replay from a fresh send will double-count its own sends in its own reporting.
    return ctx.json(claimed.existing!.responseJson, claimed.existing!.responseStatus || 202, { 'Idempotent-Replayed': 'true' });
  }
  if (claimed.outcome === 'conflict') {
    throw new ApiError('idempotency_key_reused',
      'This Idempotency-Key was already used for a different request. Use a new key, or resend the identical request to get the original result.',
      { param: 'idempotency_key', extra: { original_message_id: claimed.existing?.messageId || null } });
  }
  if (claimed.outcome === 'in_progress') {
    throw new ApiError('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry in a moment.', { param: 'idempotency_key' });
  }

  try {
    const outcome = await sendNow(ctx.auth, body, { idempotencyKey: key });
    await complete(claimed.recordId!, { messageId: outcome.message.id, status: 202, body: outcome.response });
    return ctx.json(outcome.response, 202);
  } catch (e) {
    // Nothing was sent, so the key must not stay spent — otherwise the fix-and-retry that every
    // developer performs after a 422 would come back as a 409 about a message that never existed.
    await release(claimed.recordId!).catch(() => {});
    throw e;
  }
});
