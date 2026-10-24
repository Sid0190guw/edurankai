import { decryptField, encryptField, EnvelopeCiphertextSchema } from '@/lib/crypto';

const ENCRYPTED_PREFIX = 'era-mail-secret:v1:';
const SECRET_COLUMNS = new Set([
  'smtp_pass',
  'imap_pass',
  'resend_api_key',
  'inbound_secret',
]);

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

  const parsed: unknown = JSON.parse(stored.slice(ENCRYPTED_PREFIX.length));
  const envelope = EnvelopeCiphertextSchema.parse(parsed);
  const expectedAad = aadFor(column);
  if (envelope.aad !== expectedAad) {
    throw new Error('Encrypted mail secret is bound to a different configuration field.');
  }
  return decryptField(envelope);
}
