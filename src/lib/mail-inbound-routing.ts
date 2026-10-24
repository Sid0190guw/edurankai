export interface ConfiguredMailboxRecipientRow {
  mailbox_id: string;
  is_active: boolean | null;
  mailbox_deleted_at: Date | string | null;
  organization_status: string | null;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
}

export interface ConfiguredInboundRecipient {
  userId: string | null;
  email: string;
  name: string | null;
}

export interface ConfiguredMailboxResolution {
  matched: boolean;
  recipients: ConfiguredInboundRecipient[];
}

export function normalizeInboundMessageId(
  messageId: string | null | undefined,
  rawMessage: Uint8Array | string,
): string {
  const candidate = String(messageId || '').trim();
  if (candidate && candidate.length <= 255) return candidate;
  const digest = createHash('sha256').update(rawMessage).digest('hex');
  return `<${digest}@inbound.edurankai.invalid>`;
}

export function resolveConfiguredMailboxRecipients(
  rows: ConfiguredMailboxRecipientRow[],
  address: string,
): ConfiguredMailboxResolution {
  const recipients = new Map<string, ConfiguredInboundRecipient>();
  for (const row of rows) {
    if (!row.user_id || !row.is_active || row.mailbox_deleted_at ||
        row.organization_status !== 'active') continue;
    const userId = String(row.user_id);
    recipients.set(userId, {
      userId,
      email: address,
      name: row.user_name || row.user_email || null,
    });
  }
  return { matched: rows.length > 0, recipients: [...recipients.values()] };
}
import { createHash } from 'node:crypto';
