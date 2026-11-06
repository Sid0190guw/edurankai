// THE EMPLOYEE ID CARD REGISTRY: issue, revoke, present, verify.
//
// The cryptography is in id-card-crypto.ts and is pure. This file holds the one table, reads the
// employee record a card speaks for, and answers the question a person holding a phone over a card
// actually has: is this a genuine EduRankAI card, is it still good, and who is it for?
//
// A CARD SPEAKS FOR A RECORD, IT DOES NOT COPY IT. Name, photo and designation are read from
// hr_employees at verification time. Nothing personal is in the QR (see the crypto header), so the
// registry is the one place a card can be switched off - and switching it off works on every copy,
// printed or on a phone, the moment it happens.
//
// THE TABLE IS NOT CREATED ON A REQUEST. Production runs no DDL on the request path (see
// src/lib/ensure-once.ts), so hr_id_cards is created by the bootstrap at /admin/setup or by hand from
// db/id-card-schema.sql. Every reader here reports `ready: false` when it is absent instead of
// pretending there are no cards.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { getKeyMaterial, activeKeyId } from '@/lib/crypto/keys';
import { logAudit } from '@/lib/audit';
import {
  deriveSigningKey, dataKeyIdOf, signCard, verifyCard, newSerial, isSerial,
  LIVE_TTL_SECONDS, type SigningKey, type CardClaims, type VerifyFailure,
} from './id-card-crypto';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const why = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const isUuid = (v: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const isMissingTable = (e: any) => String(e?.cause?.code || e?.code || '') === '42P01';

export const ID_CARD_DDL = `
CREATE TABLE IF NOT EXISTS hr_id_cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial             TEXT NOT NULL UNIQUE,
  employee_id        UUID NOT NULL,
  state              TEXT NOT NULL DEFAULT 'active',
  valid_from         DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until        DATE NOT NULL,
  issued_by_user_id  UUID,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at         TIMESTAMPTZ,
  revoked_by_user_id UUID,
  revoked_reason     TEXT,
  verify_count       INT NOT NULL DEFAULT 0,
  last_verified_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_id_cards_one_active ON hr_id_cards (employee_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS hr_id_cards_emp_idx ON hr_id_cards (employee_id, issued_at DESC);
`;

export function ensureIdCardSchema(): Promise<void> {
  return ensureOnce('hr_id_cards_v1', async () => {
    for (const stmt of ID_CARD_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(stmt));
    }
  });
}

// -------------------------------------------------------------------------------------------------
// KEYS
// -------------------------------------------------------------------------------------------------

const keyCache = new Map<string, SigningKey | null>();

/** The key new cards are signed with. Throws with the env var name when it is not configured. */
export function activeSigningKey(): SigningKey {
  const dk = activeKeyId();
  const kid = 'id-' + dk;
  const hit = keyCache.get(kid);
  if (hit) return hit;
  const key = deriveSigningKey(dk, getKeyMaterial(dk));
  keyCache.set(kid, key);
  return key;
}

/** Resolve any key id a token names. Null when this deployment cannot derive it. */
export function signingKeyFor(kid: string): SigningKey | null {
  if (keyCache.has(kid)) return keyCache.get(kid) || null;
  const dk = dataKeyIdOf(kid);
  let key: SigningKey | null = null;
  if (dk) {
    try { key = deriveSigningKey(dk, getKeyMaterial(dk)); } catch { key = null; }
  }
  // A miss is NOT cached: a key configured a moment later must start working without a restart.
  if (key) keyCache.set(kid, key);
  return key;
}

