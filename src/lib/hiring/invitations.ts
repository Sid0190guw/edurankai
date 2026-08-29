// src/lib/hiring/invitations.ts — "an administrator asked this person to apply."
//
// WHAT THIS IS, IN ONE SENTENCE
//
// An invitation shortens the walk to an application: it carries the role, the person's name, a line
// from whoever invited them, and optionally a fee waiver decided for that one person. The invited
// person still fills in the application and it still goes to a human reviewer.
//
// WHAT IT IS NOT
//
// Not tal_onboarding_code (ERA-SEL). That code means somebody was already SELECTED, skips the
// application entirely, and is a typed secret — which is why it has a uniform rejection sentence and
// a rate limiter reading a table. This is a URL token that shortens the walk to a form anyone can
// already reach from /careers, so it does not carry that blast radius and does not pretend to.
//
// THREE RULES THIS MODULE KEEPS
//
// 1. THE TOKEN IS NEVER STORED. token_hash is sha256(token); the plaintext is returned once, to the
//    administrator who created it. A dump of this table opens nothing.
//
// 2. ONE LIVE INVITATION PER PERSON PER ROLE, enforced by the partial unique index
//    app_inv_active_uq, not by convention. Re-inviting revokes the previous one first.
//
// 3. A FAILED SEND IS RECORDED AS A FAILED SEND. email_sent/email_error hold what actually happened,
//    because an administrator who believes an invitation was delivered will not follow it up.
//
// PRODUCTION NOTE: the table is created by db/application-invitations-schema.sql, run by hand, and
// registered in BOOTSTRAP_MODULES. ensureInvitationSchema() below is the local-development path only
// — bootstrap DDL is suppressed in production by design, so nothing here may assume it ran.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { publicOrigin } from '@/lib/public-origin';
// The code vocabulary is IMPORTED, never restated. src/lib/talent/codes.ts was reconciled onto this
// exact rule after two definitions of one code format existed side by side and whichever happened to
// be imported decided whether a code validated. A second invitation-flavoured alphabet here would
// recreate that, and it would also mean /apply/gateway telling somebody the wrong characters are
// forbidden.
import { CODE_ALPHABET, CODE_GROUP_LEN, CODE_GROUPS, CODE_BODY_LEN } from '@/lib/talent/types';
import { countAttempt } from '@/lib/auth/two-factor';
// THE POSTING CATALOGUE, resolved the same way /careers and /apply resolve it. An invitation names a
// posting by slug; the title stored beside it is a snapshot taken when the invitation was sent, so
// anything that wants to know whether that posting is STILL open has to ask the roles table.
import { effectiveJobStatus } from '@/lib/xscale/taxonomy';
// textIn, NEVER `= ANY(${jsArray})`. postgres-js serialises a JS array as a record literal, so that
// pattern renders ANY(($1, $2)) and Postgres refuses the statement - src/lib/pg-array.ts documents
// the five places it silently broke, and a repo-wide scan in its test fails the build over a new one.
import { textIn } from '@/lib/pg-array';
// The gate pass. gate-pass.ts imports nothing but node:crypto, so this costs the bundle nothing and
// keeps the "who may reach /apply" decision in the one module that owns it.
import { issuePass, GATE_TTL_MINUTES } from '@/lib/talent/gate-pass';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const fail = (where: string, e: any) => console.error('[invitations] ' + where + ':', e?.cause?.message || e?.message);

/** How long an invitation link stays usable, unless an administrator picks something shorter. */
export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 180;

export type InvitationStatus = 'pending' | 'opened' | 'applied' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  email: string;
  fullName: string;
  roleId: string | null;
  roleSlug: string;
  roleTitle: string;
  tokenPrefix: string;
  codePrefix: string;
  note: string;
  waiveFee: boolean;
  invitedBy: string | null;
  invitedByName: string;
  status: InvitationStatus;
  emailSent: boolean;
  emailError: string;
  applicationId: string | null;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  openedAt: string | null;
  appliedAt: string | null;
  revokedAt: string | null;
}

// =================================================================================================
// PURE — no database, no network, unit-tested
// =================================================================================================

/** 32 bytes of randomness, url-safe. Not a typed secret, so it is long rather than memorable. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** The first characters of a token, for the admin list. Never enough to reconstruct one. */
export function tokenPrefixOf(token: string): string {
  return String(token || '').slice(0, 8);
}

