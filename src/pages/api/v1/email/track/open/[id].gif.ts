// GET /api/v1/email/track/open/<messageId>.gif?s=<signature> — the open pixel.
//
// PUBLIC BY NECESSITY: the caller is the recipient's mail client, which has no API key. The signature
// is what stands in for one. Without it this URL is a counter anybody can increment by guessing a
// message id, and open rates would be fiction.
//
// IT ALWAYS RETURNS THE PIXEL. A bad signature, an unknown message, a database that is down — the
// response is the same 35-byte transparent GIF, because a broken image icon in a recipient's mail is
// a worse outcome than a missing statistic, and because a differing response would let someone probe
// which message ids exist.
//
// Opens are opt-in per send (`options.track_opens`). Nothing is injected unless a caller asked for it.
import type { APIRoute } from 'astro';
import { verifyParts } from '@/lib/mailapi/tracking';
import { recordEventById } from '@/lib/mailapi/messages';

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const HEADERS: Record<string, string> = {
  'Content-Type': 'image/gif',
  'Content-Length': String(GIF.length),
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
};

const SECRET = String(process.env.MAILAPI_TRACK_SECRET || process.env.SESSION_SECRET || '').trim();

export const GET: APIRoute = async ({ params, url, request, clientAddress }) => {
  const pixel = () => new Response(GIF, { status: 200, headers: HEADERS });
  const id = String(params.id || '').replace(/\.gif$/i, '').trim();
  const sig = url.searchParams.get('s') || '';
  if (!SECRET || !id || !verifyParts(SECRET, sig, 'open', id)) return pixel();

  const ua = (request.headers.get('user-agent') || '').slice(0, 300);
  const ip = (request.headers.get('x-forwarded-for') || clientAddress || '').toString().split(',')[0].trim().slice(0, 64);

  // Awaited, not fire-and-forget: on a serverless runtime the instance can be frozen the moment the
  // response is returned, and a floating promise is then a write that silently never happens. The
  // work is one insert and one event queue, and the pixel is returned either way.
  try {
    await recordEventById(id, 'email.opened', {
      data: { user_agent: ua, ip: ip || null },
      dedupeWindowSec: 60,
    });
  } catch (e: any) {
    console.error('[mailapi] open tracking failed for ' + id + ':', e?.cause?.message || e?.message);
  }
  return pixel();
};
