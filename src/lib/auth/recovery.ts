// src/lib/auth/recovery.ts — the shared machinery behind every self-serve account-recovery flow.
//
// WHY THIS EXISTS. Three endpoints under /api/auth (forgot-password, verify-by-questions,
// identity-setup) each proved a claim about who you are and then, on success, WROTE A NEW PASSWORD
// AND RETURNED IT IN THE HTTP RESPONSE BODY. Every one of them is reachable with no session at all —
// src/middleware.ts:115-117 exempts the whole of /api/ from the session and face gates, and none of
// the three read locals.user. So anyone who could guess a date of birth, or answer five questions
// drawn largely from public pages, received a working password for that account in the reply. For a
// super_admin account that is the whole admin console: the legal-hold records and the wellness
// oversight screens included.
//
// The shape of the fix is one idea repeated: PROVING SOMETHING ABOUT AN ACCOUNT NO LONGER HANDS YOU
// THE ACCOUNT. It hands the account's own mailbox a single-use, expiring link. An attacker who
// defeats the knowledge check still ends up with nothing, because the secret goes to the address on
// file rather than to the caller. That is why the knowledge checks themselves are only tightened
// here, not rebuilt: they stopped being the last line of defence.
//
// THE COUNTER IS A TABLE, NOT A SLEEP. Both endpoints previously "rate limited" with
// `await new Promise(r => setTimeout(r, 600))`. That is per-request with no shared state: a hundred
// concurrent requests still cost 600ms of wall clock in total, so it slowed a human down and did
// nothing at all to a script. The window below is counted in Postgres, which is the only place two
// serverless invocations can agree on how many attempts have happened.
//
// IT DOES NOT LOCK THE BUILDING. This project has taken an outage from an over-eager auth guard
// twice, so the failure directions are chosen deliberately and they are NOT uniform:
//   - the ATTEMPT COUNTER fails OPEN. If the counting query throws, recovery keeps working and the
//     error is logged loudly. A broken counter must not become an outage of password recovery.
//   - TOKEN ISSUANCE fails CLOSED. If the token cannot be stored, no mail goes out and the caller is
//     told plainly. A reset link nobody can revoke or expire is worse than no reset link.
//   - the per-IP ceiling is deliberately loose (see MAX_PER_IP). A shared office or campus NAT puts
//     every colleague behind one address, and a tight per-IP cap is exactly how a lockout ships.
//     The per-IDENTIFIER ceiling is the tight one, because that is the account under attack.
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ADMIN_CAPABLE_ROLES, canOpenAdmin } from '@/lib/auth/admin-access';
import { sendEmail, brandedEmail } from '@/lib/email';
import { transportStatus } from '@/lib/mail-transport';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the top of the module
// because `const` is not hoisted and a handler reaching a later declaration has taken pages down here.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason lives on e.cause; e.message is only the SQL that failed.
const logFail = (tag: string, e: any) => console.error('[recovery] ' + tag, e?.cause?.message || e?.message);

/** How long a reset link stays usable. Short enough to matter, long enough to survive a slow inbox. */
export const RESET_TOKEN_TTL_MINUTES = 30;

/** Rolling window every ceiling below is counted over. */
export const ATTEMPT_WINDOW_MINUTES = 15;
/**
 * Attempts per IDENTIFIER (the email or name being recovered) per window. This is the tight one: it
 * bounds a brute force against ONE account, which is what F1's ~18k-candidate date-of-birth space
 * and F2's re-rollable question set both need in order to work.
 */
export const MAX_PER_IDENTIFIER = 8;
/**
 * Attempts per IP per window. Deliberately loose. Everyone in one office shares this number, and a
 * cap that fits a single user is a cap that locks out a whole floor on a busy morning.
 */
export const MAX_PER_IP = 40;

/**
 * How long one issued question set stays THE question set for that identifier.
 *
 * The whole exploit on /verify-by-questions was that the draw was random on every call and nothing
 * recorded that a set had been issued, so an attacker re-rolled until the six questions happened to
 * be six facts they could look up. Within this window the SAME set comes back, whoever asks and
 * however often — the set is randomised once and then persisted (see activeQuestionSet).
 */
export const QUESTION_SET_TTL_MINUTES = 10;