export function normaliseEmail(input: unknown): string {
  return String(input ?? '').trim().toLowerCase().slice(0, 160);
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

export function isEmail(input: unknown): boolean {
  return EMAIL_RE.test(normaliseEmail(input));
}

// =================================================================================================
// THE TYPED CODE — the half of an invitation that survives a broken link
// =================================================================================================
//
// A URL token is fine when the person can click it and useless when they cannot: an email client
// mangles the link, they read the mail on a phone and apply on a laptop, somebody reads it out over
// a call. The code is ERA-INV-XXXXX-XXXXX-XXXXX and is typed at /invite.
//
// ERA-INV, NOT ERA-SEL, AND THAT DISTINCTION IS LOAD-BEARING. ERA-SEL means somebody was already
// SELECTED and goes straight to onboarding with no application. /apply/gateway is built around the
// two doors never opening onto each other, because one hire holding both a selection and an
// application is the contradiction that whole gate exists to prevent. A code that looked like the
// other one would be an invitation into the wrong door.
//
// WHY THIS NEEDS MORE CARE THAN THE TOKEN. Fifteen characters is short enough to be guessed at, and
// a hit is not nothing: it reveals who was invited, to which posting, the line the administrator
// wrote them, and whether their fee was waived. Hence the shared alphabet, one sentence for every
// refusal, and attempts counted in the limiter this project already has.

/** Displayed as ERA-INV-XXXXX-XXXXX-XXXXX. Distinct from ERA-SEL on purpose — see above. */
export const INVITE_CODE_PREFIX = 'ERA-INV';

/** Per IP, per window. A code is typed by a person, so a human never comes close to this. */
export const CODE_ATTEMPTS_PER_IP = 10;
export const CODE_ATTEMPT_WINDOW_SECONDS = 600;

/** The one sentence every failed code gets. Wrong, spent, withdrawn and never-existed are the same. */
export const INVALID_CODE =
  'That code is not valid. If you were sent one, check it against the email you received, or reply '
  + 'to that message and we will look it up for you.';

export const RATE_LIMITED_CODE =
  'Too many attempts from this connection. Wait ten minutes and try again, or open the link in your '
  + 'invitation email instead.';

/** A fresh code body — CODE_BODY_LEN characters from the project's shared alphabet. */
export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_BODY_LEN; i++) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * What somebody typed, reduced to a comparable body — or null if it cannot be one.
 *
 * Accepts the whole displayed form, the body alone, lower case, and any spacing or punctuation,
 * because people paste what they were sent and type what they remember. Characters outside the
 * alphabet are DROPPED rather than rejected: the alphabet excludes O, 0, I and 1 precisely because
 * they are mistyped for one another, so a stray hyphen or space must not be treated as a wrong code.
 */
export function normaliseCode(input: unknown): string | null {
  const raw = String(input ?? '').toUpperCase();
  const withoutPrefix = raw.replace(/^\s*ERA[\s-]*INV[\s-]*/, '');
  const body = withoutPrefix.split('').filter((c) => CODE_ALPHABET.includes(c)).join('');
  return body.length === CODE_BODY_LEN ? body : null;
}

/** The displayed form. The only place the grouping is decided. */
export function formatCode(body: string): string {
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) {
    groups.push(body.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN));
  }
  return INVITE_CODE_PREFIX + '-' + groups.join('-');
}

export function hashCode(body: string): string {
  return createHash('sha256').update('invite-code:' + String(body || ''), 'utf8').digest('hex');
}

/** The first group only. Enough to recognise which invitation somebody means on a call. */
export function codePrefixOf(body: string): string {
  return String(body || '').slice(0, CODE_GROUP_LEN);
}

/**
 * The status an invitation actually has right now.
 *
 * Expiry is DERIVED rather than stored, so no scheduled job has to run for this column to stay
 * honest. A revoked invitation stays revoked even after its expiry date, because "the administrator
 * took this back" and "nobody used it in time" are different things to whoever reads the list.
 */
export function statusOf(
  row: { status: string; expiresAt: string | Date; appliedAt?: string | Date | null },
  now: Date = new Date(),
): InvitationStatus {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'applied' || row.appliedAt) return 'applied';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return row.status === 'opened' ? 'opened' : 'pending';
}

/** Only these two can still be walked through. Everything else is history. */
export function isLive(status: InvitationStatus): boolean {
  return status === 'pending' || status === 'opened';
}

