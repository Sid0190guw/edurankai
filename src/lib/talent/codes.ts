// src/lib/talent/codes.ts — ONBOARDING CODES. Spec section 16, the load-bearing module.
//
// A code says one thing: "the bearer of this secret was selected, by a named approver, for THIS
// opportunity, and may therefore go straight to onboarding." Everything dangerous about the feature
// follows from that sentence, so the rules live here once and every surface asks this module.
//
// ---------------------------------------------------------------------------------------------
// THIS FILE WAS RECONCILED, AND IT MATTERS WHY
// ---------------------------------------------------------------------------------------------
// An earlier pass wrote this module against a `tos_authorization_codes` table with its own alphabet
// (31 symbols), its own length (12), its own prefix (ERA-SEL) and its own rejection sentence. None
// of those tables are created by src/lib/talent/schema.ts, and src/lib/talent/types.ts already owned
// the vocabulary. That is the worst possible shape for a security primitive: two definitions of one
// code format, where the one that happens to be imported decides whether a code validates.
//
// So the vocabulary is now IMPORTED, never restated. CODE_ALPHABET, CODE_BODY_LEN, CODE_LIMITS,
// UNIFORM_REJECTION, RedeemOutcome and OnboardingCode all come from types.ts, and the persistence
// targets tal_onboarding_code — the table schema.ts actually creates.
//
// ---------------------------------------------------------------------------------------------
// THE FIVE THINGS THAT MAKE THIS SAFE
// ---------------------------------------------------------------------------------------------
// 1. THE SECRET IS NEVER STORED. tal_onboarding_code.code_hash holds sha256(normalised body) and
//    nothing else. The plaintext is returned exactly once, to the administrator who issued it, and
//    is unrecoverable afterwards. A database dump, a log line or a screenshot of that table cannot
//    onboard anybody.
//
// 2. LOOKUP IS BY HASH. Redemption hashes the input and hits a unique index. There is no
//    "find codes starting with..." path in this file, so there is nothing to walk.
//
// 3. ONE MESSAGE FOR EVERY REFUSAL — UNIFORM_REJECTION, spec 16.5. Wrong, expired, revoked,
//    exhausted and never-existed are indistinguishable to the caller, because an endpoint that
//    distinguishes them is an oracle telling an attacker which guesses hit a real record. The
//    RedeemOutcome union still carries the truth, for the audit log and the admin console, which
//    are entitled to it. This is the single most important line in the module.
//
// 4. ONE ACTIVE CODE PER SELECTION, enforced by the partial unique index tal_onbcode_active_uq —
//    not by convention. Re-issuing revokes the previous code first, so a selection can never sit on
//    two working secrets where revoking "the" code revokes one of them.
//
// 5. EVERY ATTEMPT IS RECORDED, and rate limiting reads that table rather than process memory. On a
//    serverless deployment an in-memory counter resets on almost every request, which is the same as
//    having no rate limit at all while looking like it has one.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------------------------
// Not `offer_letters.token` (a public read-URL for a letter) and not `invite_tokens` (a set-your-
// password link for a users row that already exists). Neither is bound to an opportunity, neither
// has revocation, use accounting or an approver, and both are URL tokens rather than a secret a
// human types.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { ensureTalentSchema } from './schema';
import { allocateCode } from './ids';
import {
  rowsOf, reasonOf,
  CODE_ALPHABET, CODE_GROUP_LEN, CODE_GROUPS, CODE_BODY_LEN, CODE_LIMITS, UNIFORM_REJECTION,
  CODE_DISPLAY_PREFIX,
  type OnboardingCode, type OnboardingCodeStatus, type RedeemOutcome, type IssuedCode,
} from './types';

// The vocabulary is re-exported so a consumer has one import for the whole code story, but it is
// DEFINED in types.ts. Nothing in this file may shadow it.
export {
  CODE_ALPHABET, CODE_GROUP_LEN, CODE_GROUPS, CODE_BODY_LEN, CODE_LIMITS, UNIFORM_REJECTION,
  CODE_DISPLAY_PREFIX,
};
export type { OnboardingCode, OnboardingCodeStatus, RedeemOutcome, IssuedCode };

// ---------------------------------------------------------------------------------------------
// FORMAT — 32 symbols, 15 characters, ~75 bits. Spec 16.1.
// ---------------------------------------------------------------------------------------------

/**
 * Remove the ERA-SEL display prefix if the caller pasted it, and only then.
 *
 * THE LENGTH TEST IS THE WHOLE SAFETY ARGUMENT. A blanket "strip ERASEL wherever it starts a code"
 * would eat six REAL characters out of a body that happens to begin with them — E, R, A, S and L
 * are every one of them in CODE_ALPHABET, so such a body is perfectly issuable. Stripping only when
 * what remains is exactly CODE_BODY_LEN makes the two cases distinguishable with no ambiguity left.
 */