export type RecoveryRoute = 'dob_reset' | 'question_set' | 'identity_setup' | 'token_redeem';

/**
 * WHY THE COUNTER IS NOT `identity_verifications`.
 *
 * The brief asked for the existing table to be reused rather than a second one added. It cannot
 * carry this job, and the reason is in its own DDL (.dev-scripts/migrate-user-identity.cjs:38-55):
 *   - `user_id UUID REFERENCES users(id)` and `email VARCHAR(255) NOT NULL` — every row must name a
 *     real, existing account. The attempts that matter most are the ones against addresses that do
 *     NOT resolve to an account; those rows cannot exist there at all, so a brute force that walks a
 *     list of guessed addresses would be counted as zero attempts.
 *   - there is no IP column, so a per-IP ceiling has nothing to count.
 *   - there is no route or identifier column, so /forgot-password's attempts and
 *     /verify-by-questions' attempts cannot be told apart or bounded separately.
 *   - `verdict` carries `CHECK (verdict IN ('verified','rejected','pending_review'))`, so 'rate
 *     limited', 'questions issued' and 'privileged refused' are not expressible.
 * Widening that table would mean altering a compliance audit table that other code reads. The
 * attempts table below is additive, self-bootstrapping and touches nothing that already exists.
 * identity_verifications keeps its own job — it still records the verification verdict itself.
 */

/** Best-effort client address. Never trusted for authorisation — only for counting and audit. */
export function clientIpOf(request: Request, clientAddress?: string | null): string {
  const raw = (clientAddress || request.headers.get('x-forwarded-for') || '').toString();
  return raw.split(',')[0].trim().slice(0, 64);
}

/**
 * Show a person WHERE their link went without publishing the address. `siddharth@edurankai.in`
 * becomes `si*******@edurankai.in`. Used only after identity has already been proven.
 */
export function maskEmail(email: string): string {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return '';
  const local = e.slice(0, at);
  const domain = e.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return head + '*'.repeat(Math.max(1, local.length - head.length)) + domain;
}

// ── Self-bootstrapping storage ────────────────────────────────────────────────────────────────
// Created on first use so this ships without a migration step. `IF NOT EXISTS` throughout, and each
// statement runs on its own because postgres-js sends one statement per query.
let bootstrap: Promise<boolean> | null = null;

async function ensureTables(): Promise<boolean> {
  if (!bootstrap) {
    bootstrap = (async () => {
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS auth_recovery_attempts (
            id text PRIMARY KEY,
            route varchar(32) NOT NULL,
            identifier varchar(320) NOT NULL,
            ip varchar(64),
            user_id text,
            outcome varchar(32) NOT NULL,
            detail text,
            created_at timestamptz NOT NULL DEFAULT NOW()
          )`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_recovery_attempts_ident_idx ON auth_recovery_attempts (identifier, created_at DESC)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_recovery_attempts_ip_idx ON auth_recovery_attempts (ip, created_at DESC)`);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
            id text PRIMARY KEY,
            user_id text NOT NULL,
            token_hash varchar(64) NOT NULL UNIQUE,
            purpose varchar(32) NOT NULL,
            issued_ip varchar(64),
            created_at timestamptz NOT NULL DEFAULT NOW(),
            expires_at timestamptz NOT NULL,
            used_at timestamptz,
            used_ip varchar(64)
          )`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_pw_reset_user_idx ON auth_password_reset_tokens (user_id, created_at DESC)`);
        return true;
      } catch (e: any) {
        logFail('table bootstrap failed', e);
        // Let a later call retry rather than pinning the failure for the life of the process.
        bootstrap = null;
        return false;
      }
    })();
  }
  return bootstrap;
}

// ── Audit ─────────────────────────────────────────────────────────────────────────────────────

export interface AttemptRecord {
  route: RecoveryRoute;
  identifier: string;
  ip: string;
  userId?: string | null;
  outcome: string;
  detail?: string | null;
}

/**
 * Every attempt, refused or not, leaves a row. This is both the audit trail (there was none before —
 * forgot-password wrote nothing at all) and the shared state the ceilings are counted from.
 *
 * Failures here are LOGGED, not thrown: an unwritable audit row must not stop a legitimate person
 * recovering their account. It is not swallowed — the cause reaches the log.
 */
