// GET /api/mail/c/open?r=<recipientId> — the campaign open pixel.
//
// ALWAYS RETURNS THE GIF. A tracking failure must never leave a broken-image box in somebody's mail;
// every error path below still answers 200 with the pixel and logs the reason server-side.
//
// WHAT AN OPEN ACTUALLY MEANS, because the dashboard should not overstate it: this fires when a mail
// client loads remote images. Clients that block images by default (Outlook's default, Apple Mail
// Privacy Protection in the other direction, which PRE-loads them) make this an approximation, not a
// count of people who read the message. docs/mail-campaigns.md states that where the number is read.
import type { APIRoute } from 'astro';
import { recipientForTracking, recordCampaignEvent } from '@/lib/mail-campaigns';
import { touchActivity, dbReason } from '@/lib/mail-contacts';

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

function pixel(): Response {
  return new Response(GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    },
  });
}

export const GET: APIRoute = async ({ url, request, clientAddress }) => {
  const recipientId = url.searchParams.get('r') || '';
  try {
    const rec = await recipientForTracking(recipientId);
    if (rec) {
      await recordCampaignEvent({
        campaignId: rec.campaignId,
        recipientId,
        contactId: rec.contactId,
        email: rec.email,
        kind: 'opened',
        variant: rec.variant,
        ip: clientAddress || request.headers.get('x-forwarded-for') || null,
        userAgent: request.headers.get('user-agent') || null,
      });
      await touchActivity([rec.email]);
    }
  } catch (e: any) {
    console.error('[api/mail/c/open] could not record an open:', dbReason(e));
  }
  return pixel();
};
