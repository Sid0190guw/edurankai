// GET  /api/mail/gov/deletion   the deletion jobs, and what each one is waiting for
// POST /api/mail/gov/deletion   { action: 'preview' | 'request' | 'approve' | 'cancel' | 'run', ... }
//
// `preview` is pure: it returns the plan — every table that will be touched, everything deliberately
// kept, the phrase to type, how many approvals are needed and how long the grace window is — without
// creating anything. The console shows that BEFORE the confirmation box, because a confirmation
// screen that does not say what will be destroyed is a formality rather than a control.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { approveDeletion, cancelDeletion, getDeletion, listDeletions, requestDeletion, runDeletionJob } from '@/lib/mailgov/deletion';
import { deletionPlan, type DeletionScope } from '@/lib/mailgov/deletion-plan';
import { normalizeEmail } from '@/lib/mailgov/consent-policy';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'deletion.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const jobId = url.searchParams.get('job');
  if (jobId) {
    const one = await getDeletion(jobId);
    if (!one.ok) return govJson({ ok: false, error: one.reason }, 404);
    if (g.actor.orgId && one.job?.orgId !== g.actor.orgId) {
      return govJson({ ok: false, error: 'forbidden', code: 'cross-tenant' }, 403);
    }
    return govJson({ ok: true, job: one.job });
  }

  const list = await listDeletions(orgParam(url, g.actor.orgId));
  return govJson({ ok: list.ok, error: list.ok ? null : list.reason, jobs: list.ok ? list.rows : [] });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || '');
  const scope = String(body.scope || '') as DeletionScope;
  const orgId = String(body.orgId || url.searchParams.get('org') || '') || null;

  // A mailbox deletion acts on the internal mail store, which belongs to no tenant — so it is a
  // platform-scoped action and a tenant-scoped actor cannot reach it at all.
  const target = { orgId: orgId || undefined, platformWide: scope === 'mailbox' };

  if (action === 'preview') {
    const g = await requireGov(locals, 'deletion.view', target, request);
    if (g.denied) return g.denied;
    const t = scope === 'contact' ? normalizeEmail(String(body.target || '')) : String(body.target || '');
    return govJson({
      ok: true,
      plan: deletionPlan({ scope, target: t, targetLabel: String(body.targetLabel || t), alsoRemoveSuppression: body.alsoRemoveSuppression === true }),
    });
  }

  if (action === 'request') {
    const g = await requireGov(locals, 'deletion.request', target, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.DELETION_REQUESTED, orgId,
        targetType: scope, targetId: String(body.target || ''), reason: String(body.reason || ''),
        meta: { scope, alsoRemoveSuppression: body.alsoRemoveSuppression === true }, facts: g.facts,
      },
      async () => {
        const r = await requestDeletion({
          orgId: scope === 'mailbox' ? null : orgId,
          scope,
          target: String(body.target || ''),
          targetLabel: String(body.targetLabel || body.target || ''),
          reason: String(body.reason || ''),
          typedPhrase: String(body.typedPhrase || ''),
          alsoRemoveSuppression: body.alsoRemoveSuppression === true,
          requestedBy: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({
      ok: out.ok, error: out.error,
      jobId: out.data?.jobId, status: out.data?.status, next: out.data?.next, plan: out.data?.plan,
    }, out.ok ? 200 : 400);
  }

  if (action === 'approve' || action === 'cancel' || action === 'run') {
    const jobId = String(body.jobId || '');
    const existing = await getDeletion(jobId);
    if (!existing.ok) return govJson({ ok: false, error: existing.reason }, 404);
    const job = existing.job!;

    const capability = action === 'approve' ? 'deletion.approve' : action === 'cancel' ? 'deletion.cancel' : 'deletion.approve';
    const g = await requireGov(locals, capability as any, { orgId: job.orgId || undefined, platformWide: job.scope === 'mailbox' }, request);
    if (g.denied) return g.denied;

    if (action === 'approve') {
      const out = await auditedWrite(
        { actor: g.actor, action: AUDIT_ACTIONS.DELETION_APPROVED, orgId: job.orgId, targetType: job.scope, targetId: job.target, reason: String(body.reason || ''), meta: { jobId }, facts: g.facts },
        async () => {
          const r = await approveDeletion({ jobId, byUserId: g.actor.userId as string });
          if (!r.ok) throw new Error(r.error);
          return r;
        },
      );
      return govJson({ ok: out.ok, error: out.error, have: out.data?.have, need: out.data?.need, status: out.data?.status }, out.ok ? 200 : 400);
    }

    if (action === 'cancel') {
      const out = await auditedWrite(
        { actor: g.actor, action: AUDIT_ACTIONS.DELETION_CANCELLED, orgId: job.orgId, targetType: job.scope, targetId: job.target, reason: String(body.reason || ''), meta: { jobId }, facts: g.facts },
        async () => {
          const r = await cancelDeletion({ jobId, byUserId: g.actor.userId as string, reason: String(body.reason || '') });
          if (!r.ok) throw new Error(r.error);
          return r;
        },
      );
      return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
    }

    // `run` executes it now. The gate is re-checked inside runDeletionJob() regardless of who asks —
    // a grace window that a button can skip is not a grace window, so a job whose window has not
    // elapsed is refused here exactly as it would be in the worker.
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.DELETION_EXECUTED, orgId: job.orgId, targetType: job.scope, targetId: job.target, reason: 'Manual execution of deletion job ' + jobId, meta: { jobId }, facts: g.facts },
      async () => runDeletionJob(jobId),
    );
    const r = out.data as any;
    return govJson({ ok: !!r?.ok, error: r?.error || out.error, blocked: r?.blocked, counts: r?.counts, summary: r?.summary }, r?.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['preview', 'request', 'approve', 'cancel', 'run'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
