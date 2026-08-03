// POST /api/auth/verify-by-questions
// Two-phase identity verification by knowledge questions for users who can't
// recall their DOB and can't do gov-ID + face match.
//
// Phase 1 (action='get-questions'): { email } -> { questions: [{id,label,type}], token }
//   Facts drawn from applications + hr_employees + users. No answers leak to the client.
//
// Phase 2 (action='verify'): { email, token, answers } -> ONE generic answer, always.
//   Levenshtein-ratio per answer, averaged; passes at >= 0.80 aggregate AND >= 0.50 on EVERY
//   question asked. On a pass a single-use reset link is EMAILED to the address on the account.
//
// WHAT THIS USED TO DO, AND WHY IT CHANGED.
// On a pass this wrote a new password and returned it in the response body, and it is reachable with
// no session at all (src/middleware.ts:117 exempts every /api/ path). The pool it draws from is
// largely public: the role title comes from the CDN-cached /careers catalogue, first and last name
// are just users.name split, city / institution / field of study are ordinary professional facts, and
// the account and joining "years" are single years. Only the employee code, the emergency contact and
// the Duolingo score are genuinely private — and nothing recorded that a question set had been
// issued, so an attacker could re-roll the random draw until those were not in it. Four amplifiers
// made it worse: the failure response returned the aggregate percentage, which let an attacker vary
// one answer at a time and read the ~16.7-point shift to solve the set question by question; there was
// no cap on attempts; the reset set is_active = true, quietly reviving offboarded accounts; and the
// role was selected and never consulted, so a super_admin was recoverable this way.
//
// Changed here, and only this:
//   1. PRIVILEGED ACCOUNTS ARE REFUSED, and the refusal alerts a human while telling the caller
//      nothing (alertAdminOfPrivilegedAttempt).
//   2. THE ORACLE IS GONE. No score, no percentage, no partial credit and no per-question feedback
//      ever reaches the caller. Every phase-2 outcome — passed, failed, unknown address, refused
//      account — is the SAME 200 and the SAME sentence. The numbers stay in the audit row, where the
//      person reviewing an attack can read them and the attacker cannot.
//   3. THE ADDRESS IS NO LONGER CONFIRMED EITHER. Phase 1 used to answer 404 "No account found" for
//      an address that did not exist and a question list for one that did, which told an
//      unauthenticated caller which addresses are real — and, after privileged accounts started being
//      refused, which of those are administrators'. An unusable address now receives a question set
//      too: a stable, plausible decoy drawn from the same labels (decoySet). It cannot be answered,
//      so it fails like any other wrong answer, with the same reply.
//   4. THE SET IS DRAWN ONCE AND HELD (activeQuestionSet). Within QUESTION_SET_TTL_MINUTES the same
//      questions come back however often they are asked, so re-rolling until the draw is answerable —
//      the actual exploit — no longer works. Every request still costs attempt budget.
//   5. SHARED-STATE CEILINGS covering BOTH phases (src/lib/auth/recovery.ts), replacing a per-request
//      setTimeout that cost a concurrent script nothing.
//   6. A PER-QUESTION FLOOR of 0.50 alongside the 0.80 mean, so five public facts can no longer carry
//      one genuinely private one. This is a real behaviour change — see the note at PER_QUESTION_FLOOR.
//   7. THE SECRET IS NO LONGER RETURNED and `is_active = true` is gone. A pass mails a single-use link
//      to the address on file; no password is written by this route at all.
//   8. THE FORM IS CSRF-PROTECTED, and the mail transport is checked before any account is read so a
//      mail outage answers everyone identically instead of becoming a new oracle.
//
// Audit: the verdict goes to `identity_verifications` (which is also where a long-standing silent
// failure was fixed — see audit() below), and every request, refusal, issuance, lockout, token and
// alert goes to auth_recovery_attempts, which is also the shared counter.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  CSRF_REJECTED_MESSAGE,
  GENERIC_RECOVERY_MESSAGE,
  RECOVERY_UNAVAILABLE_MESSAGE,
  activeQuestionSet,
  alertAdminOfPrivilegedAttempt,
  checkRateLimit,
  clientIpOf,
  isPrivilegedAccount,
  issueResetToken,
  recordAttempt,
  recoveryMailReady,
  sendResetLink,
  verifyRecoveryCsrf,
  QUESTION_SET_TTL_MINUTES,
} from '@/lib/auth/recovery';

// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

const ROUTE = 'question_set' as const;

/** The aggregate bar, unchanged. */
const AGGREGATE_THRESHOLD = 0.80;
/**
 * The per-question floor, new.
 *
 * With six questions the old mean-only rule passed at 0.833 on five exact answers and a sixth left
 * blank — so the five facts an attacker can look up carried the one they could not. Requiring every
 * question asked to clear 0.50 removes that. It is generous against the Levenshtein ratio used for
 * text: a typo or two in "Bangalore" still scores well above 0.5, and only a blank or a genuinely
 * different answer falls below it.
 *
 * IT WILL REFUSE SOME HONEST PEOPLE — someone who truly cannot remember their Duolingo score now
 * fails where they used to pass. They are not stranded: /forgot-password (date of birth) and
 * /identity-setup (government ID plus a live selfie, with human review) both remain, and both are
 * named on the page.
 */
const PER_QUESTION_FLOOR = 0.50;

/** Fewest real facts on file before this method is worth offering at all. */
const MIN_POOL = 4;
/** Most questions in one set. */
const MAX_QUESTIONS = 6;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * The single non-committal answer for every phase-2 outcome, and for anything in phase 1 that would
 * otherwise say whether an address is real. Identical to the one /api/auth/forgot-password returns,
 * on purpose: two endpoints that answer differently for the same address are together an oracle even
 * when neither is one alone.
 */
function genericAnswer() {
  return json({ ok: true, sent: true, generic: true, message: GENERIC_RECOVERY_MESSAGE });
}

/**
 * The HMAC key for the question-set token, with the committed literal it has always fallen back to.
 *
 * THE FALLBACK IS DELIBERATELY STILL HERE. If production is in fact running on it, hard-failing when
 * AUTH_SECRET is unset would turn a weakness into an outage of the recovery flow on the deploy that
 * shipped the fix — and this project has taken a lockout outage twice already. Set AUTH_SECRET in the
 * environment FIRST (an ops change, no code, no risk), confirm the warning below stops appearing,
 * then delete the fallback. The same pattern lives in src/lib/api-keys.ts, credential.ts, calendar.ts
 * and activity-log.ts, so it is a repo-wide item, not one endpoint's.
 *
 * What the fallback can still buy an attacker is now much smaller: forging a token only names which
 * questions get asked, and a pass mails a link to the account owner rather than answering with a
 * password.
 */
let warnedAboutSecret = false;
function questionSetSecret(): string {
  const configured = process.env.AUTH_SECRET || process.env.SESSION_SECRET || '';
  if (configured) return configured;
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.error('[verify-by-questions] AUTH_SECRET and SESSION_SECRET are both unset - question-set tokens are signed with the committed default key. Set AUTH_SECRET in the environment.');
  }
  return 'edurankai-default';
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

/** What the browser is allowed to see about a question. Never the expected answer. */
interface PresentedQuestion { id: string; label: string; type: QType; }

