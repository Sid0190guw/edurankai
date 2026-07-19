// src/lib/crypto/index.ts — Block 11 crypto public surface.
export { encryptField, decryptField, encryptBlob, decryptBlob } from './envelope';
export { getKeyMaterial, activeKeyId, ensureCryptoSchema, listKeyMetadata, markRotating, retireKey } from './keys';
export { EnvelopeCiphertextSchema, CRYPTO_DDL, cryptoKeys, type EnvelopeCiphertext, type CryptoKey } from './schema';
