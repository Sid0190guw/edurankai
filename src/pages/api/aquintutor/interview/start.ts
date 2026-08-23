// POST /api/aquintutor/interview/start
// Body: { templateSlug, candidateName?, candidateEmail?, language? }
// Creates a session and returns the first seed question.
// Auth optional; if signed in, candidate_id is linked.
//
// THIS IS WHERE THE SESSION IS BOUND TO THE BROWSER THAT ASKED FOR IT. bindSession() sets an
// HttpOnly signature over the new session id, and the five writers under this folder require it
// back — without it, possession of a sessionId string was the whole credential for overwriting a
// candidate's face reference, their ID document and their proctoring record. See
// src/lib/aquin/interview-session.ts. Sign-in is still not required and candidate_id is still
// optional: the binding is to the browser, not to an account.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { bindSession } from '@/lib/aquin/interview-session';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals, clientAddress, cookies }) => {
  const user = (locals as any)?.user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const templateSlug = (body?.templateSlug || '').toString().trim();
  const candidateName = (body?.candidateName || user?.name || '').toString().trim().slice(0, 200);
  const candidateEmail = (body?.candidateEmail || user?.email || '').toString().trim().slice(0, 255).toLowerCase();
  const requestedLang = (body?.language || '').toString().trim().slice(0, 20);

  if (!templateSlug) return json({ ok: false, error: 'templateSlug required' }, 400);

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    const t = await db.execute(sql`
      SELECT id, slug, title, language_default, max_minutes, is_published,
        COALESCE(proctor_level, 'standard') AS proctor_level,
        COALESCE(require_face_enroll, true) AS require_face_enroll,
        COALESCE(block_tab_switch, true) AS block_tab_switch,
        COALESCE(max_tab_switches, 3) AS max_tab_switches,
        COALESCE(max_strikes, 5) AS max_strikes,
        COALESCE(require_fullscreen, false) AS require_fullscreen,
        COALESCE(enable_object_detection, false) AS enable_object_detection,
        COALESCE(allow_paste, false) AS allow_paste
      FROM ai_interview_templates WHERE slug = ${templateSlug} LIMIT 1
    `);
    const tRows = Array.isArray(t) ? t : (t?.rows || []);
    if (tRows.length === 0) return json({ ok: false, error: 'Interview not found' }, 404);
    const template = tRows[0] as any;
    if (!template.is_published) return json({ ok: false, error: 'Interview is not yet published' }, 403);

    const seedsR = await db.execute(sql`
      SELECT id, prompt_text, expected_topics, sort_order
      FROM ai_interview_seeds WHERE template_id = ${template.id} AND is_active = true
      ORDER BY sort_order ASC, created_at ASC
    `);
    const seeds = Array.isArray(seedsR) ? seedsR : (seedsR?.rows || []);
    if (seeds.length === 0) return json({ ok: false, error: 'No questions configured for this interview yet.' }, 503);

    const lang = requestedLang || template.language_default || 'en-IN';

    const ins = await db.execute(sql`
      INSERT INTO ai_interview_sessions (
        template_id, candidate_id, candidate_name, candidate_email, language,
        status, user_agent, ip_address
      ) VALUES (
        ${template.id}, ${user?.id || null}, ${candidateName || null}, ${candidateEmail || null}, ${lang},
        'in_progress', ${ua}, ${ip || null}
      ) RETURNING id, started_at
    `);
    const insRows = Array.isArray(ins) ? ins : (ins?.rows || []);
    const session = insRows[0] as any;

    // Bound BEFORE the first turn is written, so there is no window in which a session exists that
    // nothing can prove ownership of. A deployment with no SESSION_SECRET cannot sign, and the
    // writers refuse rather than accept an unsigned caller — so the interview is stopped here, with
    // a sentence, instead of at the first upload.
    if (!bindSession(cookies, session.id)) {
      console.error('[interview/start] could not bind session', session.id, '- SESSION_SECRET is missing or the cookie could not be set');
      await db.execute(sql`UPDATE ai_interview_sessions SET status = 'abandoned', ended_at = NOW() WHERE id = ${session.id}`).catch(() => {});
      return json({ ok: false, error: 'This deployment cannot start an interview right now. Nothing was recorded.' }, 503);
    }

    // First AI turn = first seed
    const firstSeed = seeds[0] as any;
    await db.execute(sql`
      INSERT INTO ai_interview_transcript (session_id, turn_index, role, text, lang, is_follow_up, client_ts)
      VALUES (${session.id}, 0, 'ai', ${firstSeed.prompt_text}, ${lang}, false, NOW())
    `).catch(() => {});

    return json({
      ok: true,
      sessionId: session.id,
      lang,
      totalSeeds: seeds.length,
      currentSeedIndex: 0,
      question: {
        text: firstSeed.prompt_text,
        lang,
        isFollowUp: false,
        turnIndex: 0,
      },
      maxMinutes: template.max_minutes || 30,
      title: template.title,
      proctor: {
        level: template.proctor_level,
        requireFaceEnroll: !!template.require_face_enroll,
        blockTabSwitch: !!template.block_tab_switch,
        maxTabSwitches: template.max_tab_switches,
        maxStrikes: template.max_strikes,
        requireFullscreen: !!template.require_fullscreen,
        enableObjectDetection: !!template.enable_object_detection,
        allowPaste: !!template.allow_paste,
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