/** Every key this deployment can verify with, for /api/id-card/keys. Values never included. */
export function verifiableKeys(): SigningKey[] {
  const ids = new Set<string>([activeKeyId()]);
  for (const name of Object.keys(process.env)) {
    const m = /^DATA_ENCRYPTION_KEY_([A-Za-z0-9._-]{1,64})$/.exec(name);
    if (m) ids.add(m[1]);
  }
  const out: SigningKey[] = [];
  for (const id of ids) {
    const k = signingKeyFor('id-' + id);
    if (k) out.push(k);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE PERSON A CARD SPEAKS FOR
// -------------------------------------------------------------------------------------------------

export interface CardHolder {
  employeeId: string;
  userId: string | null;
  fullName: string;
  employeeCode: string;
  designation: string;
  employmentType: string;
  photoUrl: string | null;
  joiningDate: string | null;
  isActive: boolean;
}

/** Only the columns a card shows. No email, phone, address, blood group or identity number. */
async function readHolder(employeeId: string): Promise<CardHolder | null> {
  const r = rows(await db.execute(sql`
    SELECT e.id, e.user_id, e.full_name, e.employee_code, e.designation, e.employment_type,
           e.photo_url, e.joining_date, e.is_active, e.employment_status,
           COALESCE(e.user_id, (SELECT u.id FROM users u WHERE lower(u.email) = lower(e.email) LIMIT 1)) AS resolved_user_id
      FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`));
  const e = r[0];
  if (!e) return null;
  const status = String(e.employment_status || '').toLowerCase();
  return {
    employeeId: String(e.id),
    userId: e.resolved_user_id ? String(e.resolved_user_id) : null,
    fullName: String(e.full_name || ''),
    employeeCode: String(e.employee_code || ''),
    designation: String(e.designation || ''),
    employmentType: String(e.employment_type || ''),
    photoUrl: e.photo_url ? String(e.photo_url) : null,
    joiningDate: isoDay(e.joining_date),
    isActive: e.is_active !== false && !/exited|terminated|offboarded|separated|inactive/.test(status),
  };
}

function isoDay(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10) || null;
}

/** A DATE as the end of that day in IST, in epoch seconds. A card valid "until 31 Dec" works on 31 Dec. */
export function endOfDayIst(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return 0;
  // 23:59:59 IST is 18:29:59 UTC.
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 18, 29, 59) / 1000);
}

// -------------------------------------------------------------------------------------------------
// CARDS
// -------------------------------------------------------------------------------------------------

export interface CardRow {
  id: string;
  serial: string;
  employeeId: string;
  state: string;
  validFrom: string | null;
  validUntil: string | null;
  issuedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  verifyCount: number;
  lastVerifiedAt: string | null;
}

function mapCard(r: any): CardRow {
  return {
    id: String(r.id),
    serial: String(r.serial),
    employeeId: String(r.employee_id),
    state: String(r.state || 'active'),
    validFrom: isoDay(r.valid_from),
    validUntil: isoDay(r.valid_until),
    issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    revokedReason: r.revoked_reason ? String(r.revoked_reason) : null,
    verifyCount: Number(r.verify_count) || 0,
    lastVerifiedAt: r.last_verified_at ? new Date(r.last_verified_at).toISOString() : null,
  };
}

export type Read<T> = { ready: true; value: T } | { ready: false; error: string };

const NOT_SET_UP = 'ID cards are not set up on this deployment yet: the hr_id_cards table does not exist. '
  + 'Run the bootstrap at /admin/setup, or run db/id-card-schema.sql.';

