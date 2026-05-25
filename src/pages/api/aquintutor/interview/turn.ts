// POST /api/aquintutor/interview/turn
// Body: { sessionId, transcript, lang, currentSeedIndex, justAnsweredFollowUp? }
// Saves the candidate turn, decides next: follow-up (if vague AND llm available),
// or next seed, or done.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { askFollowUp, isLlmConfigured } from '@/lib/llm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const VAGUE_THRESHOLD_CHARS = 50;
const MAX_FOLLOWUPS_PER_SEED = 1; // single follow-up per seed keeps interviews snappy

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const sessionId = (body?.sessionId || '').toString();
  const transcript = (body?.transcript || '').toString().trim().slice(0, 8000);
  const lang = (body?.lang || 'en-IN').toString().slice(0, 20);
  const currentSeedIndex = parseInt((body?.currentSeedIndex ?? 0).toString(), 10) || 0;
  const justAnsweredFollowUp = !!body?.justAnsweredFollowUp;

  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  if (!transcript) return json({ ok: false, error: 'transcript required' }, 400);

  try {
    const s = await db.execute(sql`
      SELECT id, template_id, language, status FROM ai_interview_sessions WHERE id = ${sessionId} LIMIT 1
    `);
    const sRows = Array.isArray(s) ? s : (s?.rows || []);
    if (sRows.length === 0) return json({ ok: false, error: 'Session not found' }, 404);
    const session = sRows[0] as any;
    if (session.status !== 'in_progress') return json({ ok: false, error: 'Session already ended' }, 410);

    // Get the next turn_index
    const lastR = await db.execute(sql`SELECT COALESCE(MAX(turn_index), -1)::int as max_idx FROM ai_interview_transcript WHERE session_id = ${sessionId}`);
    const lastRows = Array.isArray(lastR) ? lastR : (lastR?.rows || []);
    const candidateTurnIndex = ((lastRows[0] as any)?.max_idx ?? -1) + 1;

    // Save candidate's turn
    await db.execute(sql`
      INSERT INTO ai_interview_transcript (session_id, turn_index, role, text, lang, is_follow_up, client_ts)
      VALUES (${sessionId}, ${candidateTurnIndex}, 'candidate', ${transcript}, ${lang}, ${justAnsweredFollowUp}, NOW())
    `);

    // Load seeds
    const seedsR = await db.execute(sql`
      SELECT id, prompt_text, expected_topics, sort_order
      FROM ai_interview_seeds WHERE template_id = ${session.template_id} AND is_active = true
      ORDER BY sort_order ASC, created_at ASC
    `);
    const seeds = (Array.isArray(seedsR) ? seedsR : (seedsR?.rows || [])) as any[];

    const justAnsweredSeed = seeds[currentSeedIndex];
    const isAnswerVague = transcript.length < VAGUE_THRESHOLD_CHARS;

    // Try one follow-up if: just answered a seed (not a follow-up itself), answer is vague, llm configured, under cap
    if (!justAnsweredFollowUp && justAnsweredSeed && isAnswerVague && isLlmConfigured()) {
      // Count prior follow-ups for this seed by looking at how many recent 'ai' turns have is_follow_up=true after the last seed
      const followText = await askFollowUp({
        seed: justAnsweredSeed.prompt_text,
        candidateAnswer: transcript,
        lang,
        contextTurns: [],
      });
      if (followText) {
        const nextIdx = candidateTurnIndex + 1;
        await db.execute(sql`
          INSERT INTO ai_interview_transcript (session_id, turn_index, role, text, lang, is_follow_up, client_ts)
          VALUES (${sessionId}, ${nextIdx}, 'ai', ${followText}, ${lang}, true, NOW())
        `);
        return json({
          ok: true,
          next: { text: followText, lang, isFollowUp: true, turnIndex: nextIdx },
          currentSeedIndex,
          done: false,
        });
      }
    }

    // Move to next seed
    const nextSeedIdx = currentSeedIndex + 1;
    if (nextSeedIdx < seeds.length) {
      const nextSeed = seeds[nextSeedIdx] as any;
      const nextIdx = candidateTurnIndex + 1;
      await db.execute(sql`
        INSERT INTO ai_interview_transcript (session_id, turn_index, role, text, lang, is_follow_up, client_ts)
        VALUES (${sessionId}, ${nextIdx}, 'ai', ${nextSeed.prompt_text}, ${lang}, false, NOW())
      `);
      return json({
        ok: true,
        next: { text: nextSeed.prompt_text, lang, isFollowUp: false, turnIndex: nextIdx },
        currentSeedIndex: nextSeedIdx,
        done: false,
      });
    }

    // No more seeds - done
    return json({ ok: true, done: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