function stripDisplayPrefix(stripped: string): string {
  const p = CODE_DISPLAY_PREFIX.replace(/[^A-Z0-9]/g, '');
  if (stripped.length === p.length + CODE_BODY_LEN && stripped.startsWith(p)) return stripped.slice(p.length);
  return stripped;
}

/**
 * Normalise anything a human might paste into the canonical 15-character body.
 *
 * Accepts lower case, spaces, tabs, the hyphens from the display grouping, and any dash character a
 * mail client substituted. Returns the bare body, or null when what is left is not a code shape.
 *
 * IT NEVER AUTO-CORRECTS AN EXCLUDED CHARACTER. O to 0 and I to 1 look like kindnesses, but a code
 * containing one was never issued by us, and silently rewriting it turns a typo into a DIFFERENT
 * guess — which is both a worse error message and, at scale, free extra attempts against the limiter.
 */
export function normaliseCode(input: string): string | null {
  const s = stripDisplayPrefix(String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (s.length !== CODE_BODY_LEN) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/**
 * The display form: three groups of five, hyphen separated.
 *
 * NAMED formatSecret, NOT formatCode. src/lib/talent/ids.ts already exports formatCode() for the
 * ERAI-* identifier series, and two functions called formatCode in one module namespace is exactly
 * how the wrong one gets imported.
 */
export function formatSecret(body: string): string {
  const b = String(body || '');
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) groups.push(b.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN));
  const grouped = groups.filter(Boolean).join('-');
  // An empty body must stay empty rather than becoming a bare "ERA-SEL", which would look to an
  // operator like a code that had been issued.
  return grouped ? CODE_DISPLAY_PREFIX + '-' + grouped : '';
}

/**
 * Why a malformed entry was rejected, in words a candidate can act on.
 *
 * SAFE TO SHOW, because it is decided from the INPUT ALONE and never touches the database. It says
 * "this is not the shape of a code", which reveals nothing about which codes exist. A caller must
 * still not fall through to a lookup after showing it.
 */
export function formatProblem(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return 'Enter the onboarding code you were sent.';
  // The COUNT is taken after a lenient prefix strip, unlike normaliseCode's strict one: this
  // function only produces an error message, so counting "ERA-SEL-ABCD-EFGH" as 12 characters and
  // not 18 is what makes the message act on the part the candidate can actually fix.
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pfx = CODE_DISPLAY_PREFIX.replace(/[^A-Z0-9]/g, '');
  const stripped = bare.startsWith(pfx) && bare.length !== CODE_BODY_LEN ? bare.slice(pfx.length) : bare;
  if (stripped.length !== CODE_BODY_LEN) {
    return `An onboarding code has ${CODE_BODY_LEN} characters, shown in three groups of ${CODE_GROUP_LEN}. This one has ${stripped.length}.`;
  }
  const bad = Array.from(new Set(Array.from(stripped).filter((c) => !CODE_ALPHABET.includes(c))));
  if (bad.length) {
    return `Onboarding codes never contain the characters O, I, 0 or 1. Check "${bad.join('", "')}" against the code you were sent.`;
  }
  return null;
}

/**
 * The CSPRNG. randomInt, never Math.random — a predictable token generator has sunk enough products
 * that it is worth naming here so nobody "optimises" it later.
 */
