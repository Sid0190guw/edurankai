// POST /api/mail/campaigns — the campaign control surface.
//
// Every status change goes through the state machine in src/lib/mail-campaign-state.ts, and every
// send goes through the preflight gate. Nothing in this file invents a status or bypasses a check;
// it validates its input, calls the library, and returns the library's own sentence.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import {
  createCampaign, updateCampaign, deleteCampaign, duplicateCampaign, getCampaign, listCampaigns,
  scheduleCampaign, unscheduleCampaign, queueCampaign, pauseCampaign, resumeCampaign,
  cancelCampaign, reopenCampaign, previewCampaign, sendCampaignBatch, promoteWinner,
  campaignTotals, variantStats, clickBreakdown, campaignRecipients, copyForVariant,
  unsubscribeUrl, SITE_BASE,
} from '@/lib/mail-campaigns';
import { isUuid, dbReason, type Actor } from '@/lib/mail-contacts';
import { pickWinner } from '@/lib/mail-campaign-state';
import { mergeVarsForContact, renderHtml, renderSubject } from '@/lib/mail-personalize';
import { getContact } from '@/lib/mail-contacts';
import { sendExternal } from '@/lib/mail-transport';
import { getMailConfig, isInternalAddress, normalizeEmail, parseAddressList, MAIL_DOMAIN } from '@/lib/mail';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.campaigns' });
  if (denied) return denied;
  const user = (locals as any).user;
  const actor: Actor = { userId: user?.id || null, name: user?.name || user?.email || 'admin' };

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action || '');
  const id = String(body.id || '');
  const needsId = !['create', 'list'].includes(action);
  if (needsId && !isUuid(id)) return json({ ok: false, error: 'That campaign id is not valid.' }, 400);

  try {
    switch (action) {
      case 'create': {
        const r = await createCampaign({ name: String(body.name || ''), subject: body.subject, bodyHtml: body.bodyHtml, stream: body.stream }, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'list':
        return json({ ok: true, campaigns: await listCampaigns({ status: body.status, limit: body.limit }) });

      case 'get': {
        const c = await getCampaign(id);
        return c ? json({ ok: true, campaign: c }) : json({ ok: false, error: 'That campaign no longer exists.' }, 404);
      }

      case 'update': {
        const r = await updateCampaign(id, {
          name: body.name, subject: body.subject, preheader: body.preheader,
          fromName: body.fromName, fromAddress: body.fromAddress, replyTo: body.replyTo,
          bodyHtml: body.bodyHtml, bodyText: body.bodyText,
          audience: body.audience, ab: body.ab, stream: body.stream,
        });
        return json(r, r.ok ? 200 : 400);
      }

      case 'delete': {
        const r = await deleteCampaign(id);
        return json(r, r.ok ? 200 : 400);
      }

      case 'duplicate': {
        const r = await duplicateCampaign(id, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'preview': {
        const pv = await previewCampaign(id, { sampleSize: Number(body.sampleSize) || 3 });
        if (!pv) return json({ ok: false, error: 'That campaign no longer exists.' }, 404);
        return json({
          ok: true,
          status: pv.campaign.status,
          recipientCount: pv.recipientCount,
          counts: pv.resolved.counts,
          skipLines: pv.skipLines,
          truncated: pv.resolved.truncated,
          preflight: pv.preflight,
          transportReady: pv.transportReady,
          recentDuplicate: pv.recentDuplicate,
          samples: pv.sampleRendered,
        });
      }

      case 'schedule': {
        const r = await scheduleCampaign(id, {
          localTime: String(body.localTime || ''),
          timeZone: String(body.timeZone || 'Asia/Kolkata'),
          recurrence: body.recurrence || null,
        }, actor);
        return json(r.ok ? { ok: true, at: r.at } : r, r.ok ? 200 : 400);
      }

      case 'unschedule': {
        const r = await unscheduleCampaign(id);
        return json(r, r.ok ? 200 : 400);
      }

      case 'queue': {
        const confirmed = body.confirmedCount === undefined || body.confirmedCount === null
          ? null
          : Number(body.confirmedCount);
        if (confirmed !== null && !Number.isFinite(confirmed)) {
          return json({ ok: false, error: 'The confirmation must be the recipient count, typed as a number.' }, 400);
        }
        const r = await queueCampaign(id, { confirmedCount: confirmed, actor });
        return json(r, r.ok ? 200 : 400);
      }

      case 'send-batch': {
        // Manual drain, for an operator who does not want to wait for the cron. Bounded exactly as
        // the cron is — this endpoint never sends a whole campaign in one request.
        const r = await sendCampaignBatch(id, Math.min(200, Number(body.limit) || 50));
        return json({ ok: !r.error || r.claimed > 0, ...r });
      }

      case 'pause': {
        const r = await pauseCampaign(id, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'resume': {
        const r = await resumeCampaign(id);
        return json(r, r.ok ? 200 : 400);
      }

      case 'cancel': {
        const r = await cancelCampaign(id, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'reopen': {
        const r = await reopenCampaign(id);
        return json(r, r.ok ? 200 : 400);
      }

      case 'promote-winner': {
        const r = await promoteWinner(id, { variant: body.variant, override: !!body.override });
        return json(r, r.ok ? 200 : 400);
      }

      case 'stats': {
        const c = await getCampaign(id);
        if (!c) return json({ ok: false, error: 'That campaign no longer exists.' }, 404);
        const variants = await variantStats(id);
        return json({
          ok: true,
          totals: await campaignTotals(id),
          variants,
          winner: c.ab?.enabled ? pickWinner(variants, c.ab.winnerMetric) : null,
          links: await clickBreakdown(id),
        });
      }

      case 'recipients':
        return json({ ok: true, ...(await campaignRecipients(id, { status: body.status, limit: body.limit, offset: body.offset })) });

      case 'test': {
        return testSend(id, body, user);
      }

      default:
        return json({ ok: false, error: 'Unknown action "' + action + '".' }, 400);
    }
  } catch (e: any) {
    console.error('[api/mail/campaigns] ' + action + ':', dbReason(e));
    return json({ ok: false, error: 'That did not run: ' + dbReason(e) }, 500);
  }
};

/**
 * Send a test copy.
 *
 * REFUSES ANY ADDRESS THAT IS NOT OURS OR THE OPERATOR'S OWN. A test send is the natural way to
 * accidentally mail a real prospect an unfinished draft, and a load test aimed at a public inbox is
 * how a sending domain earns a complaint it cannot undo. Internal mailboxes and the signed-in
 * operator's own address are enough to check rendering, links and deliverability.
 *
 * A test is NOT recorded as a campaign recipient — it would otherwise appear in the report and in
 * the unique index, and the real send to that address would then be silently skipped.
 */
async function testSend(id: string, body: any, user: any): Promise<Response> {
  const c = await getCampaign(id);
  if (!c) return json({ ok: false, error: 'That campaign no longer exists.' }, 404);
  if (!String(c.subject || '').trim() || !String(c.body_html || '').trim()) {
    return json({ ok: false, error: 'Write a subject and a body before sending a test.' }, 400);
  }

  const asked = parseAddressList(body.to || user?.email || '');
  if (!asked.length) return json({ ok: false, error: 'Give at least one test address.' }, 400);

  const own = normalizeEmail(user?.email || '');
  const allowed = asked.filter((e) => isInternalAddress(e) || e === own);
  const refused = asked.filter((e) => !allowed.includes(e));
  if (!allowed.length) {
    return json({
      ok: false,
      error: 'Test sends go to @' + MAIL_DOMAIN + ' mailboxes or to your own address only. '
        + refused.join(', ') + ' ' + (refused.length === 1 ? 'is' : 'are') + ' outside that, so nothing was sent.',
    }, 400);
  }

  const cfg = await getMailConfig().catch(() => null);
  if (!cfg?.smtpHost) return json({ ok: false, error: 'No outbound mail server is configured, so the test could not be sent.' }, 400);

  // Render against a real contact when one is named, so the test shows real merge data rather than
  // placeholder text that hides an empty field.
  let vars: Record<string, any>;
  if (isUuid(body.contactId)) {
    const contact = await getContact(String(body.contactId));
    if (!contact) return json({ ok: false, error: 'That contact no longer exists.' }, 404);
    vars = mergeVarsForContact(contact as any, {
      unsubscribe_url: unsubscribeUrl(contact.id, contact.unsub_token, id),
      view_in_browser_url: SITE_BASE + '/mail/view/' + id,
    });
  } else {
    // Obviously-fake values, so a blank merge field is visible in the test rather than papered over
    // with something that reads like real data.
    vars = {
      first_name: 'Test', last_name: 'Recipient', full_name: 'Test Recipient',
      email: allowed[0], organization: 'Sample Organisation', role: 'Sample Role',
      stage: 'Assessment', application_id: 'ERA-TEST-0000', deadline: 'in seven days',
      unsubscribe_url: SITE_BASE + '/mail/unsubscribe',
      view_in_browser_url: SITE_BASE + '/mail/view/' + id,
    };
  }

  const variant = String(body.variant || 'a');
  const copy = copyForVariant(c, variant);
  const subject = '[TEST' + (c.ab?.enabled ? ' ' + variant.toUpperCase() : '') + '] ' + renderSubject(copy.subject, vars);
  const html = renderHtml(copy.bodyHtml, vars);

  const res = await sendExternal({
    from: (c.from_name || cfg.fromName || 'EduRankAI') + ' <' + (c.from_email || cfg.fromAddress) + '>',
    to: allowed,
    subject,
    html,
    replyTo: c.reply_to || undefined,
    logToDb: true,
    headers: { 'X-ERA-Stream': 'campaign-test', 'X-ERA-Campaign': id, 'Precedence': 'bulk' },
  });

  if (!res.ok) return json({ ok: false, error: 'The test did not send: ' + (res.error || 'unknown error') }, 502);
  return json({
    ok: true,
    sentTo: allowed,
    refused,
    note: refused.length ? refused.join(', ') + ' were not sent to — test sends stay inside the organisation.' : undefined,
  });
}
