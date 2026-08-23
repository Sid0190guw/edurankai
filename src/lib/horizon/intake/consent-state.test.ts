// The logic that decides whether we may hold somebody's data, tested with no database in sight.
//
// deriveConsentState() exists as a separate pure function precisely so this suite can exercise the
// orderings that matter — out-of-order rows, a re-grant after a withdrawal, a grant against a
// superseded notice — none of which are convenient to set up against a live table.
import { describe, expect, it } from 'vitest';
import { applicantSubject } from '@/lib/horizon/ids';
import { deriveConsentState } from './consent';
import { CURRENT_NOTICE_VERSION } from './notice';
import { CONSENT_SCOPE_PERSONAL_FOUNDATION, type ConsentEvent } from './types';

const SUBJECT = applicantSubject('11111111-1111-4111-8111-111111111111', 'user');

function ev(action: 'granted' | 'withdrawn', at: string, version = CURRENT_NOTICE_VERSION): ConsentEvent {
  return {
    id: action + '-' + at,
    subject: SUBJECT,
    scope: CONSENT_SCOPE_PERSONAL_FOUNDATION,
    action,
    noticeVersion: version,
    noticeHash: 'x'.repeat(64),
    occurredAt: at,
    actor: { kind: 'user', id: SUBJECT.id, displayName: null },
    source: 'apply/step-1',
    ipAddress: null,
    userAgent: null,
    reason: null,
  };
}

describe('deriving consent from the ledger', () => {
  it('an empty ledger is not consent', () => {
    const s = deriveConsentState([], SUBJECT);
    expect(s.granted).toBe(false);
    expect(s.grantedAt).toBeNull();
    expect(s.consentRef).toBeNull();
  });

  it('a single grant is consent', () => {
    const s = deriveConsentState([ev('granted', '2026-08-01T10:00:00.000Z')], SUBJECT);
    expect(s.granted).toBe(true);
    expect(s.grantedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(s.stale).toBe(false);
  });

  it('the most recent act wins, whatever order the rows arrive in', () => {
    const rows = [
      ev('withdrawn', '2026-08-05T10:00:00.000Z'),
      ev('granted', '2026-08-01T10:00:00.000Z'),
    ];
    expect(deriveConsentState(rows, SUBJECT).granted).toBe(false);
    // Same rows, reversed: the answer must not depend on the order they came back in.
    expect(deriveConsentState([...rows].reverse(), SUBJECT).granted).toBe(false);
  });

  it('a re-grant after a withdrawal is consent again, dated to the re-grant', () => {
    const s = deriveConsentState([
      ev('granted', '2026-03-01T10:00:00.000Z'),
      ev('withdrawn', '2026-03-20T10:00:00.000Z'),
      ev('granted', '2026-07-04T10:00:00.000Z'),
    ], SUBJECT);
    expect(s.granted).toBe(true);
    // NOT March. Showing the first grant would misdate the authorisation actually in force.
    expect(s.grantedAt).toBe('2026-07-04T10:00:00.000Z');
    // The withdrawal still happened and is still visible.
    expect(s.withdrawnAt).toBe('2026-03-20T10:00:00.000Z');
  });

  it('a withdrawal after a re-grant wins', () => {
    const s = deriveConsentState([
      ev('granted', '2026-07-04T10:00:00.000Z'),
      ev('withdrawn', '2026-07-05T10:00:00.000Z'),
    ], SUBJECT);
    expect(s.granted).toBe(false);
    expect(s.grantedAt).toBeNull();
  });

  // A grant against superseded terms is STILL A GRANT. It is not silently revoked, and it is not
  // silently carried forward onto new terms either.
  it('marks a live grant against an old notice as stale without revoking it', () => {
    const s = deriveConsentState([ev('granted', '2026-01-01T10:00:00.000Z', 'pf-1999-01-01.v1')], SUBJECT);
    expect(s.granted).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.noticeVersion).toBe('pf-1999-01-01.v1');
  });

  it('cites the exact consent row so another layer can reference it', () => {
    const s = deriveConsentState([ev('granted', '2026-08-01T10:00:00.000Z')], SUBJECT);
    expect(s.consentRef).toBe('granted-2026-08-01T10:00:00.000Z');
  });

  it('ignores events for another scope', () => {
    const other = { ...ev('granted', '2026-08-01T10:00:00.000Z'), scope: 'something_else' as any };
    expect(deriveConsentState([other], SUBJECT).granted).toBe(false);
  });
});