export async function recordAttempt(a: AttemptRecord): Promise<void> {
  const ok = await ensureTables();
  if (!ok) return;
  try {
    await db.execute(sql`
      INSERT INTO auth_recovery_attempts (id, route, identifier, ip, user_id, outcome, detail)
      VALUES (${crypto.randomUUID()}, ${a.route}, ${a.identifier.slice(0, 320)}, ${a.ip || null},
              ${a.userId || null}, ${a.outcome.slice(0, 32)}, ${a.detail ? a.detail.slice(0, 500) : null})`);
  } catch (e: any) {
    logFail('attempt audit insert', e);
  }
}

/**
 * Rows that are BOOKKEEPING, not attempts, and must not be counted against a ceiling.
 *
 * Two reasons, and the first is a lockout bug:
 *   - 'rate_limited' rows are written by the refusal itself. If they counted, a person who hit the
 *     ceiling and then kept clicking would keep pushing their own window forward and never get back
 *     in — a self-extending lockout, which is exactly the failure mode this project has shipped
 *     before.
 *   - 'token_issued', 'token_consumed' and the alert rows are consequences of a SUCCESSFUL recovery.
 *     Counting them would mean succeeding costs you two or three of your eight attempts.
 */
const UNCOUNTED_OUTCOMES = ['rate_limited', 'token_issued', 'token_consumed', 'admin_alerted', 'admin_alert_failed', 'csrf_rejected'];
/**
 * Written as literal SQL from the module constant above rather than bound as an array parameter:
 * postgres-js would send it as an untyped array and the `<> ALL(...)` operator resolution is not
 * worth the risk in a query whose failure silently removes every ceiling. Nothing here is caller
 * data — the list is fixed at build time and matched against /^[a-z_]+$/ before it is interpolated.
 */
const UNCOUNTED_SQL = "outcome NOT IN (" +
  UNCOUNTED_OUTCOMES.filter((o) => /^[a-z_]+$/.test(o)).map((o) => "'" + o + "'").join(',') + ")";

export interface RateVerdict {
  allowed: boolean;
  /** Seconds the caller should wait. Only meaningful when allowed is false. */
  retryAfterSeconds: number;
  scope: 'identifier' | 'ip' | 'none';
}

/**
 * Count this identifier's and this IP's attempts in the rolling window.
 *
 * FAILS OPEN, on purpose. See the header note: a counting query that throws (missing table, database
 * hiccup) would otherwise refuse every recovery request on the site, which is the outage this project
 * has already had twice. The error is logged with its real Postgres cause so the counter being down
 * is visible rather than silent.
 */
