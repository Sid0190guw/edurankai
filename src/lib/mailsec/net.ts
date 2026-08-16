// src/lib/mailsec/net.ts — MAY THE SERVER OPEN A CONNECTION TO THE ADDRESS SOMEBODY TYPED?
//
// ═══ THE THREE ENDPOINTS THIS EXISTS FOR ═══
//
//   POST /api/mail/verify     host, port, user, pass  -> nodemailer transport.verify()
//   POST /api/mail/imap-test  host, port, user, pass  -> imapflow connect
//   POST /api/mail/test       host, port, user, pass, to -> a real message
//
// Every one of them takes the destination FROM THE REQUEST BODY and connects to it. Nothing checks
// that the target is a mail server, that it is on the public internet, or that the port speaks
// SMTP. The gate is `can(user, 'mail.manage')`, which all ten non-applicant built-in roles hold —
// partner, teacher, technical_moderator, and any account flagged as an internship engagement.
//
// So the platform will, on request, connect to any host:port a signed-in teacher names and report
// the outcome in discriminating detail: verifySmtp() distinguishes ECONNREFUSED from ETIMEDOUT from
// ENOTFOUND from a TLS version mismatch. That is a port scanner with an authentication oracle
// bolted to it, pointed at whatever the deployment can reach — the container's own loopback, the
// private network, the cloud metadata endpoint.
//
// ═══ WHAT THIS FILE REFUSES, AND WHY IT RESOLVES FIRST ═══
//
// Refusing by NAME is not a control: `localtest.me`, a hostname whose A record is 127.0.0.1, and
// `2130706433` (which getaddrinfo reads as 127.0.0.1) all defeat a string check. So the host is
// RESOLVED and every address it resolves to is judged. A name that resolves to eight addresses is
// only allowed if all eight are public — one private answer refuses the whole name, because we
// cannot choose which one the connection will use.
//
// ═══ THE RESIDUAL RISK, STATED RATHER THAN PAPERED OVER ═══
//
// Between our lookup and the transport's own lookup, the answer can change. That is DNS rebinding,
// and a checker that resolves and then hands the NAME to another library has not closed it. Two
// honest options, and this file offers both:
//
//   assertSafeMailTarget()  resolves, judges, and hands back the ADDRESSES it approved. A caller
//                           that connects to `result.addresses[0]` with `tls.servername = host`
//                           has no window at all. This is what the mail probes should do.
//   The caller may instead connect by name and accept the window. That is a real, small risk on an
//   endpoint that already requires a session, and it is written down here so choosing it is a
//   choice rather than an oversight.
//
// Nothing in this file touches the database, and it is pure apart from one DNS lookup — so the
// address arithmetic below is testable without a network.

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** Ports a mail probe has any business opening. Everything else is a scan. */
export const MAIL_PORTS: ReadonlySet<number> = new Set([
  25,   // SMTP relay
  465,  // SMTP implicit TLS
  587,  // SMTP submission (STARTTLS)
  2525, // SMTP submission, alternate — common where 587 is blocked
  143,  // IMAP
  993,  // IMAP implicit TLS
  110,  // POP3
  995,  // POP3 implicit TLS
]);

export type RefusalCode =
  | 'ok'
  | 'empty-host'
  | 'bad-host'
  | 'bad-port'
  | 'private-address'
  | 'lookup-failed';

export interface TargetVerdict {
  allowed: boolean;
  code: RefusalCode;
  /** A sentence for the operator. Never names the blocked address back to them in full. */
  reason: string;
  /** The public addresses the name resolved to. Connect to one of these to close the DNS window. */
  addresses: string[];
  /** The address family of `addresses[0]`, so a caller can set the right socket option. */
  family: 4 | 6 | null;
}

const OK = (addresses: string[], family: 4 | 6 | null): TargetVerdict =>
  ({ allowed: true, code: 'ok', reason: '', addresses, family });

const NO = (code: RefusalCode, reason: string): TargetVerdict =>
  ({ allowed: false, code, reason, addresses: [], family: null });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Address arithmetic. Pure — no DNS, no network, so every range below is covered by a test.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** [first, last] inclusive, as unsigned 32-bit. */
const V4_BLOCKED: [number, number, string][] = [
  [0x00000000, 0x00ffffff, 'the unspecified block'],          // 0.0.0.0/8
  [0x7f000000, 0x7fffffff, 'loopback'],                       // 127.0.0.0/8
  [0x0a000000, 0x0affffff, 'a private network'],              // 10.0.0.0/8
  [0xac100000, 0xac1fffff, 'a private network'],              // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff, 'a private network'],              // 192.168.0.0/16
  [0xa9fe0000, 0xa9feffff, 'link-local, where cloud metadata lives'], // 169.254.0.0/16
  [0x64400000, 0x647fffff, 'carrier-grade NAT'],              // 100.64.0.0/10
  [0xc0000000, 0xc00000ff, 'a reserved block'],               // 192.0.0.0/24
  [0xc0000200, 0xc00002ff, 'a documentation block'],          // 192.0.2.0/24
  [0xc6336400, 0xc63364ff, 'a documentation block'],          // 198.51.100.0/24
  [0xcb007100, 0xcb0071ff, 'a documentation block'],          // 203.0.113.0/24
  [0xc6120000, 0xc613ffff, 'a benchmarking block'],           // 198.18.0.0/15
  [0xe0000000, 0xefffffff, 'multicast'],                      // 224.0.0.0/4
  [0xf0000000, 0xffffffff, 'a reserved block'],               // 240.0.0.0/4
];

/** Why this IPv4 address may not be connected to, or null when it may. */
export function ipv4Refusal(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return 'that is not an address we could read';
  for (const [lo, hi, label] of V4_BLOCKED) if (n >= lo && n <= hi) return label;
  return null;
}

