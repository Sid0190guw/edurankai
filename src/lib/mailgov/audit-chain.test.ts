// src/lib/mailgov/audit-chain.test.ts — can the audit log be edited without anybody noticing?
//
// Every test here is an attack. Change a field; change a field and its own hash; remove an event from
// the middle; fork the chain. The verifier has to catch all four, and it has to distinguish "this was
// tampered with" from "this window simply starts here".
import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH, auditAnchor, canonicalJson, chainHash, contentHash, contentMatches, verifyChain,
  type AuditEventInput, type AuditEventRow,
} from './audit-chain';

const base = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
  orgId: 'org-1',
  actorUserId: 'user-1',
  actorEmail: 'admin@example.test',
  actorRole: 'platform_admin',
  actorApiKeyId: null,
  action: 'org.suspended',
  targetType: 'organization',
  targetId: 'org-1',
  result: 'ok',
  reason: 'Complaint rate above threshold.',
  ip: '203.0.113.7',
  userAgent: 'test',
  requestId: 'req-1',
  meta: { control: 'sending' },
  occurredAt: '2026-08-16T10:00:00.000Z',
  ...over,
});

/** Build a valid chain of n events, the way recordAudit() would. */
function buildChain(inputs: AuditEventInput[]): AuditEventRow[] {
  let prev = GENESIS_HASH;
  return inputs.map((input, i) => {
    const ch = contentHash(input);
    const hash = chainHash(prev, ch);
    const row: AuditEventRow = { ...input, id: 'id-' + i, seq: i + 1, contentHash: ch, prevHash: prev, hash };
    prev = hash;
    return row;
  });
}

describe('canonical JSON', () => {
  it('produces the same bytes whatever order the keys were assembled in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe(canonicalJson({ x: { y: 2, z: 1 } }));
  });

  it('keeps array order, which is data rather than presentation', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined and serialises a Date rather than emptying it', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ d: new Date('2026-01-01T00:00:00.000Z') })).toBe('{"d":"2026-01-01T00:00:00.000Z"}');
  });
});

describe('the content hash', () => {
  it('changes when any field changes', () => {
    const h = contentHash(base());
    const fields: Partial<AuditEventInput>[] = [
      { action: 'org.restored' }, { reason: 'Something else.' }, { result: 'denied' },
      { orgId: 'org-2' }, { actorUserId: 'user-2' }, { targetId: 'org-2' },
      { ip: '203.0.113.8' }, { occurredAt: '2026-08-16T10:00:01.000Z' }, { meta: { control: 'receiving' } },
    ];
    for (const f of fields) {
      expect(contentHash(base(f)), JSON.stringify(f) + ' must change the hash').not.toBe(h);
    }
  });

  it('distinguishes an absent value from an empty one', () => {
    expect(contentHash(base({ reason: null }))).not.toBe(contentHash(base({ reason: '' })));
  });

  it('cannot be fooled by moving characters across a field boundary', () => {
    // Without a separator, action='ab' + target='c' and action='a' + target='bc' would concatenate
    // identically. That is a forgery primitive, not a cosmetic detail.
    const a = contentHash(base({ action: 'ab', targetType: 'c' }));
    const b = contentHash(base({ action: 'a', targetType: 'bc' }));
    expect(a).not.toBe(b);
  });

  it('is stable across calls, so verification is repeatable', () => {
    expect(contentHash(base())).toBe(contentHash(base()));
  });
});

describe('verifying a chain', () => {
  const rows = buildChain([
    base({ action: 'user.created', occurredAt: '2026-08-16T10:00:00.000Z' }),
    base({ action: 'org.suspended', occurredAt: '2026-08-16T10:01:00.000Z' }),
    base({ action: 'export.requested', occurredAt: '2026-08-16T10:02:00.000Z' }),
    base({ action: 'deletion.executed', occurredAt: '2026-08-16T10:03:00.000Z' }),
  ]);

  it('accepts an intact chain anchored at genesis', () => {
    const v = verifyChain(rows, GENESIS_HASH);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(4);
    expect(v.brokenAtSeq).toBe(null);
    expect(v.headHash).toBe(rows[3].hash);
  });

  it('accepts an empty range rather than calling it broken', () => {
    const v = verifyChain([], GENESIS_HASH);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(0);
  });

  it('catches an edited field, because the stored hash no longer matches', () => {
    const tampered = rows.map((r, i) => (i === 1 ? { ...r, reason: 'A nicer reason.' } : r));
    // The row's own content_hash is unchanged, so contentMatches spots it...
    expect(contentMatches(tampered[1])).toBe(false);
    // ...and re-deriving the content hash and re-linking would be needed to hide it.
    expect(contentMatches(rows[1])).toBe(true);
  });

  it('catches an edited field even when its own content hash is recomputed', () => {
    const edited = { ...rows[1], reason: 'A nicer reason.' };
    const recomputed = { ...edited, contentHash: contentHash(edited) };
    const chain = [rows[0], recomputed, rows[2], rows[3]];
    const v = verifyChain(chain, GENESIS_HASH);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
    expect(String(v.reason)).toContain('does not hash to its stored value');
  });

  it('catches a removed event', () => {
    const chain = [rows[0], rows[2], rows[3]];
    const v = verifyChain(chain, GENESIS_HASH);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
    expect(String(v.reason)).toContain('does not link');
  });

  it('catches a chain whose start does not link to the expected anchor', () => {
    const v = verifyChain(rows.slice(1), GENESIS_HASH);
    expect(v.ok).toBe(false);
    expect(String(v.reason)).toContain('anchor');
  });

  it('verifies a WINDOW when given the hash it should link back to', () => {
    const v = verifyChain(rows.slice(2), rows[1].hash);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(2);
  });

  it('reports a seq gap without failing when the links still hold', () => {
    // A burnt sequence number (a rolled-back insert, or the prev_hash retry) is not tampering.
    const renumbered = rows.map((r, i) => (i >= 2 ? { ...r, seq: r.seq + 5 } : r));
    const v = verifyChain(renumbered, GENESIS_HASH);
    expect(v.ok).toBe(true);
    expect(v.gaps.length).toBe(1);
    expect(v.gaps[0]).toEqual({ afterSeq: 2, beforeSeq: 8 });
  });

  it('catches a forked chain — two events claiming the same predecessor', () => {
    const forked = { ...rows[2], id: 'id-fork', seq: 99, action: 'org.deleted' };
    const rebuilt = { ...forked, contentHash: contentHash(forked), hash: chainHash(rows[1].hash, contentHash(forked)) };
    const v = verifyChain([rows[0], rows[1], rows[2], rebuilt], GENESIS_HASH);
    expect(v.ok).toBe(false);
  });

  it('sorts by seq, so the caller cannot break verification by ordering rows differently', () => {
    const shuffled = [rows[3], rows[0], rows[2], rows[1]];
    expect(verifyChain(shuffled, GENESIS_HASH).ok).toBe(true);
  });
});

describe('the external anchor', () => {
  it('states the head so it can be recorded outside this database', () => {
    const line = auditAnchor({ seq: 42, hash: 'abc123' }, '2026-08-16T10:00:00.000Z');
    expect(line).toContain('seq=42');
    expect(line).toContain('hash=abc123');
  });

  it('says so plainly when the chain is empty', () => {
    expect(auditAnchor(null, '2026-08-16T10:00:00.000Z')).toContain('chain empty');
  });
});
