// mail-engine/src/smtp/transport.ts — the MailTransport implementation that actually opens sockets.
//
// TWO MODES, ONE INTERFACE:
//
//   RELAY    — every message goes to one smarthost with credentials. This is what runs on the
//              laptop and on any cloud host, because outbound port 25 is blocked on domestic
//              connections and on AWS/GCP/Azure/Vercel by default. See docs/dns.md.
//   DIRECT   — resolve the recipient domain's MX records and talk to them on port 25. This is what
//              runs on a real mail server with a clean IP, a PTR record and port 25 open.
//
// The rest of the engine cannot tell which is in use. That is the point: the queue, the retry
// engine, the classifier and the event stream are identical either way, so moving from a relay to
// direct delivery is a configuration change and not a rewrite.
//
// TLS, HONESTLY. In DIRECT mode certificates are NOT verified by default, and that is not laziness —
// it is how SMTP between mail servers works. A large share of MX hosts present certificates that do
// not match their MX name, and a sender that rejects them delivers nothing; opportunistic TLS
// (encrypted, unauthenticated) is strictly better than the cleartext fallback the RFC otherwise
// requires. Verified TLS to arbitrary MX hosts needs MTA-STS or DANE, neither of which is
// implemented here — that is written down in docs/dns.md rather than papered over. In RELAY mode
// certificates ARE verified, because there the peer is a known host we chose.
//
// PER-RECIPIENT TRUTH. nodemailer reports accepted/rejected per address, so a message to five people
// at one domain where two addresses do not exist produces three delivered results and two bounced
// ones from a single SMTP conversation, instead of one verdict smeared across all five.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { DeliveryResult, MailTransport, OutboundMessage } from '../contracts/index.js';
import type { EngineConfig } from '../config.js';
import { classifyNetworkError, classifySmtpReply } from './classify.js';
import { MxResolver, domainOf } from './mx.js';
import { DkimKeyStore, nodemailerDkim } from '../dkim.js';
import { type Logger, reasonOf } from '../logger.js';
import { M, metrics } from '../metrics.js';

export interface SmtpTransportDeps {
  config: EngineConfig;
  logger: Logger;
  mx?: MxResolver;
  keys?: DkimKeyStore;
  /** Injectable for tests: build a transporter for a given host/port. */
  createTransport?: typeof nodemailer.createTransport;
}

interface PoolEntry {
  transporter: Transporter;
  createdAt: number;
}

export class SmtpMailTransport implements MailTransport {
  readonly name: string;
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly mx: MxResolver;
  private readonly keys: DkimKeyStore;
  private readonly make: typeof nodemailer.createTransport;
  private pool = new Map<string, PoolEntry>();