export async function checkRateLimit(route: RecoveryRoute, identifier: string, ip: string): Promise<RateVerdict> {
  const ok = await ensureTables();
  if (!ok) return { allowed: true, retryAfterSeconds: 0, scope: 'none' };
  const windowMin = ATTEMPT_WINDOW_MINUTES;
  // The interval is interpolated rather than bound because a bound parameter reaches Postgres as
  // unknown-typed text and `$1 * interval '1 minute'` has no operator. ATTEMPT_WINDOW_MINUTES is a
  // module constant integer declared above, never request data, so nothing here is caller-influenced.
  const windowClause = sql.raw("created_at > NOW() - INTERVAL '" + Math.trunc(windowMin) + " minutes'");
  try {
    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE identifier = ${identifier.slice(0, 320)}) AS ident_count,
        COUNT(*) FILTER (WHERE ip IS NOT NULL AND ip <> '' AND ip = ${ip || ''}) AS ip_count
      FROM auth_recovery_attempts
      WHERE route = ${route}
        AND ${sql.raw(UNCOUNTED_SQL)}
        AND ${windowClause}`);
    const row = rows(r)[0] as any;
    const identCount = Number(row?.ident_count || 0);
    const ipCount = Number(row?.ip_count || 0);
    if (identCount >= MAX_PER_IDENTIFIER) {
      return { allowed: false, retryAfterSeconds: windowMin * 60, scope: 'identifier' };
    }
    if (ipCount >= MAX_PER_IP) {
      return { allowed: false, retryAfterSeconds: windowMin * 60, scope: 'ip' };
    }
    return { allowed: true, retryAfterSeconds: 0, scope: 'none' };
  } catch (e: any) {
    logFail('rate-limit count', e);
    return { allowed: true, retryAfterSeconds: 0, scope: 'none' };
  }
}

/**
 * Has this identifier already produced a row with this outcome inside the window?
 *
 * Used to keep one administrator alert per attacker per window rather than one per request, so an
 * attempt against a privileged address cannot be turned into a mail flood aimed at the alert
 * mailbox. Returns false when it cannot tell, which errs towards sending the alert.
 */
export async function recentAttemptExists(route: RecoveryRoute, identifier: string, outcome: string, minutes = ATTEMPT_WINDOW_MINUTES): Promise<boolean> {
  const ok = await ensureTables();
  if (!ok) return false;
  const windowClause = sql.raw("created_at > NOW() - INTERVAL '" + Math.trunc(minutes) + " minutes'");
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM auth_recovery_attempts
       WHERE route = ${route} AND identifier = ${identifier.slice(0, 320)} AND outcome = ${outcome.slice(0, 32)}
         AND ${windowClause}
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('recent attempt lookup', e);
    return false;
  }
}

// ── The question set, randomised once and then held ────────────────────────────────────────────

export interface PersistedQuestionSet { ids: string[]; issuedAt: Date; }

/**
 * The question set already issued to this identifier inside QUESTION_SET_TTL_MINUTES, if any.
 *
 * The set is persisted as the `detail` of the 'questions_issued' attempt row, which the counter
 * already writes — so locking the set costs no extra table and no extra write. A second
 * get-questions call inside the window returns exactly what the first call returned, which is what
 * makes re-rolling pointless: the draw happens once per window, not once per request.
 *
 * Returns null when the row is absent OR when the lookup fails. A failure therefore degrades to a
 * fresh random draw rather than to a broken flow — the same fail-open direction as the counter, and
 * for the same reason. It is logged.
 */
export async function activeQuestionSet(route: RecoveryRoute, identifier: string): Promise<PersistedQuestionSet | null> {
  const ok = await ensureTables();
  if (!ok) return null;
  const windowClause = sql.raw("created_at > NOW() - INTERVAL '" + Math.trunc(QUESTION_SET_TTL_MINUTES) + " minutes'");
  try {
    const r = await db.execute(sql`
      SELECT detail, created_at FROM auth_recovery_attempts
       WHERE route = ${route} AND identifier = ${identifier.slice(0, 320)} AND outcome = 'questions_issued'
         AND ${windowClause}
       ORDER BY created_at DESC
       LIMIT 1`);
    const row = rows(r)[0] as any;
    if (!row) return null;
    const ids = String(row.detail || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return null;
    return { ids, issuedAt: new Date(row.created_at) };
  } catch (e: any) {
    logFail('active question set lookup', e);
    return null;
  }
}

// ── Who may not use a self-serve flow at all ───────────────────────────────────────────────────

export interface RecoveryUser {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  assignedDepartmentId?: string | null;
}

/**
 * Privileged accounts do NOT recover themselves through a knowledge check.
 *
 * A date of birth and a handful of professional facts are a reasonable bar for an applicant's own
 * application record. They are not a reasonable bar for the account that can open every employee
 * record, the legal-hold register and the wellness oversight screens. Staff recover through an
 * admin-issued reset, which is already this project's documented pattern for privileged operations.
 *
 * Two arms, and the SECOND is why this is not just a role test:
 *   1. the role appears in ADMIN_CAPABLE_ROLES — derived from the permission matrix, so it cannot
 *      drift from it;
 *   2. canOpenAdmin says yes anyway — which catches a CUSTOM role granted admin.access in the
 *      registry, i.e. an admin created after this code was written.
 *
 * It FAILS CLOSED (treats the account as privileged) if that lookup throws. Note what that costs and
 * what it does not: canOpenAdmin refuses a non-admin-capable role BEFORE it touches the database, so
 * an applicant never reaches the throwing path and cannot be locked out of recovery by it.
 */
export async function isPrivilegedAccount(user: RecoveryUser): Promise<boolean> {
  const role = String(user.role || '').trim();
  if (role && ADMIN_CAPABLE_ROLES.has(role)) return true;
  try {
    const verdict = await canOpenAdmin({
      id: user.id,
      email: user.email ?? null,
      role: role || null,
      isActive: user.isActive ?? true,
      assignedDepartmentId: user.assignedDepartmentId ?? null,
    });
    if (verdict.allowed) return true;
    // 'lookup-failed' is only reachable for a role that already passed the admin-capable test, so
    // treating it as privileged refuses an admin during a database wobble and never an applicant.
    return verdict.reason === 'lookup-failed';
  } catch (e: any) {
    logFail('privileged check', e);
    return true;
  }
}

/**
 * Where a privileged-recovery alert goes.
 *
 * Not a lookup of "everyone with role X": that would be the role-name list this change is meant to
 * avoid, and a query that mails every administrator is a mail amplifier. One configured address,
 * defaulting to the recovery contact that every one of these screens already prints.
 */
export function adminAlertAddress(): string {
  const configured = process.env.SECURITY_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || '';
  return (configured || 'hr@edurankai.in').trim();
}

export interface PrivilegedAttempt {
  route: RecoveryRoute;
  identifier: string;
  ip: string;
  userId?: string | null;
  accountEmail?: string | null;
}

/**
 * Somebody tried to recover a privileged account through a knowledge check. The caller has already
 * refused them with the ordinary generic answer; this tells a human it happened.
 *
 * NEVER THROWS. An alert that cannot be sent must not turn into a 500 on a request that was going to
 * be refused anyway — the refusal is the control, the alert is the notification. The failure is
 * logged and recorded as its own attempt row instead.
 *
 * Rate-limited to one alert per identifier per window, because "mail an administrator on every
 * attempt" against an endpoint anyone can POST to is a way to flood the alert mailbox.
 */
export async function alertAdminOfPrivilegedAttempt(a: PrivilegedAttempt): Promise<void> {
  try {
    const already = await recentAttemptExists(a.route, a.identifier, 'admin_alerted');
    if (already) return;
    // Recorded BEFORE the send, so a slow or failing transport cannot let a burst through the
    // once-per-window gate while the first message is still in flight.
    await recordAttempt({ route: a.route, identifier: a.identifier, ip: a.ip, userId: a.userId, outcome: 'admin_alerted' });
    const to = adminAlertAddress();
    const html = brandedEmail({
      preheader: 'A privileged account was named in a self-serve password recovery attempt.',
      heading: 'Privileged account recovery attempt refused',
      body:
        '<p style="margin:0 0 12px;">Someone asked to recover a privileged account through a self-serve knowledge check. <strong>The request was refused</strong> and no password was changed, no link was sent.</p>' +
        '<p style="margin:0 0 6px;">Route: ' + escapeHtml(a.route) + '</p>' +
        '<p style="margin:0 0 6px;">Identifier submitted: ' + escapeHtml(a.identifier) + '</p>' +
        '<p style="margin:0 0 6px;">Account: ' + escapeHtml(a.accountEmail || 'not disclosed') + '</p>' +
        '<p style="margin:0 0 12px;">Request origin: ' + escapeHtml(a.ip || 'unknown') + '</p>' +
        '<p style="margin:0 0 12px;">Staff and administrator passwords are reset by an administrator, never by date of birth or question set. If the account holder is asking for a reset, do it from the admin console.</p>',
      footerNote: 'Sent once per identifier per ' + ATTEMPT_WINDOW_MINUTES + ' minutes. Every attempt is recorded in auth_recovery_attempts regardless.',
    });
    const r = await sendEmail({
      to,
      subject: 'Refused: self-serve recovery attempt on a privileged account',
      html,
      text: 'A self-serve recovery attempt named a privileged account and was refused. Route ' + a.route + ', identifier ' + a.identifier + ', origin ' + (a.ip || 'unknown') + '.',
    });
    if (!r.ok) {
      console.error('[recovery] privileged-attempt alert not sent:', r.error);
      await recordAttempt({ route: a.route, identifier: a.identifier, ip: a.ip, userId: a.userId, outcome: 'admin_alert_failed', detail: r.error });
    }
  } catch (e: any) {
    // Logged, not swallowed, and deliberately not rethrown into the request.
    logFail('privileged-attempt alert', e);
  }
}

// ── Reset tokens ───────────────────────────────────────────────────────────────────────────────

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export interface IssuedToken { token: string; expiresAt: Date; }

/**
 * Mint a single-use reset token. Only the SHA-256 of it is stored, so a database read (a backup, a
 * log, a compromised replica) does not yield a usable link. Any earlier unused token for the same
 * user is burned first: a fresh request should invalidate the one in the last email, not stack with it.
 *
 * THROWS on failure, and the caller must let that reach the client as an error. Silently continuing
 * without a stored token is how a reset link becomes unrevocable and never expires.
 *
 * The issuance itself is audited ('token_issued'), so the trail runs request -> refusal or match ->
 * token issued -> token consumed -> password set, with no gap where a secret appears from nowhere.
 */
export async function issueResetToken(userId: string, purpose: RecoveryRoute, ip: string, identifier?: string): Promise<IssuedToken> {
  const ok = await ensureTables();
  if (!ok) throw new Error('reset token storage unavailable');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  await db.execute(sql`
    UPDATE auth_password_reset_tokens SET used_at = NOW(), used_ip = 'superseded'
     WHERE user_id = ${userId} AND used_at IS NULL`);
  await db.execute(sql`
    INSERT INTO auth_password_reset_tokens (id, user_id, token_hash, purpose, issued_ip, expires_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${sha256(token)}, ${purpose}, ${ip || null}, ${expiresAt.toISOString()}::timestamptz)`);
  await recordAttempt({
    route: purpose, identifier: identifier || userId, ip, userId,
    outcome: 'token_issued', detail: 'expires ' + expiresAt.toISOString(),
  });
  return { token, expiresAt };
}

export interface ConsumedToken { ok: boolean; userId?: string; reason?: 'invalid' | 'expired' | 'used' | 'unavailable'; }

/**
 * Redeem a token, ONCE. The claim is an atomic UPDATE with the used/expiry test in its own WHERE
 * clause and RETURNING for the result, so two simultaneous redemptions cannot both win — a
 * read-then-write would let the same link reset a password twice.
 */
export async function consumeResetToken(token: string, ip: string): Promise<ConsumedToken> {
  const ok = await ensureTables();
  if (!ok) return { ok: false, reason: 'unavailable' };
  const hash = sha256(String(token || ''));
  const claimed = rows(await db.execute(sql`
    UPDATE auth_password_reset_tokens
       SET used_at = NOW(), used_ip = ${ip || null}
     WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > NOW()
    RETURNING user_id`));
  if (claimed.length > 0) {
    const userId = String((claimed[0] as any).user_id);
    // Audited here rather than at the call site so a redemption can never be spent without a row,
    // whatever the caller then does with it.
    await recordAttempt({ route: 'token_redeem', identifier: userId, ip, userId, outcome: 'token_consumed' });
    return { ok: true, userId };
  }
  // Nothing claimed. Say WHY only in terms the holder of the link already knows.
  const existing = rows(await db.execute(sql`
    SELECT used_at, expires_at FROM auth_password_reset_tokens WHERE token_hash = ${hash} LIMIT 1`));
  if (existing.length === 0) return { ok: false, reason: 'invalid' };
  const row = existing[0] as any;
  if (row.used_at) return { ok: false, reason: 'used' };
  return { ok: false, reason: 'expired' };
}

// ── CSRF for the browser forms ─────────────────────────────────────────────────────────────────
//
// astro.config.mjs sets `security: { checkOrigin: false }`, so Astro's built-in origin check is off
// site-wide and cannot be switched on from here without changing the behaviour of every other
// endpoint in the project. These four recovery POSTs therefore carry their own check.
//
// Two independent tests:
//   1. ORIGIN. A present Origin (or, failing that, Referer) must name the same host the request was
//      addressed to. Compared against the request's OWN host rather than a configured origin, so the
//      apex domain, www and preview deployments all keep working without a list to maintain. A
//      Sec-Fetch-Site of 'cross-site' is refused outright.
//   2. DOUBLE SUBMIT. The page mints a random token, keeps it in an HttpOnly cookie and embeds the
//      same value in its HTML; the form echoes it in x-csrf-token. A cross-site page can neither read
//      our cookie nor read our markup, so it cannot produce a matching pair.
//
// A request carrying NONE of those signals — no Origin, no Referer, no Sec-Fetch-Site, no cookie —
// is ALLOWED, and that is deliberate. It is not a door a browser can walk through, because a browser
// always sends at least one of them on a cross-site POST. It is what stops a support script, an old
// in-app webview, or a privacy setting that drops cookies from turning password recovery into the
// lockout outage this project has already shipped twice.
export const RECOVERY_CSRF_COOKIE = 'era_recovery_csrf';
const CSRF_TTL_SECONDS = 60 * 60 * 12;

export interface CsrfVerdict { ok: boolean; reason?: string; }

/**
 * Mint (or re-use) the page's CSRF token and pin it to an HttpOnly cookie. Call from the frontmatter
 * of a recovery page and embed the returned value in the markup.
 *
 * An existing valid cookie value is RE-USED rather than replaced: two tabs of /forgot-password open
 * at once must not invalidate each other's forms.
 */
export function issueRecoveryCsrf(cookies: AstroCookies): string {
  let token = '';
  try { token = cookies.get(RECOVERY_CSRF_COOKIE)?.value || ''; } catch (_) { token = ''; }
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) token = crypto.randomBytes(32).toString('base64url');
  try {
    cookies.set(RECOVERY_CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: import.meta.env.PROD,
      path: '/',
      maxAge: CSRF_TTL_SECONDS,
    });
  } catch (e: any) {
    // A page that cannot set the cookie still renders and still works: verifyRecoveryCsrf falls back
    // to the origin tests when no cookie is presented. Losing the second factor is not worth losing
    // the page.
    logFail('csrf cookie set', e);
  }
  return token;
}

function hostOf(v: string | null | undefined): string {
  if (!v) return '';
  try { return new URL(v).host.toLowerCase(); } catch { return ''; }
}

function readRequestCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/** See the section header for why each arm fails the way it does. */
export function verifyRecoveryCsrf(request: Request, cookies?: AstroCookies): CsrfVerdict {
  const selfHost = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || '').toLowerCase();

  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') return { ok: false, reason: 'cross-site' };

  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    const oh = hostOf(origin);
    if (selfHost && oh && oh !== selfHost) return { ok: false, reason: 'origin-mismatch' };
  } else {
    const rh = hostOf(request.headers.get('referer'));
    if (selfHost && rh && rh !== selfHost) return { ok: false, reason: 'referer-mismatch' };
  }

  let cookieToken = '';
  try { cookieToken = cookies?.get(RECOVERY_CSRF_COOKIE)?.value || ''; } catch (_) { cookieToken = ''; }
  if (!cookieToken) cookieToken = readRequestCookie(request, RECOVERY_CSRF_COOKIE);
  if (cookieToken) {
    // A token was issued to this browser, so the form is required to echo it. Missing or stale means
    // the page is old (the cookie rolled over after 12 hours) or the post did not come from it.
    if (!timingEqual(cookieToken, request.headers.get('x-csrf-token') || '')) {
      return { ok: false, reason: 'form-token' };
    }
  }
  return { ok: true };
}

/** The one thing to say when a CSRF check fails. It describes the page, never the account. */
export const CSRF_REJECTED_MESSAGE =
  'This form could not be submitted securely. Reload the page and try again.';

// ── Mail ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Is there anywhere for a reset link to go?
 *
 * Checked BEFORE the identity check, on purpose. If the answer is no, every caller gets the same
 * "temporarily unavailable" reply whether or not their details matched — so a mail outage does not
 * turn the endpoint into an oracle that says "your date of birth was right" by failing differently.
 * Fails OPEN on a status-lookup error, because the actual send still fails closed a moment later.
 */
export async function recoveryMailReady(): Promise<{ ready: boolean; detail: string }> {
  try {
    const s = await transportStatus();
    return { ready: s.mode !== 'none', detail: s.detail };
  } catch (e: any) {
    logFail('transport status', e);
    return { ready: true, detail: 'transport status unavailable' };
  }
}

/** Said when no transport is configured. Identical for everyone, matched or not. */
export const RECOVERY_UNAVAILABLE_MESSAGE =
  'Password recovery is temporarily unavailable. Email hr@edurankai.in and we will reset it manually.';

/**
 * The site's own origin, from the Astro config rather than from the request.
 *
 * NOT the Host header: a reset link built from an attacker-controlled Host would be mailed to the
 * REAL owner and point at the attacker's domain. The one thing this link must not be is
 * caller-influenced.
 */
export function siteOrigin(): string {
  const configured = (import.meta as any)?.env?.SITE || process.env.PUBLIC_SITE_URL || '';
  return String(configured || 'https://edurankai.in').replace(/\/+$/, '');
}

export interface MailOutcome { ok: boolean; error?: string; }

/**
 * Deliver the reset link to the address ON THE ACCOUNT — never to an address supplied by the caller.
 *
 * The result is RETURNED, not swallowed. Callers must fail closed on a false: this project's own
 * rule is that a login or signing path never hides an exception, and "we could not send it, so here
 * is the password instead" is exactly the disclosure this whole change removes.
 */
export async function sendResetLink(to: string, name: string, token: string, minutes = RESET_TOKEN_TTL_MINUTES): Promise<MailOutcome> {
  const url = siteOrigin() + '/reset-password?token=' + encodeURIComponent(token);
  const html = brandedEmail({
    preheader: 'Set a new password for your EduRankAI account.',
    heading: 'Set a new password',
    body:
      '<p style="margin:0 0 12px;">Hello ' + escapeHtml(name || 'there') + ',</p>' +
      '<p style="margin:0 0 12px;">Someone asked to reset the password on this account. Use the button below to choose a new one. The link works once and expires in ' + minutes + ' minutes.</p>' +
      '<p style="margin:0 0 12px;">If this was not you, no action is needed — your current password still works and nothing has changed. Tell us at hr@edurankai.in if you did not expect this message.</p>',
    ctaText: 'Set a new password',
    ctaUrl: url,
    footerNote: 'This link was sent because a password reset was requested for this address. It expires in ' + minutes + ' minutes and can be used once.',
  });
  try {
    const r = await sendEmail({
      to,
      subject: 'Set a new password for your EduRankAI account',
      html,
      text: 'Set a new password (link works once, expires in ' + minutes + ' minutes): ' + url,
    });
    if (!r.ok) return { ok: false, error: r.error || 'no transport' };
    return { ok: true };
  } catch (e: any) {
    // Not swallowed: the cause is logged AND the failure is reported to the caller, which fails closed.
    logFail('reset link send', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'send failed' };
  }
}

/**
 * Tell the owner their password actually changed. This is the control that turns a silent takeover
 * into something the account holder finds out about within seconds, and it is why the notification
 * runs even though the reset has already succeeded by the time it is sent.
 */
export async function notifyPasswordChanged(to: string, name: string, ip: string): Promise<MailOutcome> {
  const html = brandedEmail({
    preheader: 'Your EduRankAI password was changed.',
    heading: 'Your password was changed',
    body:
      '<p style="margin:0 0 12px;">Hello ' + escapeHtml(name || 'there') + ',</p>' +
      '<p style="margin:0 0 12px;">The password on your EduRankAI account was just changed, and every existing sign-in session was signed out.</p>' +
      '<p style="margin:0 0 12px;">Request origin: ' + escapeHtml(ip || 'unknown') + '.</p>' +
      '<p style="margin:0 0 12px;"><strong>If this was not you, contact hr@edurankai.in immediately.</strong></p>',
    footerNote: 'Sent automatically when a password changes. You cannot turn this notice off.',
  });
  try {
    const r = await sendEmail({ to, subject: 'Your EduRankAI password was changed', html, text: 'Your EduRankAI password was changed. If this was not you, contact hr@edurankai.in immediately.' });
    if (!r.ok) return { ok: false, error: r.error || 'no transport' };
    return { ok: true };
  } catch (e: any) {
    logFail('password-changed notice', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'send failed' };
  }
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The ONE answer every self-serve reset gives, whatever actually happened.
 *
 * Before this, the endpoint distinguished "no such account" (404), "no date of birth on file" (404,
 * different text) and "wrong date of birth" (404, third text) — an enumeration oracle that told an
 * attacker which addresses and names are real before they spent a single guess. One string, one
 * status, no information.
 */
export const GENERIC_RECOVERY_MESSAGE =
  'If those details match an account, a single-use link to set a new password has been sent to the email address on that account. It expires in ' +
  RESET_TOKEN_TTL_MINUTES + ' minutes. Check spam, and contact hr@edurankai.in if nothing arrives.';
