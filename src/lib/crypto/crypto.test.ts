// src/lib/crypto/crypto.test.ts — run: npx tsx src/lib/crypto/crypto.test.ts
// Self-contained (no DB): envelope encryption round-trip, tamper detection, and rotation.
// Sets its own key material in env before exercising the pure crypto.
process.env.DATA_ENCRYPTION_KEY_k1 = Buffer.alloc(32, 1).toString('base64');
process.env.ACTIVE_DATA_KEY_ID = 'k1';

import { encryptField, decryptField, encryptBlob, decryptBlob } from './envelope';
import { EnvelopeCiphertextSchema } from './schema';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

function main() {
  console.log('\n== field round-trip ==');
  const secret = 'PAN: ABCDE1234F • ₹ sensitive';
  const env = encryptField(secret);
  ok('envelope has v/keyId/alg/iv/ct/tag', EnvelopeCiphertextSchema.safeParse(env).success && env.keyId === 'k1' && env.alg === 'A256GCM');
  ok('ciphertext is not the plaintext', env.ct.length > 0 && !env.ct.includes('sensitive'));
  ok('decrypts back to the original (unicode-safe)', decryptField(env) === secret);
  ok('two encryptions of the same text differ (random IV)', encryptField(secret).ct !== encryptField(secret).ct);

  console.log('\n== AAD binding ==');
  const withAad = encryptField('doc-body', 'objectId:123');
  ok('decrypts with the correct AAD', decryptField(withAad) === 'doc-body');
  let aadThrew = false; try { decryptField({ ...withAad, aad: 'objectId:999' }); } catch { aadThrew = true; }
  ok('wrong AAD fails authentication', aadThrew);

  console.log('\n== tamper detection (GCM auth tag) ==');
  const t = encryptField('immutable');
  const raw = Buffer.from(t.ct, 'base64'); raw[0] ^= 0xff;   // flip a ciphertext byte
  let tamperThrew = false; try { decryptField({ ...t, ct: raw.toString('base64') }); } catch { tamperThrew = true; }
  ok('a flipped ciphertext byte makes decrypt throw', tamperThrew);
  let tagThrew = false; try { const bad = Buffer.from(t.tag, 'base64'); bad[0] ^= 0xff; decryptField({ ...t, tag: bad.toString('base64') }); } catch { tagThrew = true; }
  ok('a flipped auth tag makes decrypt throw', tagThrew);

  console.log('\n== non-destructive rotation (decrypt by keyId) ==');
  const oldEnv = encryptField('written under k1');     // active = k1
  process.env.DATA_ENCRYPTION_KEY_k2 = Buffer.alloc(32, 2).toString('base64');
  process.env.ACTIVE_DATA_KEY_ID = 'k2';               // rotate active to k2
  ok('new writes use k2', encryptField('x').keyId === 'k2');
  ok('old k1 ciphertext still decrypts after rotation', decryptField(oldEnv) === 'written under k1');
  process.env.ACTIVE_DATA_KEY_ID = 'k1';               // restore

  console.log('\n== blob round-trip ==');
  const data = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const { header, body } = encryptBlob(data, 'blob:abc');
  ok('blob header carries iv/tag, body holds ciphertext', header.ct === '' && body.length > 0);
  ok('blob decrypts byte-for-byte', Buffer.from(decryptBlob(header, body)).equals(Buffer.from(data)));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