  constructor(deps: SmtpTransportDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'smtp-transport' });
    this.mx = deps.mx || new MxResolver();
    this.keys = deps.keys || new DkimKeyStore(deps.config.dkimKeyDir, deps.config.dkimSelector);
    this.make = deps.createTransport || nodemailer.createTransport;
    this.name = deps.config.relayHost ? `relay:${deps.config.relayHost}:${deps.config.relayPort}` : 'direct-mx';
  }

  /**
   * Connection reuse, "where safe" per the brief. Pooling is safe to a relay — one known host, one
   * credential, a connection that stays useful. It is NOT done in direct mode: holding an idle
   * socket open to a stranger's MX is what earns a 421 and a reputation note, and the recipient
   * domain changes on every message anyway.
   */
  private transporterFor(host: string, port: number, opts: { relay: boolean }): Transporter {
    const key = `${host}:${port}:${opts.relay ? 'relay' : 'direct'}`;
    if (opts.relay) {
      const hit = this.pool.get(key);
      if (hit) return hit.transporter;
    }

    const secure = opts.relay ? (port === 465 ? true : this.cfg.relaySecure && port !== 587) : false;
    const transporter = this.make({
      host,
      port,
      secure,
      name: this.cfg.hostname,                 // what we say in EHLO
      auth: opts.relay && this.cfg.relayUser ? { user: this.cfg.relayUser, pass: this.cfg.relayPass } : undefined,
      requireTLS: this.cfg.requireTls,
      // See the TLS note at the top of this file.
      tls: opts.relay ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
      connectionTimeout: this.cfg.smtpConnectTimeoutMs,
      greetingTimeout: this.cfg.smtpGreetingTimeoutMs,
      socketTimeout: this.cfg.smtpSocketTimeoutMs,
      pool: opts.relay,
      maxConnections: opts.relay ? Math.max(1, this.cfg.perDomainConcurrency) : undefined,
      logger: false,
    } as Parameters<typeof nodemailer.createTransport>[0]);

    if (opts.relay) this.pool.set(key, { transporter, createdAt: Date.now() });
    return transporter;
  }

  async deliver(message: OutboundMessage, recipients: string[], attempt: number): Promise<DeliveryResult[]> {
    const domain = domainOf(recipients[0] || '');
    const started = Date.now();

    if (!this.cfg.deliveryEnabled) {
      // The dry-run path. Everything above this line has already run — validation, queue, MX
      // grouping, throttle, DKIM key load — so this exercises the whole pipeline without mailing a
      // stranger. It reports a DEFERRAL, never a delivery: a queue that silently reports success for
      // messages it never sent is the exact failure mode CLAUDE.md warns about.
      return recipients.map((r) => ({
        recipient: r,
        outcome: 'deferred' as const,
        smtpCode: null,
        enhancedCode: '4.3.0',
        smtpResponse: 'delivery disabled (MAIL_DELIVERY_ENABLED is off) — message held in the queue',
        mxHost: null,
        tls: false,
        dkimSigned: false,
        latencyMs: Date.now() - started,
        bounceClass: 'temporary_rejection' as const,
      }));
    }

    // Which hosts to try, in order.
    let hosts: { host: string; port: number }[];
    if (this.cfg.relayHost) {
      hosts = [{ host: this.cfg.relayHost, port: this.cfg.relayPort }];
    } else {
      try {
        const mx = await this.mx.lookup(domain);
        hosts = mx.hosts.map((h) => ({ host: h.host, port: 25 }));
        this.log.debug('mx resolved', { domain, hosts: hosts.map((h) => h.host), implicit: mx.implicit, cached: mx.cached });
      } catch (e) {
        const cls = classifyNetworkError(e);
        metrics.counter(M.mtaErrors, 'Errors raised by the MTA layer', { stage: 'mx_lookup' });
        this.log.warn('mx lookup failed', { domain, reason: reasonOf(e), outcome: cls.outcome });
        return recipients.map((r) => ({
          recipient: r,
          outcome: cls.outcome === 'delivered' ? 'deferred' : cls.outcome,
          smtpCode: null,
          enhancedCode: cls.enhancedCode,
          smtpResponse: reasonOf(e),
          mxHost: null,
          tls: false,
          dkimSigned: false,
          latencyMs: Date.now() - started,
          bounceClass: cls.bounceClass,
        }));
      }
    }

    const dkimDomain = (message.dkimDomain || domainOf(message.from) || '').toLowerCase();
    const key = dkimDomain ? await this.keys.get(dkimDomain) : null;
    const dkim = nodemailerDkim(key);
    if (!dkim) {
      this.log.warn('sending unsigned: no DKIM key for domain', { domain: dkimDomain, messageId: message.messageId });
    }

    const mail = this.toNodemailer(message, recipients, dkim);

    let lastError: unknown = null;
    for (const target of hosts) {
      const isRelay = !!this.cfg.relayHost;
      const transporter = this.transporterFor(target.host, target.port, { relay: isRelay });
      metrics.counter(M.smtpConnections, 'SMTP connections opened', { mode: isRelay ? 'relay' : 'direct' });
      try {
        const info = await transporter.sendMail(mail);
        const latencyMs = Date.now() - started;
        metrics.observe(M.deliveryLatency, 'Time from attempt start to SMTP verdict', latencyMs, { domain });
        if (!isRelay) { try { transporter.close(); } catch { /* nothing to do */ } }
        return this.resultsFrom(info, recipients, target.host, !!dkim, latencyMs, attempt);
      } catch (e) {
        lastError = e;
        const cls = classifyNetworkError(e);
        metrics.counter(M.mtaErrors, 'Errors raised by the MTA layer', { stage: 'smtp' });
        this.log.warn('smtp attempt failed', {
          host: target.host, domain, attempt, reason: reasonOf(e), outcome: cls.outcome, bounceClass: cls.bounceClass,
        });
        if (!isRelay) { try { transporter.close(); } catch { /* nothing to do */ } }
        // A PERMANENT verdict is not retried against the next MX host. All of a domain's MX hosts
        // share one policy and one user database; asking the backup server whether the mailbox
        // exists after the primary said it does not is how a bounce turns into five bounces.
        if (cls.outcome === 'bounced') break;
      }
    }

    const cls = classifyNetworkError(lastError);
    const latencyMs = Date.now() - started;
    return recipients.map((r) => ({
      recipient: r,
      outcome: cls.outcome === 'delivered' ? 'deferred' : cls.outcome,
      smtpCode: (lastError as { responseCode?: number } | null)?.responseCode ?? null,
      enhancedCode: cls.enhancedCode,
      smtpResponse: reasonOf(lastError),
      mxHost: hosts[0]?.host ?? null,
      tls: false,
      dkimSigned: !!dkim,
      latencyMs,
      bounceClass: cls.bounceClass,
    }));
  }

  /** Turn nodemailer's accepted/rejected report into one result per recipient. */
  private resultsFrom(
    info: { accepted?: (string | { address: string })[]; rejected?: (string | { address: string })[]; rejectedErrors?: unknown[]; response?: string },
    recipients: string[],
    mxHost: string,
    dkimSigned: boolean,
    latencyMs: number,
    _attempt: number,
  ): DeliveryResult[] {
    const addr = (a: string | { address: string }) => (typeof a === 'string' ? a : a.address).toLowerCase();
    const accepted = new Set((info.accepted || []).map(addr));
    const rejectedErrors = new Map<string, { responseCode?: number; response?: string; message?: string }>();
    for (const re of (info.rejectedErrors || []) as { recipient?: string; responseCode?: number; response?: string; message?: string }[]) {
      if (re?.recipient) rejectedErrors.set(String(re.recipient).toLowerCase(), re);
    }

    return recipients.map((r) => {
      const low = r.toLowerCase();
      if (accepted.has(low)) {
        const cls = classifySmtpReply(250, info.response || '250 OK');
        metrics.counter(M.outboundDelivered, 'Messages accepted by a remote server', { domain: domainOf(r) });
        return {
          recipient: r, outcome: 'delivered' as const, smtpCode: 250,
          enhancedCode: cls.enhancedCode, smtpResponse: (info.response || '250 OK').slice(0, 500),
          mxHost, tls: true, dkimSigned, latencyMs, bounceClass: null,
        };
      }
      const err = rejectedErrors.get(low);
      const cls = classifySmtpReply(err?.responseCode ?? null, err?.response || err?.message || info.response || null);
      return {
        recipient: r,
        outcome: cls.outcome === 'delivered' ? 'bounced' : cls.outcome,
        smtpCode: err?.responseCode ?? null,
        enhancedCode: cls.enhancedCode,
        smtpResponse: String(err?.response || err?.message || 'rejected by the receiving server').slice(0, 500),
        mxHost,
        tls: true,
        dkimSigned,
        bounceClass: cls.bounceClass,
        latencyMs,
      };
    });
  }

  private toNodemailer(m: OutboundMessage, recipients: string[], dkim: ReturnType<typeof nodemailerDkim>) {
    return {
      // The ENVELOPE is what the SMTP conversation uses, and it is set explicitly: only the
      // recipients for THIS domain go in RCPT TO, whatever the To/Cc headers say. That is also what
      // keeps Bcc working — the header is never written, the envelope carries the address.
      envelope: { from: m.from, to: recipients },
      from: m.headerFrom || m.from,
      to: (m.to || []).join(', ') || undefined,
      cc: (m.cc || []).length ? (m.cc || []).join(', ') : undefined,
      replyTo: m.replyTo,
      subject: m.subject,
      text: m.text,
      html: m.html,
      messageId: m.messageId.includes('@') ? m.messageId : `<${m.messageId}@${this.cfg.hostname}>`,
      inReplyTo: m.inReplyTo,
      references: m.references?.length ? m.references.join(' ') : undefined,
      headers: m.headers,
      attachments: (m.attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content ? Buffer.from(a.content, 'base64') : undefined,
        path: a.content ? undefined : a.path || a.href,
        contentType: a.contentType,
      })),
      dkim,
    } as Parameters<Transporter['sendMail']>[0];
  }

  async close(): Promise<void> {
    for (const [key, entry] of this.pool) {
      try { entry.transporter.close(); } catch { /* already closed */ }
      this.pool.delete(key);
    }
  }
}
