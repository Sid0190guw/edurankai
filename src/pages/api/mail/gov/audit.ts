// GET /api/mail/gov/audit            the audit log, filtered
// GET /api/mail/gov/audit?verify=1   walk the hash chain and report what was actually checked
//
// READ-ONLY BY CONSTRUCTION. There is no POST, no PATCH and no DELETE on this route, and there is no
// code path anywhere in this repository that updates a row in mailapi_audit_events. The database
// refuses UPDATE outright (see the trigger in src/lib/mailgov/schema.ts); this route is the other
// half of that guarantee — the surface that reads the log cannot also change it.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam } from '@/lib/mailgov/http';
import { requireGov } from '@/lib/mailgov/guard';
import { auditActions, listAudit, verifyAuditChain, auditHead } from '@/lib/mailgov/audit';
import { auditAnchor } from '@/lib/mailgov/audit-chain';

export const GET: APIRoute = async ({ locals, request, url }) => {
  // Verification is a PLATFORM question: the chain is one chain across every tenant, so a tenant
  // cannot verify "their" section of it in isolation — the links run through other tenants' events.
  // Saying that plainly is better than offering a per-tenant verify that quietly proves less.
  if (url.searchParams.get('verify') === '1') {
    const g = await requireGov(locals, 'audit.verify', { platformWide: true }, request);
    if (g.denied) return g.denied;

    const status = await verifyAuditChain({ limit: Number(url.searchParams.get('limit')) || 500 });
    const head = await auditHead();
    return govJson({
      ok: status.ok,
      readError: status.readError,
      verdict: status.verdict,
      contentMismatches: status.contentMismatches,
      total: status.total,
      checkpoints: status.checkpoints,
      head,
      anchor: auditAnchor(head, new Date().toISOString()),
      note: 'Verification covers the window named in `verdict.checked`, anchored to the event before it. It is a proof about that range, not about the whole table.',
    });
  }

  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'audit.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);

  if (url.searchParams.get('facets') === '1') {
    const facets = await auditActions(orgId);
    return facets.ok ? govJson({ ok: true, actions: facets.rows }) : govJson({ ok: false, error: facets.reason }, 500);
  }

  const list = await listAudit({
    orgId,
    action: url.searchParams.get('action'),
    actorUserId: url.searchParams.get('actor'),
    targetType: url.searchParams.get('targetType'),
    targetId: url.searchParams.get('targetId'),
    result: url.searchParams.get('result'),
    since: url.searchParams.get('since'),
    until: url.searchParams.get('until'),
    beforeSeq: url.searchParams.get('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : null,
    limit: Number(url.searchParams.get('limit')) || 100,
  });

  // An empty list and a failed read are different facts and must not render the same. See the note at
  // the top of src/lib/mailgov/audit.ts.
  if (!list.ok) return govJson({ ok: false, error: list.reason, readFailed: true }, 500);
  return govJson({ ok: true, events: list.rows, count: list.rows.length });
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET']);
