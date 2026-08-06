// POST /api/auth/verify-by-questions
// Knowledge-based recovery for users who cannot recall their DOB and cannot do gov-ID + face match.
//
//   { action:'get-questions', email }                  -> { questions:[{id,label,type}], token }
//   { action:'verify', email, token, answers:{id:val} } -> { ok, message }   (never a score)
//
// WHAT WAS WRONG WITH IT, precisely, because the shape recurs.
//
//   1. IT WAS A PER-FACT ORACLE. The failure branch returned `score` — the aggregate over the
//      questions asked. Answer exactly ONE field and leave the rest blank and that aggregate is
//      s/N: the score of that single answer, isolated. So place of birth, employee code, emergency
//      contact and joining year could each be brute-forced independently, one probe at a time,
//      until the combination cleared 0.80. A grading number returned to an unauthenticated caller
//      IS the secret, delivered slowly.
//   2. IT RETURNED A CREDENTIAL. On passing it overwrote users.password_hash and handed back the
//      plaintext temp password. Unauthenticated, for any account.
//   3. THE QUESTION TOKEN WAS NOT A TOKEN. It was an HMAC over a JSON payload, reusable for ten
//      minutes, and the signing secret fell back to the literal 'edurankai-default' when neither
//      AUTH_SECRET nor SESSION_SECRET was set — a secret in the repository is not a secret.
//   4. NO RATE LIMIT. A 400 ms sleep inside one serverless invocation limits nothing between
//      requests.
//
// WHAT IT DOES NOW.
//   - The question set is a row in auth_recovery_challenge: a random token, hashed at rest,
//     single-use, expiring, bound to one user and to this purpose. No shared secret is involved, so
//     there is no fallback literal to get wrong.
//   - The verdict is pass or fail. No score, no per-question breakdown, no threshold echoed back —
//     nothing that varies with how close an answer was.
//   - A pass mails a one-time reset link (src/lib/auth/recovery.ts). It never writes a password and
//     never returns one.
//   - Every attempt spends from the shared Postgres attempt limiter, per account and per IP, and
//     the challenge itself is burned on the first verify whatever the outcome — one question set,
//     one answer.
//   - Unknown account and thin-record answer the same way an ordinary failure does.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import {
  overRecoveryLimit, clearRecoveryLimit, issueAndMailReset, RECOVERY_TTL_MINUTES, causeOf,
} from '@/lib/auth/recovery';

export const prerender = false;

// ── declared before every handler that reads them: `const` is not hoisted ────
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

/** Aggregate accuracy required. Unchanged from the value the flow already enforced. */
const PASS_THRESHOLD = 0.80;
/** How long a question set stays answerable. */
const CHALLENGE_TTL_MINUTES = 10;

/**
 * The SAME text for: unknown account, too few facts on file, wrong answers, expired question set.
 * A recovery surface that distinguishes these is an account-enumeration tool.
 */
const UNIFORM_FAIL = 'We could not verify you from those answers. Try the government-ID and face match instead, or email hr@edurankai.in and a person will help.';
const UNIFORM_OK = 'If your answers matched, a one-time reset link is on its way to the email address on that account. It expires in ' + RECOVERY_TTL_MINUTES + ' minutes.';

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
  return Math.max(0, 1 - levenshtein(na, nb) / maxLen);
}

type QType = 'text' | 'year' | 'date' | 'number';

interface QSpec {
  id: string;
  label: string;
  type: QType;
  expected: string;   // server-side only; never serialised to the client
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
  if (spec.type === 'year' || spec.type === 'number' || spec.type === 'date') {
    return digitsOnly(given) === digitsOnly(spec.expected) ? 1 : 0;
  }
  return ratio(given, spec.expected);
}

async function loadUserContext(email: string) {
  const u = await db.execute(sql`SELECT id, email, name, role, created_at FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
  const usr = (rowsOf(u)[0] as any) || null;
  if (!usr) return { usr: null, app: null, emp: null };

  let app: any = null;
  try {
    const a = await db.execute(sql`SELECT first_name, last_name, city, birth_place, role_title_snapshot, field_of_study, institution, duolingo_score, dob FROM applications WHERE applicant_user_id = ${usr.id} ORDER BY created_at DESC LIMIT 1`);
    app = rowsOf(a)[0] || null;
  } catch (e: any) { console.error('[verify-by-questions] applications', causeOf(e)); }

  let emp: any = null;
  try {
    const e = await db.execute(sql`SELECT designation, employee_code, joining_date, emergency_contact_name, city FROM hr_employees WHERE user_id = ${usr.id} LIMIT 1`);
    emp = rowsOf(e)[0] || null;
  } catch (e: any) { console.error('[verify-by-questions] hr_employees', causeOf(e)); }

  return { usr, app, emp };
}

// ── challenge storage: a real token, not a signed blob ──────────────────────
let ensured = false;
async function ensureChallengeSchema(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS auth_recovery_challenge (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL,
    purpose text NOT NULL,
    question_ids jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_recovery_challenge_expiry_idx ON auth_recovery_challenge(expires_at)`);
  ensured = true;
}

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

async function issueChallenge(userId: string, ids: string[]): Promise<string> {
  await ensureChallengeSchema();
  const token = randomBytes(32).toString('base64url');
  await db.execute(sql`
    DELETE FROM auth_recovery_challenge
    WHERE (user_id = ${userId} AND consumed_at IS NULL) OR expires_at < now()
  `).catch(() => {});
  await db.execute(sql`
    INSERT INTO auth_recovery_challenge (token_hash, user_id, purpose, question_ids, expires_at)
    VALUES (${hashToken(token)}, ${userId}, 'question-set', ${JSON.stringify(ids)}::jsonb,
            now() + make_interval(mins => ${CHALLENGE_TTL_MINUTES}))
  `);
  return token;
}

