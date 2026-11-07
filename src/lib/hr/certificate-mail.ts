// EMAIL ONE ISSUED CERTIFICATE. Shared by the certificate desk and the completion engine, so an
// automatically issued certificate arrives exactly as a hand-issued one does.
import { sendLetterEmail } from '@/lib/hr/letter-mail';
import { certificateHtml, certificateFromRecord } from '@/lib/hr/brand-doc';
import { publicUrl } from '@/lib/public-origin';

export const DEFAULT_CERTIFICATE_NOTE = [
  '<p>Dear {{name}},</p>',
  '<p>Congratulations. It gives us real pleasure to send you your certificate for <strong>{{role}}</strong>.</p>',
  '<p>It is below, and anyone can verify it at the link underneath it &mdash; add it to your professional profile, or share the link with a university or an employer.</p>',
  '<p>Thank you for everything you built with us. We are proud of you, and we look forward to hearing what you do next.</p>',
  '<p>{{signatory}}<br/>EduRankAI</p>',
].join('');

const isoDay = (v: any): string => {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
};

/** Never throws. Answers a sentence for whoever (or whatever) asked. */
export async function emailUniversalCertificate(
  row: any, to: string, noteHtml: string, actorUserId: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (!row) return { ok: false, message: 'That certificate could not be found, so nothing was sent.' };
  if (row.revoked) return { ok: false, message: 'That certificate is revoked, so it was not sent.' };
  const verifyUrl = publicUrl('/credentials/' + encodeURIComponent(String(row.serial)));
  const out = await sendLetterEmail({
    actorUserId,
    typeKey: 'certificate:certificate',
    noteHtml: noteHtml || DEFAULT_CERTIFICATE_NOTE,
    letterHtml: certificateHtml(certificateFromRecord(row, verifyUrl)),
    ctx: {
      recipientName: String(row.recipient_name || ''),
      recipientEmail: to,
      roleTitle: String(row.title || ''),
      refNumber: String(row.serial || ''),
      issueDate: isoDay(row.signed_at),
      signatoryName: String(row.issued_by_name || ''),
      signatoryTitle: String(row.issued_by_designation || ''),
      letterUrl: verifyUrl,
    },
  });
  return { ok: out.sent, message: out.message };
}
