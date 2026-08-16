// mail-engine/src/smtp/mx.ts — where does mail for this domain actually go.
//
// RFC 5321 section 5.1, in code: ask for MX records; if the domain has none but does have an address
// record, the domain itself is the mail exchanger (the "implicit MX" rule); if it has neither, the
// address is undeliverable and that is permanent.
//
// SORTING IS NOT JUST BY PRIORITY. Hosts at equal preference must be tried in a random order — that
// is what the RFC asks for and it is how a large provider's dozen equal-preference hosts share load
// instead of every sender in the world hammering whichever one sorts first alphabetically.
//
// The cache exists because a queue draining a thousand messages to one provider should not make a
// thousand identical DNS queries; negative answers are cached for much less time than positive ones,
// so a domain whose DNS was briefly broken recovers in a minute rather than in an hour.

import { promises as dns } from 'node:dns';

export interface MxHost {
  host: string;
  priority: number;
}

export interface MxLookupResult {
  domain: string;
  hosts: MxHost[];
  /** True when the hosts came from the implicit-MX rule rather than from MX records. */
  implicit: boolean;
  cached: boolean;
}

export class MxLookupError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MxLookupError';
    this.code = code;
  }
}

interface CacheRow {
  result: Omit<MxLookupResult, 'cached'>;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;

export interface MxResolverOptions {
  /** Injectable so tests do not touch the network. */
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  resolve4?: (domain: string) => Promise<string[]>;
  resolve6?: (domain: string) => Promise<string[]>;
  now?: () => number;
  shuffle?: <T>(items: T[]) => T[];
}

function defaultShuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class MxResolver {
  private cache = new Map<string, CacheRow>();
  private negative = new Map<string, { error: MxLookupError; expiresAt: number }>();
  private readonly opts: Required<MxResolverOptions>;

  constructor(opts: MxResolverOptions = {}) {
    this.opts = {
      resolveMx: opts.resolveMx || ((d) => dns.resolveMx(d)),
      resolve4: opts.resolve4 || ((d) => dns.resolve4(d)),
      resolve6: opts.resolve6 || ((d) => dns.resolve6(d)),
      now: opts.now || (() => Date.now()),
      shuffle: opts.shuffle || defaultShuffle,
    };
  }

  clear(): void {
    this.cache.clear();
    this.negative.clear();
  }

  async lookup(domain: string): Promise<MxLookupResult> {
    const key = domain.toLowerCase().replace(/\.$/, '');
    const now = this.opts.now();

    const neg = this.negative.get(key);
    if (neg && neg.expiresAt > now) throw neg.error;

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return { ...hit.result, cached: true };

    let hosts: MxHost[] = [];
    let implicit = false;
    let mxError: unknown = null;

    try {
      const records = await this.opts.resolveMx(key);
      hosts = (records || [])
        .filter((r) => r && r.exchange)
        .map((r) => ({ host: String(r.exchange).replace(/\.$/, ''), priority: Number(r.priority) || 0 }))
        // A single MX of "." is the RFC 7505 null MX: the domain is publishing that it accepts no
        // mail at all. Treating that as a host to connect to would produce a week of pointless
        // deferrals instead of an immediate, correct, permanent failure.
        .filter((h) => h.host !== '' && h.host !== '.');
      if (records && records.length === 1 && String(records[0].exchange).replace(/\.$/, '') === '') {
        const err = new MxLookupError(`${key} publishes a null MX and accepts no mail`, 'ENULLMX');
        this.negative.set(key, { error: err, expiresAt: now + POSITIVE_TTL_MS });
        throw err;
      }
    } catch (e) {
      if (e instanceof MxLookupError) throw e;
      mxError = e;
    }

    if (!hosts.length) {
      // Implicit MX: no MX records, but an address record means the host takes its own mail.
      let addresses: string[] = [];
      try {
        addresses = await this.opts.resolve4(key);
      } catch {
        try { addresses = await this.opts.resolve6(key); } catch { addresses = []; }
      }
      if (addresses.length) {
        hosts = [{ host: key, priority: 0 }];
        implicit = true;
      } else {
        const code = String((mxError as { code?: string } | null)?.code || 'ENOTFOUND').toUpperCase();
        const permanent = code === 'ENOTFOUND' || code === 'ENODATA';
        const err = new MxLookupError(
          permanent
            ? `no MX or address record for ${key}`
            : `DNS lookup for ${key} failed (${code})`,
          permanent ? 'ENOTFOUND' : code,
        );
        this.negative.set(key, { error: err, expiresAt: now + NEGATIVE_TTL_MS });
        throw err;
      }
    }

    // Group by priority, shuffle within each group, then flatten in priority order.
    const byPriority = new Map<number, MxHost[]>();
    for (const h of hosts) {
      const list = byPriority.get(h.priority) || [];
      list.push(h);
      byPriority.set(h.priority, list);
    }
    const ordered: MxHost[] = [];
    for (const p of [...byPriority.keys()].sort((a, b) => a - b)) {
      ordered.push(...this.opts.shuffle(byPriority.get(p)!));
    }

    const result = { domain: key, hosts: ordered, implicit };
    this.cache.set(key, { result, expiresAt: now + POSITIVE_TTL_MS });
    return { ...result, cached: false };
  }
}

/** Domain part of an address, lowercased. Empty string for anything that is not an address. */
export function domainOf(address: string): string {
  const at = String(address || '').lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** Group recipients by destination domain — one SMTP conversation serves all of a domain's. */
export function groupByDomain(recipients: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of recipients) {
    const d = domainOf(r);
    if (!d) continue;
    const list = out.get(d) || [];
    list.push(r);
    out.set(d, list);
  }
  return out;
}
