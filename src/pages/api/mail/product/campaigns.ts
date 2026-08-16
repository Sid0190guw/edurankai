// /api/mail/product/campaigns — campaign CRUD, the state machine, test sends and dispatch.
//
//   GET  ?id=            one campaign with its audience count, stats and series
//   GET  ?status=&q=     the list
//   POST { action: 'create' | 'save' | 'schedule' | 'queue' | 'pause' | 'resume' | 'cancel'
//                | 'test' | 'dispatch' | 'duplicate' | 'delete' }
//
// 'dispatch' SENDS ONE BATCH and returns how many are left. The sending screen calls it in a loop
// and shows real progress; a cron can call the same endpoint. There is no code path here that starts
// an unbounded send inside one request — that request would be killed part-way with no record of
// where it got to.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyMailApi } from '@/lib/auth/mail-access';
import {
  listCampaigns, getCampaign, createCampaign, updateCampaign, setStatus,
  materialiseRecipients, dispatchBatch, campaignStats, campaignSeries,
  campaignAudienceCount, sendTest, STATUS_WORDING,
} from '@/lib/mail-product/campaigns';
import { ensureMailProductSchema } from '@/lib/mail-product/schema';
import { json, fail, reasonOf, rowsOf, isUuid, isEmail, str, clampInt } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.campaigns.read' });
  if (denied) return denied;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    if (id) {
      const campaign = await getCampaign(id);
      if (!campaign) return fail('No campaign with that id.', 404);
      // Four bounded reads in parallel. The audience count is live (it is a filter, not a snapshot)
      // until the campaign is queued, at which point recipients_total is the frozen truth.
      const [audience, stats, series] = await Promise.all([
        campaignAudienceCount(campaign).catch(() => 0),
        campaignStats(id).catch(() => ({})),
        campaignSeries(id, clampInt(url.searchParams.get('days'), 1, 90, 14)).catch(() => []),
      ]);
      return json({ ok: true, campaign, audience, stats, series, wording: STATUS_WORDING[campaign.status] });
    }
    const rows = await listCampaigns({
      status: str(url.searchParams.get('status'), 20) || undefined,
      q: str(url.searchParams.get('q'), 120) || undefined,
      limit: clampInt(url.searchParams.get('limit'), 1, 200, 60),
    });
    return json({ ok: true, rows });
  } catch (e: any) {
    console.error('[api/mail/product/campaigns] read failed:', reasonOf(e));
    return fail('Campaigns could not be read just now. Nothing has been changed.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.campaigns.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);
  const id = str(body.id, 40);

  try {
    await ensureMailProductSchema();

    switch (action) {
      case 'create': {
        const newId = await createCampaign({ name: str(body.name, 160), subject: str(body.subject, 300), createdBy: user?.id });
        return newId ? json({ ok: true, id: newId }) : fail('The campaign was not created.', 500);
      }

      case 'save':
        return respond(await updateCampaign(id, {
          name: body.name, subject: body.subject, preheader: body.preheader,
          fromName: body.fromName, fromEmail: body.fromEmail, replyTo: body.replyTo,
          templateId: body.templateId, listIds: body.listIds, segmentId: body.segmentId,
          blocks: body.blocks, scheduledAt: body.scheduledAt,
        }));

      case 'duplicate': {
        const c = await getCampaign(id);
        if (!c) return fail('No campaign with that id.', 404);
        const r = await db.execute(sql`
          INSERT INTO mail_campaigns (name, subject, preheader, from_name, from_email, reply_to,
                                      template_id, blocks, body_html, body_text, list_ids, segment_id, created_by)
          SELECT name || ' (copy)', subject, preheader, from_name, from_email, reply_to,
                 template_id, blocks, body_html, body_text, list_ids, segment_id, ${isUuid(user?.id) ? user.id : null}
          FROM mail_campaigns WHERE id = ${id} RETURNING id`);
        // The copy is a DRAFT with no recipients, no counts and no events. A duplicate that carried
        // the original's report would be two campaigns claiming the same sends.
        return json({ ok: true, id: rowsOf(r)[0]?.id ?? null });
      }

      case 'delete': {
        const c = await getCampaign(id);
        if (!c) return fail('No campaign with that id.', 404);
        if (['sending', 'queued'].includes(c.status)) {
          return fail('This campaign is mid-send. Cancel it first — deleting it now would destroy the record of who has already received it.');
        }
        await db.execute(sql`DELETE FROM mail_campaigns WHERE id = ${id}`);
        return json({ ok: true });
      }

      case 'schedule': {
        const when = body.scheduledAt ? new Date(body.scheduledAt) : null;
        if (!when || Number.isNaN(when.getTime())) return fail('That send time could not be read.');
        if (when.getTime() < Date.now() + 60_000) return fail('Pick a time at least a minute from now, so there is time to cancel.');
        const saved = await updateCampaign(id, { scheduledAt: when.toISOString() });
        if (!saved.ok) return fail(saved.error || 'The send time was not saved.');
        return respond(await setStatus(id, 'scheduled'));
      }

      case 'queue': {
        const c = await getCampaign(id);
        if (!c) return fail('No campaign with that id.', 404);
        // Refuse a campaign that cannot go out, BEFORE any recipient row is written — so a refusal
        // leaves the campaign exactly as it was rather than half-prepared.
        const missing: string[] = [];
        if (!c.subject.trim()) missing.push('a subject line');
        if (!c.body_html.trim()) missing.push('content');
        if (!c.from_email) missing.push('a From address');
        if (!(c.list_ids || []).length && !c.segment_id) missing.push('a list or a segment to send to');
        if (missing.length) {
          return fail('This campaign is not ready to send. It still needs ' + missing.join(', ') + '. Nothing has been queued.');
        }

        const mat = await materialiseRecipients(id);
        if (mat.error) return fail('The recipient list could not be built, so nothing was queued: ' + mat.error, 500);
        if (mat.total === 0) {
          return fail('That list and segment match nobody who is currently subscribed, so there is no one to send to. Nothing has been queued.');
        }
        const moved = await setStatus(id, 'queued');
        if (!moved.ok) return fail(moved.error || 'The campaign could not be queued.');
        return json({ ok: true, total: mat.total });
      }

      case 'pause': return respond(await setStatus(id, 'paused'));
      case 'resume': return respond(await setStatus(id, 'queued'));

      case 'cancel': {
        const res = await setStatus(id, 'cancelled');
        if (!res.ok) return fail(res.error || 'The campaign could not be cancelled.');
        // Everything not yet attempted is dropped from the queue. Rows already 'sent' or 'failed'
        // stay exactly as they are — they are the record of what happened.
        const r = await db.execute(sql`
          UPDATE mail_campaign_recipients SET status = 'cancelled'
          WHERE campaign_id = ${id} AND status IN ('queued','sending') RETURNING id`);
        return json({ ok: true, dropped: rowsOf(r).length });
      }

      case 'test': {
        const to = String(body.to || '').trim();
        if (!isEmail(to)) return fail('Enter one email address to send the test to.');
        const res = await sendTest(id, to);
        return res.ok
          ? json({ ok: true, note: `A test message has been sent to ${to}. It is not counted in this campaign's report.` })
          : fail(res.error || 'The test was not sent.');
      }

      case 'dispatch': {
        const res = await dispatchBatch(id, clampInt(body.batchSize, 1, 100, 25));
        // A refusal is reported as a refusal WITH its reason, not as a zero-progress success.
        if (!res.ok) return json({ ok: false, error: res.error, ...res }, 200);
        return json({ ok: true, ...res });
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/campaigns] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and the campaign is unchanged.', 500);
  }
};

/** A service result becomes a response in one place, so every action answers in the same shape. */
function respond(r: { ok: boolean; error?: string; [k: string]: unknown }): Response {
  return r.ok ? json({ ...r, ok: true }) : fail(r.error || 'That did not go through.');
}