/**
 * Burn the challenge and return the question ids it named. Single-use: the UPDATE matches only while
 * consumed_at IS NULL, so the set cannot be answered twice and a per-answer probe cannot be repeated
 * against the same questions.
 */
async function consumeChallenge(token: string, userId: string): Promise<string[] | null> {
  if (!token) return null;
  await ensureChallengeSchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE auth_recovery_challenge SET consumed_at = now()
    WHERE token_hash = ${hashToken(token)}
      AND user_id = ${userId}
      AND purpose = 'question-set'
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING question_ids
  `));
  const r = rows[0];
  if (!r) return null;
  const raw = (r as any).question_ids;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

async function audit(userId: string | null, verdict: string, meta: any) {
  try {
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, method, verdict, metadata)
      VALUES (${userId}, 'question_set', ${verdict}, ${JSON.stringify(meta)}::jsonb)
    `);
  } catch (e: any) {
    // Not swallowed silently: an unrecorded recovery attempt is the row an investigation needs.
    console.error('[verify-by-questions] audit', causeOf(e));
  }
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = (body?.action || '').toString();
  const email = (body?.email || '').toString().trim().toLowerCase();
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);
  if (!email) return json({ ok: false, error: 'Email required' }, 400);

  // Spend from the allowance before any lookup, on BOTH actions — otherwise the question-issuing
  // half is a free enumeration and probing loop.
  const limit = await overRecoveryLimit(email, ip, 'password-reset');
  if (limit.blocked) {
    return json({
      ok: false,
      error: 'Too many recovery attempts. Wait an hour and try again, or email hr@edurankai.in to recover manually.',
    }, 429);
  }

  try {
    const ctx = await loadUserContext(email);
    const pool = ctx.usr ? buildQuestionPool(ctx.app, ctx.emp, ctx.usr) : [];
    // Unknown account, or too little on file to ask about: answered like any other failure so the
    // two cannot be told apart. The old code returned distinct 404 / 400 texts here.
    const usable = !!ctx.usr && pool.length >= 4;

    if (action === 'get-questions') {
      if (!usable) return json({ ok: false, error: UNIFORM_FAIL }, 400);
      const count = Math.min(7, Math.max(5, Math.min(pool.length, 6)));
      const chosen = shuffle(pool).slice(0, count);
      const token = await issueChallenge(String(ctx.usr.id), chosen.map(q => q.id));
      return json({
        ok: true,
        token,
        questions: chosen.map(q => ({ id: q.id, label: q.label, type: q.type })),
      });
    }

    if (action === 'verify') {
      const token = (body?.token || '').toString();
      const answers = body?.answers || {};
      if (!usable || !token) return json({ ok: false, error: UNIFORM_FAIL }, 401);

      // Burned first, before any answer is looked at. Whatever happens below, this question set is
      // spent — that is what stops one set being replayed field by field.
      const askedIds = await consumeChallenge(token, String(ctx.usr.id));
      if (!askedIds || askedIds.length === 0) return json({ ok: false, error: UNIFORM_FAIL }, 401);

      const askedSpecs = askedIds.map(id => pool.find(q => q.id === id)).filter(Boolean) as QSpec[];
      if (askedSpecs.length === 0) return json({ ok: false, error: UNIFORM_FAIL }, 401);

      // EVERY question asked counts toward the denominator, answered or not. Leaving fields blank
      // used to shrink nothing — the average was over the asked set — but stating it here keeps the
      // isolation property explicit: a single correct answer can never reach the threshold alone.
      let total = 0;
      for (const spec of askedSpecs) {
        total += scoreAnswer(spec, (answers?.[spec.id] || '').toString());
      }
      const aggregate = total / askedSpecs.length;
      const passed = aggregate >= PASS_THRESHOLD;

      if (!passed) {
        // The score is written to the audit row, where an investigator can see it, and is NOT in the
        // response. That single move is what turns this back from an oracle into a check.
        await audit(String(ctx.usr.id), 'rejected', { reason: 'below_threshold', score: Number(aggregate.toFixed(3)), threshold: PASS_THRESHOLD, asked: askedIds });
        return json({ ok: false, error: UNIFORM_FAIL }, 401);
      }

      const origin = new URL(request.url).origin;
      const outcome = await issueAndMailReset(ctx.usr as any, origin, { ip, method: 'question_set' });
      await audit(String(ctx.usr.id), 'question_verified', { score: Number(aggregate.toFixed(3)), threshold: PASS_THRESHOLD, asked: askedIds, delivery: outcome });

      if (outcome === 'no-address') {
        return json({ ok: false, error: 'That account has no email address on file, so a reset link cannot be delivered. Email hr@edurankai.in to recover it manually.' }, 409);
      }
      if (outcome === 'no-transport') {
        return json({ ok: false, error: 'We could not send the reset email just now. Nothing has changed on your account. Try again shortly, or email hr@edurankai.in.' }, 503);
      }

      await clearRecoveryLimit(email, ip, 'password-reset');
      return json({ ok: true, message: UNIFORM_OK });
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e: any) {
    // Real reason on e.cause, logged not returned.
    console.error('[api/auth/verify-by-questions]', causeOf(e));
    return json({ ok: false, error: 'We could not process that request. Try again shortly.' }, 500);
  }
};
