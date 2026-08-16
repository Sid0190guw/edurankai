// GET  /api/mail/gov/retention   policies in force, conflicts, and the run history
// POST /api/mail/gov/retention   { action: 'set' | 'sweep', ... }
//
// A `sweep` with `dryRun: true` counts what would go and deletes nothing. The console offers that
// first, and the payload always states which one ran — a retention screen whose only button destroys
// two years of a customer's mail is a screen people are right to be frightened of.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { getPolicies, listRetentionRuns, runSweep, setPolicy } from '@/lib/mailgov/retention';
import { RETENTION_SPECS, RETENTION_CLASSES } from '@/lib/mailgov/retention-policy';
import { aiRecordSummary } from '@/lib/mailgov/ai-records';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'retention.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);
  if (!orgId) return govJson({ ok: false, error: 'Name the organization whose retention you want.' }, 400);

  const environment = url.searchParams.get('environment') || 'production';
  const policies = await getPolicies(orgId, environment);
  const runs = await listRetentionRuns(orgId, 30);
  const ai = await aiRecordSummary(orgId);

  return govJson({
    ok: policies.ok,
    readError: policies.ok ? null : policies.reason,
    policies: policies.policies,
    conflicts: policies.conflicts,
    specs: RETENTION_CLASSES.map((c) => RETENTION_SPECS[c]),
    runs: runs.ok ? runs.rows : [],
    runsError: runs.ok ? null : runs.reason,
    aiRecords: ai,
  });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || 'set');
  const orgId = String(body.orgId || url.searchParams.get('org') || '');

  if (action === 'set') {
    const g = await requireGov(locals, 'retention.edit', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.RETENTION_CHANGED, orgId,
        targetType: 'retention_policy', targetId: String(body.dataClass || ''),
        reason: String(body.reason || ''),
        meta: { dataClass: body.dataClass, retainDays: body.retainDays, retentionAction: body.retentionAction || 'delete', enabled: body.enabled !== false },
        facts: g.facts,
      },
      async () => {
        const r = await setPolicy({
          orgId,
          environment: String(body.environment || 'production'),
          dataClass: String(body.dataClass || ''),
          retainDays: Number(body.retainDays),
          action: String(body.retentionAction || 'delete'),
          enabled: body.enabled !== false,
          byUserId: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error, conflicts: out.data?.conflicts || [] }, out.ok ? 200 : 400);
  }

  if (action === 'sweep') {
    const dryRun = body.dryRun !== false;
    // A dry run needs only `retention.view` — it reads and counts. Actually deleting needs
    // `retention.edit`, because it is the change.
    const g = await requireGov(locals, dryRun ? 'retention.view' : 'retention.edit', { orgId }, request);
    if (g.denied) return g.denied;

    if (dryRun) {
      const report = await runSweep({ orgId, environment: String(body.environment || 'production'), dryRun: true, byUserId: g.actor.userId });
      return govJson({ ok: report.ok, error: report.error, report, dryRun: true });
    }

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.RETENTION_SWEPT, orgId,
        targetType: 'organization', targetId: orgId,
        reason: String(body.reason || 'Manual retention sweep.'),
        meta: { environment: String(body.environment || 'production') }, facts: g.facts,
      },
      async () => runSweep({ orgId, environment: String(body.environment || 'production'), dryRun: false, byUserId: g.actor.userId }),
    );
    return govJson({ ok: out.ok, error: out.error, report: out.data, dryRun: false }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['set', 'sweep'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