/**
 * /invite/<token>, NOT /apply/invite/<token>.
 *
 * The first version of this lived under /apply, and every invitation link 302'd straight to the
 * application gate without the landing page ever running — src/middleware.ts gates the whole
 * `/apply` prefix, and its exemption list is matched EXACTLY and never by prefix, on purpose, so a
 * path with a token segment in it can never be exempted there. Weakening that check to admit this
 * page would trade a gate that is deny-by-default for one that is not, over a page that grants
 * nothing. Living outside the prefix is the correct answer, and it costs nothing: the landing page
 * hands off to /apply, which goes through the gate exactly as it should.
 *
 * THE ORIGIN IS NOT A PARAMETER, AND THAT IS THE SECOND FIX HERE. It was, and the route passed
 * `new URL(request.url).origin` — which on a serverless deployment is the address the FUNCTION was
 * invoked on. Production minted `https://localhost/invite/<token>`: a real token in a link nobody
 * outside the machine could open, with nothing to log because nothing failed. Resolving it inside
 * means no caller can get it wrong. See src/lib/public-origin.ts for why the Host header is not the
 * repair either.
 */
export function inviteUrl(token: string): string {
  return publicOrigin() + '/invite/' + encodeURIComponent(token);
}

export function ttlDays(input: unknown): number {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
}

export interface InviteInput {
  email: unknown;
  fullName?: unknown;
  roleSlug?: unknown;
  note?: unknown;
  waiveFee?: unknown;
  days?: unknown;
}

export interface CleanInvite {
  email: string;
  fullName: string;
  roleSlug: string;
  note: string;
  waiveFee: boolean;
  days: number;
}

/** Cap on the invitation note. Generous because it may now be formatted markup, not prose. */
export const NOTE_MAX = 8000;

/**
 * Does this note actually say anything?
 *
 * WHY THIS IS A QUESTION AT ALL. The note is written in a contenteditable composer, and a field that
 * was focused and then emptied does not come back as ''. It comes back as '<br>', '<p><br></p>',
 * '<span></span>' or a paragraph holding one non-breaking space - every one of those is a perfectly
 * non-empty STRING and none of them is a message. The composer strips the first two on the way out;
 * it cannot strip every shape, and it never sees a note written before it shipped.
 *
 * THE FAILURE THIS FIXES IS VISIBLE TO THE PERSON WE INVITED. An invitation went out with an empty
 * quote block sitting between two paragraphs - a bordered box with nothing in it, in a message that
 * is supposed to read as though a person wrote it. The same box rendered on the landing page.
 *
 * DECIDED FROM THE TEXT, NOT FROM THE MARKUP, so it survives whatever tags a paste brought with it.
 * An image-only note counts as content: a picture with no words is still something somebody chose
 * to send.
 */
export function hasVisibleNote(html: unknown): boolean {
  const raw = String(html ?? '');
  if (!raw.trim()) return false;
  if (/<\s*(img|hr)\b/i.test(raw)) return true;
  // Tags out, then the entities that render as blank out, then look for one printable character.
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;/gi, 'x')
    .replace(/\s+/g, '');
  return text.length > 0;
}

/** The note as it should be STORED: capped, and empty when it says nothing. See hasVisibleNote(). */
export function cleanNote(input: unknown): string {
  const trimmed = String(input ?? '').trim().slice(0, NOTE_MAX);
  return hasVisibleNote(trimmed) ? trimmed : '';
}

/**
 * Was this typed as an INVITATION code rather than a selection code?
 *
 * Used by /apply/gateway, which has one code box and gets both families typed into it. It answers
 * from the PREFIX ALONE and never from the body, on purpose: a mistyped ERA-SEL code has to keep
 * falling through to the selection path and its uniform refusal, or the gate's oldest rule - that a
 * failed code never silently becomes an application - would be back on the table. Somebody who types
 * a bare body with no prefix at that box is taken to mean the box they are standing in.
 */
export function looksLikeInviteCode(input: unknown): boolean {
  const bare = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return bare.startsWith('ERAINV') && bare.length === 'ERAINV'.length + CODE_BODY_LEN;
}

/**
 * Where an invitation sends somebody: the application, carrying the posting it named.
 *
 * THE ROLE HAS TO TRAVEL WITH THEM. Without ?role= the invited person lands on a blank application
 * and picks a posting out of a list, which is not what "you are invited to apply for Executive
 * Assistant to CEO" promised them - and it loses the role match the fee-waiver lookup makes later.
 */
