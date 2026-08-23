// src/lib/talentos/codes.ts — every human-readable code this system mints, in one place.
//
// TWO KINDS OF CODE LIVE HERE AND THEY ARE NOT THE SAME KIND OF THING.
//
//   SEQUENCE CODES   ERAI-P-000001, ERAI-EMP-00128, ERAI-SEL-26-000412, ERAI-ONB-26-000412
//                    Identifiers. Public inside the organisation, printed on records, quoted in
//                    email. Guessing one grants nothing.
//
//   THE AUTHORIZATION CODE   ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD
//                    A BEARER CREDENTIAL that a person types. Guessing one would let someone reach
//                    another person's onboarding form. It is generated from a cryptographic source,
//                    stored only as a hash, and never recoverable.
//
// Mixing those two up — numbering a credential, or hashing an identifier — is the mistake this
// file's structure exists to prevent.
//
// ================================================================================================
// WHY SEQUENCES ARE DERIVED FROM MAX AND NOT FROM COUNT.
//
// src/lib/hr/employee-code.ts already carries this scar at length: two code paths numbered
// employees with `SELECT COUNT(*) + 1`, which is wrong in two ordinary situations.
//
//   1. A row has ever been deleted. Codes 0001..0005 exist, 0003 is removed, COUNT(*) is 4, so the
//      next record is minted 0005 — which already exists, the INSERT violates the unique
//      constraint, and the write is lost.
//   2. Two writers land at the same moment. Both read the same COUNT, both mint the same code, and
//      the loser throws.
//
// On the auto-hire path that exception was caught and written to console only, so an applicant
// showed "Hired" while no employee record existed. That went unnoticed for eleven days.
//
// MAX of the numeric suffix is immune to deletions; the bounded retry closes the race that no
// single SELECT can. Codes that do not match the house pattern are IGNORED by the MAX rather than
// parsed, so one hand-typed or imported row cannot push the counter to a wild value or throw a cast
// error on every subsequent mint.
// ================================================================================================
import { sql } from 'drizzle-orm';
import { randomInt, createHash } from 'node:crypto';

/** Lazily resolved so the pure functions below are testable with no database in reach. */
async function database(): Promise<any> {
  const { db } = await import('@/lib/db');
  return db;
}

/** postgres-js returns a plain array. `r.rows[0]` is undefined in production. */
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** True when a thrown error is a Postgres unique violation. The code lives on e.cause, not e. */
export function isUniqueViolation(e: any): boolean {
  const code = e?.cause?.code || e?.code;
  return String(code || '') === '23505';
}

// ================================================================================================
// SEQUENCE CODES
// ================================================================================================

/**
 * The next free code in a `<prefix><zero-padded number>` series, derived from the highest already
 * issued in that series.
 *
 * `table` and `column` are interpolated as raw SQL identifiers, so they MUST come from this
 * module's own callers and never from a request. Every call site below passes a literal.
 */
async function nextInSeries(
  table: string,
  column: string,
  prefix: string,
  width: number,
): Promise<string> {
  const db = await database();
  const pattern = '^' + prefix.replace(/[-]/g, '\\-') + '[0-9]+$';
  const r = await db.execute(sql`
    SELECT COALESCE(MAX(regexp_replace(${sql.raw(column)}, ${'^' + prefix}, '')::bigint), 0)::bigint AS mx
    FROM ${sql.raw(table)}
    WHERE ${sql.raw(column)} ~ ${pattern}`);
  const mx = Number(rows(r)[0]?.mx || 0);
  return prefix + String(mx + 1).padStart(width, '0');
}

/**
 * Run `attempt` with a freshly minted code, re-minting and retrying if another writer took it first.
 *
 * `attempt` MUST do exactly one INSERT and MUST NOT be otherwise repeatable — it is called again on
 * a unique violation, and on nothing else. Any other failure is raised immediately rather than
 * attempted five times.
 */
export async function withMintedCode<T>(
  mint: () => Promise<string>,
  attempt: (code: string) => Promise<T>,
  tries = 5,
): Promise<T> {
  let last: any = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const code = await mint();
    try {
      return await attempt(code);
    } catch (e: any) {
      if (!isUniqueViolation(e)) throw e;
      last = e;
    }
  }
  throw last;
}