function buildQuestionPool(app: any, emp: any, usr: any): QSpec[] {
  const pool: QSpec[] = [];

  if (app?.first_name) pool.push({ id: 'first_name', label: 'First name on your application', type: 'text', expected: app.first_name });
  if (app?.last_name) pool.push({ id: 'last_name', label: 'Last name on your application', type: 'text', expected: app.last_name });
  if (app?.city) pool.push({ id: 'app_city', label: 'City you listed on your application', type: 'text', expected: app.city });
  if (app?.birth_place) pool.push({ id: 'birth_place', label: 'Place of birth on your application', type: 'text', expected: app.birth_place });
  if (app?.role_title_snapshot) pool.push({ id: 'role_title', label: 'Role title you applied to', type: 'text', expected: app.role_title_snapshot });
  if (app?.field_of_study) pool.push({ id: 'field_of_study', label: 'Field of study on your application', type: 'text', expected: app.field_of_study });
  if (app?.institution) pool.push({ id: 'institution', label: 'Institution / college on your application', type: 'text', expected: app.institution });
  // Label deliberately does not name the test vendor: this string is shown to whoever asks, including
  // callers who are not the account holder, and naming a real company in user-facing copy is against
  // this project's copy rules. The id and the expected value are unchanged, so scoring is unaffected.
  if (app?.duolingo_score != null && app.duolingo_score !== '') pool.push({ id: 'duolingo', label: 'Your English proficiency test score', type: 'number', expected: String(app.duolingo_score) });
  if (app?.dob) pool.push({ id: 'app_dob', label: 'Date of birth on your application (YYYY-MM-DD)', type: 'date', expected: typeof app.dob === 'string' ? app.dob.substring(0, 10) : new Date(app.dob).toISOString().substring(0, 10) });

  if (emp?.designation) pool.push({ id: 'designation', label: 'Your designation at EduRankAI', type: 'text', expected: emp.designation });
  if (emp?.employee_code) pool.push({ id: 'employee_code', label: 'Your employee code', type: 'text', expected: emp.employee_code });
  if (emp?.joining_date) pool.push({ id: 'joining_year', label: 'Year you joined EduRankAI', type: 'year', expected: String(new Date(emp.joining_date).getFullYear()) });
  if (emp?.emergency_contact_name) pool.push({ id: 'emergency_contact', label: 'Name of your emergency contact', type: 'text', expected: emp.emergency_contact_name });
  if (emp?.city) pool.push({ id: 'emp_city', label: 'City on your HR record', type: 'text', expected: emp.city });

  if (usr?.created_at) pool.push({ id: 'account_year', label: 'Year your portal account was created', type: 'year', expected: String(new Date(usr.created_at).getFullYear()) });

  return pool;
}

/**
 * The decoy catalogue, for addresses this route will not really verify.
 *
 * THE IDS AND LABELS ARE THE REAL ONES, deliberately. The question-set token is a base64 payload the
 * caller can decode, so a decoy carrying ids like `x_first_name` would announce itself the moment
 * anyone looked — the enumeration oracle back again, wearing a costume. Sharing the real identifiers
 * means the token, the labels and the input types of a decoy set are byte-for-byte the kind of thing
 * a real set contains. Nothing here holds an expected answer, and a decoy set is never scored: the
 * verify phase returns the generic answer for a refused address before scoring is reached.
 *
 * IT MUST COVER EVERY ID buildQuestionPool CAN PRODUCE, and that is a correctness requirement rather
 * than a stylistic one. Two things break when an id is missing here:
 *   1. THE ORACLE COMES BACK. A question a decoy set can never contain proves, on sight, that the
 *      address is a real account — and for the two HR-sourced ones, that the holder is an employee.
 *      The set is the answer to "does this address exist", which is the whole thing decoys remove.
 *   2. A REUSED SET SILENTLY SHORTENS. get-questions filters a persisted set through present(), which
 *      resolves an id from the live pool OR from here. If the underlying record changes so that an id
 *      leaves the pool and it has no entry here either, the reissued set comes back shorter than the
 *      set still held in auth_recovery_attempts, and the verify phase then rejects every submission as
 *      a stale set until the window expires. Complete coverage makes present() total, so the filter
 *      can never drop anything.
 * Add a row here whenever a question is added to buildQuestionPool.
 */
