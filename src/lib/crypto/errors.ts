export type CryptoFailureCode =
  | 'missing_key_material'
  | 'invalid_key_base64'
  | 'invalid_key_length'
  | 'malformed_ciphertext'
  | 'ciphertext_authentication_failed';

export class CryptoKeyMaterialError extends Error {
  readonly keyId: string;
  readonly envVarName: string;
  readonly code: 'missing_key_material' | 'invalid_key_base64' | 'invalid_key_length';
  readonly decodedLength?: number;

  constructor(input: {
    keyId: string;
    code: CryptoKeyMaterialError['code'];
    message: string;
    decodedLength?: number;
  }) {
    super(input.message);
    this.name = 'CryptoKeyMaterialError';
    this.keyId = input.keyId;
    this.envVarName = `DATA_ENCRYPTION_KEY_${input.keyId}`;
    this.code = input.code;
    this.decodedLength = input.decodedLength;
  }
}

export class MalformedCiphertextError extends Error {
  readonly code = 'malformed_ciphertext' as const;
  constructor(message = 'Encrypted data is malformed.') {
    super(message);
    this.name = 'MalformedCiphertextError';
  }
}

export class CiphertextAuthenticationError extends Error {
  readonly code = 'ciphertext_authentication_failed' as const;
  readonly keyId: string;
  constructor(keyId: string) {
    super(`Ciphertext authentication failed for keyId '${keyId}'. The key may be wrong or the ciphertext may have changed.`);
    this.name = 'CiphertextAuthenticationError';
    this.keyId = keyId;
  }
}

/** Safe classification for logs and admin diagnostics. Never includes key or plaintext values. */
export function cryptoFailureCode(error: unknown): CryptoFailureCode | 'unknown_crypto_error' {
  if (error instanceof CryptoKeyMaterialError) return error.code;
  if (error instanceof MalformedCiphertextError) return error.code;
  if (error instanceof CiphertextAuthenticationError) return error.code;
  return 'unknown_crypto_error';
}

/** Safe, actionable diagnostic suitable for an authenticated admin health screen. */
export function cryptoFailureMessage(error: unknown): string {
  if (error instanceof CryptoKeyMaterialError) {
    if (error.code === 'missing_key_material') {
      return `Missing ${error.envVarName}. Restore the original key for existing ciphertext.`;
    }
    if (error.code === 'invalid_key_base64') {
      return `${error.envVarName} must be valid Base64 encoding of a 32-byte key.`;
    }
    return `${error.envVarName} must decode to exactly 32 bytes (received ${error.decodedLength ?? 'an invalid length'}).`;
  }
  if (error instanceof MalformedCiphertextError) return 'The saved encrypted value is malformed.';
  if (error instanceof CiphertextAuthenticationError) {
    return `Authentication failed for keyId '${error.keyId}'. A wrong key and changed ciphertext cannot be distinguished.`;
  }
  return 'The saved encrypted value could not be read due to an unexpected crypto error.';
}
