// mail-engine/src/dkim.ts — signing keys, and the DNS record that makes them mean something.
//
// A DKIM key is only half of DKIM. The private half signs; the public half has to be published at
// <selector>._domainkey.<domain> or every signature is worthless — worse than worthless, because a
// receiver that finds no key treats the signature as a failure rather than as absent. So key
// generation here always hands back the exact TXT record to publish alongside the key, and the
// startup check refuses to claim a domain is signed when it cannot read the key file.
//
// KEY SIZE. 2048-bit RSA. 1024 is still accepted everywhere and still widely deployed, but it is
// below what any current guidance recommends, and the DNS-record-too-long problem that pushed people
// to 1024 is solved by the quoted-string split in dnsRecordFor().
//
// WHERE KEYS LIVE. mail-engine/keys/<domain>.private, gitignored, mode 0600 where the platform
// supports it. Never in the database, never in an environment variable: a key that fits in an env
// var fits in a log line.

import { promises as fs } from 'node:fs';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import path from 'node:path';

export interface DkimKey {
  domain: string;
  selector: string;
  privateKey: string;
  /** base64 of the SPKI public key — the p= value in the DNS record. */
  publicKeyB64: string;
}

export interface DkimKeyPair extends DkimKey {
  /** The full TXT record value to publish. */
  dnsValue: string;
  /** The name to publish it at. */
  dnsName: string;
}

/** Generate a 2048-bit RSA key and the record that publishes it. */
export function generateDkimKey(domain: string, selector: string): DkimKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyB64 = pemToBase64(publicKey);
  return {
    domain,
    selector,
    privateKey,
    publicKeyB64,
    dnsName: `${selector}._domainkey.${domain}`,
    dnsValue: `v=DKIM1; k=rsa; p=${publicKeyB64}`,
  };
}

/** Strip the PEM armour and the newlines, leaving the base64 body. */
export function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
}

/** Derive the public half from a private key, for verifying a key file matches published DNS. */
export function publicKeyFromPrivate(privateKeyPem: string): string {
  return pemToBase64(createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString());
}

/**
 * A 2048-bit p= value is ~392 characters, and a single DNS TXT string may hold at most 255. Every
 * DNS provider worth using splits it automatically, but some ask for the quoted form; this produces
 * it so a copy-paste into a stubborn control panel works the first time.
 */
export function dnsRecordFor(key: { selector: string; domain: string; publicKeyB64: string }): { name: string; value: string; quoted: string } {
  const value = `v=DKIM1; k=rsa; p=${key.publicKeyB64}`;
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
  return {
    name: `${key.selector}._domainkey.${key.domain}`,
    value,
    quoted: chunks.map((c) => `"${c}"`).join(' '),
  };
}

export class DkimKeyStore {
  private readonly dir: string;
  private readonly selector: string;
  private cache = new Map<string, DkimKey | null>();

  constructor(dir: string, selector: string) {
    this.dir = path.resolve(dir);
    this.selector = selector;
  }

  keyPath(domain: string): string {
    return path.join(this.dir, `${domain.toLowerCase()}.private`);
  }

  /** Null when there is no key for this domain — the caller then sends unsigned and says so. */
  async get(domain: string): Promise<DkimKey | null> {
    const d = domain.toLowerCase();
    if (this.cache.has(d)) return this.cache.get(d)!;
    let key: DkimKey | null = null;
    try {
      const pem = await fs.readFile(this.keyPath(d), 'utf8');
      if (/BEGIN [A-Z ]*PRIVATE KEY/.test(pem)) {
        key = { domain: d, selector: this.selector, privateKey: pem, publicKeyB64: publicKeyFromPrivate(pem) };
      }
    } catch {
      key = null;
    }
    this.cache.set(d, key);
    return key;
  }

  async write(pair: DkimKeyPair): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.keyPath(pair.domain);
    await fs.writeFile(file, pair.privateKey, { encoding: 'utf8', mode: 0o600 });
    this.cache.delete(pair.domain.toLowerCase());
    return file;
  }

  /** Which of the configured domains can actually be signed right now. */
  async status(domains: string[]): Promise<{ domain: string; signed: boolean; selector: string; dnsName: string }[]> {
    const out: { domain: string; signed: boolean; selector: string; dnsName: string }[] = [];
    for (const d of domains) {
      const key = await this.get(d);
      out.push({ domain: d, signed: !!key, selector: this.selector, dnsName: `${this.selector}._domainkey.${d}` });
    }
    return out;
  }
}

/**
 * The header set to sign. From/To/Subject/Date/Message-ID are the ones a receiver cares about, and
 * signing more than a sender controls is how a signature breaks in transit: a mailing list that
 * appends List-Id to a message that signed List-Id invalidates it.
 */
export const DKIM_HEADER_FIELDS = 'from:to:cc:subject:date:message-id:mime-version:content-type:reply-to';

/** Shape nodemailer wants. Returns undefined when the domain has no key, so the caller can record that. */
export function nodemailerDkim(key: DkimKey | null): { domainName: string; keySelector: string; privateKey: string; headerFieldNames: string } | undefined {
  if (!key) return undefined;
  return {
    domainName: key.domain,
    keySelector: key.selector,
    privateKey: key.privateKey,
    headerFieldNames: DKIM_HEADER_FIELDS,
  };
}
