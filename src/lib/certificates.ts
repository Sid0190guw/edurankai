// Course-completion certificates with a cryptographically verifiable ledger.
//
// Each certificate is a "block" in a hash chain (the blockchain data structure):
//   content_hash = SHA-256(canonical credential JSON)
//   block_hash   = SHA-256(prev_block_hash | content_hash | chain_index)
//   signature    = Ed25519(block_hash) by EduRankAI's issuing key
// Altering any field of any past certificate changes its content_hash, which
// changes its block_hash, which breaks the prev_hash reference of every later
// certificate — tamper-evident, exactly like an on-chain ledger. The Ed25519
// signature proves the issuer; anyone can verify with the published public key.
//
// Auto-issued when an enrollment hits 100% progress. Unique per (user, course).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes, createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
const GENESIS = '0'.repeat(64);

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const ex = async (q: any) => { try { await db.execute(q); } catch (_) {} };
    await ex(sql`CREATE TABLE IF NOT EXISTS course_certificates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      course_id UUID NOT NULL, course_title TEXT NOT NULL,
      cert_number VARCHAR(40) UNIQUE NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      grade VARCHAR(8), verification_url TEXT,
      UNIQUE(user_id, course_id))`);
    // Ledger columns (idempotent).
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS holder_name TEXT`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS issuer VARCHAR(80) DEFAULT 'EduRankAI'`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS issued_at_iso TEXT`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64)`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64)`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS block_hash VARCHAR(64)`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS chain_index BIGINT`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS signature TEXT`);
    await ex(sql`ALTER TABLE course_certificates ADD COLUMN IF NOT EXISTS signing_key_id UUID`);
    await ex(sql`CREATE INDEX IF NOT EXISTS cc_chain_idx ON course_certificates(chain_index)`);
    // Signing keys.
    await ex(sql`CREATE TABLE IF NOT EXISTS cert_signing_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      algo VARCHAR(20) NOT NULL DEFAULT 'ed25519',
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })();
  return schemaReady;
}

// ---- signing key (generated once, then loaded) -------------------------------
let keyCache: { id: string; publicKeyPem: string; privateKeyPem: string } | null = null;
async function getSigningKey() {
  if (keyCache) return keyCache;
  await ensureSchema();
  // Prefer an env-provided key (so the same key survives DB resets).
  const envPub = process.env.CERT_PUBLIC_KEY_PEM, envPriv = process.env.CERT_PRIVATE_KEY_PEM;
  if (envPub && envPriv) {
    let r = rows(await db.execute(sql`SELECT id FROM cert_signing_keys WHERE public_key_pem = ${envPub} LIMIT 1`))[0] as any;
    if (!r) r = rows(await db.execute(sql`INSERT INTO cert_signing_keys (public_key_pem, private_key_pem) VALUES (${envPub}, ${envPriv}) RETURNING id`))[0];
    keyCache = { id: r.id, publicKeyPem: envPub, privateKeyPem: envPriv };
    return keyCache;
  }
  const existing = rows(await db.execute(sql`SELECT id, public_key_pem, private_key_pem FROM cert_signing_keys WHERE is_active = true ORDER BY created_at ASC LIMIT 1`))[0] as any;
  if (existing) { keyCache = { id: existing.id, publicKeyPem: existing.public_key_pem, privateKeyPem: existing.private_key_pem }; return keyCache; }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const ins = rows(await db.execute(sql`INSERT INTO cert_signing_keys (public_key_pem, private_key_pem) VALUES (${pub}, ${priv}) RETURNING id`))[0] as any;
  keyCache = { id: ins.id, publicKeyPem: pub, privateKeyPem: priv };
  return keyCache;
}

export async function getPublicKeyPem(): Promise<string> {
  return (await getSigningKey()).publicKeyPem;
}

// ---- canonical content + hashing --------------------------------------------
function canonical(c: { cert_number: string; holder_name: string; user_id: string; course_id: string; course_title: string; grade: string | null; issuer: string; issued_at_iso: string }): string {
  return JSON.stringify({
    v: 1, cert_number: c.cert_number, holder: c.holder_name, holder_id: c.user_id,
    course_id: c.course_id, course: c.course_title, grade: c.grade,
    issuer: c.issuer, issued_at: c.issued_at_iso,
  });
}
function sha256(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function blockHash(prev: string, contentHash: string, idx: number): string { return sha256(prev + '|' + contentHash + '|' + idx); }

function makeCertNumber(): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rnd = randomBytes(3).toString('hex').toUpperCase();
  return `ERA-CERT-${ts}-${rnd}`;
}

export async function issueCertificate(opts: { userId: string; courseId: string; courseTitle: string; grade?: string; holderName?: string }): Promise<{ id: string; certNumber: string; alreadyIssued: boolean; blockHash?: string } | null> {
  if (!opts.userId || !opts.courseId) return null;
  await ensureSchema();
  const existing = rows(await db.execute(sql`SELECT id, cert_number, block_hash FROM course_certificates WHERE user_id = ${opts.userId} AND course_id = ${opts.courseId} LIMIT 1`))[0] as any;
  if (existing) return { id: existing.id, certNumber: existing.cert_number, alreadyIssued: true, blockHash: existing.block_hash };

  // holder name
  let holderName = opts.holderName || '';
  if (!holderName) {
    try { holderName = (rows(await db.execute(sql`SELECT name FROM users WHERE id = ${opts.userId} LIMIT 1`))[0] as any)?.name || 'Learner'; } catch { holderName = 'Learner'; }
  }

  let certNumber = makeCertNumber();
  for (let i = 0; i < 5; i++) {
    const clash = rows(await db.execute(sql`SELECT 1 FROM course_certificates WHERE cert_number = ${certNumber} LIMIT 1`));
    if (!clash[0]) break;
    certNumber = makeCertNumber();
  }

  const key = await getSigningKey();
  const issuer = 'EduRankAI';
  const issued_at_iso = new Date().toISOString();

  // chain link (retry on chain_index race)
  let chainIndex = 1, prevHash = GENESIS, blockH = '', sig = '', contentHash = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const tip = rows(await db.execute(sql`SELECT chain_index, block_hash FROM course_certificates WHERE chain_index IS NOT NULL ORDER BY chain_index DESC LIMIT 1`))[0] as any;
    chainIndex = tip ? Number(tip.chain_index) + 1 : 1;
    prevHash = tip ? (tip.block_hash || GENESIS) : GENESIS;
    contentHash = sha256(canonical({ cert_number: certNumber, holder_name: holderName, user_id: opts.userId, course_id: opts.courseId, course_title: opts.courseTitle, grade: opts.grade || null, issuer, issued_at_iso }));
    blockH = blockHash(prevHash, contentHash, chainIndex);
    const privObj = createPrivateKey(key.privateKeyPem);
    sig = edSign(null, Buffer.from(blockH, 'utf8'), privObj).toString('base64');
    try {
      const ins = rows(await db.execute(sql`
        INSERT INTO course_certificates
          (user_id, course_id, course_title, cert_number, grade, verification_url,
           holder_name, issuer, issued_at, issued_at_iso, content_hash, prev_hash, block_hash, chain_index, signature, signing_key_id)
        VALUES (${opts.userId}, ${opts.courseId}, ${opts.courseTitle}, ${certNumber}, ${opts.grade || null},
           ${'https://www.edurankai.in/verify/' + certNumber},
           ${holderName}, ${issuer}, ${issued_at_iso}::timestamptz, ${issued_at_iso}, ${contentHash}, ${prevHash}, ${blockH}, ${chainIndex}, ${sig}, ${key.id})
        RETURNING id, cert_number, block_hash
      `));
      return { id: ins[0].id, certNumber: ins[0].cert_number, alreadyIssued: false, blockHash: ins[0].block_hash };
    } catch (e: any) {
      if (attempt === 4) {
        try {
          const ins = rows(await db.execute(sql`
            INSERT INTO course_certificates (user_id, course_id, course_title, cert_number, grade, verification_url, holder_name, issuer, issued_at, issued_at_iso, content_hash, signature, signing_key_id)
            VALUES (${opts.userId}, ${opts.courseId}, ${opts.courseTitle}, ${certNumber}, ${opts.grade || null}, ${'https://www.edurankai.in/verify/' + certNumber}, ${holderName}, ${issuer}, ${issued_at_iso}::timestamptz, ${issued_at_iso}, ${contentHash}, ${sig}, ${key.id})
            RETURNING id, cert_number`));
          return { id: ins[0].id, certNumber: ins[0].cert_number, alreadyIssued: false };
        } catch { return null; }
      }
    }
  }
  return null;
}

export async function getCertificatesForUser(userId: string) {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT id, course_id, course_title, cert_number, issued_at, grade, verification_url, block_hash
    FROM course_certificates WHERE user_id = ${userId} ORDER BY issued_at DESC
  `));
}