export const PERSON_CODE_PREFIX = 'ERAI-P-';

/** ERAI-P-000001 — the durable identifier of one human across every application they ever make. */
export function nextPersonCode(): Promise<string> {
  return nextInSeries('tos_person', 'person_code', PERSON_CODE_PREFIX, 6);
}

/** ERAI-EMP-00128, ERAI-FEL-00007 — one independent sequence per identity type. */
export async function nextIdentityCode(identityType: string): Promise<string> {
  const { identityPrefix, assertIdentityType } = await import('./vocab');
  const prefix = identityPrefix(assertIdentityType(identityType));
  return nextInSeries('tos_identity', 'identity_code', prefix, 5);
}

/**
 * ERAI-SEL-26-000412 — the selection record reference, quoted in the decision letter and in any
 * appeal. The two-digit year is part of the PREFIX, so each year restarts at 000001 and the series
 * stays readable rather than climbing forever.
 */
export function nextSelectionRef(year: number): Promise<string> {
  return nextInSeries('tos_selection', 'selection_ref', 'ERAI-SEL-' + yy(year) + '-', 6);
}

/** ERAI-ONB-26-000412 — the onboarding record reference. */
export function nextOnboardingRef(year: number): Promise<string> {
  return nextInSeries('tos_onboarding', 'onboarding_ref', 'ERAI-ONB-' + yy(year) + '-', 6);
}

function yy(year: number): string {
  return String(year % 100).padStart(2, '0');
}

// ================================================================================================
// THE AUTHORIZATION CODE
//
// FORMAT.  ERAI-SEL-ONB-{YY}-{OPP}-{XXXX}-{XXXX}-{XXXX}
//
//   ERAI-SEL-ONB  fixed, so a person can tell at a glance what they are holding
//   YY            year of issue
//   OPP           the opportunity's short code (tos_opportunity.opportunity_code)
//   three groups  twelve characters of Crockford base32 — the secret, 60 bits
//
// WHY TWELVE CHARACTERS AND NOT FIVE. The originating brief's example carries a single
// five-character group, and that group is the ENTIRE secret. Five characters of base32 is 2^25,
// about 33.5 million values. With L codes live at once and G guesses an hour, expected guesses to
// the first hit is 2^25 / L — at 200 live codes that is 168,000 guesses, which a single throttled
// attacker reaches in under a day. A hit is not a nuisance: it is one stranger reaching another
// person's onboarding form.
//
// At twelve characters the same arithmetic gives 2^60 / 200, about 5.8e15 guesses — roughly 66
// million years at 10,000 guesses an hour. The margin absorbs a far larger live-code population and
// a far larger botnet without reopening the question.
//
// The typed string grows from 25 characters to 34, in four-character groups a person can read aloud
// over a telephone. This credential is typed once, from an email, on the most consequential day of
// that person's relationship with the organisation. Nine characters is the correct price.
//
// The readable structure the brief asked for is unchanged; the secret was widened. That is the only
// deviation, it is stated here and in section 10 of docs/talent-os-spec.md, and the alternative —
// shipping a credential with 25 bits because an example had five characters in it — is not a real
// option.
//
// NO CHECK CHARACTER, deliberately. A Crockford check symbol would let the form say "you mistyped"
// rather than "that is not the right format", but an attacker computes the check symbol as easily
// as we do, so it buys no security while consuming five bits of the typeable budget. The malformed
// rung of the validation ladder already carries the mistyping message.
//
// EVEN SO, THE CODE ALONE IS NEVER SUFFICIENT. Redemption additionally requires proof that the
// redeemer is the person the code is bound to: an authenticated session resolving to that person,
// or a one-time verification to the bound address. The entropy above is what stops guessing; the
// binding is what stops a leaked or forwarded code from being usable by whoever received it.
// ================================================================================================

/** Crockford base32: no I, no L, no O, no U. Chosen because a person reads this aloud and types it. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const AUTH_CODE_PREFIX = 'ERAI-SEL-ONB';
export const AUTH_CODE_GROUP_LEN = 4;
export const AUTH_CODE_GROUPS = 3;
/** 12 characters x 5 bits. Stated as a number so a test can assert it did not quietly shrink. */
export const AUTH_CODE_ENTROPY_BITS = AUTH_CODE_GROUP_LEN * AUTH_CODE_GROUPS * 5;

