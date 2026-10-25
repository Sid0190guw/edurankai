import { CryptoKeyMaterialError, cryptoFailureMessage, decryptField, encryptField, EnvelopeCiphertextSchema, MalformedCiphertextError } from '@/lib/crypto';

const ENCRYPTED_PREFIX = 'era-mail-secret:v1:';
export const MAIL_SECRET_COLUMNS = [
  'smtp_pass',
  'imap_pass',
  'resend_api_key',
  'inbound_secret',
 ] as const;
export type MailSecretColumn = typeof MAIL_SECRET_COLUMNS[number];
const SECRET_COLUMNS = new Set<string>(MAIL_SECRET_COLUMNS);

export class MailSecretReplacementRequiredError extends Error {
  readonly code = 'mail_secret_recovery_required' as const;
  constructor(readonly column: MailSecretColumn, detail: string) {
    super(`The saved ${column} value is unreadable. ${detail}`);
    this.name = 'MailSecretReplacementRequiredError';
  }
}

export class MailSecretStillReadableError extends Error {
  readonly code = 'mail_secret_still_readable' as const;
  constructor(readonly column: MailSecretColumn) {
    super(`The saved ${column} value is readable. Use the normal settings form to change it.`);
    this.name = 'MailSecretStillReadableError';
  }
}

function aadFor(column: string): string {
  if (!SECRET_COLUMNS.has(column)) throw new Error('Unsupported mail secret column.');
  return 'edurankai.mail_config.' + column + '.v1';
}

export function encodeMailSecret(value: unknown, column: string): string | null {
  const plaintext = String(value ?? '').trim();
  if (!plaintext) return null;
  const envelope = encryptField(plaintext, aadFor(column));
  return ENCRYPTED_PREFIX + JSON.stringify(envelope);
}

export function decodeMailSecret(value: unknown, column: string): string {
  const stored = String(value ?? '');
  if (!stored) return '';
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.slice(ENCRYPTED_PREFIX.length));
  } catch {
    throw new MalformedCiphertextError('Stored mail secret has an invalid envelope encoding.');
  }
  let envelope;
  try {
    envelope = EnvelopeCiphertextSchema.parse(parsed);
  } catch {
    throw new MalformedCiphertextError('Stored mail secret has an invalid envelope structure.');
  }
  const expectedAad = aadFor(column);
  if (envelope.aad !== expectedAad) {
    throw new MalformedCiphertextError('Stored mail secret is bound to a different configuration field.');
  }
  return decryptField(envelope);
}

/** Prevent a routine settings save from silently replacing a field that cannot currently be read. */
export function assertMailSecretReadableBeforeReplace(storedValue: unknown, column: MailSecretColumn): void {
  const stored = String(storedValue ?? '');
  if (!stored) return;
  try {
    decodeMailSecret(stored, column);
  } catch (error) {
    throw new MailSecretReplacementRequiredError(column, cryptoFailureMessage(error));
  }
}

/** Recovery is allowed only for an existing, non-empty value that fails normal decryption. */
export function assertMailSecretIsUnreadable(storedValue: unknown, column: MailSecretColumn): void {
  const stored = String(storedValue ?? '');
  if (!stored) throw new Error(`No saved ${column} value is available to recover.`);
  try {
    decodeMailSecret(stored, column);
  } catch (error) {
    // Recovery is specifically for ciphertext whose original key is absent. A malformed envelope,
    // invalid key configuration, or authentication failure needs investigation first; in the last
    // case a wrong key and altered ciphertext cannot be distinguished safely.
    if (error instanceof CryptoKeyMaterialError && error.code === 'missing_key_material') return;
    throw new Error(`Recovery for ${column} is blocked until the key configuration or ciphertext issue is resolved. ${cryptoFailureMessage(error)}`);
  }
  throw new MailSecretStillReadableError(column);
}
