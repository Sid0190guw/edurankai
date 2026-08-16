// src/lib/mailplatform/domains/dns.ts — THE RESOLVER, AND THE ONE DISTINCTION EVERYTHING ELSE
// DEPENDS ON.
//
// A LOOKUP THAT DID NOT HAPPEN IS NOT AN ABSENT RECORD. src/pages/api/mail/dns-check.ts already
// learned this the expensive way: its helpers ended in `catch { return [] }`, and an empty array is
// exactly what a domain with no SPF record produces — so a resolver timeout rendered as a statement
// of fact about the operator's DNS, on a screen whose documented next step is to CHANGE that DNS.
// The verification engine built on this module is stricter still: it writes a `verified` state into
// a database and unlocks sending. A false negative annoys; a false POSITIVE lets an unverified
// domain send mail in somebody else's name. So every answer here carries whether the question was
// actually asked, and verify.ts is forbidden from turning `checked: false` into a verdict.
//
// Transport is DNS-over-HTTPS. This runs on serverless functions where a UDP socket is not
// available and node:dns resolves against whatever the platform's resolver happens to be; DoH is
// the same question asked of two named public resolvers, which is also how a second opinion is got.
//
// The interface is deliberately small: verify.ts takes a DnsResolver, so its tests run against
// staticResolver() with no network at all.

export type DnsRecordType = 'TXT' | 'MX' | 'CNAME' | 'A' | 'AAAA' | 'NS' | 'PTR';

/**
 * The result of asking one question.
 *
 * `checked: false` must never be rendered as a verdict. `values: []` with `checked: true` IS a
 * verdict: the name resolved and holds no record of that type.
 */
export interface Lookup<T> {
  checked: boolean;
  values: T[];
  error: string | null;
  /** Which resolver answered. Null when none did. */
  resolver: string | null;
  /** True when the name itself does not exist (NXDOMAIN), rather than existing with no records. */
  nxdomain?: boolean;
}

export interface MxValue {
  priority: number;
  host: string;
}

export interface DnsResolver {
  txt(name: string): Promise<Lookup<string>>;
  mx(name: string): Promise<Lookup<MxValue>>;
  cname(name: string): Promise<Lookup<string>>;
  a(name: string): Promise<Lookup<string>>;
  /** Reverse lookup for an IPv4 or IPv6 address. */
  ptr(ip: string): Promise<Lookup<string>>;
}

export const DOH_ENDPOINTS: { name: string; url: string }[] = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
];

/** DNS response codes that matter here. 0 = NOERROR, 3 = NXDOMAIN; anything else is a failed ask. */
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;

/** Numeric RR types, so a CNAME travelling alongside an A answer is not mistaken for one. */
const TYPE_CODE: Record<DnsRecordType, number> = { A: 1, NS: 2, CNAME: 5, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };

/**
 * Join the quoted chunks of a TXT answer.
 *
 * A TXT record longer than 255 bytes arrives as several quoted strings and MUST be concatenated
 * with nothing between them. A DKIM public key split across two chunks becomes an invalid key if a
 * single space is introduced, and that presents as "DKIM is published but does not match", which is
 * genuinely hard to see by eye and sends people looking in the wrong place for hours.
 */
export function joinTxtChunks(raw: string): string {
  const s = String(raw ?? '');
  const chunks = s.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks) return s.trim();
  return chunks
    .map((c) => c.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    .join('');
}

/** Expand an IPv6 address to 32 lowercase hex nibbles, or null when it is not one. */
export function expandIpv6(ip: string): string | null {
  const s = String(ip || '').trim().toLowerCase();
  if (!s || !/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((g) => g.padStart(4, '0')).join('');
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length > 4)) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

/** `192.0.2.15` becomes `15.2.0.192.in-addr.arpa`. Null for anything that is not an address. */
export function reverseName(ip: string): string | null {
  const v4 = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return parts.slice().reverse().join('.') + '.in-addr.arpa';
  }
  const v6 = expandIpv6(ip);
  if (v6) return v6.split('').reverse().join('.') + '.ip6.arpa';
  return null;
}

/** A hostname we are willing to put in a URL. Refuses anything that is not a plain DNS name. */
export function isQueryableName(name: string): boolean {
  const n = String(name || '').trim();
  if (!n || n.length > 253) return false;
  return /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i.test(n);
}