export function generateSecret(): string {
  let out = '';
  for (let i = 0; i < CODE_BODY_LEN; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}

/** sha256 of the NORMALISED body. Hashing raw input would make punctuation significant. */
export function hashCode(body: string): string {
  return createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

/**
 * The non-secret handle an operator can search on: the FIRST GROUP of the secret.
 *
 * THIS COSTS ENTROPY AND THE COST IS STATED RATHER THAN HIDDEN. Publishing five of fifteen
 * characters takes the secret from ~75 bits to ~50. That is deliberate — schema.ts indexes
 * code_prefix precisely so the people desk can answer "the code starting ABCDE" without being able
 * to reconstruct it — and 50 bits is still many orders of magnitude beyond what CODE_LIMITS
 * (5 attempts per IP per 10 minutes, auto-revoke after 10 lifetime failures) could ever search.
 * If that tradeoff is ever unwanted, the fix is a separate random handle, not a shorter prefix.
 */
export function codePrefixOf(body: string): string {
  return String(body || '').slice(0, CODE_GROUP_LEN);
}

/** Compare two digests without leaking their difference through timing. */
export function digestsEqual(a: string, b: string): boolean {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export function emailsMatch(a: string, b: string): boolean {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// THE DECISION — pure, so every rule is testable with no database at all.
// ---------------------------------------------------------------------------------------------

export interface RedeemContext {
  now: Date;
  /** What the person redeeming claims their email is. The identity confirmation. */
  claimedEmail: string;
  /** Set when redemption is attempted against a particular opportunity. */
  againstOpportunityId?: string | null;
  /** Joined from tal_selection_decision. A code must not outlive its own decision. */
  selectionApproved?: boolean;
  selectionWithdrawn?: boolean;
}

export interface RedeemDecision {
  ok: boolean;
  /** The truth, for the audit log and the admin console. NEVER put this on the wire. */
  outcome: RedeemOutcome;
  /** What the candidate is shown. UNIFORM_REJECTION for every refusal, without exception. */
  message: string;
}

export function isNotYetValid(r: { validFrom: string | Date }, now: Date): boolean {
  const t = r.validFrom instanceof Date ? r.validFrom : new Date(r.validFrom);
  if (Number.isNaN(t.getTime())) return false; // an unreadable start date is not a reason to refuse
  return t.getTime() > now.getTime();
}

export function isExpired(r: { validUntil: string | Date }, now: Date): boolean {
  const t = r.validUntil instanceof Date ? r.validUntil : new Date(r.validUntil);
  // An UNREADABLE expiry is treated as EXPIRED. Failing closed on a corrupt timestamp is the only
  // safe reading; the alternative is a code that never expires because its date got mangled.
  if (Number.isNaN(t.getTime())) return true;
  return t.getTime() <= now.getTime();
}

export function isExhausted(r: { maxUses: number; usedCount: number }): boolean {
  const max = Number(r.maxUses);
  const used = Number(r.usedCount);
  if (!Number.isFinite(max) || max <= 0) return true;
  if (!Number.isFinite(used)) return true;
  return used >= max;
}

/**
 * May this code be redeemed?
 *
 * EVERY REFUSAL RETURNS UNIFORM_REJECTION. The ordering below therefore does not exist to control
 * disclosure — nothing is disclosed — it exists so the OUTCOME recorded in the audit log is the
 * most specific true reason, which is what an administrator needs when a candidate calls.
 */
export function decideRedeem(code: OnboardingCode | null, ctx: RedeemContext): RedeemDecision {
  const no = (outcome: RedeemOutcome): RedeemDecision => ({ ok: false, outcome, message: UNIFORM_REJECTION });

  if (!code) return no('unknown');

  // Identity confirmation. Checked first because it is the commonest genuine mismatch, and because
  // an attacker who does not hold the bound email should burn their attempt budget here.
  if (code.requiresIdentityConfirmation && !emailsMatch(code.boundEmailNorm, ctx.claimedEmail)) {
    return no('subject_mismatch');
  }

  if (code.status === 'revoked') return no('revoked');
  if (code.status === 'consumed' || isExhausted(code)) return no('exhausted');
  if (isNotYetValid(code, ctx.now)) return no('not_yet_valid');
  if (code.status === 'expired' || isExpired(code, ctx.now)) return no('expired');

  // The decision behind the code must still stand. A code is a pointer to a selection; if the
  // selection was withdrawn, the pointer must not still open the door.
  if (ctx.selectionWithdrawn) return no('selection_withdrawn');
  if (ctx.selectionApproved === false) return no('selection_not_approved');

  // Bound to the opportunity. A code minted for one opportunity must never open another — that is
  // precisely how a convenience becomes a privilege-escalation primitive.
  if (ctx.againstOpportunityId && code.opportunityId && ctx.againstOpportunityId !== code.opportunityId) {
    return no('unknown');
  }

  // Any status this module does not recognise is NOT an implicit yes.
  if (code.status !== 'active') return no('unknown');

  return { ok: true, outcome: 'ok', message: 'Code accepted.' };
}

// ---------------------------------------------------------------------------------------------
// RATE LIMITING — pure, driven entirely by CODE_LIMITS.
// ---------------------------------------------------------------------------------------------

export interface AttemptRow { at: string | Date; outcome: string }

export interface RateDecision {
  limited: boolean;
  failures: number;
  retryAfterMs: number;
  /** Spec 16.5: a challenge is demanded before the hard limit, not instead of it. */
  captchaRequired: boolean;
}

/**
 * Should this attempt be refused before the code is even looked up?
 *
 * Counts FAILURES only: somebody who redeems successfully and returns to the screen has not spent
 * anybody's budget. Refusal is deliberately silent about which limit was hit.
 */
export function rateLimitDecision(
  attempts: AttemptRow[],
  now: Date,
  limit: number = CODE_LIMITS.perIpAttempts,
  windowMs: number = CODE_LIMITS.perIpWindowMinutes * 60 * 1000,
): RateDecision {
  const since = now.getTime() - windowMs;
  const recent = (attempts || []).filter((a) => {
    const t = a.at instanceof Date ? a.at.getTime() : new Date(a.at).getTime();
    return Number.isFinite(t) && t >= since && a.outcome !== 'ok';
  });
  const captchaRequired = recent.length >= CODE_LIMITS.captchaAfter;
  if (recent.length < limit) {
    return { limited: false, failures: recent.length, retryAfterMs: 0, captchaRequired };
  }
  const oldest = recent.reduce((min, a) => {
    const t = a.at instanceof Date ? a.at.getTime() : new Date(a.at).getTime();
    return t < min ? t : min;
  }, Number.POSITIVE_INFINITY);
  return {
    limited: true,
    failures: recent.length,
    retryAfterMs: Math.max(0, oldest + windowMs - now.getTime()),
    captchaRequired,
  };
}

/** Shown when the limiter refuses. Says nothing about any code. */
export const RATE_LIMITED_MESSAGE =
  'Too many attempts from here in the last few minutes. Wait a short while and try again, or reply to the message you received from EduRankAI.';

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_onboarding_code
// ---------------------------------------------------------------------------------------------

async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

function toCode(x: any): OnboardingCode {
  return {
    id: String(x.id),
    codeId: String(x.code_id),
    codePrefix: String(x.code_prefix || ''),
    selectionId: String(x.selection_id),
    personId: String(x.person_id),
    boundEmailNorm: String(x.bound_email_norm || ''),
    opportunityId: String(x.opportunity_id),
    positionId: x.position_id ? String(x.position_id) : null,
    departmentId: x.department_id ? String(x.department_id) : null,
    employmentType: x.employment_type ? String(x.employment_type) : null,
    maxUses: Number(x.max_uses),
    usedCount: Number(x.used_count),
    requiresIdentityConfirmation: x.requires_identity_confirmation !== false,
    validFrom: x.valid_from ? new Date(x.valid_from).toISOString() : new Date().toISOString(),
    validUntil: x.valid_until ? new Date(x.valid_until).toISOString() : new Date(0).toISOString(),
    status: String(x.status) as OnboardingCodeStatus,
    multiUseReason: x.multi_use_reason ? String(x.multi_use_reason) : null,
    issuedBy: String(x.issued_by || ''),
    issuedAt: x.issued_at ? new Date(x.issued_at).toISOString() : new Date().toISOString(),
    deliveredAt: x.delivered_at ? new Date(x.delivered_at).toISOString() : null,
    deliveryChannel: x.delivery_channel ? String(x.delivery_channel) : null,
    deliveryError: x.delivery_error ? String(x.delivery_error) : null,
    revokedBy: x.revoked_by ? String(x.revoked_by) : null,
    revokedAt: x.revoked_at ? new Date(x.revoked_at).toISOString() : null,
    revokedReason: x.revoked_reason ? String(x.revoked_reason) : null,
    supersedesCodeId: x.supersedes_code_id ? String(x.supersedes_code_id) : null,
    failedAttempts: Number(x.failed_attempts || 0),
  };
}

const CODE_COLUMNS = `id, code_id, code_prefix, selection_id, person_id, bound_email_norm,
  opportunity_id, position_id, department_id, employment_type, max_uses, used_count,
  requires_identity_confirmation, valid_from, valid_until, status, multi_use_reason,
  issued_by, issued_at, delivered_at, delivery_channel, delivery_error,
  revoked_by, revoked_at, revoked_reason, supersedes_code_id, failed_attempts`;

export interface IssueArgs {
  selectionId: string;
  issuedByUserId: string;
  validityDays?: number;
  maxUses?: number;
  multiUseReason?: string;
  /** Sensitive positions get the tighter ceilings from CODE_LIMITS. Spec 16.2. */
  sensitive?: boolean;
  replaceReason?: string;
}

export interface IssueResult {
  ok: boolean;
  error?: string;
  /** The plaintext, formatted for display. Returned ONCE and never recoverable, by anybody. */
  secret?: string;
  code?: OnboardingCode;
  /** Set when an earlier live code for this selection was revoked to make room. */
  replacedCodeRef?: string;
}

/**
 * Mint a code against an APPROVED selection.
 *
 * The selection is re-read here rather than trusted from the caller: the button that triggers this
 * sits on an admin page whose data may be a minute old, and "issue a code for a selection that was
 * withdrawn while the page was open" is an ordinary sequence, not a hypothetical.
 */
export async function issueCode(args: IssueArgs): Promise<IssueResult> {
  try {
    const { db, sql } = await ctx();

    const sel = rowsOf(await db.execute(sql`
      SELECT id, application_id, person_id, opportunity_id, decision, position_id, department_id,
             employment_type, approved_for_onboarding_at, withdrawn_at
      FROM tal_selection_decision WHERE id = ${args.selectionId}::uuid LIMIT 1
    `));
    if (!sel.length) return { ok: false, error: 'That selection could not be read back, so no code was issued.' };
    const s = sel[0] as any;

    if (s.withdrawn_at) return { ok: false, error: 'That selection has been withdrawn. Reinstate it before issuing a code.' };
    if (String(s.decision) !== 'selected') {
      return { ok: false, error: `A code can only be issued against a selection decision of "selected". This one is "${s.decision}".` };
    }
    if (!s.approved_for_onboarding_at) {
      return { ok: false, error: 'That selection has not been approved for onboarding yet. Approval comes before a code.' };
    }

    // The email the code binds to is read from the person record, never passed in. A caller-supplied
    // binding is a caller-supplied way to redirect somebody else's onboarding to your own inbox.
    const per = rowsOf(await db.execute(sql`
      SELECT primary_email FROM tal_person WHERE id = ${String(s.person_id)}::uuid LIMIT 1
    `));
    const boundEmail = String((per[0] as any)?.primary_email || '').trim().toLowerCase();
    if (!boundEmail) {
      return { ok: false, error: 'That person has no primary email on record, so a code could not be bound to anybody.' };
    }

    const maxValidity = args.sensitive ? CODE_LIMITS.sensitiveMaxValidityDays : CODE_LIMITS.maxValidityDays;
    const days = Math.min(maxValidity, Math.max(1, Number(args.validityDays) || CODE_LIMITS.defaultValidityDays));
    const ceilingUses = args.sensitive ? CODE_LIMITS.sensitiveMaxUses : 5;
    const maxUses = Math.min(ceilingUses, Math.max(1, Number(args.maxUses) || 1));
    // A multi-use code is an exception and has to say why it exists. Spec 16.2.
    if (maxUses > 1 && !String(args.multiUseReason || '').trim()) {
      return { ok: false, error: 'A code that may be used more than once needs a written reason.' };
    }

    // Revoke any live code for this selection FIRST: the partial unique index would refuse the
    // insert otherwise, and "the button did nothing" is worse than an explicit rotation.
    const prior = rowsOf(await db.execute(sql`
      SELECT id, code_id FROM tal_onboarding_code
      WHERE selection_id = ${args.selectionId}::uuid AND status = 'active' LIMIT 1
    `));
    let replacedCodeRef: string | undefined;
    let supersedes: string | null = null;
    if (prior.length) {
      const p = prior[0] as any;
      replacedCodeRef = String(p.code_id);
      supersedes = String(p.id);
      await db.execute(sql`
        UPDATE tal_onboarding_code
        SET status = 'revoked', revoked_at = NOW(), revoked_by = ${args.issuedByUserId}::uuid,
            revoked_reason = ${String(args.replaceReason || 'Replaced by a newly issued code').slice(0, 500)}
        WHERE id = ${supersedes}::uuid AND status = 'active'
      `);
    }

    // Retry on collision. A 75-bit body will not collide in this lifetime, but the loop costs
    // nothing and turns an impossible-in-theory event into a retry rather than a lost issue.
    let lastErr = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = generateSecret();
      const publicRef = await allocateCode('onboardingCode');
      try {
        const ins = rowsOf(await db.execute(sql`
          INSERT INTO tal_onboarding_code (
            code_id, code_prefix, code_hash, selection_id, person_id, bound_email_norm,
            opportunity_id, position_id, department_id, employment_type,
            max_uses, used_count, requires_identity_confirmation,
            valid_from, valid_until, status, multi_use_reason, issued_by, issued_at,
            supersedes_code_id, failed_attempts
          ) VALUES (
            ${publicRef}, ${codePrefixOf(body)}, ${hashCode(body)},
            ${String(s.id)}::uuid, ${String(s.person_id)}::uuid, ${boundEmail},
            ${String(s.opportunity_id)}::uuid,
            ${s.position_id ? sql`${String(s.position_id)}::uuid` : sql`NULL`},
            ${s.department_id ? String(s.department_id) : null},
            ${s.employment_type ? String(s.employment_type) : null},
            ${maxUses}, 0, TRUE,
            NOW(), NOW() + make_interval(days => ${days}), 'active',
            ${maxUses > 1 ? String(args.multiUseReason).slice(0, 500) : null},
            ${args.issuedByUserId}::uuid, NOW(),
            ${supersedes ? sql`${supersedes}::uuid` : sql`NULL`}, 0
          ) RETURNING ${sql.raw(CODE_COLUMNS)}
        `));
        return { ok: true, secret: formatSecret(body), code: toCode(ins[0]), replacedCodeRef };
      } catch (e: any) {
        if (String(e?.cause?.code || e?.code) !== '23505') throw e;
        lastErr = reasonOf(e);
      }
    }
    return { ok: false, error: `Could not mint a unique code after five attempts (${lastErr}).` };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

/** Look a code up by its SECRET. There is no prefix-search path here, so there is nothing to walk. */
export async function findByCode(body: string): Promise<OnboardingCode | null> {
  const { db, sql } = await ctx();
  const r = rowsOf(await db.execute(sql`
    SELECT ${sql.raw(CODE_COLUMNS)} FROM tal_onboarding_code WHERE code_hash = ${hashCode(body)} LIMIT 1
  `));
  return r.length ? toCode(r[0]) : null;
}

/** The selection behind a code, for the two selection checks in decideRedeem(). */
export async function selectionStateFor(selectionId: string): Promise<{ approved: boolean; withdrawn: boolean } | null> {
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT approved_for_onboarding_at, withdrawn_at, decision
      FROM tal_selection_decision WHERE id = ${selectionId}::uuid LIMIT 1
    `));
    if (!r.length) return null;
    const x = r[0] as any;
    return {
      approved: !!x.approved_for_onboarding_at && String(x.decision) === 'selected',
      withdrawn: !!x.withdrawn_at,
    };
  } catch (e: any) {
    console.error('[talent-codes] selectionStateFor: ' + reasonOf(e));
    return null;
  }
}

/**
 * Record an attempt, and auto-revoke a code that has been hammered.
 *
 * NEVER throws: a failure to log must not become a failure to answer, and it must never become an
 * accidental allow — the decision is already made by the time this runs.
 */
export async function recordAttempt(a: {
  codeRowId: string | null; codePrefix: string | null; outcome: RedeemOutcome | 'malformed';
  ip: string | null; userAgent: string | null;
}): Promise<void> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO tal_onboarding_code_attempt (code_id, code_prefix, outcome, ip_address, user_agent)
      VALUES (${a.codeRowId ? sql`${a.codeRowId}::uuid` : sql`NULL`},
              ${a.codePrefix || null}, ${a.outcome}, ${a.ip || null}, ${a.userAgent || null})
    `);
    if (a.codeRowId && a.outcome !== 'ok') {
      // AUTO-REVOKE AFTER perCodeFailures LIFETIME FAILURES — spec 16.5. The window limiter stops a
      // burst; this stops a patient attacker who spreads attempts out over days. Done in ONE
      // statement so the count and the revocation cannot disagree.
      await db.execute(sql`
        UPDATE tal_onboarding_code
        SET failed_attempts = failed_attempts + 1,
            status = CASE WHEN failed_attempts + 1 >= ${CODE_LIMITS.perCodeFailures} AND status = 'active'
                          THEN 'revoked' ELSE status END,
            revoked_at = CASE WHEN failed_attempts + 1 >= ${CODE_LIMITS.perCodeFailures} AND status = 'active'
                              THEN NOW() ELSE revoked_at END,
            revoked_reason = CASE WHEN failed_attempts + 1 >= ${CODE_LIMITS.perCodeFailures} AND status = 'active'
                                  THEN 'Automatically withdrawn after repeated failed attempts' ELSE revoked_reason END
        WHERE id = ${a.codeRowId}::uuid
      `);
    }
  } catch (e: any) {
    console.error('[talent-codes] attempt log failed: ' + reasonOf(e));
  }
}

/**
 * Recent attempts from one address, for the limiter.
 *
 * FAILS CLOSED. If the attempt history cannot be read the limiter cannot do its job, and the safe
 * answer is to behave as though the budget is spent rather than wave everybody through.
 */
export async function recentAttempts(ip: string | null): Promise<AttemptRow[]> {
  if (!ip) return [];
  try {
    const { db, sql } = await ctx();
    const since = new Date(Date.now() - CODE_LIMITS.perIpWindowMinutes * 60 * 1000).toISOString();
    const r = rowsOf(await db.execute(sql`
      SELECT attempted_at AS at, outcome FROM tal_onboarding_code_attempt
      WHERE ip_address = ${ip} AND attempted_at >= ${since}::timestamptz
      ORDER BY attempted_at DESC LIMIT 100
    `));
    return r as AttemptRow[];
  } catch (e: any) {
    console.error('[talent-codes] attempt read failed: ' + reasonOf(e));
    return Array.from({ length: CODE_LIMITS.perIpAttempts }, () => ({ at: new Date(), outcome: 'unknown' }));
  }
}

/**
 * Consume one use, ATOMICALLY.
 *
 * The WHERE clause re-asserts every condition decideRedeem() checked. This is not belt-and-braces:
 * it is the only thing standing between two simultaneous submissions of one single-use code and two
 * onboardings. Zero rows returned means somebody else won the race and the caller MUST NOT proceed.
 */
export async function consumeCode(codeRowId: string, ip: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_code
      SET used_count = used_count + 1,
          status = CASE WHEN used_count + 1 >= max_uses THEN 'consumed' ELSE status END
      WHERE id = ${codeRowId}::uuid
        AND status = 'active'
        AND valid_from <= NOW()
        AND valid_until > NOW()
        AND used_count < max_uses
      RETURNING id, used_count, status
    `));
    if (!r.length) {
      return { ok: false, error: 'That code was used or withdrawn a moment ago. Nothing has been started twice.' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

/** Withdraw a live code. Idempotent: revoking an already-revoked code is not an error. */
export async function revokeCode(codeRowId: string, byUserId: string, reason: string): Promise<{ ok: boolean; error?: string; changed: boolean }> {
  try {
    const { db, sql } = await ctx();
    const why = String(reason || '').trim();
    if (!why) return { ok: false, changed: false, error: 'A withdrawal needs a written reason.' };
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_code
      SET status = 'revoked', revoked_at = NOW(), revoked_by = ${byUserId}::uuid,
          revoked_reason = ${why.slice(0, 500)}
      WHERE id = ${codeRowId}::uuid AND status = 'active'
      RETURNING id
    `));
    return { ok: true, changed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, changed: false, error: reasonOf(e) };
  }
}

