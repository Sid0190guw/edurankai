// GET  /api/mail/gov/export     the export jobs for an organization, and the dataset catalogue
// POST /api/mail/gov/export     { action: 'request' | 'run' | 'revoke', ... }
//
// The download token is in the RESPONSE TO THE REQUEST and nowhere else. It is stored as a SHA-256,
// exactly like an API key, so nobody — including whoever holds the database — can recover it later.
// If the operator loses it, the export is re-requested; that is the correct outcome, not a gap.
//
// `run` is offered so an operator can push a job through without waiting for the worker, which is
// what happens on a deployment where the scheduled worker is not wired up yet. It is the same code
// path the worker uses.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { getExportJob, listExports, requestExport, revokeExport, runExportJob } from '@/lib/mailgov/exports';
import { DATASETS, contentDatasets } from '@/lib/mailgov/export-plan';
import { storageBackend, storageProvisioned } from '@/lib/storage';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'export.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);
  const jobId = url.searchParams.get('job');

  if (jobId) {
    const one = await getExportJob(jobId);
    if (!one.ok) return govJson({ ok: false, error: one.reason }, 404);
    // Tenant isolation applies to a direct id lookup exactly as it does to a list.
    if (g.actor.orgId && one.job?.orgId !== g.actor.orgId) {
      return govJson({ ok: false, error: 'forbidden', code: 'cross-tenant' }, 403);
    }
    return govJson({ ok: true, job: one.job });
  }

  const list = await listExports(orgId);
  return govJson({
    ok: list.ok,
    error: list.ok ? null : list.reason,
    jobs: list.ok ? list.rows : [],
    datasets: DATASETS.map((d) => ({ key: d.key, label: d.label, describes: d.describes, content: d.content, table: d.table })),
    storage: { backend: storageBackend(), provisioned: storageProvisioned() },
  });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || 'request');
  const orgId = String(body.orgId || url.searchParams.get('org') || '');

  if (action === 'request') {
    const datasets = Array.isArray(body.datasets) ? body.datasets.map(String) : [];
    const g = await requireGov(locals, 'export.request', { orgId }, request);
    if (g.denied) return g.denied;

    // A content export needs `audit.export` too when the audit dataset is in it, and the content
    // acknowledgement regardless. Both are checked before the job row exists.
    if (datasets.includes('audit')) {
      const a = await requireGov(locals, 'audit.export', { orgId }, request);
      if (a.denied) return a.denied;
    }

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.EXPORT_REQUESTED, orgId,
        targetType: 'export', targetId: null, reason: String(body.reason || ''),
        meta: { datasets, format: String(body.format || 'jsonl'), includesContent: contentDatasets(datasets).length > 0 },
        facts: g.facts,
      },
      async () => {
        const r = await requestExport({
          orgId,
          environment: String(body.environment || 'production'),
          datasets, format: String(body.format || 'jsonl'),
          since: body.since || null, until: body.until || null,
          acknowledgedContent: body.acknowledgedContent === true,
          reason: String(body.reason || ''),
          requestedBy: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    if (!out.ok) return govJson({ ok: false, error: out.error }, 400);

    return govJson({
      ok: true,
      jobId: out.data?.jobId,
      downloadToken: out.data?.downloadToken,
      includesContent: out.data?.includesContent,
      warning: 'This download token is shown once. It is stored only as a hash and cannot be re-issued — if it is lost, request the export again.',
    });
  }

  if (action === 'run') {
    const jobId = String(body.jobId || '');
    const job = await getExportJob(jobId);
    if (!job.ok) return govJson({ ok: false, error: job.reason }, 404);
    const g = await requireGov(locals, 'export.request', { orgId: job.job?.orgId }, request);
    if (g.denied) return g.denied;

    const result = await runExportJob(jobId);
    return govJson({ ok: result.ok, error: result.error, rows: result.rows });
  }

  if (action === 'revoke') {
    const jobId = String(body.jobId || '');
    const job = await getExportJob(jobId);
    if (!job.ok) return govJson({ ok: false, error: job.reason }, 404);
    const g = await requireGov(locals, 'export.request', { orgId: job.job?.orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      { actor: g.actor, action: 'export.revoked', orgId: job.job?.orgId || null, targetType: 'export', targetId: jobId, reason: String(body.reason || ''), facts: g.facts },
      async () => {
        const r = await revokeExport(jobId);
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['request', 'run', 'revoke'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
