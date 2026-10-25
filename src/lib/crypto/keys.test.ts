import { afterEach, describe, expect, it } from 'vitest';
import { CryptoKeyMaterialError } from './errors';
import { getKeyMaterial, inspectKeyMaterial } from './keys';

const keyId = 'test_key';
const envName = `DATA_ENCRYPTION_KEY_${keyId}`;
const previous = process.env[envName];

afterEach(() => {
  if (previous === undefined) delete process.env[envName];
  else process.env[envName] = previous;
});

describe('data encryption key loading', () => {
  it('reports a missing key with the exact environment variable name', () => {
    delete process.env[envName];
    try {
      getKeyMaterial(keyId);
      throw new Error('expected missing key to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoKeyMaterialError);
      expect(error).toMatchObject({ code: 'missing_key_material', keyId, envVarName: envName });
      expect((error as Error).message).toBe(`missing key material for keyId '${keyId}' (set ${envName})`);
    }
  });

  it('accepts existing padded and unpadded Base64 encodings of the same 32 bytes', () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    process.env[envName] = bytes.toString('base64');
    expect(getKeyMaterial(keyId)).toEqual(bytes);
    process.env[envName] = bytes.toString('base64').replace(/=+$/, '');
    expect(getKeyMaterial(keyId)).toEqual(bytes);
  });

  it('rejects malformed Base64 rather than silently decoding a partial key', () => {
    process.env[envName] = 'AA!A';
    expect(() => getKeyMaterial(keyId)).toThrow(expect.objectContaining({ code: 'invalid_key_base64' }));
  });

  it('rejects a valid Base64 value that decodes to the wrong byte length', () => {
    process.env[envName] = Buffer.alloc(31, 9).toString('base64');
    expect(() => getKeyMaterial(keyId)).toThrow(expect.objectContaining({ code: 'invalid_key_length', decodedLength: 31 }));
  });

  it('reports key health without returning the key value', () => {
    const value = Buffer.alloc(32, 41).toString('base64');
    process.env[envName] = value;
    const status = inspectKeyMaterial(keyId);
    expect(status).toEqual({ keyId, envVarName: envName, status: 'valid', message: `${envName} is valid.` });
    expect(JSON.stringify(status)).not.toContain(value);
  });
});
