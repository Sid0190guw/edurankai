// POST /api/auth/verify-by-questions
// Two-phase identity verification by knowledge questions for users who can't
// recall their DOB and can't do gov-ID + face match.
//
// Phase 1 (action='get-questions'): { email } -> { questions: [{id,label,type}] }
//   Pulls 5-7 known facts about the user from applications + hr_employees + users.
//   No answers leak to the client.
//
// Phase 2 (action='verify'): { email, answers: { id: value, ... } } ->
//   Computes Levenshtein-ratio per answer, averages across all answered questions,
//   passes at >= 0.80 aggregate. On pass, generates a temp password.
//
// Audit: every attempt logged to `identity_verifications` with verdict + score.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { hashPassword } from '@/lib/auth/password';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

function genTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function normaliseText(s: string): string {
  return (s || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsOnly(s: string): string {
  return (s || '').toString().replace(/[^0-9]/g, '');
}

// Levenshtein distance
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const al = a.length;
  const bl = b.length;
  const v0 = new Array(bl + 1);
  const v1 = new Array(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl];
}

function ratio(a: string, b: string): number {
  const na = normaliseText(a);
  const nb = normaliseText(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(na, nb);
  return Math.max(0, 1 - d / maxLen);
}

type QType = 'text' | 'year' | 'date' | 'number';

interface QSpec {
  id: string;
  label: string;
  type: QType;
  expected: string;     // canonical expected (server-side only)
  weight?: number;      // optional weight, default 1
}

function buildQuestionPool(app: any, emp: any, usr: any): QSpec[] {
  const pool: QSpec[] = [];

  if (app?.first_name) pool.push({ id: 'first_name', label: 'First name on your application', type: 'text', expected: app.first_name });
  if (app?.last_name) pool.push({ id: 'last_name', label: 'Last name on your application', type: 'text', expected: app.last_name });
  if (app?.city) pool.push({ id: 'app_city', label: 'City you listed on your application', type: 'text', expected: app.city });
  if (app?.birth_place) pool.push({ id: 'birth_place', label: 'Place of birth on your application', type: 'text', expected: app.birth_place });
  if (app?.role_title_snapshot) pool.push({ id: 'role_title', label: 'Role title you applied to', type: 'text', expected: app.role_title_snapshot });
  if (app?.field_of_study) pool.push({ id: 'field_of_study', label: 'Field of study on your application', type: 'text', expected: app.field_of_study });
  if (app?.institution) pool.push({ id: 'institution', label: 'Institution / college on your application', type: 'text', expected: app.institution });
  if (app?.duolingo_score != null && app.duolingo_score !== '') pool.push({ id: 'duolingo', label: 'Your Duolingo English Test score', type: 'number', expected: String(app.duolingo_score) });
  if (app?.dob) pool.push({ id: 'app_dob', label: 'Date of birth on your application (YYYY-MM-DD)', type: 'date', expected: typeof app.dob === 'string' ? app.dob.substring(0, 10) : new Date(app.dob).toISOString().substring(0, 10) });

  if (emp?.designation) pool.push({ id: 'designation', label: 'Your designation at EduRankAI', type: 'text', expected: emp.designation });
  if (emp?.employee_code) pool.push({ id: 'employee_code', label: 'Your employee code', type: 'text', expected: emp.employee_code });
  if (emp?.joining_date) pool.push({ id: 'joining_year', label: 'Year you joined EduRankAI', type: 'year', expected: String(new Date(emp.joining_date).getFullYear()) });
  if (emp?.emergency_contact_name) pool.push({ id: 'emergency_contact', label: 'Name of your emergency contact', type: 'text', expected: emp.emergency_contact_name });
  if (emp?.city) pool.push({ id: 'emp_city', label: 'City on your HR record', type: 'text', expected: emp.city });

  if (usr?.created_at) pool.push({ id: 'account_year', label: 'Year your portal account was created', type: 'year', expected: String(new Date(usr.created_at).getFullYear()) });

  return pool;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function scoreAnswer(spec: QSpec, given: string): number {
  if (!given) return 0;
  if (spec.type === 'year' || spec.type === 'number') {
    return digitsOnly(given) === digitsOnly(spec.expected) ? 1 : 0;
  }
  if (spec.type === 'date') {
    return digitsOnly(given) === digitsOnly(spec.expected) ? 1 : 0;
  }
  return ratio(given, spec.expected);
}

async function loadUserContext(email: string) {
  const u = await db.execute(sql`SELECT id, email, name, role, created_at FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
  const uRows = Array.isArray(u) ? u : (u?.rows || []);
  const usr = (uRows[0] as any) || null;
  if (!usr) return { usr: null, app: null, emp: null };

  let app: any = null;
  try {
    const a = await db.execute(sql`SELECT first_name, last_name, city, birth_place, role_title_snapshot, field_of_study, institution, duolingo_score, dob FROM applications WHERE applicant_user_id = ${usr.id} ORDER BY created_at DESC LIMIT 1`);
    const rows = Array.isArray(a) ? a : (a?.rows || []);
    app = rows[0] || null;
  } catch (_) {}

  let emp: any = null;
  try {
    const e = await db.execute(sql`SELECT designation, employee_code, joining_date, emergency_contact_name, city FROM hr_employees WHERE user_id = ${usr.id} LIMIT 1`);
    const rows = Array.isArray(e) ? e : (e?.rows || []);
    emp = rows[0] || null;
  } catch (_) {}

  return { usr, app, emp };
}

async function audit(userId: string | null, verdict: string, score: number, meta: any) {
  try {
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, method, verdict, score, metadata)
      VALUES (${userId}, 'question_set', ${verdict}, ${score}, ${JSON.stringify(meta)}::jsonb)
    `);
  } catch (_) {}
}

export const POST: APIRoute = async ({ request }) => {
  // Small artificial delay against bursts
  await new Promise(r => setTimeout(r, 400));

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = (body?.action || '').toString();
  const email = (body?.email || '').toString().trim().toLowerCase();
  if (!email) return json({ ok: false, error: 'Email required' }, 400);

  try {
    const ctx = await loadUserContext(email);
    if (!ctx.usr) {
      return json({ ok: false, error: 'No account found with that email' }, 404);
    }

    const pool = buildQuestionPool(ctx.app, ctx.emp, ctx.usr);
    if (pool.length < 4) {
      return json({ ok: false, error: 'Not enough data on file to verify by questions. Use the DOB reset or ID + face setup instead.' }, 400);
    }

    if (action === 'get-questions') {
      // Pick 5-7 questions from the pool, randomised
      const count = Math.min(7, Math.max(5, Math.min(pool.length, 6)));
      const chosen = shuffle(pool).slice(0, count);
      const publicQuestions = chosen.map(q => ({ id: q.id, label: q.label, type: q.type }));
      // Store the chosen set in a short-lived HMAC token so the client can't tamper
      const secret = process.env.AUTH_SECRET || process.env.SESSION_SECRET || 'edurankai-default';
      const payload = JSON.stringify({ email, ids: chosen.map(q => q.id), exp: Date.now() + 10 * 60 * 1000 });
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const token = Buffer.from(payload).toString('base64url') + '.' + sig;
      return json({ ok: true, questions: publicQuestions, token });
    }

    if (action === 'verify') {
      const token = (body?.token || '').toString();
      const answers = body?.answers || {};
      if (!token) return json({ ok: false, error: 'Missing question token. Please reload.' }, 400);

      // Validate token
      const secret = process.env.AUTH_SECRET || process.env.SESSION_SECRET || 'edurankai-default';
      const [payloadB64, sig] = token.split('.');
      if (!payloadB64 || !sig) return json({ ok: false, error: 'Invalid token' }, 400);
      let payload: any = null;
      try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return json({ ok: false, error: 'Invalid token' }, 400); }
      const expected = crypto.createHmac('sha256', secret).update(Buffer.from(payloadB64, 'base64url').toString('utf8')).digest('hex');
      if (sig !== expected) return json({ ok: false, error: 'Token tampered' }, 400);
      if (payload.email !== email) return json({ ok: false, error: 'Token email mismatch' }, 400);
      if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return json({ ok: false, error: 'Question set expired. Reload and try again.' }, 400);

      const askedIds: string[] = Array.isArray(payload.ids) ? payload.ids : [];
      const askedSpecs = askedIds.map(id => pool.find(q => q.id === id)).filter(Boolean) as QSpec[];
      if (askedSpecs.length === 0) return json({ ok: false, error: 'No questions matched.' }, 400);

      let total = 0;
      const perQ: { id: string; score: number }[] = [];
      for (const spec of askedSpecs) {
        const given = (answers?.[spec.id] || '').toString();
        const s = scoreAnswer(spec, given);
        perQ.push({ id: spec.id, score: Number(s.toFixed(3)) });
        total += s;
      }
      const aggregate = total / askedSpecs.length;
      const pct = Math.round(aggregate * 100);

      const passed = aggregate >= 0.80;

      if (!passed) {
        await audit(ctx.usr.id, 'rejected', aggregate, { reason: 'below_threshold', perQ, threshold: 0.80 });
        return json({ ok: false, score: pct, threshold: 80, error: 'Verification failed. Your answers scored ' + pct + '%. We need at least 80% to reset your password. Try the gov-ID + face match flow instead.' }, 401);
      }

      // Pass: reset password
      const tempPassword = genTempPassword();
      const hash = await hashPassword(tempPassword);
      await db.execute(sql`UPDATE users SET password_hash = ${hash}, is_active = true, updated_at = NOW() WHERE id = ${ctx.usr.id}`);
      await audit(ctx.usr.id, 'question_verified', aggregate, { perQ, threshold: 0.80 });

      return json({
        ok: true,
        score: pct,
        threshold: 80,
        tempPassword,
        email: ctx.usr.email,
        name: ctx.usr.name,
        message: 'Verified. Use this temporary password to sign in, then change it from your account settings.',
      });
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