export function inviteApplyHref(roleSlug: string): string {
  const slug = String(roleSlug || '').trim();
  return '/apply' + (slug ? '?role=' + encodeURIComponent(slug) : '');
}

/**
 * Validate and clean one invitation. Returns the problem as a sentence a person can act on, or the
 * cleaned record — never both, and never a half-cleaned one.
 */
export function parseInvite(input: InviteInput): { error: string } | { value: CleanInvite } {
  const email = normaliseEmail(input.email);
  if (!email) return { error: 'Enter the email address to invite.' };
  if (!isEmail(email)) return { error: 'That email address does not look right.' };
  return {
    value: {
      email,
      fullName: String(input.fullName ?? '').trim().slice(0, 120),
      roleSlug: String(input.roleSlug ?? '').trim().slice(0, 200),
      // 8000, not 1000. The note is now written in a composer and may carry markup, and a
      // paragraph of prose wrapped in tags is several times its own length - a 1000-char cap
      // silently truncated formatted notes mid-tag. It is still a cap: the note goes into an
      // email and onto a landing page, and neither is a document store.
      // cleanNote, not a bare trim. A composer that was focused and then emptied hands back markup
      // for a message nobody wrote, and storing that put an empty quote box in a real invitation.
      note: cleanNote(input.note),
      waiveFee: input.waiveFee === true || input.waiveFee === 'true' || input.waiveFee === 'on',
      days: ttlDays(input.days),
    },
  };
}

/** The one sentence every failed invitation link gets. Distinguishing them helps nobody outside. */
export const INVALID_LINK =
  'This invitation link is not valid any more. It may have been used, withdrawn, or expired.';

// =================================================================================================
// PERSISTENCE
// =================================================================================================

/** Local development only. Production gets this table from db/application-invitations-schema.sql. */
export function ensureInvitationSchema(): Promise<void> {
  return ensureOnce('application_invitations_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      role_id UUID,
      role_slug TEXT NOT NULL DEFAULT '',
      role_title TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL DEFAULT '',
      code_hash TEXT,
      code_prefix TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      waive_fee BOOLEAN NOT NULL DEFAULT FALSE,
      invited_by UUID,
      invited_by_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      email_error TEXT NOT NULL DEFAULT '',
      application_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS app_inv_token_uq ON application_invitations (token_hash)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS app_inv_code_uq ON application_invitations (code_hash) WHERE code_hash IS NOT NULL`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS app_inv_email_idx ON application_invitations (email, role_slug)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS app_inv_created_idx ON application_invitations (created_at DESC)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS app_inv_active_uq ON application_invitations (email, role_slug) WHERE status IN ('pending', 'opened')`);
  });
}

const COLS = `id, email, full_name, role_id, role_slug, role_title, token_prefix, code_prefix, note, waive_fee,
              invited_by, invited_by_name, status, email_sent, email_error, application_id,
              created_at, expires_at, sent_at, opened_at, applied_at, revoked_at`;

function toInvitation(r: any): Invitation {
  const base = {
    id: String(r.id),
    email: String(r.email || ''),
    fullName: String(r.full_name || ''),
    roleId: r.role_id ? String(r.role_id) : null,
    roleSlug: String(r.role_slug || ''),
    roleTitle: String(r.role_title || ''),
    tokenPrefix: String(r.token_prefix || ''),
    codePrefix: String(r.code_prefix || ''),
    note: String(r.note || ''),
    waiveFee: r.waive_fee === true,
    invitedBy: r.invited_by ? String(r.invited_by) : null,
    invitedByName: String(r.invited_by_name || ''),
    emailSent: r.email_sent === true,
    emailError: String(r.email_error || ''),
    applicationId: r.application_id ? String(r.application_id) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : '',
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  };
  return {
    ...base,
    status: statusOf({ status: String(r.status || ''), expiresAt: base.expiresAt, appliedAt: base.appliedAt }),
  };
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  invitation?: Invitation;
  /** Returned exactly once. Not recoverable afterwards. */
  token?: string;
  /** The same, for the typed form. Both are hashed at rest; this response is the only copy. */
  code?: string;
}

/**
 * Create one invitation, revoking any live one this person already holds for the same role.
 *
 * The revoke-then-insert pair runs inside a transaction: the partial unique index would otherwise
 * reject the insert on a re-invite, and a half-applied re-invite would leave the person holding a
 * revoked link and no new one.
 */
