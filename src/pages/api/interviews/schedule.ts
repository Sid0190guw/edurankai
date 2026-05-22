// src/pages/api/interviews/schedule.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const body = await request.json();
    const { applicationId, roundType, title, scheduledAt, durationMins, interviewerIds, notes } = body;

    if (!applicationId || !title || !scheduledAt) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing required fields' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get application info
    const appResult = await db.execute(sql`
      SELECT first_name, last_name, email, role_title_snapshot
      FROM applications WHERE id = ${applicationId} LIMIT 1
    `);
    const apps = Array.isArray(appResult) ? appResult : (appResult?.rows || []);
    if (apps.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'Application not found' }), { headers: { 'Content-Type': 'application/json' } });
    }
    const app = apps[0] as any;

    // Count existing rounds for round_number
    const countResult = await db.execute(sql`SELECT COUNT(*)::int as c FROM interview_rounds WHERE application_id = ${applicationId}`);
    const counts = Array.isArray(countResult) ? countResult : (countResult?.rows || []);
    const roundNumber = ((counts[0] as any)?.c || 0) + 1;

    // Generate unique Jitsi room
    const roomName = 'edurankai-iv-' + applicationId.substring(0,8) + '-' + Date.now().toString(36);
    const meetingUrl = `https://meet.jit.si/${roomName}#config.prejoinPageEnabled=false&userInfo.displayName="Interviewer"`;

    // Create interview
    const result = await db.execute(sql`
      INSERT INTO interview_rounds
        (application_id, candidate_id, round_number, round_type, title, scheduled_at, duration_mins, interviewer_ids, meeting_url, meeting_room, notes, status)
      VALUES
        (${applicationId}, NULL, ${roundNumber}, ${roundType||'screening'}, ${title}, ${scheduledAt}, ${durationMins||60},
         ${JSON.stringify(interviewerIds||[user.id])}, ${meetingUrl}, ${roomName}, ${notes||null}, 'scheduled')
      RETURNING id
    `);
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    const interviewId = (rows[0] as any)?.id;

    // Find candidate's user account
    const candResult = await db.execute(sql`SELECT id FROM users WHERE email = ${app.email} LIMIT 1`);
    const candRows = Array.isArray(candResult) ? candResult : (candResult?.rows || []);
    if (candRows.length > 0) {
      const candidateId = (candRows[0] as any).id;
      await db.execute(sql`UPDATE interview_rounds SET candidate_id = ${candidateId} WHERE id = ${interviewId}`);

      // Notify candidate
      await db.execute(sql`
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (${candidateId}, 'Interview Scheduled', ${'Your ' + (roundType||'interview') + ' is scheduled. Title: ' + title}, 'system')
      `).catch(()=>{});
    }

    // Log activity
    await db.execute(sql`
      INSERT INTO hiring_activity (application_id, actor_id, activity_type, description, metadata)
      VALUES (${applicationId}, ${user.id}, 'interview_scheduled', ${'Round ' + roundNumber + ' scheduled: ' + title},
        ${JSON.stringify({ interview_id: interviewId, scheduled_at: scheduledAt, type: roundType })})
    `).catch(()=>{});

    return new Response(JSON.stringify({ ok: true, interviewId, meetingUrl, roundNumber }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
