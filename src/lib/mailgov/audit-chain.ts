// src/lib/mailgov/audit-chain.ts — TAMPER-EVIDENT AUDIT, AND AN HONEST NAME FOR IT.
//
// PURE (node:crypto only). No database. The chain arithmetic lives here so it can be tested against
// hand-built rows, and so the verifier and the writer cannot drift apart — they call the same two
// functions.
//
// WHAT THIS IS, PRECISELY. Every audit event stores a `content_hash` over its own fields and a
// `hash` over `prev_hash || content_hash`. That makes the log a linked chain: change one field of
// one row and every hash after it stops matching, and there is no way to recompute them without
// rewriting every subsequent row. Remove a row and the link across the gap breaks.
//
// WHAT THIS IS NOT. It is not "immutable" in the sense that word is usually sold. A database
// superuser can rewrite a table and recompute a chain; a backup can be restored over the top. What
// this buys is DETECTION — verifyChain() says where the chain broke and refuses to call a damaged
// log intact. That, plus a database trigger that refuses UPDATE outright (see ./schema.ts), plus the
// fact that no code path in this repository issues an UPDATE against the table, is what
// "append-only" means here. The brief asked for immutable/append-oriented; this is the
// append-oriented half implemented properly rather than the immutable half claimed loosely.
//
// WHY THE CONTENT HASH IS COMPUTED IN TYPESCRIPT AND THE CHAIN HASH IN SQL. The chain hash has to be
// computed from the CURRENT TAIL of the table at insert time, atomically, or two concurrent writers
// fork the chain — so it is one `INSERT ... SELECT` with the tail read inside it, and a UNIQUE index
// on prev_hash turns a fork into a failed insert that retries instead of a silent branch. The
// content hash has no such constraint and belongs where the canonicalisation rules are readable and
// testable, which is here. See recordAudit() in ./audit.ts for the statement.
import { createHash } from 'node:crypto';

/** The hash a genesis row links back to. 64 zeros, so the column is never null and never special. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The audit event as it is written and read back.
 *
 * `result` is not decoration. An audit that only records successes is a record of what the system
 * permitted, not of what people attempted — and the attempts are the interesting half. Every denied
 * governance call writes a row with result 'denied' and the deny code as the reason.
 */
export interface AuditEventInput {
  orgId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  actorApiKeyId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: 'ok' | 'denied' | 'failed';
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  meta: Record<string, unknown>;
  occurredAt: string;
}

