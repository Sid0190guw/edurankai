// POST /api/rbac/check — Block 10: evaluate a subject×action×resource decision AS the signed-in
// user. Any authenticated user may ask (checks run against their own principal). Presented
// bearer capability tokens (header `x-capability-token`, comma-separated) are attached and
// participate as engine Tier 4.
import type { APIRoute } from 'astro';
import { resolvePrincipal, enforce, writeAudit } from '@/lib/rbac';
import { checkRequestSchema } from '@/lib/rbac/types';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);

  let body: unknown;
  try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = checkRequestSchema.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: 'invalid body', issues: parsed.error.issues.map((i) => i.message) }, 400);
  const { capability, resource, context } = parsed.data;

  const presented = (request.headers.get('x-capability-token') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const principal = await resolvePrincipal(user, presented);
  const decision = await enforce(principal, capability as any, resource as any, context as any, writeAudit);
  return j({
    allow: decision.allow, reason: decision.reason, stage: decision.stage,
    matchedGrant: decision.matchedGrant ?? null,
  });
};