export async function createInvitation(args: {
  clean: CleanInvite;
  roleId: string | null;
  roleTitle: string;
  invitedBy: string | null;
  invitedByName: string;
}): Promise<CreateResult> {
  const token = generateToken();
  const code = generateCode();
  const expires = new Date(Date.now() + args.clean.days * 86400000).toISOString();
  try {
    const inserted = await db.transaction(async (tx: any) => {
      await tx.execute(sql`
        UPDATE application_invitations
           SET status = 'revoked', revoked_at = NOW()
         WHERE email = ${args.clean.email}
           AND role_slug = ${args.clean.roleSlug}
           AND status IN ('pending', 'opened')`);
      const r = await tx.execute(sql`
        INSERT INTO application_invitations
          (email, full_name, role_id, role_slug, role_title, token_hash, token_prefix,
           code_hash, code_prefix, note,
           waive_fee, invited_by, invited_by_name, expires_at)
        VALUES
          (${args.clean.email}, ${args.clean.fullName},
           ${args.roleId}::uuid,
           ${args.clean.roleSlug}, ${args.roleTitle},
           ${hashToken(token)}, ${tokenPrefixOf(token)},
           ${hashCode(code)}, ${codePrefixOf(code)}, ${args.clean.note},
           ${args.clean.waiveFee},
           ${args.invitedBy}::uuid,
           ${args.invitedByName}, ${expires}::timestamptz)
        RETURNING ${sql.raw(COLS)}`);
      return rows(r)[0];
    });
    if (!inserted) return { ok: false, error: 'The invitation could not be saved.' };
    return { ok: true, invitation: toInvitation(inserted), token, code: formatCode(code) };
  } catch (e: any) {
    fail('createInvitation', e);
    return { ok: false, error: e?.cause?.message || 'The invitation could not be saved.' };
  }
}

/**
 * Read one invitation by its token.
 *
 * Returns null for every failure — missing, revoked, expired, already used. The caller shows
 * INVALID_LINK, one sentence for all of them.
 */
export async function findByToken(token: string): Promise<Invitation | null> {
  const t = String(token || '').trim();
  if (!t) return null;
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       WHERE token_hash = ${hashToken(t)} LIMIT 1`);
    const row = rows(r)[0];
    return row ? toInvitation(row) : null;
  } catch (e: any) {
    fail('findByToken', e);
    return null;
  }
}

/** Read one invitation by its typed code. Null for every failure, same as findByToken. */
export async function findByCode(typed: string): Promise<Invitation | null> {
  const body = normaliseCode(typed);
  if (!body) return null;
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       WHERE code_hash = ${hashCode(body)} LIMIT 1`);
    const row = rows(r)[0];
    return row ? toInvitation(row) : null;
  } catch (e: any) {
    fail('findByCode', e);
    return null;
  }
}

export interface Resolution {
  invitation: Invitation | null;
  /** True when the caller has spent their allowance. The surface says so instead of INVALID_CODE. */
  rateLimited: boolean;
  /**
   * Whether the input was code-shaped, so the refusal can be worded as the person experienced it.
   * Telling somebody who carefully typed ERA-INV-... that their LINK has expired reads as a bug on
   * our side, and sends them looking for a link they may not have.
   */
  wasCode: boolean;
}

/**
 * The ONE lookup both surfaces use — the landing page and the code form.
 *
 * Two things live here rather than in either caller. First, an input can be a URL token or a typed
 * code and the person does not know or care which; second, the attempt limit has to bite wherever
 * the guess arrives, and a limiter that only guards the POST is not a limiter when the GET does the
 * same lookup.
 *
 * ONLY CODE-SHAPED INPUT IS COUNTED. A URL token is 43 characters of randomness and nobody is
 * guessing one; counting page loads of a valid link toward a limit would lock people out of their
 * own invitation for opening the email twice.
 *
 * FAILS CLOSED. If the limiter cannot be read, the answer is rate-limited rather than "carry on" —
 * the same reading src/lib/auth/recovery.ts takes, for the same reason.
 */
