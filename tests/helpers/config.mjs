// tests/helpers/config.mjs — where the suites point, and what they are allowed to touch.
//
// EVERY DEFAULT IS LOCAL. Not because production is inconvenient to test, but because a test suite
// whose default target is production is one mistyped flag away from sending mail to real people, and
// from writing test rows into a database with no migration history and no restore rehearsal.
//
// Pointing at anything else is deliberate and loud: TEST_BASE_URL must be set explicitly, and
// tests/run.mjs refuses a target on edurankai.in unless ALLOW_PRODUCTION_TESTS=yes-i-mean-it.

export const config = {
  /** The Astro app. Local docker stack by default. */
  baseUrl: (process.env.TEST_BASE_URL || 'http://127.0.0.1:4321').replace(/\/+$/, ''),

  /** The SMTP sink — captures outbound mail and delivers nothing. */
  sink: {
    smtpHost: process.env.TEST_SINK_HOST || '127.0.0.1',
    smtpPort: Number(process.env.TEST_SINK_SMTP_PORT || 1025),
    apiUrl: (process.env.TEST_SINK_API || 'http://127.0.0.1:1080').replace(/\/+$/, ''),
  },

  /** The inbound bridge. Sending here is how the suites simulate a stranger's MTA. */
  ingest: {
    smtpHost: process.env.TEST_INGEST_HOST || '127.0.0.1',
    smtpPort: Number(process.env.TEST_INGEST_SMTP_PORT || 1026),
    apiUrl: (process.env.TEST_INGEST_API || 'http://127.0.0.1:1081').replace(/\/+$/, ''),
  },

  /** The real MTA, when the `mail` profile is running. Most suites skip without it. */
  mta: {
    host: process.env.TEST_MTA_HOST || '127.0.0.1',
    smtpPort: Number(process.env.TEST_MTA_SMTP_PORT || 25),
    submissionPort: Number(process.env.TEST_MTA_SUBMISSION_PORT || 587),
    imapPort: Number(process.env.TEST_MTA_IMAP_PORT || 143),
  },

  /** Stack health aggregator. */
  mailopsUrl: (process.env.TEST_MAILOPS_URL || 'http://127.0.0.1:9100').replace(/\/+$/, ''),

  /** Secrets the suites need in order to authenticate as an operator or an MTA. */
  secrets: {
    cron: process.env.CRON_SECRET || '',
    inbound: process.env.MAIL_INBOUND_SECRET || '',
    webhook: process.env.MAIL_WEBHOOK_SECRET || '',
    metrics: process.env.METRICS_TOKEN || '',
    /** A session cookie for a signed-in operator. See docs/mail/TESTING.md section 3 for how to get one. */
    sessionCookie: process.env.TEST_SESSION_COOKIE || '',
  },

  /** The domain the stack hosts. Inbound tests address mail here. */
  mailDomain: process.env.MAIL_DOMAIN || 'edurankai.in',

  /**
   * Addresses the suites are allowed to send TO.
   *
   * `.invalid` and `.test` are reserved by RFC 2606 and RFC 6761 — they can never be registered, so
   * a message that escapes the sink cannot reach a real mailbox. Using a real-looking domain in a
   * fixture is how a load test ends up in someone's inbox.
   */
  testRecipient: process.env.TEST_RECIPIENT || 'recipient@example.invalid',
  testSender: process.env.TEST_SENDER || 'sender@example.invalid',
};

/** True when this run is pointed at anything that is not obviously local. */
export function looksLikeProduction(url) {
  const u = String(url).toLowerCase();
  if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/.test(u)) return false;
  if (/^https?:\/\/(app|mta|mail-parser|mail-worker|smtp-sink|mailops)(:|\/)/.test(u)) return false; // compose service names
  return true;
}
