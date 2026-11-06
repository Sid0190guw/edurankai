import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { activeKeyId, getKeyMaterial } from '@/lib/crypto/keys';
import {
  decodeMailSecret,
  encodeMailSecretVerbatim,
  MAIL_SECRET_COLUMNS,
  isMailSecretEnvelope,
  type MailSecretColumn,
} from '@/lib/mail-secrets';

export interface MailSecretMigrationApproval {
  keyIdInventoryReviewed: boolean;
  smtpAndImapVerified: boolean;
  explicitlyAuthorized: boolean;
}

export type MailSecretMigrationOutcome = {
  column: MailSecretColumn;
  result: 'migrated' | 'already_encrypted' | 'empty';
};

export class MailSecretMigrationError extends Error {
  constructor(readonly code: 'confirmation_required' | 'invalid_selection' | 'mail_config_missing' | 'compare_and_swap_failed' | 'roundtrip_failed' | 'invalid_storage_value') {
    super(`Mail-secret migration stopped (${code}).`);
    this.name = 'MailSecretMigrationError';
  }
}

const rows = (result: any): any[] => Array.isArray(result) ? result : (result?.rows || []);

function validColumn(value: unknown): value is MailSecretColumn {
  return typeof value === 'string' && (MAIL_SECRET_COLUMNS as readonly string[]).includes(value);
}

function selectForUpdate(tx: any, column: MailSecretColumn) {
  switch (column) {
    case 'smtp_pass': return tx.execute(sql`SELECT smtp_pass AS stored FROM mail_config WHERE id = 1 FOR UPDATE`);
    case 'imap_pass': return tx.execute(sql`SELECT imap_pass AS stored FROM mail_config WHERE id = 1 FOR UPDATE`);
    case 'resend_api_key': return tx.execute(sql`SELECT resend_api_key AS stored FROM mail_config WHERE id = 1 FOR UPDATE`);
    case 'inbound_secret': return tx.execute(sql`SELECT inbound_secret AS stored FROM mail_config WHERE id = 1 FOR UPDATE`);
  }
}

function compareAndSwap(tx: any, column: MailSecretColumn, oldValue: string, encrypted: string) {
  switch (column) {
    case 'smtp_pass': return tx.execute(sql`UPDATE mail_config SET smtp_pass = ${encrypted}, updated_at = NOW() WHERE id = 1 AND smtp_pass IS NOT DISTINCT FROM ${oldValue} RETURNING id`);
    case 'imap_pass': return tx.execute(sql`UPDATE mail_config SET imap_pass = ${encrypted}, updated_at = NOW() WHERE id = 1 AND imap_pass IS NOT DISTINCT FROM ${oldValue} RETURNING id`);
    case 'resend_api_key': return tx.execute(sql`UPDATE mail_config SET resend_api_key = ${encrypted}, updated_at = NOW() WHERE id = 1 AND resend_api_key IS NOT DISTINCT FROM ${oldValue} RETURNING id`);
    case 'inbound_secret': return tx.execute(sql`UPDATE mail_config SET inbound_secret = ${encrypted}, updated_at = NOW() WHERE id = 1 AND inbound_secret IS NOT DISTINCT FROM ${oldValue} RETURNING id`);
  }
}

/**
 * Encrypt selected legacy mail fields atomically. The operator must have reviewed every encrypted
 * field/key ID and verified mail connectivity first. Field names are allowlisted, rows are locked,
 * each update is guarded by the exact value read, and no secret or ciphertext is returned/logged.
 */
export async function migrateLegacyMailSecrets(
  requestedColumns: readonly unknown[],
  approval: MailSecretMigrationApproval,
): Promise<MailSecretMigrationOutcome[]> {
  if (!approval || approval.keyIdInventoryReviewed !== true
    || approval.smtpAndImapVerified !== true || approval.explicitlyAuthorized !== true) {
    throw new MailSecretMigrationError('confirmation_required');
  }
  if (!Array.isArray(requestedColumns) || requestedColumns.length === 0 || !requestedColumns.every(validColumn)) {
    throw new MailSecretMigrationError('invalid_selection');
  }
  const columns = [...new Set(requestedColumns as MailSecretColumn[])];

  // Fail before opening a database transaction or reading stored values if the write key is absent
  // or malformed. The configured key is resolved by the active ID; no key material leaves memory.
  getKeyMaterial(activeKeyId());

  return db.transaction(async (tx: any) => {
    const outcomes: MailSecretMigrationOutcome[] = [];
    for (const column of columns) {
      const row = rows(await selectForUpdate(tx, column))[0];
      if (!row) throw new MailSecretMigrationError('mail_config_missing');
      if (row.stored == null || row.stored === '') {
        outcomes.push({ column, result: 'empty' });
        continue;
      }
      if (typeof row.stored !== 'string') throw new MailSecretMigrationError('invalid_storage_value');

      const oldValue = row.stored;
      if (isMailSecretEnvelope(oldValue)) {
        // Verify encrypted fields too: a missing historical key or damaged envelope aborts the
        // entire transaction instead of being reported as successfully migrated.
        decodeMailSecret(oldValue, column);
        outcomes.push({ column, result: 'already_encrypted' });
        continue;
      }

      const encrypted = encodeMailSecretVerbatim(oldValue, column);
      if (!encrypted || decodeMailSecret(encrypted, column) !== oldValue) {
        throw new MailSecretMigrationError('roundtrip_failed');
      }
      const updated = rows(await compareAndSwap(tx, column, oldValue, encrypted));
      if (updated.length !== 1) throw new MailSecretMigrationError('compare_and_swap_failed');
      outcomes.push({ column, result: 'migrated' });
    }
    return outcomes;
  });
}