export async function resolveInvitation(input: string, ip: string): Promise<Resolution> {
  const raw = String(input || '').trim();
  if (!raw) return { invitation: null, rateLimited: false, wasCode: false };

  const byToken = await findByToken(raw);
  if (byToken) return { invitation: byToken, rateLimited: false, wasCode: false };

  const body = normaliseCode(raw);
  if (!body) return { invitation: null, rateLimited: false, wasCode: false };

  const bucket = 'invitecode:ip:' + createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 32);
  try {
    const used = await countAttempt(bucket, CODE_ATTEMPT_WINDOW_SECONDS);
    if (used > CODE_ATTEMPTS_PER_IP) return { invitation: null, rateLimited: true, wasCode: true };
  } catch (e: any) {
    fail('resolveInvitation limiter', e);
    return { invitation: null, rateLimited: true, wasCode: true };
  }

  return { invitation: await findByCode(body), rateLimited: false, wasCode: true };
}

export async function markOpened(id: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'opened', opened_at = COALESCE(opened_at, NOW())
       WHERE id = ${id}::uuid AND status = 'pending'`);
  } catch (e: any) {
    // An invitation that opened but could not record it is still a usable invitation. Never block
    // the person on our own bookkeeping.
    fail('markOpened', e);
  }
}

export async function recordSend(id: string, sent: boolean, error: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET email_sent = ${sent}, email_error = ${String(error || '').slice(0, 400)},
             sent_at = CASE WHEN ${sent} THEN NOW() ELSE sent_at END
       WHERE id = ${id}::uuid`);
  } catch (e: any) {
    fail('recordSend', e);
  }
}

export async function revokeInvitation(id: string, byUserId: string | null): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      UPDATE application_invitations
         SET status = 'revoked', revoked_at = NOW(), revoked_by = ${byUserId}::uuid
       WHERE id = ${id}::uuid AND status IN ('pending', 'opened')
      RETURNING id`);
    return rows(r).length > 0;
  } catch (e: any) {
    fail('revokeInvitation', e);
    return false;
  }
}

export async function listInvitations(limit = 200): Promise<Invitation[]> {
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       ORDER BY created_at DESC LIMIT ${limit}`);
    return rows(r).map(toInvitation);
  } catch (e: any) {
    // A read that failed is NOT "there are none". The caller is handed the failure so the screen can
    // say so, rather than rendering an empty list that reads as a confident nobody-was-invited.
    fail('listInvitations', e);
    throw e;
  }
}

/**
 * The live invitation this person holds for this role, if any — the fee-waiver lookup.
 *
 * A role-less ("open") invitation counts for any role: an administrator who invited somebody without
 * naming a posting meant the person, not the posting. A role-specific one wins when both exist.
 */
export async function liveInvitationFor(email: string, roleSlug: string): Promise<Invitation | null> {
  const e = normaliseEmail(email);
  if (!e) return null;
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       WHERE email = ${e}
         AND status IN ('pending', 'opened')
         AND expires_at > NOW()
         AND (role_slug = ${String(roleSlug || '')} OR role_slug = '')
       ORDER BY (role_slug <> '') DESC, created_at DESC
       LIMIT 1`);
    const row = rows(r)[0];
    return row ? toInvitation(row) : null;
  } catch (e2: any) {
    fail('liveInvitationFor', e2);
    return null;
  }
}

/**
 * Close the loop from the application side: this email now has an application, so whatever live
 * invitation they were holding is spent.
 *
 * Deliberately NOT matched on role. By the time an application exists the person may have applied
 * to a different posting than the one they were invited to, and an invitation left sitting at
 * "pending" would tell the administrator to chase somebody who already applied. Marking the most
 * recent live one is the answer that makes the admin list mean what it says.
 *
 * Swallows its own failures on purpose: this is bookkeeping that runs after an application has
 * already been created, and nothing here may put that application at risk.
 */
export async function markAppliedForEmail(email: string, applicationId: string | null): Promise<void> {
  const e = normaliseEmail(email);
  if (!e) return;
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'applied', applied_at = NOW(), application_id = ${applicationId}::uuid
       WHERE id = (
         SELECT id FROM application_invitations
          WHERE email = ${e} AND status IN ('pending', 'opened')
          ORDER BY created_at DESC LIMIT 1
       )`);
  } catch (e2: any) {
    fail('markAppliedForEmail', e2);
  }
}