/**
 * Sweep codes past their validity into an explicit 'expired' status.
 *
 * Redemption does not depend on this — decideRedeem() compares timestamps and refuses them anyway.
 * It exists so the admin register and its counts tell the truth without every reader recomputing
 * expiry, and so the partial unique index frees up for a re-issue.
 */
export async function expireStaleCodes(): Promise<number> {
  try {
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_code SET status = 'expired'
      WHERE status = 'active' AND valid_until <= NOW() RETURNING id
    `));
    return r.length;
  } catch (e: any) {
    console.error('[talent-codes] expire sweep failed: ' + reasonOf(e));
    return 0;
  }
}

/** The admin register. Never returns a hash, and there is no column here that could rebuild a secret. */
export async function listCodes(filter: { status?: string; limit?: number; offset?: number } = {}): Promise<OnboardingCode[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const r = filter.status
      ? rowsOf(await db.execute(sql`SELECT ${sql.raw(CODE_COLUMNS)} FROM tal_onboarding_code WHERE status = ${filter.status} ORDER BY issued_at DESC LIMIT ${limit} OFFSET ${offset}`))
      : rowsOf(await db.execute(sql`SELECT ${sql.raw(CODE_COLUMNS)} FROM tal_onboarding_code ORDER BY issued_at DESC LIMIT ${limit} OFFSET ${offset}`));
    return r.map(toCode);
  } catch (e: any) {
    console.error('[talent-codes] listCodes: ' + reasonOf(e));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// THE REGISTER — what /admin/talent/codes reads. Spec 16.7.
// ---------------------------------------------------------------------------------------------
//
// WHY THESE RETHROW WHEN listCodes() ABOVE DOES NOT. listCodes() swallows its error and returns [],
// which is survivable on /admin/talent/selected because there it is a side lookup beside a board
// that fails honestly — a missing revoke button is a visible degradation, not a false statement.
// It is the wrong contract for a page whose ENTIRE content is this list: "no code has ever been
// issued" and "the register could not be read" would render as the same empty screen and mean
// opposite things, and the second one wearing the first one's clothes is how somebody issues a
// second code to a person who already holds a live one. Same queries, two contracts, per surface.
//
// NOTHING HERE CAN REBUILD A SECRET. code_hash is not selected, and code_prefix is the deliberate
// five-character handle documented on codePrefixOf(). A register that could show the code back would
// defeat the one property that makes this whole feature safe.

/** One row of the register: the code, plus the names an operator needs to recognise it by. */
export interface CodeRegisterRow extends OnboardingCode {
  personName: string;
  personCode: string;
  personEmail: string;
  opportunityTitle: string;
  selectionCode: string;
  issuedByName: string;
  revokedByName: string;
}

export interface RegisterFilter {
  /** 'all', or any OnboardingCodeStatus. */
  status?: string;
  /** Matches the code reference, the five-character handle, the bound email, the name or person code. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** The columns of tal_onboarding_code, qualified for the joined query below. */
const CODE_COLUMNS_C = CODE_COLUMNS.split(',').map((c) => 'c.' + c.trim()).join(', ');

/** Delivery routes an operator may record. Free text would not be countable. */
export const DELIVERY_CHANNELS = ['email', 'phone', 'secure_message', 'in_person', 'post'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  phone: 'Read out by phone',
  secure_message: 'Secure message',
  in_person: 'In person',
  post: 'Post',
};

/**
 * The register. RETHROWS — see the note at the top of this section.
 *
 * The search term is matched against code_prefix by EQUALITY as well as by ILIKE on the other
 * columns, because tal_onbcode_prefix_idx makes that comparison indexed and it is the lookup an
 * operator actually performs: a candidate reads the first group of their code down the phone, and
 * the desk has to find which code that is without ever seeing the rest of it.
 */
export async function codeRegister(filter: RegisterFilter = {}): Promise<CodeRegisterRow[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 100));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const status = filter.status && filter.status !== 'all' ? String(filter.status) : null;
    const q = String(filter.q || '').trim();
    const term = q || null;
    const handle = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_GROUP_LEN);
    // LIKE metacharacters are escaped, so a term containing a per-cent sign does not silently become
    // a match-everything scan — which on a search box reads as "the filter is broken".
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(CODE_COLUMNS_C)},
             COALESCE(p.display_name, '')   AS person_name,
             COALESCE(p.person_code, '')    AS person_code,
             COALESCE(p.primary_email, '')  AS person_email,
             COALESCE(o.title, '')          AS opportunity_title,
             COALESCE(s.selection_code, '') AS selection_code,
             COALESCE(iu.name, '')          AS issued_by_name,
             COALESCE(ru.name, '')          AS revoked_by_name
        FROM tal_onboarding_code c
        LEFT JOIN tal_person p              ON p.id = c.person_id
        LEFT JOIN tal_opportunity o         ON o.id = c.opportunity_id
        LEFT JOIN tal_selection_decision s  ON s.id = c.selection_id
        LEFT JOIN users iu                  ON iu.id = c.issued_by
        LEFT JOIN users ru                  ON ru.id = c.revoked_by
       WHERE (${status}::text IS NULL OR c.status = ${status})
         AND (${term}::text IS NULL
              OR c.code_prefix = ${handle}
              OR c.code_id ILIKE ${like}
              OR c.bound_email_norm ILIKE ${like}
              OR p.display_name ILIKE ${like}
              OR p.person_code ILIKE ${like})
       ORDER BY c.issued_at DESC
       LIMIT ${limit} OFFSET ${offset}`));
    return rows.map((x: any) => ({
      ...toCode(x),
      personName: String(x.person_name || ''),
      personCode: String(x.person_code || ''),
      personEmail: String(x.person_email || ''),
      opportunityTitle: String(x.opportunity_title || ''),
      selectionCode: String(x.selection_code || ''),
      issuedByName: String(x.issued_by_name || ''),
      revokedByName: String(x.revoked_by_name || ''),
    }));
  } catch (e: any) {
    console.error('[talent-codes] codeRegister: ' + reasonOf(e));
    throw e;
  }
}