const DECOY_CATALOGUE: PresentedQuestion[] = [
  { id: 'first_name', label: 'First name on your application', type: 'text' },
  { id: 'last_name', label: 'Last name on your application', type: 'text' },
  { id: 'app_city', label: 'City you listed on your application', type: 'text' },
  { id: 'birth_place', label: 'Place of birth on your application', type: 'text' },
  { id: 'role_title', label: 'Role title you applied to', type: 'text' },
  { id: 'field_of_study', label: 'Field of study on your application', type: 'text' },
  { id: 'institution', label: 'Institution / college on your application', type: 'text' },
  { id: 'duolingo', label: 'Your English proficiency test score', type: 'number' },
  { id: 'app_dob', label: 'Date of birth on your application (YYYY-MM-DD)', type: 'date' },
  { id: 'designation', label: 'Your designation at EduRankAI', type: 'text' },
  { id: 'employee_code', label: 'Your employee code', type: 'text' },
  { id: 'joining_year', label: 'Year you joined EduRankAI', type: 'year' },
  { id: 'emergency_contact', label: 'Name of your emergency contact', type: 'text' },
  { id: 'emp_city', label: 'City on your HR record', type: 'text' },
  { id: 'account_year', label: 'Year your portal account was created', type: 'year' },
];

/**
 * A decoy set that is stable for a given address WITHIN A WINDOW and different across windows.
 *
 * Derived from an HMAC rather than Math.random so two calls inside the window agree even if the
 * attempts table (which is what normally holds the set) is unavailable. The window bucket is in the
 * seed because a real account re-draws when its held set expires: a decoy that stayed identical
 * forever while real sets rotated would be a slower version of the same oracle. The size varies
 * between 4 and 6 for the same reason — a sparse real record produces a short set, so decoys must
 * sometimes be short.
 */
function decoySet(email: string): PresentedQuestion[] {
  const bucket = Math.floor(Date.now() / (QUESTION_SET_TTL_MINUTES * 60 * 1000));
  const h = crypto.createHmac('sha256', questionSetSecret()).update('decoy:' + bucket + ':' + email).digest();
  const ranked = DECOY_CATALOGUE.map((q, i) => ({ q, k: h[i % h.length] * 251 + h[(i * 7 + 3) % h.length] }));
  ranked.sort((a, b) => (a.k - b.k) || (a.q.id < b.q.id ? -1 : 1));
  const count = 4 + (h[h.length - 1] % 3);
  return ranked.slice(0, count).map((r) => r.q);
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
  const u = await db.execute(sql`SELECT id, email, name, role, is_active, assigned_department_id, created_at FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
  const usr = (rowsOf(u)[0] as any) || null;
  if (!usr) return { usr: null, app: null, emp: null };

  let app: any = null;
  try {
    const a = await db.execute(sql`SELECT first_name, last_name, city, birth_place, role_title_snapshot, field_of_study, institution, duolingo_score, dob FROM applications WHERE applicant_user_id = ${usr.id} ORDER BY created_at DESC LIMIT 1`);
    app = rowsOf(a)[0] || null;
  } catch (e: any) { console.error('[verify-by-questions] applications read', causeOf(e)); }

  let emp: any = null;
  try {
    const e = await db.execute(sql`SELECT designation, employee_code, joining_date, emergency_contact_name, city FROM hr_employees WHERE user_id = ${usr.id} LIMIT 1`);
    emp = rowsOf(e)[0] || null;
  } catch (e: any) { console.error('[verify-by-questions] hr_employees read', causeOf(e)); }

  return { usr, app, emp };
}

/**
 * The compliance record of the verdict itself.
 *
 * TWO BUGS FIXED HERE, both of which meant this table has been recording NOTHING for this method:
 *   - `email` is `VARCHAR(255) NOT NULL` (.dev-scripts/migrate-user-identity.cjs:43) and was never
 *     supplied, so every INSERT raised a not-null violation.
 *   - `verdict` carries `CHECK (verdict IN ('verified','rejected','pending_review'))` and the value
 *     passed on a pass was 'question_verified', which the constraint rejects. The finer-grained
 *     reason belongs in `metadata`, which is what it now uses.
 * Both failures were invisible because the whole call sat inside `catch (_) {}` — a bare swallow in
 * an auth path, which is precisely what this project's rules forbid and precisely why nobody noticed.
 * The write is still non-fatal (an audit problem must not stop a legitimate recovery) but the cause
 * now reaches the log.
 */
async function audit(userId: string | null, email: string, verdict: 'verified' | 'rejected', score: number, ip: string, meta: any) {
  try {
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, method, verdict, score, ip_address, metadata)
      VALUES (${userId}, ${email.slice(0, 255)}, 'question_set', ${verdict}, ${score}, ${ip || null}, ${JSON.stringify(meta)}::jsonb)
    `);
  } catch (e: any) {
    console.error('[verify-by-questions] identity_verifications insert failed:', causeOf(e));
  }
}