// =================================================================================================
// THE POSTING AN INVITATION NAMED — resolved live, including for invitations sent long ago
// =================================================================================================
//
// WHY LIVE AND NOT THE STORED SNAPSHOT. role_title is written onto the invitation row when it is
// sent, which is right for the record: renaming a posting must not rewrite the history of who was
// invited to what. But two things the stored snapshot cannot tell anybody:
//
//   * whether the posting still accepts applications, and
//   * the title at all, for a row written before role_title was populated, or by an import that
//     only carried the slug - which is every "past" invitation on this deployment.
//
// So the record keeps its snapshot and the SCREEN asks the catalogue. That is the same rule the
// invite form at /admin/applications/invitations already follows for its dropdown, which is why the
// two cannot drift apart.

export interface LivePosting {
  slug: string;
  /** The title as the careers portal shows it today. Empty when the posting no longer exists. */
  title: string;
  /** Whether an application started right now would be accepted. */
  acceptsApplications: boolean;
  /** The sentence to show when it would not. */
  publicNote: string;
}

/**
 * Resolve several slugs in ONE query. Round-trip count is the lever on this deployment, so the list
 * screen must not ask the database once per row.
 *
 * NARROWED RETRY, because job_status arrives from db/xscale-schema.sql - a hand-run file that a given
 * database may not have had run against it. The retry names ONLY columns `roles` has always had, so
 * it cannot fail for the same reason the wide query did.
 *
 * A FAILED READ IS NOT AN EMPTY CATALOGUE. It returns null so the caller can say "not checked"
 * rather than rendering "this posting is closed" over a database hiccup.
 */
export async function livePostings(slugs: string[]): Promise<Map<string, LivePosting> | null> {
  const wanted = Array.from(new Set(slugs.map((s) => String(s || '').trim()).filter(Boolean)));
  if (!wanted.length) return new Map();
  const read = async (wide: boolean) => {
    const r = wide
      ? await db.execute(sql`SELECT slug, title, is_open, job_status, application_deadline
                               FROM roles WHERE slug IN ${textIn(wanted)}`)
      : await db.execute(sql`SELECT slug, title, is_open, application_deadline
                               FROM roles WHERE slug IN ${textIn(wanted)}`);
    return rows(r);
  };
  let raw: any[];
  try {
    raw = await read(true);
  } catch (e: any) {
    try {
      raw = await read(false);
    } catch (e2: any) {
      fail('livePostings', e2);
      return null;
    }
  }
  const out = new Map<string, LivePosting>();
  for (const x of raw) {
    const status = effectiveJobStatus({
      jobStatus: x.job_status, isOpen: x.is_open, applicationDeadline: x.application_deadline,
    });
    out.set(String(x.slug), {
      slug: String(x.slug),
      title: String(x.title || ''),
      acceptsApplications: !!status.acceptsApplications,
      publicNote: String((status as any).publicNote || ''),
    });
  }
  return out;
}

/** One slug. Null means "no such posting"; the thrown-read case is reported as null too - see above. */
export async function livePosting(slug: string): Promise<LivePosting | null> {
  const s = String(slug || '').trim();
  if (!s) return null;
  const map = await livePostings([s]);
  return map ? (map.get(s) || null) : null;
}

/**
 * The title to SHOW for an invitation: the catalogue's, then the snapshot, then nothing.
 *
 * This is the "synced for the past too" rule in one line. An invitation sent before the title was
 * being stored - or one whose posting has since been renamed - names the position correctly on
 * every screen, without any backfill having to run.
 */
export function displayRoleTitle(inv: { roleSlug: string; roleTitle: string }, live: LivePosting | null): string {
  return String(live?.title || inv.roleTitle || '');
}

// =================================================================================================
// THE GATE PASS AN INVITATION EARNS
// =================================================================================================
//
// THE BUG THIS EXISTS TO CLOSE. /apply and /onboarding are both behind the application gate, and a
// browser without a pass is redirected to /apply/gateway. So an invited person clicked "Open the
// application", read the landing page, pressed Continue - and was bounced to a screen asking for an
// ERA-SEL onboarding code, which an invitation is not and never was. The only code they held was
// the ERA-INV one in their email, so they typed that, and were told it was the wrong kind of code
// and to go to /invite, where they had just come from. A closed loop with our name on it.
//
// WHY THIS IS THE 'open' DOOR AND NOT A THIRD ONE. An invitation means exactly "please apply", which
// is what the open door grants, and it is a door anybody can walk through from /careers with no code
// at all. So this GRANTS NOTHING NEW. What it removes is a question we already knew the answer to:
// the invitation names the email address, so making the person retype it at a gate proves nothing.
//
// AND IT STILL IS NOT A SELECTION. door stays 'open', so applyGateRedirect() keeps this pass out of
// /onboarding exactly as before. An invitation cannot become a selection by walking through here -
// that separation is the whole reason the gate exists and nothing in this file weakens it.
export function invitationPassTtlSeconds(): number {
  return GATE_TTL_MINUTES * 60;
}

