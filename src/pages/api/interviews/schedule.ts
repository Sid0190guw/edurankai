// src/pages/api/interviews/schedule.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// EXAMINED AND DELIBERATELY NOT CONVERTED. There is no capability whose holders equal the population
// this route admits today, and every candidate key removes somebody:
//
//   TODAY  `!user || user.role === 'applicant'` -> all ten non-applicant built-in roles
//          (super_admin, hr, recruiter, reviewer, department_head, marketing, editor, partner,
//          teacher, technical_moderator), including intern-flagged accounts.
//   applications.edit  -> super_admin, hr, recruiter, department_head. Removes six roles.
//   the 'interviews' ROLE_SECTIONS set -> hr, recruiter, reviewer, department_head. Different again,
//                                         and also a removal.
//   interviews.author  -> exact population, but it means "generate interview questions from a
//                         document" (see its catalogue entry in src/lib/auth/registry.ts).
//                         Borrowing it would make one key mean two powers, so the day somebody
//                         narrows question-generation they would silently narrow scheduling too.
//                         That is precisely the drift this vocabulary exists to prevent.
//
// The governing rule for this sprint is mechanism, not policy: a conversion that gives or removes
// access for any role is reported, not shipped. WHAT IS NEEDED: an `interviews.schedule` key granted
// to the same ten non-applicant roles, added to the Permission union and BUILTIN_PERMISSIONS first
// and verified, after which this line becomes can(user, 'interviews.schedule') with no change in who
// may call it. Reads applications (name, email, role title) and writes interview_rounds.
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
    const candidateName = ((app.first_name || app.firstName || '') + ' ' + (app.last_name || app.lastName || '')).trim() || app.email || 'Candidate';
    const whenText = (() => {
      try { return new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
      catch { return String(scheduledAt); }
    })();

    if (candRows.length > 0) {
      const candidateId = (candRows[0] as any).id;
      await db.execute(sql`UPDATE interview_rounds SET candidate_id = ${candidateId} WHERE id = ${interviewId}`);

      // Notify the candidate. This previously wrote straight into the notifications table with
      // type 'system', which meant: no web push was ever delivered (only a silent in-app row),
      // no category/priority was stored so it rendered as system/medium instead of
      // interviews/critical, and the 2-minute de-dupe in persistNotification was bypassed.
      // sendPushToUser does all of that correctly. Guarded so a push failure can never make a
      // successfully-scheduled interview report ok:false to the caller.
      try {
        const { sendPushToUser } = await import('@/lib/push');
        await sendPushToUser(candidateId, {
          type: 'interview_scheduled',
          title: 'Interview scheduled',
          body: 'Your ' + (roundType || 'interview') + ' is on ' + whenText + '. ' + title,
          url: '/portal/applications/' + applicationId,
          tag: 'interview-' + interviewId,
        });
      } catch (_) {}
    }

    // Tell the rest of the recruiting team, excluding the admin who just scheduled it — they
    // already know. sendPushToAdmins honours per-admin preference toggles.
    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({
        type: 'interview_scheduled',
        title: 'Interview scheduled',
        body: candidateName + ' - round ' + roundNumber + ' (' + (roundType || 'screening') + ') on ' + whenText,
        url: '/admin/applications/' + applicationId,
        tag: 'interview-admin-' + interviewId,
      }, user.id);
    } catch (_) {}

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