export interface VerifyResult {
  found: boolean;
  cert?: any;
  anchored: boolean;       // is it part of the hash chain?
  contentIntact: boolean;  // recomputed content hash matches
  blockIntact: boolean;    // recomputed block hash matches
  signatureValid: boolean; // Ed25519 signature verifies
  chainLinked: boolean;    // prev_hash matches the actual previous block
  verified: boolean;       // all of the above
  recomputed?: { content_hash: string; block_hash: string };
  publicKeyPem?: string;
}

export async function verifyCertificate(certNumber: string): Promise<VerifyResult> {
  await ensureSchema();
  const c = rows(await db.execute(sql`
    SELECT c.*, u.name AS user_name FROM course_certificates c LEFT JOIN users u ON c.user_id = u.id
    WHERE c.cert_number = ${certNumber} LIMIT 1
  `))[0] as any;
  if (!c) return { found: false, anchored: false, contentIntact: false, blockIntact: false, signatureValid: false, chainLinked: false, verified: false };

  const anchored = !!c.content_hash;
  if (!anchored) {
    return { found: true, cert: c, anchored: false, contentIntact: false, blockIntact: false, signatureValid: false, chainLinked: false, verified: false };
  }

  const key = await getSigningKey();
  const recomputedContent = sha256(canonical({
    cert_number: c.cert_number, holder_name: c.holder_name || c.user_name || 'Learner',
    user_id: c.user_id, course_id: c.course_id, course_title: c.course_title,
    grade: c.grade || null, issuer: c.issuer || 'EduRankAI', issued_at_iso: c.issued_at_iso || new Date(c.issued_at).toISOString(),
  }));
  const contentIntact = recomputedContent === c.content_hash;

  let blockIntact = false, recomputedBlock = '';
  if (c.chain_index != null && c.block_hash) {
    recomputedBlock = blockHash(c.prev_hash || GENESIS, c.content_hash, Number(c.chain_index));
    blockIntact = recomputedBlock === c.block_hash;
  }

  let signatureValid = false;
  try {
    if (c.signature && c.block_hash) {
      const pubObj = createPublicKey(key.publicKeyPem);
      signatureValid = edVerify(null, Buffer.from(c.block_hash, 'utf8'), pubObj, Buffer.from(c.signature, 'base64'));
    }
  } catch { signatureValid = false; }

  let chainLinked = false;
  if (c.chain_index != null) {
    if (Number(c.chain_index) === 1) chainLinked = (c.prev_hash === GENESIS);
    else {
      const prev = rows(await db.execute(sql`SELECT block_hash FROM course_certificates WHERE chain_index = ${Number(c.chain_index) - 1} LIMIT 1`))[0] as any;
      chainLinked = !!prev && prev.block_hash === c.prev_hash;
    }
  }

  const verified = contentIntact && blockIntact && signatureValid && chainLinked;
  return {
    found: true, cert: c, anchored: true, contentIntact, blockIntact, signatureValid, chainLinked, verified,
    recomputed: { content_hash: recomputedContent, block_hash: recomputedBlock },
    publicKeyPem: key.publicKeyPem,
  };
}

// Ledger explorer — the chain, newest first.
export async function getLedger(limit = 100) {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT c.cert_number, c.course_title, c.holder_name, c.chain_index, c.content_hash, c.prev_hash, c.block_hash, c.issued_at, u.name AS user_name
    FROM course_certificates c LEFT JOIN users u ON c.user_id = u.id
    WHERE c.chain_index IS NOT NULL ORDER BY c.chain_index DESC LIMIT ${limit}
  `));
}
export async function getLedgerStats() {
  await ensureSchema();
  const r = rows(await db.execute(sql`SELECT COUNT(*)::int AS total, MAX(chain_index) AS height FROM course_certificates WHERE chain_index IS NOT NULL`))[0] as any;
  return { total: r?.total || 0, height: r?.height ? Number(r.height) : 0 };
}
