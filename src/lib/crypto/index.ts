// src/lib/crypto/index.ts — Block 11 crypto public surface.
export { encryptField, decryptField, encryptBlob, decryptBlob } from './envelope';
export { getKeyMaterial, inspectKeyMaterial, activeKeyId, ensureCryptoSchema, listKeyMetadata, markRotating, retireKey, type KeyMaterialStatus } from './keys';
export { CryptoKeyMaterialError, MalformedCiphertextError, CiphertextAuthenticationError, cryptoFailureCode, cryptoFailureMessage, type CryptoFailureCode } from './errors';
export { EnvelopeCiphertextSchema, CRYPTO_DDL, cryptoKeys, type EnvelopeCiphertext, type CryptoKey } from './schema';