/**
 * Sign an open-door pass for the person this invitation was sent to.
 *
 * The email comes from the INVITATION, never from the request: a forwarded link must not let
 * somebody bind a pass to an address the invitation does not name, because the fee waiver is later
 * looked up by that address.
 *
 * Returns null when the gate cannot sign - a missing SESSION_SECRET - and the caller must then send
 * the person to the gate screen, which renders its own honest "not available" state.
 */
export function invitationPass(inv: Invitation, userId?: string | null): string | null {
  const { token } = issuePass({
    door: 'open',
    email: inv.email,
    userId: userId || null,
    invitationId: inv.id,
    roleSlug: inv.roleSlug || null,
  });
  return token;
}

export interface InviteDoorResult {
  ok: boolean;
  /** One sentence, safe to show. Never says which of wrong, spent, withdrawn or expired it was. */
  error?: string;
  status?: number;
  retryAfterSeconds?: number;
  /** The signed gate pass, on success. The caller sets the cookie. */
  token?: string;
  /** Where to send them: the application, on the posting they were invited to. */
  next?: string;
  invitation?: Invitation;
}

/**
 * An ERA-INV code typed at /apply/gateway, taken seriously instead of refused.
 *
 * WHAT WENT WRONG WITHOUT THIS. The gate has one code box and it is labelled ERA-SEL, so an invited
 * person typed the only code they had into it and was told: "That is an invitation code, not an
 * onboarding code ... Enter it at /invite instead." Which is where the link in their email had just
 * sent them. Two correct sentences, one dead end, and the person's conclusion is that our hiring
 * process is broken.
 *
 * THIS IS NOT THE "FAILED CODE SILENTLY BECOMES AN APPLICATION" TRAP. That rule exists so a MISTYPED
 * selection code cannot leave one hire holding both a selection and a contradictory application, and
 * it is untouched: the caller only reaches this function for input that carries the ERA-INV prefix
 * (looksLikeInviteCode), which no typo in an ERA-SEL code produces. What arrives here is a valid
 * credential of the other family, and honouring it is not a fallback - it is reading the code.
 *
 * THE EMAIL MUST MATCH THE INVITATION'S. Not as a barrier - the open door next to this one lets
 * anybody in with any address - but because the pass is bound to an email and the fee waiver is
 * looked up by it later. A pass bound to an address the invitation does not name would quietly fail
 * to carry the waiver the person was promised. A mismatch gets the SAME sentence as a wrong code, so
 * this cannot be used to test whether a given address was invited.
 */
export async function openDoorForInviteCode(args: {
  rawCode: string;
  claimedEmail: string;
  ip: string;
  userId?: string | null;
}): Promise<InviteDoorResult> {
  const resolved = await resolveInvitation(args.rawCode, args.ip);
  if (resolved.rateLimited) {
    return { ok: false, error: RATE_LIMITED_CODE, status: 429, retryAfterSeconds: CODE_ATTEMPT_WINDOW_SECONDS };
  }
  const inv = resolved.invitation;
  if (!inv || !isLive(inv.status)) return { ok: false, error: INVALID_CODE, status: 400 };
  if (normaliseEmail(args.claimedEmail) !== inv.email) return { ok: false, error: INVALID_CODE, status: 400 };

  const token = invitationPass(inv, args.userId);
  if (!token) {
    return {
      ok: false, status: 503,
      error: 'The application gate could not issue a pass just now. Please try again in a moment.',
    };
  }
  // Bookkeeping, and it must never be able to stop the person walking through the door.
  await markOpened(inv.id);
  return { ok: true, token, next: inviteApplyHref(inv.roleSlug), invitation: inv };
}

/** Close the loop for one known invitation. */
export async function markApplied(id: string, applicationId: string | null): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'applied', applied_at = NOW(), application_id = ${applicationId}::uuid
       WHERE id = ${id}::uuid AND status IN ('pending', 'opened')`);
  } catch (e: any) {
    fail('markApplied', e);
  }
}
