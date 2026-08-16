// GET /api/mail/c/click?r=<recipientId>&l=<linkId> — the campaign click tracker.
//
// NOT AN OPEN REDIRECT, AND THAT IS THE WHOLE POINT OF THE `l` PARAMETER. The destination is looked
// up by id from mail_campaign_links, where it was written when the message was rendered. A tracker
// that takes the URL from the query string — the obvious design — turns edurankai.in into a
// redirector anyone can point at a phishing page and send from their own mail, borrowing our domain's
// reputation. There is no arrangement of signing that is simpler than just not accepting the URL.
//
// A LINK THAT CANNOT BE TRACKED STILL WORKS WHERE IT SAFELY CAN. If the recipient row is gone but
// the link id resolves, we still redirect (untracked) rather than showing an error — the reader
// wanted the page, not our analytics. If neither resolves there is nowhere honest to send them, so
// they get the site's front page and a note, never a guessed destination.
import type { APIRoute } from 'astro';
import { resolveClick, linkDestination, recordCampaignEvent, SITE_BASE } from '@/lib/mail-campaigns';
import { touchActivity, dbReason } from '@/lib/mail-contacts';

export const GET: APIRoute = async ({ url, request, clientAddress }) => {
  const recipientId = url.searchParams.get('r') || '';
  const linkId = url.searchParams.get('l') || '';

  try {
    const hit = await resolveClick(recipientId, linkId);
    if (hit) {
      await recordCampaignEvent({
        campaignId: hit.campaignId,
        recipientId,
        contactId: hit.contactId,
        email: hit.email,
        kind: 'clicked',
        variant: hit.variant,
        url: hit.url,
        ip: clientAddress || request.headers.get('x-forwarded-for') || null,
        userAgent: request.headers.get('user-agent') || null,
      });
      await touchActivity([hit.email]);
      return new Response(null, { status: 302, headers: { Location: hit.url, 'cache-control': 'no-store' } });
    }
    const fallback = await linkDestination(linkId);
    if (fallback) {
      return new Response(null, { status: 302, headers: { Location: fallback, 'cache-control': 'no-store' } });
    }
  } catch (e: any) {
    // A tracking failure must not swallow the reader's click; log and fall through.
    console.error('[api/mail/c/click] could not record a click:', dbReason(e));
  }

  return new Response(null, { status: 302, headers: { Location: SITE_BASE + '/', 'cache-control': 'no-store' } });
};