/** The card currently active for one employee, if any. */
export async function activeCardFor(employeeId: string): Promise<Read<CardRow | null>> {
  if (!isUuid(employeeId)) return { ready: true, value: null };
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM hr_id_cards WHERE employee_id = ${employeeId}::uuid AND state = 'active'
       ORDER BY issued_at DESC LIMIT 1`));
    return { ready: true, value: r[0] ? mapCard(r[0]) : null };
  } catch (e: any) {
    return { ready: false, error: isMissingTable(e) ? NOT_SET_UP : 'The ID card register could not be read: ' + why(e) };
  }
}

export interface CardListItem extends CardRow { fullName: string; employeeCode: string; designation: string; isActiveEmployee: boolean; hasPhoto: boolean; }

/** Every employee with their current card (or none), for the HR desk. */
export async function listCardsForDesk(limit = 600): Promise<Read<Array<{ employeeId: string; fullName: string; employeeCode: string; designation: string; employmentType: string; isActive: boolean; hasPhoto: boolean; card: CardRow | null }>>> {
  try {
    const r = rows(await db.execute(sql`
      SELECT e.id AS emp_id, e.full_name, e.employee_code, e.designation, e.employment_type, e.is_active,
             (e.photo_url IS NOT NULL AND e.photo_url <> '') AS has_photo,
             c.id, c.serial, c.employee_id, c.state, c.valid_from, c.valid_until, c.issued_at,
             c.revoked_at, c.revoked_reason, c.verify_count, c.last_verified_at
        FROM hr_employees e
        LEFT JOIN hr_id_cards c ON c.employee_id = e.id AND c.state = 'active'
       ORDER BY e.is_active DESC, e.full_name ASC
       LIMIT ${Math.min(Math.max(limit, 1), 2000)}`));
    return {
      ready: true,
      value: r.map((x: any) => ({
        employeeId: String(x.emp_id),
        fullName: String(x.full_name || ''),
        employeeCode: String(x.employee_code || ''),
        designation: String(x.designation || ''),
        employmentType: String(x.employment_type || ''),
        isActive: x.is_active !== false,
        hasPhoto: !!x.has_photo,
        card: x.serial ? mapCard(x) : null,
      })),
    };
  } catch (e: any) {
    return { ready: false, error: isMissingTable(e) ? NOT_SET_UP : 'The ID card register could not be read: ' + why(e) };
  }
}

/** The default validity: six months for an intern or apprentice, two years for everybody else. */
export function defaultValidUntil(employmentType: string, todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map(Number);
  const months = /intern|apprentic|trainee/i.test(employmentType || '') ? 6 : 24;
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

export interface IssueResult { ok: boolean; serial?: string; replaced?: string | null; error?: string }

/**
 * Issue a card, replacing (and revoking) any card the person already holds. One active card per
 * person is enforced by a partial unique index, so two desks issuing at once cannot leave someone
 * with two valid cards.
 */
export async function issueCard(opts: {
  employeeId: string; validUntil: string; actorUserId: string | null; reason?: string;
}): Promise<IssueResult> {
  if (!isUuid(opts.employeeId)) return { ok: false, error: 'Choose the person this card is for.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.validUntil)) return { ok: false, error: 'Give the date the card stops working.' };
  // Refuse before writing anything if cards cannot be signed: a card in the register that no device
  // can be shown a code for is a card that does not work.
  try { activeSigningKey(); } catch (e: any) {
    return { ok: false, error: 'Cards cannot be signed on this deployment: ' + why(e) };
  }
  try {
    const holder = await readHolder(opts.employeeId);
    if (!holder) return { ok: false, error: 'That employee record could not be found.' };
    if (!holder.isActive) return { ok: false, error: holder.fullName + ' is no longer active, so no card was issued.' };

    let serial = newSerial();
    let replaced: string | null = null;
    await db.transaction(async (tx: any) => {
      const prev = rows(await tx.execute(sql`
        UPDATE hr_id_cards SET state = 'replaced', revoked_at = NOW(), revoked_by_user_id = ${opts.actorUserId}::uuid,
               revoked_reason = ${opts.reason || 'Replaced by a new card'}
         WHERE employee_id = ${opts.employeeId}::uuid AND state = 'active' RETURNING serial`));
      replaced = prev[0] ? String(prev[0].serial) : null;
      for (let i = 0; i < 4; i++) {
        const dup = rows(await tx.execute(sql`SELECT 1 FROM hr_id_cards WHERE serial = ${serial} LIMIT 1`));
        if (!dup.length) break;
        serial = newSerial();
      }
      await tx.execute(sql`
        INSERT INTO hr_id_cards (serial, employee_id, state, valid_until, issued_by_user_id)
        VALUES (${serial}, ${opts.employeeId}::uuid, 'active', ${opts.validUntil}::date, ${opts.actorUserId}::uuid)`);
    });
    await logAudit({
      userId: opts.actorUserId, action: 'hr.id_card.issued', entity: 'hr_id_card', entityId: serial,
      diff: { employeeId: opts.employeeId, validUntil: opts.validUntil, replaced },
    }).catch(() => {});
    return { ok: true, serial, replaced };
  } catch (e: any) {
    return { ok: false, error: isMissingTable(e) ? NOT_SET_UP : 'The card was not issued: ' + why(e) };
  }
}

export async function revokeCard(opts: { serial: string; reason: string; actorUserId: string | null }): Promise<{ ok: boolean; error?: string }> {
  if (!isSerial(opts.serial)) return { ok: false, error: 'That is not a card serial.' };
  const reason = String(opts.reason || '').trim();
  if (reason.length < 4) return { ok: false, error: 'Write why the card is being revoked. It is shown when somebody scans it.' };
  try {
    const r = rows(await db.execute(sql`
      UPDATE hr_id_cards SET state = 'revoked', revoked_at = NOW(), revoked_by_user_id = ${opts.actorUserId}::uuid,
             revoked_reason = ${reason.slice(0, 500)}
       WHERE serial = ${opts.serial} AND state = 'active' RETURNING serial`));
    if (!r.length) return { ok: false, error: 'No active card has the serial ' + opts.serial + '. Nothing changed.' };
    await logAudit({
      userId: opts.actorUserId, action: 'hr.id_card.revoked', entity: 'hr_id_card', entityId: opts.serial,
      diff: { reason: reason.slice(0, 300) },
    }).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: isMissingTable(e) ? NOT_SET_UP : 'The card was not revoked: ' + why(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// PRESENTATION
// -------------------------------------------------------------------------------------------------

/** The long-lived code printed on the back of a card. Deterministic: reprinting gives the same QR. */
export function printedToken(card: CardRow): string {
  const issued = card.issuedAt ? Math.floor(new Date(card.issuedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return signCard(activeSigningKey(), {
    serial: card.serial, presentation: 'printed', issuedAt: issued,
    expiresAt: endOfDayIst(card.validUntil || ''), faceAt: 0,
  });
}

/** A 90-second code for the phone card. `faceAt` is when the holder last matched, or 0. */
export function liveToken(card: CardRow, faceAt: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const cardEnd = endOfDayIst(card.validUntil || '');
  return signCard(activeSigningKey(), {
    serial: card.serial, presentation: 'live', issuedAt: nowSeconds,
    expiresAt: Math.min(nowSeconds + LIVE_TTL_SECONDS, cardEnd || nowSeconds + LIVE_TTL_SECONDS),
    faceAt,
  });
}

// -------------------------------------------------------------------------------------------------
// VERIFICATION
// -------------------------------------------------------------------------------------------------

export type Verdict =
  | 'valid'
  | 'forged'          // signature did not verify, or the token is not a card token
  | 'unknown_key'     // signed under a key this deployment no longer has
  | 'expired'         // the code (or the card it was printed for) is past its date
  | 'revoked'
  | 'replaced'
  | 'not_found'       // signed by us, but the serial is not in the register
  | 'holder_inactive' // the card is fine, the person is no longer with us
  | 'unavailable';    // we could not check: the register could not be read

export interface Verification {
  verdict: Verdict;
  claims?: CardClaims;
  card?: CardRow;
  holder?: CardHolder;
  detail?: string;
}

const FAILURE_TO_VERDICT: Record<VerifyFailure, Verdict> = {
  malformed: 'forged', bad_signature: 'forged', unknown_key: 'unknown_key',
  expired: 'expired', not_yet_valid: 'forged',
};

/**
 * The whole question, answered once. Signature first; the register only for a genuine token, so a
 * forged code costs one signature check and never a database round trip.
 */
export async function verifyToken(token: string, opts: { count?: boolean } = {}): Promise<Verification> {
  const now = Math.floor(Date.now() / 1000);
  const v = verifyCard(token, signingKeyFor, now);
  if (!v.ok) return { verdict: FAILURE_TO_VERDICT[v.reason], claims: v.claims };

  let card: CardRow | null = null;
  try {
    const r = rows(await db.execute(sql`SELECT * FROM hr_id_cards WHERE serial = ${v.claims.serial} LIMIT 1`));
    card = r[0] ? mapCard(r[0]) : null;
  } catch (e: any) {
    return { verdict: 'unavailable', claims: v.claims, detail: isMissingTable(e) ? NOT_SET_UP : why(e) };
  }
  if (!card) return { verdict: 'not_found', claims: v.claims };

  let holder: CardHolder | null = null;
  try { holder = await readHolder(card.employeeId); } catch (e: any) {
    return { verdict: 'unavailable', claims: v.claims, card, detail: why(e) };
  }

  if (card.state === 'revoked') return { verdict: 'revoked', claims: v.claims, card, holder: holder || undefined };
  if (card.state === 'replaced') return { verdict: 'replaced', claims: v.claims, card, holder: holder || undefined };
  if (card.validUntil && endOfDayIst(card.validUntil) < now) return { verdict: 'expired', claims: v.claims, card, holder: holder || undefined };
  if (!holder || !holder.isActive) return { verdict: 'holder_inactive', claims: v.claims, card, holder: holder || undefined };

  if (opts.count) {
    // Best-effort and never in the way of the answer.
    db.execute(sql`UPDATE hr_id_cards SET verify_count = verify_count + 1, last_verified_at = NOW() WHERE id = ${card.id}::uuid`)
      .catch(() => {});
  }
  return { verdict: 'valid', claims: v.claims, card, holder };
}

/** The holder of an employee id, for the employee's own card page. */
export async function holderFor(employeeId: string): Promise<CardHolder | null> {
  if (!isUuid(employeeId)) return null;
  return readHolder(employeeId);
}