export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = (body?.action || '').toString();
  const email = (body?.email || '').toString().trim().toLowerCase();
  const ip = clientIpOf(request, clientAddress);

  // CSRF first, before any database work.
  const csrf = verifyRecoveryCsrf(request, cookies);
  if (!csrf.ok) {
    await recordAttempt({ route: ROUTE, identifier: email || 'unknown', ip, outcome: 'csrf_rejected', detail: csrf.reason });
    return json({ ok: false, error: CSRF_REJECTED_MESSAGE }, 403);
  }

  if (!email) return json({ ok: false, error: 'Email required' }, 400);
  if (action !== 'get-questions' && action !== 'verify') return json({ ok: false, error: 'Unknown action' }, 400);

  // The counter that the old `setTimeout(400)` was pretending to be. It covers BOTH phases, so
  // asking for questions and grinding the answers draw on the same budget.
  const limit = await checkRateLimit(ROUTE, email, ip);
  if (!limit.allowed) {
    await recordAttempt({ route: ROUTE, identifier: email, ip, outcome: 'rate_limited', detail: limit.scope });
    return json({
      ok: false,
      error: 'Too many verification attempts. Wait ' + Math.ceil(limit.retryAfterSeconds / 60) +
        ' minutes and try again, or use ID + face setup at /identity-setup.',
    }, 429);
  }

  // Nowhere for a link to go means nobody can finish this flow, so say so to EVERYONE before an
  // account is read — a mail outage that only showed up after a correct answer would be a new oracle.
  const mailReady = await recoveryMailReady();
  if (!mailReady.ready) {
    await recordAttempt({ route: ROUTE, identifier: email, ip, outcome: 'no_transport', detail: mailReady.detail });
    console.error('[verify-by-questions] refusing: no mail transport configured -', mailReady.detail);
    return json({ ok: false, error: RECOVERY_UNAVAILABLE_MESSAGE }, 503);
  }

  try {
    // ── Who is this, and may they use this route at all ──────────────────────────────────────
    // Every "no" below produces a DECOY question set rather than a refusal, so phase 1 answers the
    // same shape for an address that does not exist, one that is deactivated, one that belongs to an
    // administrator and one with too little on file to ask about.
    const ctx = await loadUserContext(email);
    let refusal: string | null = null;
    let pool: QSpec[] = [];

    if (!ctx.usr) {
      refusal = 'no_account';
    } else if (ctx.usr.is_active === false) {
      refusal = 'inactive';
    } else if (await isPrivilegedAccount({
      id: ctx.usr.id, email: ctx.usr.email, name: ctx.usr.name, role: ctx.usr.role,
      isActive: ctx.usr.is_active, assignedDepartmentId: ctx.usr.assigned_department_id,
    })) {
      refusal = 'privileged_refused';
    } else {
      pool = buildQuestionPool(ctx.app, ctx.emp, ctx.usr);
      if (pool.length < MIN_POOL) refusal = 'insufficient_data';
    }

    const userId: string | null = ctx.usr ? String(ctx.usr.id) : null;

    if (refusal === 'privileged_refused') {
      await alertAdminOfPrivilegedAttempt({
        route: ROUTE, identifier: email, ip, userId, accountEmail: ctx.usr?.email,
      });
    }

    // Resolve id -> what the browser is shown, from the real pool first and the decoy catalogue
    // second. One lookup for both branches so the two cannot drift apart in shape.
    const present = (id: string): PresentedQuestion | null => {
      const real = pool.find((q) => q.id === id);
      if (real) return { id: real.id, label: real.label, type: real.type };
      return DECOY_CATALOGUE.find((q) => q.id === id) || null;
    };

    if (action === 'get-questions') {
      // THE SET IS DRAWN ONCE. Inside the window the persisted set comes back unchanged; re-rolling
      // until the draw happens to be answerable was the whole exploit, and it no longer exists.
      const persisted = await activeQuestionSet(ROUTE, email);
      let ids: string[] = (persisted?.ids || []).filter((id) => !!present(id));
      const reused = ids.length > 0;

      if (!reused) {
        ids = refusal
          ? decoySet(email).map((q) => q.id)
          : shuffle(pool).slice(0, Math.min(MAX_QUESTIONS, pool.length)).map((q) => q.id);
      }

      const questions = ids.map(present).filter(Boolean) as PresentedQuestion[];
      const secret = questionSetSecret();
      const payload = JSON.stringify({ email, ids, exp: Date.now() + QUESTION_SET_TTL_MINUTES * 60 * 1000 });
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const token = Buffer.from(payload).toString('base64url') + '.' + sig;

      // Both outcomes are recorded and both count against the ceiling, so asking again is never free.
      // Only a FRESH draw writes 'questions_issued' — re-recording it would keep pushing the set's
      // own expiry forward and the set would never roll over for the person who legitimately needs a
      // new one. NOTE: the detail is the set itself; that is what activeQuestionSet reads back.
      await recordAttempt({
        route: ROUTE, identifier: email, ip, userId,
        outcome: reused ? 'questions_reissued' : 'questions_issued',
        detail: ids.join(','),
      });
      return json({ ok: true, questions, token });
    }

    // ── action === 'verify' ───────────────────────────────────────────────────────────────────
    const token = (body?.token || '').toString();
    const answers = body?.answers || {};
    // Token-shape problems stay distinguishable: they describe the page's own state and say nothing
    // about which accounts exist.
    if (!token) return json({ ok: false, error: 'Missing question token. Please reload.' }, 400);

    const secret = questionSetSecret();
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return json({ ok: false, error: 'Invalid token' }, 400);
    let payload: any = null;
    try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return json({ ok: false, error: 'Invalid token' }, 400); }
    const expectedSig = crypto.createHmac('sha256', secret).update(Buffer.from(payloadB64, 'base64url').toString('utf8')).digest('hex');
    if (sig !== expectedSig) return json({ ok: false, error: 'Invalid token' }, 400);
    if (payload.email !== email) return json({ ok: false, error: 'Invalid token' }, 400);
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return json({ ok: false, error: 'Question set expired. Reload and try again.' }, 400);

    const askedIds: string[] = Array.isArray(payload.ids) ? payload.ids.map((v: any) => String(v)) : [];

    // The token must carry the set that is currently held for this address. Without this an attacker
    // could keep an older signed set alive alongside the current one; with it, only the set the
    // server last committed to can be answered. Skipped when the lookup itself failed (null), which
    // degrades to the signature check alone rather than to a refusal.
    const held = await activeQuestionSet(ROUTE, email);
    if (held && (held.ids.length !== askedIds.length || held.ids.some((id, i) => id !== askedIds[i]))) {
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'stale_question_set' });
      return genericAnswer();
    }

    if (refusal) {
      // Unknown, deactivated, privileged or too-sparse. Answered exactly like a wrong answer.
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: refusal });
      return genericAnswer();
    }

    const askedSpecs = askedIds.map((id) => pool.find((q) => q.id === id)).filter(Boolean) as QSpec[];
    if (askedSpecs.length === 0 || askedSpecs.length !== askedIds.length) {
      // A set that can no longer be scored in full (the record changed underneath it, or the ids are
      // decoys). Not scored at all — a partial set is a smaller bar than the one that was issued.
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'unscorable_set' });
      return genericAnswer();
    }

    let total = 0;
    let weakest = 1;
    const perQ: { id: string; score: number }[] = [];
    for (const spec of askedSpecs) {
      const given = (answers?.[spec.id] || '').toString();
      const s = scoreAnswer(spec, given);
      perQ.push({ id: spec.id, score: Number(s.toFixed(3)) });
      if (s < weakest) weakest = s;
      total += s;
    }
    const aggregate = total / askedSpecs.length;
    const pct = Math.round(aggregate * 100);
    const passed = aggregate >= AGGREGATE_THRESHOLD && weakest >= PER_QUESTION_FLOOR;

    if (!passed) {
      await audit(userId, email, 'rejected', aggregate, ip, {
        method_detail: 'question_set',
        reason: aggregate < AGGREGATE_THRESHOLD ? 'below_threshold' : 'below_per_question_floor',
        perQ, threshold: AGGREGATE_THRESHOLD, floor: PER_QUESTION_FLOOR, pct,
      });
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'answers_rejected', detail: 'pct=' + pct });
      // NO SCORE, NO STATUS DIFFERENCE. Returning the aggregate let an attacker change one answer at
      // a time and read the shift to solve the set question by question; returning a distinct status
      // would have said "these answers were wrong, so the account is real". The numbers are in the
      // audit row.
      return genericAnswer();
    }

    // Passed. NO PASSWORD IS WRITTEN HERE — a single-use link goes to the address on the account, so
    // answering the questions is not the same thing as holding the account.
    await audit(userId, email, 'verified', aggregate, ip, {
      method_detail: 'question_set', perQ, threshold: AGGREGATE_THRESHOLD,
      floor: PER_QUESTION_FLOOR, pct, delivery: 'reset_link_emailed',
    });

    const to = String(ctx.usr.email || '').trim();
    if (!to) {
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'no_email_on_account' });
      return genericAnswer();
    }

    // Token first: an unstorable token must not produce a link that can never expire or be revoked.
    const issued = await issueResetToken(String(ctx.usr.id), ROUTE, ip, email);
    const sent = await sendResetLink(to, String(ctx.usr.name || ''), issued.token);
    if (!sent.ok) {
      // Fail closed and say so. Falling back to returning a password is the disclosure this change
      // exists to remove, and a mail outage is not a reason to reinstate it. This is the one reply
      // that is not the generic one; the transport check at the top of the handler keeps it to a
      // genuine send failure rather than a missing configuration.
      await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'mail_failed', detail: sent.error });
      console.error('[verify-by-questions] reset mail not sent:', sent.error);
      return json({ ok: false, error: 'We could not send the reset email right now. Email hr@edurankai.in and we will reset it manually.' }, 502);
    }

    await recordAttempt({ route: ROUTE, identifier: email, ip, userId, outcome: 'link_sent' });
    return genericAnswer();
  } catch (e: any) {
    // Never swallowed: the real Postgres reason reaches the log rather than only the failed SQL.
    console.error('[verify-by-questions] failed:', causeOf(e));
    await recordAttempt({ route: ROUTE, identifier: email, ip, outcome: 'error', detail: causeOf(e) }).catch(() => {});
    return json({ ok: false, error: 'We could not process that request. Try again, or email hr@edurankai.in.' }, 500);
  }
};