export interface AuditEventRow extends AuditEventInput {
  id: string;
  seq: number;
  contentHash: string;
  prevHash: string;
  hash: string;
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace, arrays left in order.
 *
 * The hash is only meaningful if two runs over the same facts produce the same bytes, and
 * JSON.stringify() does NOT guarantee that — key order follows insertion order, so the same metadata
 * assembled by two code paths hashes differently. Sorting removes the whole class of problem.
 *
 * `undefined` is dropped (JSON has no such value); a Date is serialised as its ISO string so a
 * caller passing one does not silently produce `{}`.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) {
        if (v[k] === undefined) continue;
        out[k] = walk(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Stands in for null, so "absent" and "empty string" are different inputs to the hash — otherwise
 * "no reason recorded" and "reason recorded as blank" could be swapped for one another without
 * breaking a single hash.
 *
 * ASCII unit separator between fields, rather than plain concatenation: action='ab' with target='c'
 * and action='a' with target='bc' must not hash to the same value. A field-boundary ambiguity is a
 * forgery primitive, not a cosmetic detail. Neither byte can occur in a UUID, an action name, an
 * email address or an ISO timestamp.
 *
 * Written as fromCharCode rather than as literal bytes on purpose: a raw control character in source
 * is invisible to every reviewer who comes after, and turns the file binary to grep.
 */
const NUL = String.fromCharCode(0);
const UNIT = String.fromCharCode(31);

/**
 * The hash over one event's own content.
 *
 * FIELD ORDER IS PART OF THE FORMAT. The fields are listed explicitly rather than iterated off the
 * object, so adding a field to AuditEventInput does not silently change the hash of events already
 * written — which would report the entire existing log as tampered with. A new field that must be
 * covered goes at the END of this list, and that is a format version bump documented in
 * docs/mail-governance.md.
 */
export function contentHash(e: AuditEventInput): string {
  const n = (v: string | null | undefined): string => (v === null || v === undefined ? NUL : String(v));
  const parts = [
    n(e.occurredAt),
    n(e.orgId),
    n(e.actorUserId),
    n(e.actorEmail),
    n(e.actorRole),
    n(e.actorApiKeyId),
    n(e.action),
    n(e.targetType),
    n(e.targetId),
    n(e.result),
    n(e.reason),
    n(e.ip),
    n(e.userAgent),
    n(e.requestId),
    canonicalJson(e.meta || {}),
  ];
  return sha256(parts.join(UNIT));
}

/** hash = sha256(prevHash || contentHash). The same expression the INSERT computes in SQL. */
export function chainHash(prevHash: string, content: string): string {
  return sha256(prevHash + content);
}

export interface ChainVerdict {
  ok: boolean;
  /** How many rows were checked. */
  checked: number;
  /** The seq of the first row that failed, or null when the chain is intact. */
  brokenAtSeq: number | null;
  /** What is wrong with that row, in words. Null when intact. */
  reason: string | null;
  /** Gaps in `seq`. Reported, never fatal on their own — see the note below. */
  gaps: { afterSeq: number; beforeSeq: number }[];
  /** The hash of the last row checked — the value to record as an external anchor. */
  headHash: string | null;
}

/**
 * Walk a slice of the chain and say whether it is intact.
 *
 * `expectedFirstPrevHash` lets a caller verify a WINDOW rather than the whole table: pass the hash
 * the window should link back to (GENESIS_HASH for the very first row, or the hash recorded in a
 * prune checkpoint). Pass null to accept whatever the first row claims and check only the links from
 * there on — useful for a page of recent events, and honestly weaker, which is why the caller has to
 * choose it explicitly rather than getting it by default.
 *
 * A GAP IN `seq` IS NOT AUTOMATICALLY A FAILURE. Postgres sequences skip on rollback, and a failed
 * insert (the prev_hash uniqueness retry, for one) burns a number. So a gap whose hash links still
 * match is REPORTED and does not fail the verdict; a gap where a row was actually removed breaks the
 * prev_hash link and IS a failure, caught by the link check. The two are different facts and the
 * verdict states both.
 */
export function verifyChain(
  rows: Pick<AuditEventRow, 'seq' | 'prevHash' | 'hash' | 'contentHash'>[],
  expectedFirstPrevHash: string | null = null,
): ChainVerdict {
  const gaps: ChainVerdict['gaps'] = [];
  if (!rows.length) {
    return { ok: true, checked: 0, brokenAtSeq: null, reason: null, gaps: [], headHash: null };
  }
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);

  if (expectedFirstPrevHash !== null && sorted[0].prevHash !== expectedFirstPrevHash) {
    return {
      ok: false, checked: 0, brokenAtSeq: sorted[0].seq,
      reason: 'The first event does not link to the expected anchor. Events before it were removed or rewritten.',
      gaps: [], headHash: null,
    };
  }

  let prev: (typeof sorted)[number] | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (chainHash(r.prevHash, r.contentHash) !== r.hash) {
      return {
        ok: false, checked: i, brokenAtSeq: r.seq,
        reason: 'Event ' + r.seq + ' does not hash to its stored value. Its contents or its hash were changed.',
        gaps, headHash: prev ? prev.hash : null,
      };
    }
    if (prev) {
      if (r.prevHash !== prev.hash) {
        return {
          ok: false, checked: i, brokenAtSeq: r.seq,
          reason: 'Event ' + r.seq + ' does not link to event ' + prev.seq + '. An event between them was removed.',
          gaps, headHash: prev.hash,
        };
      }
      if (r.seq > prev.seq + 1) gaps.push({ afterSeq: prev.seq, beforeSeq: r.seq });
    }
    prev = r;
  }

  return {
    ok: true, checked: sorted.length, brokenAtSeq: null, reason: null,
    gaps, headHash: prev ? prev.hash : null,
  };
}

/**
 * Recompute one row's content hash from the fields as they are stored, so a verifier can prove the
 * CONTENT was not edited — not merely that the hashes are self-consistent.
 *
 * verifyChain() above checks the links. This checks the payload. Both matter: somebody with UPDATE
 * on the table could rewrite a row's fields AND its content_hash AND every subsequent hash, and only
 * an external anchor — a hash written somewhere this database cannot reach — closes that last door,
 * which is what auditAnchor() is for.
 */
export function contentMatches(row: AuditEventRow): boolean {
  return contentHash(row) === row.contentHash;
}

/**
 * The value to write down somewhere outside this database: an ops runbook, a monthly note to the
 * founder, a printed page in a file.
 *
 * This is the only defence against somebody who can rewrite the whole table. If the head hash
 * recorded last month does not appear in this month's chain, the log was rebuilt. Nothing clever,
 * and it is the part everybody skips.
 */
export function auditAnchor(head: { seq: number; hash: string } | null, at: string): string {
  if (!head) return 'EduRankAI Mail audit anchor ' + at + ': chain empty.';
  return 'EduRankAI Mail audit anchor ' + at + ': seq=' + head.seq + ' hash=' + head.hash;
}
