import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  assertMailSecretIsUnreadable,
  encodeMailSecret,
  MAIL_SECRET_COLUMNS,
  type MailSecretColumn,
} from '@/lib/mail-secrets';

const rows = (result: any): any[] => Array.isArray(result) ? result : (result?.rows || []);

function selectStored(column: MailSecretColumn) {
  switch (column) {
    case 'smtp_pass': return sql`SELECT smtp_pass AS stored FROM mail_config WHERE id = 1 LIMIT 1`;
    case 'imap_pass': return sql`SELECT imap_pass AS stored FROM mail_config WHERE id = 1 LIMIT 1`;
    case 'resend_api_key': return sql`SELECT resend_api_key AS stored FROM mail_config WHERE id = 1 LIMIT 1`;
    case 'inbound_secret': return sql`SELECT inbound_secret AS stored FROM mail_config WHERE id = 1 LIMIT 1`;
  }
}

function compareAndReplace(column: MailSecretColumn, oldValue: string, replacement: string) {
  switch (column) {
    case 'smtp_pass': return sql`UPDATE mail_config SET smtp_pass = ${replacement}, updated_at = NOW() WHERE id = 1 AND smtp_pass = ${oldValue} RETURNING id`;
    case 'imap_pass': return sql`UPDATE mail_config SET imap_pass = ${replacement}, updated_at = NOW() WHERE id = 1 AND imap_pass = ${oldValue} RETURNING id`;
    case 'resend_api_key': return sql`UPDATE mail_config SET resend_api_key = ${replacement}, updated_at = NOW() WHERE id = 1 AND resend_api_key = ${oldValue} RETURNING id`;
    case 'inbound_secret': return sql`UPDATE mail_config SET inbound_secret = ${replacement}, updated_at = NOW() WHERE id = 1 AND inbound_secret = ${oldValue} RETURNING id`;
  }
}

/**
 * Replace one explicitly confirmed unreadable mail secret. Only the named column is updated.
 * The original stored value is used as a compare-and-swap guard so a concurrent settings save
 * cannot be overwritten. The encrypted value and plaintext are never logged or returned.
 */
export async function replaceUnreadableMailSecret(
  column: MailSecretColumn,
  plaintext: unknown,
  confirmedUnrecoverable: boolean,
): Promise<void> {
  if (!(MAIL_SECRET_COLUMNS as readonly string[]).includes(column)) {
    throw new Error('Unsupported mail secret column.');
  }
  if (!confirmedUnrecoverable) {
    throw new Error('Explicit confirmation that the original key cannot be recovered is required.');
  }
  if (typeof plaintext !== 'string') {
    throw new Error('Enter a replacement credential as text.');
  }
  const encrypted = encodeMailSecret(plaintext, column);
  if (!encrypted) throw new Error('Enter a non-empty replacement value.');

  // These schema checks are idempotent and are run only after an authenticated recovery submission.
  const { ensureMailSchema } = await import('@/lib/mail');
  await ensureMailSchema();
  if (column === 'imap_pass') {
    const { ensureImapSchema } = await import('@/lib/mail-imap');
    await ensureImapSchema();
  }

  const current = rows(await db.execute(selectStored(column)))[0];
  const oldValue = String(current?.stored ?? '');
  assertMailSecretIsUnreadable(oldValue, column);

  const updated = rows(await db.execute(compareAndReplace(column, oldValue, encrypted)));
  if (updated.length !== 1) {
    throw new Error(`The saved ${column} value changed during recovery. Reload settings and retry.`);
  }
}
