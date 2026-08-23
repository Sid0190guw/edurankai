// POST /api/talent/gateway — THE ONLY WAY TO OBTAIN A GATE PASS.
//
// Two doors, both decided server-side and never by the browser:
//   { door: 'code', code, email, opportunityId? }  -> redeem, then a pass carrying the selection
//   { door: 'open', email }                        -> a pass permitting an ordinary application
//
// Deliberately unauthenticated, because an external candidate has no account yet. That is exactly
// why the rate limiter runs before any lookup and why every code refusal returns one sentence and
// one status — see redeemAtGate() in src/lib/talent/gateway.ts and UNIFORM_REJECTION in types.ts.
//
// `/api/*` IS NOT COVERED BY THE /admin MIDDLEWARE GATE IN THIS CODEBASE. This endpoint therefore
// carries its own controls in full and assumes nothing upstream of it.
import type { APIRoute } from 'astro';
import { redeemAtGate, issuePass, gateCookieHeader, gateUnavailable } from '@/lib/talent/gateway';
import { logAudit } from '@/lib/audit';

// Declared before the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function j(body: any, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

/** The client address, preferring what the platform resolved over anything the client asserted. */
function clientIp(clientAddress: string | undefined, request: Request): string | null {
  if (clientAddress) return String(clientAddress);
  const first = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return first || null;
}

export const POST: APIRoute = async ({ request, clientAddress, locals, url }) => {
  // A gate that cannot sign a pass must REFUSE, not admit. Failing open here would fail open in
  // precisely the environment where configuration had already gone wrong.
  if (gateUnavailable()) {
    return j({ ok: false, error: 'The application gate is not configured on this environment. No application can be accepted until it is.' }, 503);
  }

  let body: any = {};
  try { body = await request.json(); } catch { return j({ ok: false, error: 'Malformed request.' }, 400); }

  const door = String(body.door || '');
  const email = String(body.email || '').trim().toLowerCase();
  const ip = clientIp(clientAddress, request);
  const userAgent = request.headers.get('user-agent');
  const secure = url.protocol === 'https:';
  const user = (locals as any)?.user || null;

  if (!EMAIL_RE.test(email) || email.length > 255) {
    return j({ ok: false, error: 'Enter the email address the message from EduRankAI was sent to.' }, 400);
  }

  // -----------------------------------------------------------------------------------------
  // DOOR 2 — no code. Nothing is looked up, so nothing is rate limited: this door reveals nothing
  // and costs nothing. Reachable only by explicit declaration, never as a fallback from a failed
  // code, so a mistyped code cannot silently become a duplicate application.
  // -----------------------------------------------------------------------------------------
  if (door === 'open') {
    const { token } = issuePass({ door: 'open', email, userId: user?.id || null });
    if (!token) return j({ ok: false, error: 'The gate could not issue a pass. Please try again shortly.' }, 503);
    await logAudit({
      userId: user?.id || null, action: 'talent.gate.open', entity: 'talent_gate',
      diff: { email, internal: !!user?.id }, ipAddress: ip || undefined,
    });
    return j({ ok: true, door: 'open', next: '/apply/step-1' }, 200, { 'Set-Cookie': gateCookieHeader(token, secure) });
  }

  if (door !== 'code') return j({ ok: false, error: 'Choose whether you hold an onboarding code.' }, 400);

  // -----------------------------------------------------------------------------------------
  // DOOR 1 — a code. The whole ladder is in redeemAtGate(): limit, format, lookup by hash, the
  // selection behind it, the decision, and the attempt record on every path.
  // -----------------------------------------------------------------------------------------
  const result = await redeemAtGate({
    rawCode: String(body.code || ''),
    claimedEmail: email,
    againstOpportunityId: body.opportunityId ? String(body.opportunityId) : null,
    ip, userAgent,
  });

  if (!result.ok || !result.code) {
    // ONLY the message crosses the wire. result.outcome carries the true reason and belongs in the
    // audit log, never in a response — it is what distinguishes a missed guess from a real code.
    await logAudit({
      userId: user?.id || null, action: 'talent.gate.code_refused', entity: 'tal_onboarding_code',
      diff: { outcome: result.outcome, emailTried: email }, ipAddress: ip || undefined,
    });
    const headers: Record<string, string> = {};
    if (result.retryAfterSeconds) headers['Retry-After'] = String(result.retryAfterSeconds);
    return j({ ok: false, error: result.message, captchaRequired: !!result.captchaRequired }, result.status, headers);
  }

  const code = result.code;
  const { token } = issuePass({
    door: 'code', email, userId: user?.id || null,
    codeId: code.id, selectionId: code.selectionId,
    opportunityId: code.opportunityId, personId: code.personId,
  });
  if (!token) return j({ ok: false, error: 'The gate could not issue a pass. Please try again shortly.' }, 503);

  await logAudit({
    userId: user?.id || null, action: 'talent.gate.code_accepted', entity: 'tal_onboarding_code',
    entityId: code.id, diff: { codeRef: code.codeId, selectionId: code.selectionId }, ipAddress: ip || undefined,
  });

  return j({ ok: true, door: 'code', next: '/onboarding' }, 200, { 'Set-Cookie': gateCookieHeader(token, secure) });
};

/** Named so a mistaken GET does not render an HTML error page into a fetch(). */
export const GET: APIRoute = async () => j({ ok: false, error: 'Use POST.' }, 405);
