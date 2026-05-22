// src/pages/api/certificates/email.ts
// Sends certificate link via email when completed
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const body = await request.json();
    const { certificateNumber } = body;
    if (!certificateNumber) return new Response(JSON.stringify({ ok: false, error: 'Missing certificate number' }), { headers: { 'Content-Type': 'application/json' } });

    // Get certificate details
    const r = await db.execute(sql`
      SELECT c.*, u.name as user_name, u.email as user_email,
        co.title as course_title, co.instructor_name
      FROM training_certificates c
      JOIN users u ON c.user_id = u.id
      JOIN training_courses co ON c.course_id = co.id
      WHERE c.certificate_number = ${certificateNumber} AND c.user_id = ${user.id}
      LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length === 0) return new Response(JSON.stringify({ ok: false, error: 'Certificate not found' }), { headers: { 'Content-Type': 'application/json' } });

    const cert = rows[0] as any;
    const certUrl = `https://www.edurankai.in/portal/certificate/${certificateNumber}`;
    const issuedDate = new Date(cert.issued_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    // Send via SMTP if configured, else log
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      // Full SMTP send
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      await transporter.sendMail({
        from: `"EduRankAI" <${process.env.SMTP_FROM || 'noreply@edurankai.in'}>`,
        to: cert.user_email,
        subject: `Your Certificate: ${cert.course_title}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;background:#f8f6f1;">
            <div style="background:#0f0f14;border-radius:12px;padding:28px;text-align:center;margin-bottom:20px;">
              <p style="font-size:22px;font-weight:900;color:#fff;margin:0 0 4px;">EduRank<span style="color:#FF4F00;">AI</span></p>
              <p style="font-size:12px;color:#6e6e78;margin:0;">Certificate of Completion</p>
            </div>
            <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;">
              <p style="font-size:16px;font-weight:700;color:#111;margin:0 0 8px;">Congratulations, ${cert.user_name}!</p>
              <p style="font-size:14px;color:#374151;margin:0 0 16px;">You have successfully completed:</p>
              <div style="background:#f8f6f1;border-radius:8px;padding:16px;margin-bottom:16px;">
                <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 4px;">${cert.course_title}</p>
                ${cert.instructor_name ? `<p style="font-size:13px;color:#6b7280;margin:0;">by ${cert.instructor_name}</p>` : ''}
              </div>
              <p style="font-size:13px;color:#6b7280;margin:0 0 20px;">Issued: ${issuedDate} - Certificate #${certificateNumber}</p>
              <a href="${certUrl}" style="display:block;background:#FF4F00;color:#fff;text-align:center;text-decoration:none;font-size:14px;font-weight:700;padding:13px;border-radius:8px;">View & Download Certificate</a>
            </div>
            <p style="font-size:12px;color:#9ca3af;text-align:center;margin:0;">EduRankAI - The Truth Report on Universities</p>
          </div>
        `
      });
    }

    // Always notify via in-app notification
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type)
      VALUES (${user.id}, 'Certificate Issued', ${'Your certificate for ' + cert.course_title + ' is ready. Certificate #' + certificateNumber}, 'system')
    `).catch(() => {});

    return new Response(JSON.stringify({ ok: true, email: cert.user_email }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
