// POST /api/mail/domains/:id/verify — run the DNS checks now and store what they found.
//
// A real lookup, every time. This route is what the "Check now" button calls and what a scheduled
// re-check calls, and both must see the same code path — a verifier that only runs from the UI
// drifts from the one that runs on a timer, and then the two screens disagree.
import type { APIRoute } from 'astro';
import { guard, json } from '@/lib/mailplatform/domains/api';
import { getDomain } from '@/lib/mailplatform/domains/store';
import { runVerification, wizardStep } from '@/lib/mailplatform/domains/service';
import { healthSummary } from '@/lib/mailplatform/domains/verify';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals, params }) => {
  // `domains.read` deliberately, not `domains.manage`. Running a read-only DNS lookup and being
  // told what is wrong is not an administrative act; anyone who can see the domain should be able
  // to ask why it is not working. Nothing here changes configuration — the only write is the
  // recorded observation and the status it implies.
  const g = await guard(request, locals, 'domains.read');
  if (!g.ok) return g.response;

  const id = String(params.id || '');
  const domain = await getDomain(g.ctx.principal.orgId, id);
  if (!domain) return json({ ok: false, error: 'Domain not found.', code: 'not_found' }, 404);

  try {
    const health = await runVerification(g.ctx, domain);
    const after = await getDomain(g.ctx.principal.orgId, id);
    return json({
      ok: true,
      data: {
        health,
        summary: healthSummary(health),
        step: wizardStep(after || domain, health).step,
        domain: after,
      },
    });
  } catch (e: any) {
    // A verification run that throws must not be reported as a domain that failed verification.
    console.error('[api/mail/domains/verify] run failed -', causeOf(e));
    return json({
      ok: false,
      error: 'The checks could not be run: ' + causeOf(e) + '. This is about our lookup, not about your DNS.',
      code: 'check_failed',
    }, 502);
  }
};