/**
 * NORMALISATION, applied identically at generation and at verification.
 *
 * A person typing a code from a letter will use lower case, will type O for zero and I or l for
 * one, and will get the dashes wrong. All of that must resolve to the same string, because the
 * string is what gets hashed and the hash is the only thing stored.
 *
 * The Crockford look-alike mapping is applied to the WHOLE code including its fixed prefix, so
 * "ERAI" normalises to "ERA1" and an opportunity code containing O normalises with a zero. That is
 * deliberate and harmless: normalisation only has to be deterministic and total, not pretty. What
 * it must never be is partial, because a code that verifies on one screen and not another is
 * indistinguishable from a revoked one to the person holding it.
 */
export function normaliseAuthCode(input: string): string {
  return String(input || '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '');
}

/** sha256 hex of the normalised code. The plaintext is never stored, not even on a failed attempt. */
export function hashAuthCode(input: string): string {
  return createHash('sha256').update(normaliseAuthCode(input), 'utf8').digest('hex');
}

/**
 * A cryptographically random group.
 *
 * randomInt uses rejection sampling, so every character is uniform. `randomBytes(n)[i] % 32` would
 * be biased toward the first eight characters of the alphabet, which is the kind of defect that
 * never shows up in testing and quietly costs bits.
 */
function randomGroup(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CROCKFORD_ALPHABET[randomInt(0, CROCKFORD_ALPHABET.length)];
  return out;
}

export interface GeneratedAuthCode {
  /** The full code, shown to the issuer ONCE and delivered to the candidate. Never persisted. */
  display: string;
  /** What is stored and indexed. */
  hash: string;
  /** Stored so an administrator can identify a code without the database holding the credential. */
  displayPrefix: string;
  last4: string;
}

/**
 * Mint one authorization code for (year, opportunityCode).
 *
 * `opportunityCode` is uppercased and stripped to the Crockford alphabet so that a mis-configured
 * opportunity cannot inject separators into the format and make the code ambiguous to parse.
 */
export function generateAuthCode(year: number, opportunityCode: string): GeneratedAuthCode {
  const opp = String(opportunityCode || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 8);
  if (!opp) throw new Error('opportunity code is required to mint an authorization code');

  const groups: string[] = [];
  for (let i = 0; i < AUTH_CODE_GROUPS; i++) groups.push(randomGroup(AUTH_CODE_GROUP_LEN));

  const displayPrefix = AUTH_CODE_PREFIX + '-' + yy(year) + '-' + opp;
  const display = displayPrefix + '-' + groups.join('-');
  const secretChars = groups.join('');

  return {
    display,
    hash: hashAuthCode(display),
    displayPrefix,
    last4: secretChars.slice(-4),
  };
}

/**
 * A cheap shape check run BEFORE any database lookup, so that obvious rubbish is refused without
 * spending a query and without occupying a rate-limit slot's worth of database time.
 *
 * It deliberately does NOT verify the year or the opportunity segment against anything. Doing so
 * would tell an attacker which opportunities exist, and the real check is the hash lookup anyway.
 */
export function looksLikeAuthCode(input: string): boolean {
  const n = normaliseAuthCode(input);
  if (!n.startsWith(NORMALISED_PREFIX)) return false;
  // What follows the fixed prefix: YY + opportunity code (1..8) + the secret characters.
  const rest = n.slice(NORMALISED_PREFIX.length);
  const secret = AUTH_CODE_GROUP_LEN * AUTH_CODE_GROUPS;
  return rest.length >= 2 + 1 + secret && rest.length <= 2 + 8 + secret;
}

/**
 * The fixed prefix AS IT LOOKS AFTER NORMALISATION, derived rather than typed.
 *
 * Writing it by hand is a trap that has already been sprung once here: normalisation maps L to 1,
 * so "ERAI-SEL-ONB" becomes "ERA1SE10NB" and not the "ERA1SEL0NB" that reading the rule quickly
 * suggests. A hardcoded constant would have rejected every genuine code while accepting nothing,
 * and the only symptom would have been candidates being told their real code was not recognised.
 * Deriving it means the mapping can change without this check silently going out of step.
 */
const NORMALISED_PREFIX = normaliseAuthCode(AUTH_CODE_PREFIX);