/** Why this IPv6 address may not be connected to, or null when it may. */
export function ipv6Refusal(raw: string): string | null {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];

  // An IPv4-mapped or IPv4-compatible address is an IPv4 destination wearing a different notation,
  // and ::ffff:127.0.0.1 reaches loopback exactly as 127.0.0.1 does.
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  if (mapped) return ipv4Refusal(mapped[1]);

  if (ip === '::' || ip === '::0') return 'the unspecified address';
  if (ip === '::1') return 'loopback';
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return 'link-local';                 // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return 'a private network';          // fc00::/7 unique-local
  if (/^ff[0-9a-f]{2}:/.test(ip)) return 'multicast';                     // ff00::/8
  if (/^2001:0?0?db8:/.test(ip)) return 'a documentation block';          // 2001:db8::/32
  if (/^64:ff9b:/.test(ip)) return 'a translation block';                 // 64:ff9b::/96
  return null;
}

/** Why this address — either family — may not be connected to, or null when it may. */
export function addressRefusal(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) return ipv4Refusal(ip);
  if (fam === 6) return ipv6Refusal(ip);
  return 'that is not an address we could read';
}

/** True when the address is on the public internet. The form a test reads most easily. */
export function isPublicAddress(ip: string): boolean {
  return addressRefusal(ip) === null;
}

/**
 * A hostname we are willing to look up.
 *
 * Refuses the shapes that are not names: a bare IP is handled separately, and anything with a
 * scheme, a slash, a colon, whitespace, a credential or a control character is a URL somebody
 * pasted into a host field, not a host.
 */
export function isPlausibleHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/.test(host)) return false;
  // A single label with no dot is a machine on the local network ("mailserver", "localhost").
  // A mail host reachable from a serverless deployment always has a dot in it.
  if (!host.replace(/\.$/, '').includes('.')) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface TargetOptions {
  /** Override the port allow-list. Only a caller that is not a mail probe should need this. */
  ports?: ReadonlySet<number>;
  /**
   * Escape hatch for a deployment whose mail server genuinely is on a private network — a
   * self-hosted MTA beside the app. Off by default and it must stay a deliberate, named
   * environment variable rather than a request field, or it is not a control.
   */
  allowPrivate?: boolean;
}

/**
 * May we connect to `host:port`?
 *
 * Refusals do NOT echo the resolved address back to the caller. Telling somebody "10.0.3.7 is
 * private" answers the question they were asking; "that address is not on the public internet" tells
 * them their configuration is wrong without completing the scan for them.
 */
export async function assertSafeMailTarget(
  host: string,
  port: number,
  opts: TargetOptions = {},
): Promise<TargetVerdict> {
  const allowPrivate = opts.allowPrivate ?? process.env.MAIL_ALLOW_PRIVATE_SMTP === 'true';
  const ports = opts.ports ?? MAIL_PORTS;

  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h) return NO('empty-host', 'Type the mail server hostname.');

  const p = Number(port);
  if (!Number.isInteger(p) || !ports.has(p)) {
    return NO('bad-port', 'Port ' + String(port) + ' is not a mail port. Use 587 or 465 for sending, 993 for reading.');
  }

  // A literal address: judge it directly, no lookup.
  const literal = isIP(h);
  if (literal) {
    const refusal = addressRefusal(h);
    if (refusal && !allowPrivate) {
      return NO('private-address', 'That address is not on the public internet, so we will not connect to it.');
    }
    return OK([h], literal === 6 ? 6 : 4);
  }

  if (!isPlausibleHostname(h)) {
    return NO('bad-host', 'That is not a hostname. Enter something like mail.yourdomain.com — no scheme, no path, no port.');
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dnsLookup(h, { all: true, verbatim: true });
  } catch (e: any) {
    // A LOOKUP THAT DID NOT RUN IS NOT A HOST THAT DOES NOT EXIST, and on this project that
    // distinction has already cost an operator a working configuration once (see the note in
    // /api/mail/dns-check). Refused either way — we will not connect to a name we could not
    // judge — but the message says which it was.
    const code = String(e?.code || '');
    return NO(
      'lookup-failed',
      code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'That hostname did not resolve. Check the spelling.'
        : 'We could not look that hostname up (' + (code || 'unknown error') + '), so nothing was tried. This is not an authentication failure.',
    );
  }

  if (!resolved.length) return NO('lookup-failed', 'That hostname did not resolve to any address.');

  if (!allowPrivate) {
    // ONE PRIVATE ANSWER REFUSES THE WHOLE NAME. We do not get to pick which address the socket
    // uses, so "some of them are public" is not a safety property.
    for (const r of resolved) {
      if (addressRefusal(r.address)) {
        return NO('private-address', 'That hostname points at an address that is not on the public internet, so we will not connect to it.');
      }
    }
  }

  return OK(resolved.map((r) => r.address), resolved[0].family === 6 ? 6 : 4);
}

/**
 * The URL form, for anything that fetches rather than opens a socket (webhooks, avatar fetches,
 * a future link-preview). Same rules, plus http/https only and no credentials in the URL.
 */
export async function assertSafeOutboundUrl(raw: string, opts: TargetOptions = {}): Promise<TargetVerdict> {
  let u: URL;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return NO('bad-host', 'That is not a full address. It should start with https://');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return NO('bad-host', 'Only http and https addresses can be called.');
  }
  if (u.username || u.password) {
    return NO('bad-host', 'Remove the username and password from the address.');
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return assertSafeMailTarget(u.hostname, port, { ...opts, ports: new Set([80, 443, port]) });
}
