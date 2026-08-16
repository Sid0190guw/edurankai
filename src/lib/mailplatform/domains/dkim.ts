// src/lib/mailplatform/domains/dkim.ts — KEY GENERATION, SELECTOR MANAGEMENT, AND THE DNS SIDE OF
// DKIM.
//
// node:crypto only. No database, no network, no request context — key STORAGE lives in ./store.ts
// and goes through the repository's existing envelope encryption (src/lib/crypto), so the private
// half never sits in a column in the clear and never leaves the server.
//
// THE INVARIANT: A PRIVATE KEY IS RETURNED BY EXACTLY ONE FUNCTION IN THIS FILE, AND THAT VALUE IS
// NEVER PUT ON A RESPONSE. generateDkimKeyPair() hands both halves to its caller because somebody
// has to encrypt and store the private half; every other function here takes and returns public
// material only. The API layer is built so that the shape it serialises — DkimKey from ../types —
// has no field the private key could travel in.
//
// Rotation is why selectors exist. A DKIM key cannot be replaced atomically: DNS caches the old
// selector's record for its TTL, and mail already in flight was signed with the old key. So a
// rotation publishes a NEW selector, waits for it to be visible, switches signing to it, and only
// then retires the old one — during which both records are published and both are valid. Anything
// that "replaces" a key by overwriting one selector breaks every message still in a receiver's
// queue.
//
// References: RFC 6376 (DKIM), RFC 8463 (Ed25519 signatures).

import { generateKeyPairSync, createPublicKey } from 'node:crypto';

export type DkimAlgorithm = 'rsa-sha256' | 'ed25519-sha256';

export interface DkimKeyMaterial {
  selector: string;
  algorithm: DkimAlgorithm;
  /** RSA modulus length; null for Ed25519, whose key size is fixed. */
  keySize: number | null;
  /** Base64 of the DER public key, exactly as it belongs in the `p=` tag. */
  publicKey: string;
  /** PEM, PKCS#8. THE CALLER MUST ENCRYPT THIS BEFORE IT TOUCHES ANY STORE. */
  privateKeyPem: string;
  /** The full TXT value to publish. */
  dnsValue: string;
  /** The name to publish it at, relative to the domain. */
  dnsHost: string;
}

/** DKIM's own limit: a selector is a dot-separated sequence of DNS labels. */
export function isValidSelector(selector: string): boolean {
  const s = String(selector || '');
  if (!s || s.length > 63) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(s);
}

/** `sel._domainkey.example.com` — where a receiver looks the key up. */
export function dkimHost(selector: string, domain: string): string {
  return String(selector || '').toLowerCase() + '._domainkey.' + String(domain || '').toLowerCase().replace(/\.$/, '');
}

/**
 * Mint the next selector for a domain.
 *
 * Date-stamped, because the single most useful thing to know about a signing key when something is
 * wrong is how old it is, and a selector called `default` tells you nothing. A collision (two
 * rotations on the same day) gets a numeric suffix rather than reusing a live selector — reusing one
 * would publish a new key at a name whose old key is still signing mail in flight.
 */
export function nextSelector(existing: string[], prefix = 'era', now: Date = new Date()): string {
  const stamp =
    String(now.getUTCFullYear()) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  const base = (prefix || 'era').toLowerCase().replace(/[^a-z0-9]/g, '') + stamp;
  const taken = new Set((existing || []).map((s) => String(s || '').toLowerCase()));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = base + '-' + i;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('could not mint a free DKIM selector for prefix ' + prefix);
}

/**
 * The base64 `p=` value for a public key.
 *
 * RSA publishes the whole SubjectPublicKeyInfo DER. Ed25519 publishes the RAW 32-byte key (RFC 8463
 * §3), not the SPKI wrapper — and the wrapper is a fixed 12-byte prefix, so the raw key is the last
 * 32 bytes. Publishing the SPKI form for Ed25519 produces a record that parses and never verifies,
 * which is the worst kind of wrong.
 */
export function publicKeyToDkimP(publicKeyPem: string, algorithm: DkimAlgorithm): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (algorithm === 'ed25519-sha256') {
    if (der.length < 32) throw new Error('unexpected Ed25519 public key length: ' + der.length);
    return der.subarray(der.length - 32).toString('base64');
  }
  return der.toString('base64');
}

/** Build the TXT value. `t=y` marks the key as being tested, which receivers must not act on. */
export function dkimDnsValue(opts: { publicKey: string; algorithm: DkimAlgorithm; testing?: boolean }): string {
  const k = opts.algorithm === 'ed25519-sha256' ? 'ed25519' : 'rsa';
  const tags = ['v=DKIM1', 'k=' + k];
  if (opts.testing) tags.push('t=y');
  tags.push('p=' + opts.publicKey);
  return tags.join('; ');
}

