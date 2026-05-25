// POST /api/aquintutor/tutor
// Course-aware AI tutor. Streams a Claude response grounded in the course
// metadata (title, subtitle, school, department, syllabus modules).
// Body: { courseSlug, messages: [{ role, content }] }
// Returns: { ok, reply } - non-streaming for simplicity in v1.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: 'AI tutor is not configured yet. The admin needs to set ANTHROPIC_API_KEY.' }, 503);
  }

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const courseSlug = (body?.courseSlug || '').toString();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!courseSlug) return json({ ok: false, error: 'courseSlug required' }, 400);
  if (messages.length === 0) return json({ ok: false, error: 'messages required' }, 400);

  try {
    // Fetch course context
    const c = await db.execute(sql`
      SELECT c.id, c.slug, c.title, c.subtitle, c.short_desc, c.description, c.level,
        c.course_code, c.duration_weeks, c.credit_hours,
        s.name as school_name, d.name as department_name
      FROM training_courses c
      LEFT JOIN schools s ON c.school_id = s.id
      LEFT JOIN academic_departments d ON c.department_id = d.id
      WHERE c.slug = ${courseSlug} LIMIT 1
    `);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    if (cRows.length === 0) return json({ ok: false, error: 'Course not found' }, 404);
    const course = cRows[0] as any;

    // Module list for syllabus context
    let modulesText = '';
    try {
      const m = await db.execute(sql`SELECT title, description FROM training_modules WHERE course_id = ${course.id} ORDER BY sort_order ASC LIMIT 20`);
      const mods = (Array.isArray(m) ? m : (m?.rows || [])) as any[];
      if (mods.length > 0) {
        modulesText = '\n\nThe syllabus modules are:\n' + mods.map((mod, i) => '  ' + (i + 1) + '. ' + mod.title + (mod.description ? ' - ' + mod.description : '')).join('\n');
      }
    } catch (_) {}

    const user = (locals as any)?.user;
    const studentName = user?.name || 'the student';

    const system = `You are the AquinTutor AI Tutor for the course "${course.title}"${course.course_code ? ' (' + course.course_code + ')' : ''}.

About this course:
- School: ${course.school_name || 'AquinTutor'}
- Department: ${course.department_name || 'General'}
- Level: ${course.level || 'beginner'}
- Subtitle: ${course.subtitle || course.short_desc || ''}
- Description: ${course.description || course.short_desc || 'A course in ' + course.title + '.'}${modulesText}

Your role:
- You are a patient, encouraging, intellectually serious tutor.
- You answer in the context of this specific course. If a question is unrelated to the course, gently bring it back.
- Use concrete examples from the syllabus where possible.
- Encourage the student to think before you give the full answer - ask a clarifying question first when their answer is short or vague.
- Keep replies focused (2-5 paragraphs typical). Use bullets for lists.
- If you genuinely don't know something, say so. Never invent citations or facts.
- The student you are talking with is ${studentName}.

Tone: warm, precise, never condescending. Address the student as if you were a faculty member who is glad they came to office hours.`;

    // Trim message history to last 16 turns
    const trimmed = messages.slice(-16).map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: (m.content || '').toString().slice(0, 8000),
    }));

    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system,
        messages: trimmed,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      console.error('tutor: claude api error', resp.status, err);
      return json({ ok: false, error: 'AI tutor temporarily unavailable.' }, 502);
    }
    const data = await resp.json() as any;
    const reply = (data?.content?.[0]?.text || '').trim() || 'Sorry, no response generated.';
    return json({ ok: true, reply });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
