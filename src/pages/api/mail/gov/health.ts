// GET /api/mail/gov/health
//
// Observed facts about this deployment, not a green tick. Whether the tables exist, whether the
// database itself enforces the append-only audit rule or whether that rests on our code, whether the
// chain verifies right now, whether there is anywhere to put an export, and whether anything is
// stuck. Each check states what to do about it.
//
// PLATFORM-SCOPED. A tenant administrator is refused this: it describes the platform's own
// infrastructure, and "your export storage is not configured" is our problem to fix, not a customer's
// to read.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed } from '@/lib/mailgov/http';
import { requireGov } from '@/lib/mailgov/guard';
import { governanceHealth } from '@/lib/mailgov/health';

export const GET: APIRoute = async ({ locals, request }) => {
  const g = await requireGov(locals, 'health.view', { platformWide: true }, request);
  if (g.denied) return g.denied;

  const health = await governanceHealth();
  // The HTTP status follows the worst check, so an uptime probe pointed here notices a failure
  // without parsing the body. `warn` stays 200: a warning is a thing to fix, not an outage.
  const status = health.worstState === 'fail' ? 503 : 200;
  return govJson({ ok: health.worstState !== 'fail', ...health }, status);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET']);