export interface DohOptions {
  timeoutMs?: number;
  endpoints?: { name: string; url: string }[];
  /** Injected by tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface RawQuery {
  checked: boolean;
  answers: any[];
  error: string | null;
  resolver: string | null;
  nxdomain: boolean;
}

async function dohQuery(name: string, type: DnsRecordType, opts: DohOptions): Promise<RawQuery> {
  if (!isQueryableName(name)) {
    return { checked: false, answers: [], error: 'not a queryable DNS name: ' + name, resolver: null, nxdomain: false };
  }
  const endpoints = opts.endpoints || DOH_ENDPOINTS;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const doFetch = opts.fetchImpl || fetch;
  const failures: string[] = [];

  // Endpoints are tried in order and ONLY on failure. A successful NOERROR carrying zero answers is
  // a real answer, not a reason to shop around for a resolver that says something else.
  for (const ep of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url = ep.url + '?name=' + encodeURIComponent(name) + '&type=' + type;
      const r = await doFetch(url, { headers: { Accept: 'application/dns-json' }, signal: ctrl.signal });
      if (!r.ok) {
        failures.push(ep.name + ' answered HTTP ' + r.status);
        continue;
      }
      const d: any = await r.json();
      const status = typeof d?.Status === 'number' ? d.Status : RCODE_NOERROR;
      if (status === RCODE_NXDOMAIN) {
        return { checked: true, answers: [], error: null, resolver: ep.name, nxdomain: true };
      }
      if (status !== RCODE_NOERROR) {
        failures.push(ep.name + ' returned DNS status ' + status);
        continue;
      }
      return {
        checked: true,
        answers: Array.isArray(d?.Answer) ? d.Answer : [],
        error: null,
        resolver: ep.name,
        nxdomain: false,
      };
    } catch (e: any) {
      failures.push(
        ep.name + ': ' + (e?.name === 'AbortError' ? 'timed out after ' + timeoutMs + 'ms' : String(e?.message || 'request failed')),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return { checked: false, answers: [], error: failures.join('; ') || 'no resolver answered', resolver: null, nxdomain: false };
}

function shape<T>(q: RawQuery, type: DnsRecordType, map: (a: any) => T): Lookup<T> {
  const code = TYPE_CODE[type];
  const answers = q.answers.filter((a) => typeof a?.type !== 'number' || a.type === code);
  return { checked: q.checked, values: answers.map(map), error: q.error, resolver: q.resolver, nxdomain: q.nxdomain };
}

/** The production resolver: DNS over HTTPS, two endpoints, failure reported rather than swallowed. */
export function dohResolver(opts: DohOptions = {}): DnsResolver {
  return {
    async txt(name) {
      return shape(await dohQuery(name, 'TXT', opts), 'TXT', (a) => joinTxtChunks(a?.data || ''));
    },
    async mx(name) {
      return shape(await dohQuery(name, 'MX', opts), 'MX', (a) => {
        const parts = String(a?.data || '').trim().split(/\s+/);
        return { priority: Number(parts[0] || 0), host: (parts[1] || '').replace(/\.$/, '').toLowerCase() };
      });
    },
    async cname(name) {
      return shape(await dohQuery(name, 'CNAME', opts), 'CNAME', (a) => String(a?.data || '').replace(/\.$/, '').toLowerCase());
    },
    async a(name) {
      return shape(await dohQuery(name, 'A', opts), 'A', (a) => String(a?.data || '').trim());
    },
    async ptr(ip) {
      const rev = reverseName(ip);
      if (!rev) return { checked: false, values: [], error: 'not an IP address: ' + ip, resolver: null };
      return shape(await dohQuery(rev, 'PTR', opts), 'PTR', (a) => String(a?.data || '').replace(/\.$/, '').toLowerCase());
    },
  };
}

/** A zone written by hand. An explicit `null` means "this lookup FAILS", which the tests need too. */
export interface StaticZone {
  txt?: Record<string, string[] | null>;
  mx?: Record<string, MxValue[] | null>;
  cname?: Record<string, string[] | null>;
  a?: Record<string, string[] | null>;
  /** Keyed by the IP address itself, which is what a test author wants to write. */
  ptr?: Record<string, string[] | null>;
}

/**
 * A resolver over a literal zone, for tests and for previews.
 *
 * An absent key resolves to an empty, CHECKED answer — the ordinary "no such record" case. An
 * explicit null is an UNCHECKED failure, so a test can prove the engine reports UNKNOWN rather than
 * FAILED when DNS itself is unreachable. That distinction is the reason this file exists.
 */
export function staticResolver(zone: StaticZone): DnsResolver {
  const pick = <T>(table: Record<string, T[] | null> | undefined, key: string): Lookup<T> => {
    const k = String(key || '').replace(/\.$/, '').toLowerCase();
    const v = table ? table[k] : undefined;
    if (v === null) return { checked: false, values: [], error: 'simulated resolver failure', resolver: null };
    return { checked: true, values: (v || []) as T[], error: null, resolver: 'static', nxdomain: v === undefined };
  };
  return {
    async txt(name) { return pick<string>(zone.txt, name); },
    async mx(name) { return pick<MxValue>(zone.mx, name); },
    async cname(name) { return pick<string>(zone.cname, name); },
    async a(name) { return pick<string>(zone.a, name); },
    async ptr(ip) {
      if (!reverseName(ip)) return { checked: false, values: [], error: 'not an IP address: ' + ip, resolver: null };
      return pick<string>(zone.ptr, ip);
    },
  };
}

/** Normalise a domain the way every comparison in this subsystem expects it. */
export function normalizeDomain(input: string): string {
  return String(input || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
}

/**
 * Is this a syntactically valid, registrable-looking domain?
 *
 * Deliberately refuses a bare TLD and anything with a leading/trailing dash in a label. It does NOT
 * consult a public-suffix list: `careers.edurankai.in` and `edurankai.in` are both legitimate here,
 * and a subdomain is a first-class sending domain in this product.
 */
export function isValidDomain(input: string): boolean {
  const d = normalizeDomain(input);
  if (!d || d.length > 253 || d.includes('..') || d.includes('@') || d.includes(' ')) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  // A final label of digits only is an IP address fragment, never a domain.
  return !/^\d+$/.test(labels[labels.length - 1]);
}
