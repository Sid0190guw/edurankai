import { describe, expect, it } from 'vitest';
import { normalizeInboundMessageId, resolveConfiguredMailboxRecipients, type ConfiguredMailboxRecipientRow } from './mail-inbound-routing';

const row = (overrides: Partial<ConfiguredMailboxRecipientRow> = {}): ConfiguredMailboxRecipientRow => ({
  mailbox_id: 'mailbox-1',
  is_active: true,
  mailbox_deleted_at: null,
  organization_status: 'active',
  user_id: 'user-1',
  user_name: 'A. Person',
  user_email: 'a@example.test',
  ...overrides,
});

describe('configured inbound mailbox routing', () => {
  it('returns active mailbox owners and members once each', () => {
    const result = resolveConfiguredMailboxRecipients([
      row(),
      row({ user_id: 'user-2', user_name: 'B. Person', user_email: 'b@example.test' }),
      row({ user_name: 'A. Person duplicate' }),
    ], 'shared@edurankai.in');

    expect(result.matched).toBe(true);
    expect(result.recipients).toEqual([
      { userId: 'user-1', email: 'shared@edurankai.in', name: 'A. Person duplicate' },
      { userId: 'user-2', email: 'shared@edurankai.in', name: 'B. Person' },
    ]);
  });

  describe('inbound Message-ID normalization', () => {
    it('preserves a supplied identifier that fits the storage column', () => {
      expect(normalizeInboundMessageId('<message-1@example.test>', 'raw message'))
        .toBe('<message-1@example.test>');
    });

    it('creates a stable identifier from the raw message when no identifier is supplied', () => {
      const one = normalizeInboundMessageId('', 'same raw message');
      expect(normalizeInboundMessageId(null, 'same raw message')).toBe(one);
      expect(one).toMatch(/^<[a-f0-9]{64}@inbound\.edurankai\.invalid>$/);
      expect(normalizeInboundMessageId('', 'different message')).not.toBe(one);
    });

    it('hashes overlong supplied identifiers instead of truncating them into collisions', () => {
      const longId = 'x'.repeat(256);
      const normalized = normalizeInboundMessageId(longId, 'raw message');
      expect(normalized.length).toBeLessThanOrEqual(255);
      expect(normalized).toMatch(/^<[a-f0-9]{64}@inbound\.edurankai\.invalid>$/);
      expect(normalizeInboundMessageId(longId, 'raw message')).toBe(normalized);
    });
  });

  it('does not route disabled or deleted mailboxes or inactive organizations', () => {
    const result = resolveConfiguredMailboxRecipients([
      row({ is_active: false }),
      row({ mailbox_deleted_at: '2026-01-01T00:00:00Z', user_id: 'user-2' }),
      row({ organization_status: 'suspended', user_id: 'user-3' }),
    ], 'shared@edurankai.in');

    expect(result.matched).toBe(true);
    expect(result.recipients).toEqual([]);
  });

  it('distinguishes an unmapped address from a configured mailbox with no authorized recipients', () => {
    expect(resolveConfiguredMailboxRecipients([], 'unknown@edurankai.in'))
      .toEqual({ matched: false, recipients: [] });
    expect(resolveConfiguredMailboxRecipients([row({ user_id: null })], 'shared@edurankai.in'))
      .toEqual({ matched: true, recipients: [] });
  });
});
