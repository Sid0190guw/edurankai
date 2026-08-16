// mail-engine/src/config.ts — every knob the engine has, read once, in one place.
//
// Nothing here reads the application's .env files. The engine is a separate service with a separate
// environment (mail-engine/.env), because the working rule in CLAUDE.md is that the production
// credentials in this working directory are not for local processes to open, and because the engine
// is meant to move to its own host without dragging the app's secrets along.
//
// Every value has a default that is safe on a laptop: no relay, no keys, delivery disabled. A fresh
// checkout starts in a state where it cannot accidentally send anything to a real person.

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function list(name: string, fallback: string[] = []): string[] {
  const v = str(name);
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export interface EngineConfig {
  /** Hostname used in EHLO and in generated Message-IDs. Must resolve for real delivery. */
  hostname: string;
  /** Domains this engine accepts inbound mail for, and signs outbound mail as. */
  domains: string[];
  env: 'development' | 'production';

  // --- outbound ------------------------------------------------------------------
  /**
   * OFF BY DEFAULT, DELIBERATELY. With this false the delivery worker runs the whole pipeline —
   * validation, queue, MX lookup, throttle, events — and stops at the point of opening a socket to
   * a stranger's mail server. It is how the queue is exercised on a laptop without mailing anyone.
   */
  deliveryEnabled: boolean;
  /**
   * Empty = direct-to-MX. Set it to a smarthost when port 25 is blocked, which it is on every
   * domestic connection and on most cloud providers. See docs/dns.md.
   */
  relayHost: string;
  relayPort: number;
  relayUser: string;
  relayPass: string;
  relaySecure: boolean;
  /** Refuse to hand a message to a server that will not do STARTTLS. Off: TLS is opportunistic. */
  requireTls: boolean;
  smtpConnectTimeoutMs: number;
  smtpGreetingTimeoutMs: number;
  smtpSocketTimeoutMs: number;
  /** Simultaneous connections to any ONE destination domain. */
  perDomainConcurrency: number;
  /** Simultaneous connections across all domains. */
  globalConcurrency: number;
  /** Messages per minute to any one destination domain, before the queue backs off. */
  perDomainRatePerMinute: number;
  /** Messages the worker will pull from the spool in one pass. */
  batchSize: number;
  /** How long the worker sleeps when the queue is empty. */
  pollIntervalMs: number;

  // --- retry ---------------------------------------------------------------------
  maxAttempts: number;
  /** First retry delay; each subsequent one multiplies by retryFactor, up to retryMaxDelayMs. */
  retryBaseDelayMs: number;
  retryFactor: number;
  retryMaxDelayMs: number;
  /** Random proportion added to each delay so a batch of deferrals does not return in lockstep. */
  retryJitter: number;

  // --- limits --------------------------------------------------------------------
  maxMessageBytes: number;
  maxAttachmentBytes: number;
  maxRecipientsPerMessage: number;
  /** Extensions refused outright on inbound and outbound, executable-first. */
  blockedAttachmentExtensions: string[];

  // --- DKIM ----------------------------------------------------------------------
  dkimSelector: string;
  /** Directory holding <domain>.private (PEM). Never committed; see keys/README.md. */
  dkimKeyDir: string;

  // --- application link ----------------------------------------------------------
  /** Base URL of the EduRankAI application. Events and inbound deliveries are POSTed here. */
  appBaseUrl: string;
  /** Shared secret. Sent as an HMAC over the body, not as a bearer token. */
  appSharedSecret: string;
  /** Secret the app already uses on /api/mail/inbound (header x-mail-secret). */
  inboundSecret: string;
  appTimeoutMs: number;

  // --- storage -------------------------------------------------------------------
  /** Root of the durable spool. Everything the engine must not lose lives under here. */
  spoolDir: string;

  // --- inbound -------------------------------------------------------------------
  /** Accept anything at a hosted domain. Off by default — the brief says only if explicit. */
  catchAllEnabled: boolean;
  /** Rspamd score at or above which inbound mail is refused rather than filed to Spam. */
  spamRejectScore: number;
  /** Score at or above which mail is filed to the Spam folder. */
  spamQuarantineScore: number;

  // --- IMAP mailbox sync (Dovecot -> application) --------------------------------
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapSecure: boolean;
  /** Dovecot on the same host with a self-signed cert; NEVER true against a public server. */
  imapAllowSelfSigned: boolean;

  // --- server --------------------------------------------------------------------
  httpPort: number;
  /** Interface the engine API binds to. Loopback by default — it has no business on 0.0.0.0. */
  httpHost: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const prev = process.env;
  process.env = env;
  try {
    return {
      hostname: str('MAIL_HOSTNAME', 'mail.edurankai.in'),
      domains: list('MAIL_DOMAINS', ['edurankai.in']),
      env: str('NODE_ENV', 'development') === 'production' ? 'production' : 'development',

      deliveryEnabled: bool('MAIL_DELIVERY_ENABLED', false),
      relayHost: str('MAIL_RELAY_HOST'),
      relayPort: num('MAIL_RELAY_PORT', 587),
      relayUser: str('MAIL_RELAY_USER'),
      relayPass: str('MAIL_RELAY_PASS'),
      relaySecure: bool('MAIL_RELAY_SECURE', num('MAIL_RELAY_PORT', 587) === 465),
      requireTls: bool('MAIL_REQUIRE_TLS', false),
      smtpConnectTimeoutMs: num('MAIL_SMTP_CONNECT_TIMEOUT_MS', 20000),
      smtpGreetingTimeoutMs: num('MAIL_SMTP_GREETING_TIMEOUT_MS', 15000),
      smtpSocketTimeoutMs: num('MAIL_SMTP_SOCKET_TIMEOUT_MS', 60000),
      perDomainConcurrency: num('MAIL_PER_DOMAIN_CONCURRENCY', 2),
      globalConcurrency: num('MAIL_GLOBAL_CONCURRENCY', 8),
      perDomainRatePerMinute: num('MAIL_PER_DOMAIN_RATE_PER_MINUTE', 60),
      batchSize: num('MAIL_BATCH_SIZE', 20),
      pollIntervalMs: num('MAIL_POLL_INTERVAL_MS', 2000),

      maxAttempts: num('MAIL_MAX_ATTEMPTS', 9),
      retryBaseDelayMs: num('MAIL_RETRY_BASE_MS', 60_000),
      retryFactor: num('MAIL_RETRY_FACTOR', 3),
      retryMaxDelayMs: num('MAIL_RETRY_MAX_MS', 6 * 60 * 60 * 1000),
      retryJitter: num('MAIL_RETRY_JITTER', 0.2),

      maxMessageBytes: num('MAIL_MAX_MESSAGE_BYTES', 25 * 1024 * 1024),
      maxAttachmentBytes: num('MAIL_MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024),
      maxRecipientsPerMessage: num('MAIL_MAX_RECIPIENTS', 100),
      blockedAttachmentExtensions: list('MAIL_BLOCKED_EXTENSIONS', [
        'exe', 'scr', 'pif', 'com', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
        'msi', 'msp', 'hta', 'cpl', 'jar', 'lnk', 'reg', 'ps1', 'psm1', 'scf', 'inf', 'chm',
      ]),

      dkimSelector: str('MAIL_DKIM_SELECTOR', 'era1'),
      dkimKeyDir: str('MAIL_DKIM_KEY_DIR', 'mail-engine/keys'),

      appBaseUrl: str('MAIL_APP_BASE_URL', 'http://127.0.0.1:4321'),
      appSharedSecret: str('MAIL_APP_SHARED_SECRET'),
      inboundSecret: str('MAIL_INBOUND_SECRET'),
      appTimeoutMs: num('MAIL_APP_TIMEOUT_MS', 15000),

      spoolDir: str('MAIL_SPOOL_DIR', 'mail-engine/.spool'),

      catchAllEnabled: bool('MAIL_CATCH_ALL', false),
      spamRejectScore: num('MAIL_SPAM_REJECT_SCORE', 15),
      spamQuarantineScore: num('MAIL_SPAM_QUARANTINE_SCORE', 6),

      imapHost: str('MAIL_IMAP_HOST'),
      imapPort: num('MAIL_IMAP_PORT', 993),
      imapUser: str('MAIL_IMAP_USER'),
      imapPass: str('MAIL_IMAP_PASS'),
      imapSecure: bool('MAIL_IMAP_SECURE', true),
      imapAllowSelfSigned: bool('MAIL_IMAP_ALLOW_SELF_SIGNED', false),

      httpPort: num('MAIL_ENGINE_PORT', 2580),
      httpHost: str('MAIL_ENGINE_HOST', '127.0.0.1'),
      logLevel: (['debug', 'info', 'warn', 'error'].includes(str('MAIL_LOG_LEVEL', 'info'))
        ? str('MAIL_LOG_LEVEL', 'info')
        : 'info') as EngineConfig['logLevel'],
    };
  } finally {
    process.env = prev;
  }
}

/**
 * Reasons this configuration cannot deliver mail. Returned rather than thrown: the engine still
 * starts, still queues, still serves /healthz — it just says loudly what it cannot do. A worker that
 * refuses to boot because DKIM keys are missing is a worker that loses the queue it was holding.
 */
export function configWarnings(c: EngineConfig): string[] {
  const out: string[] = [];
  if (!c.deliveryEnabled) out.push('MAIL_DELIVERY_ENABLED is off: messages queue and are never handed to a remote server.');
  if (!c.relayHost) out.push('No MAIL_RELAY_HOST: delivery goes direct to MX on port 25, which most ISPs and clouds block outbound.');
  if (!c.appSharedSecret) out.push('No MAIL_APP_SHARED_SECRET: delivery events cannot be signed, and the application should reject them.');
  if (!c.inboundSecret) out.push('No MAIL_INBOUND_SECRET: inbound deliveries to the application will be refused with 403.');
  if (c.httpHost !== '127.0.0.1' && c.httpHost !== 'localhost' && !c.appSharedSecret) {
    out.push('The engine API is bound off-loopback with no shared secret. Anything that can reach the port can submit mail.');
  }
  return out;
}
