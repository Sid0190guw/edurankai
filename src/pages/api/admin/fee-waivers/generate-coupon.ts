// POST /api/admin/fee-waivers/generate-coupon
// Mint a single-use fee-waiver coupon code. Optionally bind it to a specific
// user, intent, and/or post it directly into a thread or send it by email.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { generateCoupon } from '@/lib/fee-waiver-coupons';
import { postMessage } from '@/lib/request-threads';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const waiverId: string | null = body.waiverId || null;
  const directUserId: string | null = body.userId || null;
  const directIntentId: string | null = body.intentId || null;
  const reason = (body.reason || '').toString().trim() || null;
  const maxUses = Number(body.maxUses || 1);
  const expiresInDays = Number(body.expiresInDays || 30);
  const postToThread = body.postToThread !== false;
  const sendEmail = !!body.sendEmail;

  let boundUserId: string | null = directUserId;
  let boundIntentId: string | null = directIntentId;
  let applicantEmail: string | null = null;
  let applicantName: string | null = null;
  if (waiverId) {
    const w = rows(await db.execute(sql`
      SELECT w.user_id, w.intent_id, u.email AS user_email, u.name AS user_name
      FROM application_fee_waivers w JOIN users u ON u.id = w.user_id
      WHERE w.id = ${waiverId} LIMIT 1
    `))[0] as any;
    if (!w) return json({ ok: false, error: 'waiver not found' }, 404);
    boundUserId = w.user_id;
    boundIntentId = w.intent_id;
    applicantEmail = w.user_email;
    applicantName = w.user_name;
  } else if (directUserId) {
    const u = rows(await db.execute(sql`SELECT email, name FROM users WHERE id = ${directUserId} LIMIT 1`))[0] as any;
    if (u) { applicantEmail = u.email; applicantName = u.name; }
  }

  const gen = await generateCoupon({
    createdByUserId: user.id,
    reason,
    boundUserId,
    boundIntentId,
    maxUses: Math.max(1, Math.min(1000, maxUses)),
    expiresInDays: Math.max(1, Math.min(365, expiresInDays)),
  });
  if (!gen.ok || !gen.code) return json({ ok: false, error: gen.error || 'could not mint code' }, 500);

  const msgLines: string[] = [];
  msgLines.push('We have issued you a fee-waiver code to complete your application without paying the application fee.');
  msgLines.push('');
  msgLines.push('Coupon code: ' + gen.code);
  msgLines.push('Expires in ' + Math.max(1, Math.min(365, expiresInDays)) + ' days.');
  msgLines.push('');
  msgLines.push('How to redeem:');
  msgLines.push('1. Open /apply/pay (continue your application).');
  msgLines.push('2. Click "Have a coupon code?" and paste the code above.');
  msgLines.push('3. Submit. Your application will move to review without payment.');
  if (reason) { msgLines.push(''); msgLines.push('Note from the team: ' + reason); }
  const body_text = msgLines.join('\n');

  if (postToThread && waiverId && boundUserId) {
    await postMessage({
      requestType: 'fee_waiver',
      requestId: waiverId,
      applicantUserId: boundUserId,
      senderRole: 'admin',
      senderUserId: user.id,
      senderName: user.name || 'Admissions team',
      body: body_text,
    });
  }

  if (sendEmail && applicantEmail) {
    try {
      const { sendExternal } = await import('@/lib/mail-transport');
      const { getMailConfig } = await import('@/lib/mail');
      const cfg = await getMailConfig();
      const fromName = cfg.fromName || 'EduRankAI Admissions';
      const fromAddr = cfg.fromAddress || 'admissions@edurankai.in';
      const htmlBody = '<p>Hello ' + (applicantName || 'there') + ',</p>'
        + body_text.split('\n').map(l => l ? '<p>' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>' : '').join('')
        + '<p>If you have any questions, reply to this email or to your portal thread.</p>'
        + '<p>EduRankAI Admissions</p>';
      await sendExternal({
        from: fromName + ' <' + fromAddr + '>',
        to: applicantEmail,
        subject: 'EduRankAI - Fee waiver code: ' + gen.code,
        text: 'Hello ' + (applicantName || 'there') + ',\n\n' + body_text + '\n\nIf you have any questions, reply to this email or your portal thread.\n\nEduRankAI Admissions',
        html: htmlBody,
      });
    } catch (_) { /* mail failure is non-fatal — code is still visible to applicant in-thread / on the admin reply */ }
  }

  return json({ ok: true, code: gen.code, id: gen.id });
};
