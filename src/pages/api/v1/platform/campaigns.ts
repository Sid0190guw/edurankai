// GET  /api/v1/platform/campaigns — list campaigns with live counts.
// POST /api/v1/platform/campaigns — create a campaign, or act on one (?action=start|pause|cancel).
//
// STARTING A CAMPAIGN IS A SEPARATE CAPABILITY from creating one (`campaigns.send`, not
// `campaigns.write`). Drafting a message to fifty thousand people and actually sending it to them
// are different acts with different consequences, and one permission covering both means whoever
// can type can also press the button.

import type { APIRoute } from 'astro';
import { audit, error, ok, pageParams, pageResponse, preflight, readJson, requirePrincipal, validate } from '@/lib/mailplatform/api';
import { can } from '@/lib/mailplatform/permissions';
import {
  cancelCampaign,
  campaignStats,
  createCampaign,
  expandRecipients,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  startCampaign,
} from '@/lib/mailplatform/campaigns';

const CREATE_SPEC = {
  name: { required: true, type: 'string', maxLength: 200 },
  subject: { type: 'string', maxLength: 500 },
} as const;

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'campaigns.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const id = url.searchParams.get('id');

  if (id) {
    const campaign = await getCampaign(principal.orgId, id);
    if (!campaign) return error('No campaign with that id.', 404, 'not_found');
    // Counts come from the event stream on every read, not from the cached `stats` column. A stored
    // counter that drifts is a report nobody can trust and nobody can tell is wrong.
    return ok({ campaign: { ...campaign, stats: await campaignStats(principal.orgId, campaign.id) } });
  }

  const { limit, cursor } = pageParams(url, 25, 100);
  const page = await listCampaigns(principal.orgId, { status: url.searchParams.get('status') || undefined, limit, cursor });
  return pageResponse(page, 'campaigns');
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'campaigns.write');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const action = url.searchParams.get('action');

  if (action) {
    const id = url.searchParams.get('id');
    if (!id) return error('"id" is required for an action.', 422, 'no_id');

    if (action === 'start') {
      if (!can(principal, 'campaigns.send')) return error('forbidden', 403, 'insufficient_permission');
      const result = await startCampaign(principal.orgId, id, principal);
      await audit({
        principal,
        request: ctx.request,
        action: 'campaign.start',
        targetType: 'campaign',
        targetId: id,
        meta: { queued: result.queued ?? 0, ok: result.ok },
      });
      if (!result.ok) return error(result.error || 'The campaign was not started.', 422, 'start_refused');
      return ok({ started: true, queued: result.queued });
    }

    if (action === 'pause') {
      if (!can(principal, 'campaigns.send')) return error('forbidden', 403, 'insufficient_permission');
      const result = await pauseCampaign(principal.orgId, id);
      await audit({ principal, request: ctx.request, action: 'campaign.pause', targetType: 'campaign', targetId: id });
      if (!result.ok) return error(result.error || 'The campaign was not paused.', 422, 'pause_refused');
      // Said plainly: the batch already claimed still goes out. A pause that implied otherwise
      // would have an operator believing they stopped mail that is already leaving.
      return ok({ paused: true, detail: 'No new recipients will be claimed. The batch already in flight will finish.' });
    }

    if (action === 'cancel') {
      if (!can(principal, 'campaigns.send')) return error('forbidden', 403, 'insufficient_permission');
      const result = await cancelCampaign(principal.orgId, id);
      await audit({ principal, request: ctx.request, action: 'campaign.cancel', targetType: 'campaign', targetId: id });
      if (!result.ok) return error(result.error || 'The campaign was not cancelled.', 422, 'cancel_refused');
      return ok({ cancelled: true, detail: 'Messages already sent cannot be recalled.' });
    }

    if (action === 'expand') {
      const result = await expandRecipients(principal.orgId, id);
      if (!result.ok) return error(result.error || 'The audience was not expanded.', 422, 'expand_failed');
      return ok({ queued: result.queued, suppressed: result.suppressed });
    }

    return error(`Unknown action "${action}". Use start, pause, cancel or expand.`, 400, 'unknown_action');
  }

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  const check = validate(body, CREATE_SPEC as any);
  if (!check.ok) return check.response;

  const result = await createCampaign({
    orgId: principal.orgId,
    name: String(body.name),
    slug: typeof body.slug === 'string' ? body.slug : undefined,
    templateId: (body.templateId as string) || null,
    sendingIdentityId: (body.sendingIdentityId as string) || null,
    subject: (body.subject as string) || null,
    preheader: (body.preheader as string) || null,
    listId: (body.listId as string) || null,
    scheduledAt: (body.scheduledAt as string) || null,
    createdBy: principal.kind === 'user' ? principal.id : null,
  });

  if (!result.ok) return error(result.error || 'The campaign was not created.', 422, 'create_failed');

  await audit({
    principal,
    request: ctx.request,
    action: 'campaign.create',
    targetType: 'campaign',
    targetId: result.campaign?.id || null,
  });
  return ok({ campaign: result.campaign }, 201);
};