export interface CodeCounts {
  total: number;
  active: number;
  consumed: number;
  revoked: number;
  expired: number;
  /** Still marked active but already past valid_until — the expiry sweep has not caught it yet. */
  overdue: number;
  /** Active, and nobody has recorded sending it to the candidate. */
  unshared: number;
}

/** Counts for the register header. RETHROWS, for the same reason codeRegister() does. */
export async function codeCounts(): Promise<CodeCounts> {
  try {
    const { db, sql } = await ctx();
    // ONE round trip, seven numbers. Seven COUNT queries against one table is the shape that made
    // page latency on this project a function of how many tiles a header happened to have.
    const rows = rowsOf(await db.execute(sql`
      SELECT COUNT(*)                                                          AS total,
             COUNT(*) FILTER (WHERE status = 'active')                         AS active,
             COUNT(*) FILTER (WHERE status = 'consumed')                       AS consumed,
             COUNT(*) FILTER (WHERE status = 'revoked')                        AS revoked,
             COUNT(*) FILTER (WHERE status = 'expired')                        AS expired,
             COUNT(*) FILTER (WHERE status = 'active' AND valid_until < NOW()) AS overdue,
             COUNT(*) FILTER (WHERE status = 'active' AND delivered_at IS NULL) AS unshared
        FROM tal_onboarding_code`));
    const r = (rows[0] || {}) as any;
    return {
      total: Number(r.total || 0),
      active: Number(r.active || 0),
      consumed: Number(r.consumed || 0),
      revoked: Number(r.revoked || 0),
      expired: Number(r.expired || 0),
      overdue: Number(r.overdue || 0),
      unshared: Number(r.unshared || 0),
    };
  } catch (e: any) {
    console.error('[talent-codes] codeCounts: ' + reasonOf(e));
    throw e;
  }
}