/**
 * Generate a signing key pair.
 *
 * 2048 bits is the default and the floor. 1024 is still accepted by receivers but is below what any
 * current guidance considers safe, and this is a key that will sign a university's mail for years;
 * 4096 is offered because some operators require it, with the caveat that its DNS record must be
 * split across TXT chunks and a few DNS panels get that wrong.
 */
export function generateDkimKeyPair(
  opts: { selector: string; domain: string; algorithm?: DkimAlgorithm; keySize?: number; testing?: boolean },
): DkimKeyMaterial {
  const algorithm: DkimAlgorithm = opts.algorithm || 'rsa-sha256';
  const selector = String(opts.selector || '').toLowerCase();
  if (!isValidSelector(selector)) throw new Error('invalid DKIM selector: ' + opts.selector);

  let publicKeyPem: string;
  let privateKeyPem: string;
  let keySize: number | null = null;

  if (algorithm === 'ed25519-sha256') {
    const pair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeyPem = pair.publicKey as string;
    privateKeyPem = pair.privateKey as string;
  } else {
    const modulusLength = opts.keySize || 2048;
    if (modulusLength < 2048) throw new Error('RSA DKIM keys below 2048 bits are not offered here');
    if (modulusLength > 4096) throw new Error('RSA DKIM keys above 4096 bits are not offered here');
    const pair = generateKeyPairSync('rsa', {
      modulusLength,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeyPem = pair.publicKey as string;
    privateKeyPem = pair.privateKey as string;
    keySize = modulusLength;
  }

  const publicKey = publicKeyToDkimP(publicKeyPem, algorithm);
  return {
    selector,
    algorithm,
    keySize,
    publicKey,
    privateKeyPem,
    dnsValue: dkimDnsValue({ publicKey, algorithm, testing: opts.testing }),
    dnsHost: dkimHost(selector, opts.domain),
  };
}

export interface DkimRecordParse {
  ok: boolean;
  raw: string;
  tags: Record<string, string>;
  version: string | null;
  keyType: string;
  publicKey: string | null;
  /** `p=` present but empty means the key has been REVOKED, which is not the same as absent. */
  revoked: boolean;
  testing: boolean;
  errors: string[];
  warnings: string[];
}

export function parseDkimRecord(record: string): DkimRecordParse {
  const raw = String(record || '').trim();
  const out: DkimRecordParse = {
    ok: false, raw, tags: {}, version: null, keyType: 'rsa', publicKey: null, revoked: false, testing: false,
    errors: [], warnings: [],
  };
  if (!raw) {
    out.errors.push('The record is empty.');
    return out;
  }
  for (const part of raw.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq === -1) {
      out.errors.push('"' + p + '" is not a tag=value pair.');
      continue;
    }
    const name = p.slice(0, eq).trim().toLowerCase();
    // The base64 in p= may contain internal whitespace after a DNS panel has wrapped it; strip it.
    const value = p.slice(eq + 1).trim();
    out.tags[name] = name === 'p' ? value.replace(/\s+/g, '') : value;
  }
  out.version = out.tags.v || null;
  if (out.tags.v && !/^DKIM1$/i.test(out.tags.v)) out.errors.push('"v=' + out.tags.v + '" is not DKIM1.');
  out.keyType = (out.tags.k || 'rsa').toLowerCase();
  out.testing = /(^|:)y(:|$)/i.test(out.tags.t || '');

  if (out.tags.p === undefined) {
    out.errors.push('The record has no "p=" public key tag.');
  } else if (out.tags.p === '') {
    out.revoked = true;
    out.warnings.push('"p=" is empty, which is the DKIM way of REVOKING a key. Any mail still signed with this selector will fail.');
  } else if (!/^[A-Za-z0-9+/=]+$/.test(out.tags.p)) {
    out.errors.push('The "p=" value is not valid base64.');
  } else {
    out.publicKey = out.tags.p;
  }

  out.ok = out.errors.length === 0 && !!out.publicKey;
  return out;
}

export type DkimMatch = 'match' | 'mismatch' | 'revoked' | 'absent' | 'malformed';

export interface DkimVerification {
  result: DkimMatch;
  detail: string;
  observed: string | null;
}

/**
 * Compare what is published at a selector with the key we hold.
 *
 * `mismatch` is called out separately from `absent` on purpose. Absent means the customer has not
 * added the record yet; mismatch means they added a DIFFERENT key — usually one from a previous
 * provider, or a record they pasted with the header/footer lines still in it — and the instruction
 * for each is different.
 */
export function verifyDkimPublished(txtValues: string[], expectedPublicKey: string): DkimVerification {
  const candidates = (txtValues || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (candidates.length === 0) {
    return { result: 'absent', detail: 'No TXT record is published at this selector.', observed: null };
  }
  const dkimish = candidates.filter((c) => /(^|;\s*)v=DKIM1/i.test(c) || /(^|;\s*)p=/i.test(c));
  if (dkimish.length === 0) {
    return { result: 'malformed', detail: 'A TXT record exists at this selector but it is not a DKIM record.', observed: candidates[0] };
  }
  for (const candidate of dkimish) {
    const parsed = parseDkimRecord(candidate);
    if (parsed.revoked) {
      return { result: 'revoked', detail: 'The published record revokes this selector ("p=" is empty).', observed: candidate };
    }
    if (parsed.publicKey && parsed.publicKey === expectedPublicKey) {
      return { result: 'match', detail: 'The published key matches the key held for this selector.', observed: candidate };
    }
  }
  const first = parseDkimRecord(dkimish[0]);
  if (!first.ok) {
    return { result: 'malformed', detail: first.errors.join(' '), observed: dkimish[0] };
  }
  return {
    result: 'mismatch',
    detail: 'A DKIM record is published at this selector, but the key in it is not the key held here. If this selector belonged to a previous mail provider, use a new selector rather than overwriting theirs.',
    observed: dkimish[0],
  };
}

/**
 * Split a long value into 255-byte chunks, quoted, the way a TXT record must be published.
 *
 * A 2048-bit RSA record is ~400 characters, which is over the 255-byte limit for ONE character
 * string inside a TXT record. Most DNS panels do this automatically; some require it typed out.
 * Showing both forms costs nothing and saves a support conversation.
 */
export function txtChunks(value: string, size = 255): string[] {
  const v = String(value || '');
  if (v.length <= size) return [v];
  const out: string[] = [];
  for (let i = 0; i < v.length; i += size) out.push(v.slice(i, i + size));
  return out;
}

export function quotedTxt(value: string, size = 255): string {
  return txtChunks(value, size).map((c) => '"' + c + '"').join(' ');
}

/** Lifecycle states a key may be in. Mirrors DkimKey['status'] in ../types.ts. */
export type DkimStatus = 'pending' | 'active' | 'rotating' | 'retired';

export interface RotationPlan {
  /** What each existing key becomes. */
  transitions: { selector: string; from: DkimStatus; to: DkimStatus }[];
  /** The selector that will be minted. */
  newSelector: string;
  /** Steps in the order they must happen, for the screen that walks an operator through it. */
  steps: string[];
  warnings: string[];
}

/**
 * Plan a rotation without performing one.
 *
 * The plan never retires the outgoing key in the same step as activating the new one. Between
 * "publish the new record" and "stop signing with the old key" there is a DNS TTL, and between
 * "stop signing with the old key" and "delete the old record" there is however long a receiver
 * takes to process a message that is already in its queue. Two waits, in that order, or mail that
 * was correctly signed starts failing DKIM after it was sent.
 */
export function planRotation(
  existing: { selector: string; status: DkimStatus }[],
  opts: { prefix?: string; now?: Date } = {},
): RotationPlan {
  const selectors = existing.map((k) => k.selector);
  const newSelector = nextSelector(selectors, opts.prefix || 'era', opts.now || new Date());
  const transitions: RotationPlan['transitions'] = [];
  const warnings: string[] = [];

  for (const key of existing) {
    if (key.status === 'active') transitions.push({ selector: key.selector, from: 'active', to: 'rotating' });
    else if (key.status === 'rotating') {
      transitions.push({ selector: key.selector, from: 'rotating', to: 'retired' });
      warnings.push('Selector "' + key.selector + '" was already mid-rotation and will be retired by this one. If mail signed with it is still in flight, wait before removing its DNS record.');
    }
  }

  return {
    transitions,
    newSelector,
    steps: [
      'Publish the TXT record for the new selector "' + newSelector + '". Nothing changes yet — two DKIM records can be published at once and both are valid.',
      'Wait for the new record to be visible from a public resolver. This page checks it for you.',
      'Switch signing to the new selector. The previous key stays published.',
      'Wait at least as long as the TTL of the old record, plus a day, so that mail signed with the old key can still be verified.',
      'Retire the old selector and remove its DNS record.',
    ],
    warnings,
  };
}