/**
 * Record that a code was handed to the candidate, and by which route.
 *
 * WHAT THIS IS AND IS NOT. It is the operator's note that they sent it. This product has no delivery
 * pipeline for onboarding codes, so there is no receipt to record and nothing here claims one. It
 * exists because the register's most useful question is "was this ever actually sent?", and a code
 * issued three weeks ago that nobody remembers sending is exactly the situation that ends with a
 * second code being minted for somebody who is already holding a working one.
 *
 * WHO recorded it goes to the audit log at the call site, not here: tal_onboarding_code has no
 * delivered_by column, and inventing one by packing a name into delivery_channel would make the
 * channel uncountable, which is the only thing that column is good for.
 */
export async function markCodeDelivered(
  codeRowId: string,
  channel: string,
): Promise<{ ok: boolean; error?: string; changed: boolean }> {
  const ch = String(channel || '');
  if (!(DELIVERY_CHANNELS as readonly string[]).includes(ch)) {
    return { ok: false, error: 'Choose how the code was sent.', changed: false };
  }
  try {
    const { db, sql } = await ctx();
    // Only a code that could still be used. Putting a reassuring "sent" tick beside a revoked or
    // expired code would describe a message that cannot let anybody in.
    const r = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_code
         SET delivered_at = NOW(), delivery_channel = ${ch}, delivery_error = NULL
       WHERE id = ${codeRowId}::uuid AND status = 'active'
       RETURNING id`));
    if (!r.length) {
      return { ok: false, error: 'That code is no longer active, so it was not marked as sent.', changed: false };
    }
    return { ok: true, changed: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e), changed: false };
  }
}
