// src/lib/deployment-readiness.ts — what this deployment is missing, and what stops working without it.
//
// =================================================================================================
// WRITTEN FOR MOVING TO A NEW VERCEL ACCOUNT
// =================================================================================================
//
// A hosting move is not a code change, which is exactly why it goes wrong quietly. The build
// succeeds, the site loads, the home page looks perfect — and three days later somebody notices that
// no email has gone out since Tuesday, or that every employee photograph is a broken image.
//
// This codebase reads 48 environment variables. /admin/diagnostics checked eight of them. The other
// forty were the ones nobody would think to re-enter.
//
// So each variable below carries the SENTENCE describing what stops working without it, because
// "RESEND_API_KEY: missing" tells somebody nothing and "password reset emails will not send" tells
// them whether they can go to bed.
//
// =================================================================================================
// THREE KINDS OF BROKEN, AND ONLY ONE OF THEM IS OBVIOUS
// =================================================================================================
//
//   MISSING      the variable is not set. Loud, findable, fixed by pasting it in.
//   ACCOUNT-BOUND the value belongs to the OLD account and cannot simply be copied — a Vercel Blob
//                token points at that account's store. Copying it across is not the fix; migrating
//                or replacing the store is.
//   CHANGED      the variable IS set, on the new account, to a NEW value — and that silently
//                invalidates data already in the database. Regenerated VAPID keys make every
//                existing push subscription dead. A different WEBAUTHN_ORIGINS makes every enrolled
//                passkey unusable, because a passkey is bound to the origin it was created for.
//
// The third kind is the one that has no error message anywhere.

export type Severity = 'blocking' | 'degraded' | 'optional';

export interface EnvRequirement {
  name: string;
  severity: Severity;
  /** What stops working without it. A sentence, not a category. */
  breaks: string;
  /** Set when copying the old value across is the wrong move. */
  accountBound?: string;
  /** Set when a NEW value silently invalidates data already stored. */
  mustMatchOld?: string;
}

export const REQUIREMENTS: readonly EnvRequirement[] = Object.freeze([
  // ---- blocking: the site is not usable without these ----
  { name: 'DATABASE_URL', severity: 'blocking',
    breaks: 'Nothing works. Every page that reads or writes anything fails.' },
  { name: 'SESSION_SECRET', severity: 'blocking',
    breaks: 'Sessions cannot be signed. Nobody can stay signed in.',
    mustMatchOld: 'A new value signs everybody out at once. Survivable, but do it knowingly rather than at 9am on a Monday.' },
  { name: 'CRON_SECRET', severity: 'blocking',
    breaks: 'Every scheduled job refuses itself as unauthorised: mail polling, scheduled sends, payment reconciliation, the retention sweeps.',
    accountBound: 'Vercel sends this header itself. Set it on the new project AND check it has no leading or trailing whitespace — a stray space here has rejected every deploy on this project in about two seconds.' },

  // ---- degraded: the site runs, and a whole feature is silently dead ----
  { name: 'BLOB_READ_WRITE_TOKEN', severity: 'degraded',
    breaks: 'Uploads fall back to storing images inline or to an in-memory dev store. Profile photos, ID documents and lesson media stop being saved properly.',
    accountBound: 'THE BIGGEST TRAP IN THIS MOVE. A Blob store belongs to the account that made it, and the URLs already written into users.photo_url, hr_employees.photo_url and elsewhere point at the OLD account. Deleting or downgrading that account turns every one of those into a broken image, and the database will still hold the dead links. Migrate the assets, or move to S3 — src/lib/storage.ts already prefers S3 when it is configured.' },
  { name: 'RESEND_API_KEY', severity: 'degraded',
    breaks: 'Outbound email stops. Password resets, offer letters and every notification email go nowhere.' },
  { name: 'SMTP_HOST', severity: 'degraded',
    breaks: 'The own-SMTP path cannot connect, so mail falls back or fails depending on configuration.' },
  { name: 'SMTP_USER', severity: 'degraded', breaks: 'SMTP authentication fails and no mail is sent.' },
  { name: 'SMTP_PASS', severity: 'degraded', breaks: 'SMTP authentication fails and no mail is sent.' },
  { name: 'EMAIL_FROM', severity: 'degraded', breaks: 'Mail is sent from a default address, or rejected by the recipient server.' },
  { name: 'MAIL_INBOUND_SECRET', severity: 'degraded',
    breaks: 'Inbound mail webhooks are refused, so replies into the platform are dropped.' },
  { name: 'RAZORPAY_KEY_ID', severity: 'degraded', breaks: 'No payment can be started. Every paid flow fails at the first step.' },
  { name: 'RAZORPAY_KEY_SECRET', severity: 'degraded', breaks: 'Payments cannot be verified or captured.' },
  { name: 'RAZORPAY_WEBHOOK_SECRET', severity: 'degraded',
    breaks: 'Payment webhooks are rejected, so paid orders never settle and sit pending.' },
  { name: 'VAPID_PUBLIC_KEY', severity: 'degraded',
    breaks: 'Web push stops. No notification reaches a phone.',
    mustMatchOld: 'MUST be the same pair as before. A push subscription is bound to the key that created it, so regenerating these silently kills every subscription already in the database — with no error anywhere, on either side.' },
  { name: 'VAPID_PRIVATE_KEY', severity: 'degraded',
    breaks: 'Web push cannot be signed, so nothing is delivered.',
    mustMatchOld: 'Same pair as before. See VAPID_PUBLIC_KEY.' },
  { name: 'WEBAUTHN_ORIGINS', severity: 'degraded',
    breaks: 'Passkey sign-in fails.',
    mustMatchOld: 'A passkey is cryptographically bound to the origin it was enrolled on. If this does not list the SAME origin as before, every enrolled passkey stops working and the people holding them cannot sign in that way.' },
  { name: 'ANTHROPIC_API_KEY', severity: 'degraded',
    breaks: 'The AI tutor and assistant answer with their configured fallback instead of a real reply. Nothing is credited against it, by design.' },
  { name: 'OFFER_INTEGRITY_SECRET', severity: 'degraded',
    breaks: 'Offer letters are signed with a development fallback.',
    mustMatchOld: 'Letters already issued carry a hash computed with the OLD secret. Change it and their public verification stops matching.' },
  { name: 'CREDENTIAL_SIGNING_SECRET', severity: 'degraded',
    breaks: 'Issued credentials cannot be signed.',
    mustMatchOld: 'Credentials already issued verify against the old secret.' },
  { name: 'CALENDAR_TOKEN_SECRET', severity: 'degraded',
    breaks: 'Calendar subscription links stop resolving.',
    mustMatchOld: 'Links already handed out were signed with the old secret and will 404.' },

  // ---- optional: absent is a legitimate configuration ----
  // ---- the streaming-channel connector (src/lib/live-egress.ts) ----
  // All four absent is the normal state: no channel is connected and the admin screen says so.
  // The refresh token is the one worth watching — see accountBound, which is the failure mode that
  // produces no symptom at all until a scheduled class does not start.
  { name: 'LIVE_EGRESS_CLIENT_ID', severity: 'optional',
    breaks: 'No live class can be scheduled on the streaming channel. Everything else about a live class still works.' },
  { name: 'LIVE_EGRESS_CLIENT_SECRET', severity: 'optional',
    breaks: 'No live class can be scheduled on the streaming channel.' },
  { name: 'LIVE_EGRESS_REFRESH_TOKEN', severity: 'optional',
    breaks: 'No live class can be scheduled on the streaming channel.',
    accountBound: 'This consent belongs to the account that granted it, for one channel. It also EXPIRES: a token issued while the sign-in consent screen is still in testing stops working after seven days, and any token stops after six months unused. Neither failure has a visible symptom until a class fails to start.' },
  { name: 'LIVE_EGRESS_CHANNEL_LABEL', severity: 'optional',
    breaks: 'The connected channel is described generically in the admin screen.' },

  { name: 'S3_ENDPOINT', severity: 'optional', breaks: 'S3 storage is not used; the Blob store or the dev store is used instead.' },
  { name: 'S3_BUCKET', severity: 'optional', breaks: 'S3 storage is not used.' },
  { name: 'S3_ACCESS_KEY_ID', severity: 'optional', breaks: 'S3 storage is not used.' },
  { name: 'S3_SECRET_ACCESS_KEY', severity: 'optional', breaks: 'S3 storage is not used.' },
  { name: 'KV_REST_API_URL', severity: 'optional',
    breaks: 'The shared cache is disabled and the edge/memo tier is used instead. Slower, not broken.',
    accountBound: 'A Vercel KV store belongs to the account that made it.' },
  { name: 'SESSION_COOKIE_NAME', severity: 'optional',
    breaks: 'The default cookie name is used.',
    mustMatchOld: 'A different name signs everybody out, because the browser still holds a cookie under the old one.' },
  { name: 'FOUNDER_EMAIL', severity: 'optional', breaks: 'Founder-only screens fall back to their built-in address check.' },
  { name: 'PUBLIC_GA_ID', severity: 'optional', breaks: 'Analytics is not recorded.' },
  { name: 'MAIL_DOMAIN', severity: 'optional', breaks: 'Mail uses its default domain.' },
  { name: 'ACTIVITY_ENC_KEY', severity: 'optional',
    breaks: 'Activity log entries are stored without encryption.',
    mustMatchOld: 'Entries already encrypted with the old key cannot be read back with a new one.' },

  // ---- found by deployment-readiness.test.ts, which compares this list against what the code
  // actually reads. The first draft listed 30 of 46. A checklist that quietly omits a variable is
  // worse than no checklist, because somebody trusts it and stops looking.
  { name: 'VAPID_SUBJECT', severity: 'degraded',
    breaks: 'Push messages carry no contact subject, and some push services reject them outright.' },
  { name: 'CERT_PRIVATE_KEY_PEM', severity: 'degraded',
    breaks: 'Certificates cannot be signed, so none can be issued.',
    mustMatchOld: 'Certificates already issued verify against the OLD public key. A new pair makes every one of them fail verification, and those are in other hands.' },
  { name: 'CERT_PUBLIC_KEY_PEM', severity: 'degraded',
    breaks: 'Anybody checking an issued certificate cannot verify it.',
    mustMatchOld: 'Same pair as before. See CERT_PRIVATE_KEY_PEM.' },
  { name: 'API_EMBED_SECRET', severity: 'degraded',
    breaks: 'Embed tokens cannot be verified, so embedded labs refuse to load for external viewers.',
    mustMatchOld: 'Tokens already handed to partners were signed with the old secret.' },
  { name: 'ACTIVE_DATA_KEY_ID', severity: 'degraded',
    breaks: 'Field-level encryption cannot select its current key, so encrypted writes fail.',
    mustMatchOld: 'Data encrypted under an earlier key id cannot be read once this points elsewhere.' },
  { name: 'PUBLIC_RAZORPAY_KEY_ID', severity: 'degraded',
    breaks: 'The payment widget cannot initialise in the browser, so checkout never opens. This is the public half and must match RAZORPAY_KEY_ID.' },
  { name: 'RAZORPAYX_ACCOUNT_NUMBER', severity: 'optional',
    breaks: 'Payouts from the wallet cannot be initiated. Taking payments is unaffected.' },
  { name: 'SMTP_PORT', severity: 'optional', breaks: 'The default port is used, which is wrong for most providers.' },
  { name: 'SMTP_SECURE', severity: 'optional', breaks: 'TLS is negotiated by default rather than forced.' },
  { name: 'SMTP_INSECURE', severity: 'optional', breaks: 'Certificate checking stays on, which is the correct default.' },
  { name: 'S3_REGION', severity: 'optional', breaks: 'S3 uses its default region, which fails on most providers.' },
  { name: 'S3_PUBLIC_BASE_URL', severity: 'optional', breaks: 'Objects are addressed by their endpoint URL rather than a CDN domain.' },
  { name: 'PROCTORING_PROVIDER', severity: 'optional', breaks: 'The in-house advisory proctoring is used instead of an external vendor.' },
  { name: 'PROCTORING_VENDOR_BASE_URL', severity: 'optional', breaks: 'No external proctoring vendor is called.' },
  { name: 'PROCTORING_WEBHOOK_SECRET', severity: 'optional', breaks: 'Vendor proctoring webhooks are refused.' },
  { name: 'WALLET_BASE_CURRENCY', severity: 'optional', breaks: 'The wallet falls back to its default base currency.' },

  // ---- the transactional email API (src/lib/mailapi) ----
  // MAILAPI_TRACK_SECRET is 'degraded' rather than 'optional' on purpose: without it three
  // documented features are OFF, not merely unconfigured, and the difference is visible to a
  // developer reading the API response.
  { name: 'MAILAPI_TRACK_SECRET', severity: 'degraded',
    breaks: 'Open tracking, click tracking and one-click unsubscribe links are disabled in the transactional API. It falls back to SESSION_SECRET; with neither set, nothing is emitted rather than emitting unsigned links anybody could forge, and every send response says so in its warnings.',
    mustMatchOld: 'A new value invalidates every tracking and unsubscribe link already sitting in a delivered message. Those links stop working; nothing else breaks.' },
  { name: 'MAILAPI_INGEST_SECRET', severity: 'optional',
    breaks: 'Falls back to CRON_SECRET for the delivery-event ingest endpoint. With neither set, only an admin session can report a bounce or a delivery into the transactional event log.' },
  { name: 'MAILAPI_BASE_URL', severity: 'optional',
    breaks: 'Tracking, unsubscribe and webhook URLs fall back to PUBLIC_SITE_URL and then to the site constant. Only wrong if this deployment answers on a different host.' },
  { name: 'MAILAPI_DEFAULT_FROM', severity: 'optional',
    breaks: 'A transactional send with no `from` falls back to the from_address configured on the mail server, then to noreply@ the site domain.' },
  { name: 'MAILAPI_ALLOW_INSECURE_WEBHOOKS', severity: 'optional',
    breaks: 'Nothing. It exists so a local integration can register an http webhook endpoint; https is required otherwise, because a signed event carries recipient addresses.' },
  { name: 'PUBLIC_SITE_URL', severity: 'optional',
    breaks: 'Campaign links, transactional tracking links and unsubscribe links fall back to the site constant. Wrong only when this deployment answers on a different host.' },

  // ---- the mail DOMAIN layer (src/lib/mailplatform/domains, src/lib/mailplatform/profile.ts) ----
  // These describe WHERE THIS DEPLOYMENT'S MAIL LEAVES FROM, and they are read through
  // resolveProfile(), which getProfile() calls with each variable named explicitly so that the
  // the scanner matches a direct env read by name. They are listed here anyway. A customer publishes DNS records
  // generated from these values, so a wrong one is not a degraded feature — it is a customer
  // publishing a route to infrastructure nobody runs.
  { name: 'MAIL_MX_HOSTS', severity: 'optional',
    breaks: 'No MX record can be generated, so the domain wizard omits the receiving step entirely rather than printing a host that does not exist. Sending is unaffected. Accepts `10 mx1.example.net, 20 mx2.example.net`; the singular MAIL_MX_HOST is also honoured.' },
  { name: 'MAIL_SPF_INCLUDE', severity: 'degraded',
    breaks: 'No SPF record can be recommended and the sending checks report UNKNOWN rather than a verdict, because there is nothing to look for in the customer SPF record. Domains can still be added and their ownership verified; none of them can be activated for sending.' },
  { name: 'MAIL_MX_HOST', severity: 'optional',
    breaks: 'The singular form of MAIL_MX_HOSTS, read by the DomainProvider adapter. With neither set, the receiving step is omitted rather than printing a host that does not exist.' },
  { name: 'MAIL_SPF_IP4', severity: 'optional',
    breaks: 'SPF authorises this platform by include only. Set this when sending is authorised by address range instead.' },
  { name: 'MAIL_SPF_IP6', severity: 'optional', breaks: 'As MAIL_SPF_IP4, for IPv6 ranges.' },
  { name: 'MAIL_SENDING_IPS', severity: 'optional',
    breaks: 'The reverse-DNS panel cannot be shown, because there is no address to look up. Nothing about delivery changes.' },
  { name: 'MAIL_PTR_HOSTNAME', severity: 'optional',
    breaks: 'Reverse DNS is observed but cannot be compared against an expected name, so it is reported as a warning rather than a pass or a failure.' },
  { name: 'MAIL_TRACKING_TARGET', severity: 'optional',
    breaks: 'Open and click links use the shared tracking host rather than a CNAME on the customer domain.' },
  { name: 'MAIL_DMARC_RUA', severity: 'optional',
    breaks: 'The recommended DMARC record carries no aggregate-report address, and the wizard says so rather than inventing one.' },
  { name: 'MAIL_DKIM_SIGNING', severity: 'optional',
    breaks: 'Nothing. Set it to `off` when this deployment relays through infrastructure that signs with its own key, so the wizard stops asking customers to publish a DKIM record we cannot sign against.' },
  { name: 'MAIL_VERIFICATION_PREFIX', severity: 'optional',
    breaks: 'The ownership challenge is published at the default `_edurankai` name.',
    mustMatchOld: 'Changing this after domains have been verified moves the name their TXT record sits at, and the next check on each of them fails until the record is moved too.' },
  { name: 'MAIL_DKIM_SELECTOR_PREFIX', severity: 'optional',
    breaks: 'New DKIM selectors are minted under the default `era` prefix. Existing selectors are unaffected.' },
  { name: 'MAIL_PROFILE_ID', severity: 'optional', breaks: 'The deployment profile is called `default` on the operator screens.' },
  { name: 'MAIL_PROFILE_LABEL', severity: 'optional', breaks: 'The deployment profile shows a generated label.' },
]);

export interface EnvStatus extends EnvRequirement {
  present: boolean;
  /** Set when the value is present but suspect — trailing whitespace, most often. */
  warning: string | null;
}

/**
 * Read the current deployment's configuration.
 *
 * VALUES ARE NEVER RETURNED, only whether each is set — this renders on an admin screen, and a page
 * that prints secrets is a worse problem than the one it was built to solve. The one exception is a
 * SHAPE warning (whitespace), which is reported without the value.
 */
export function readEnvStatus(): EnvStatus[] {
  return REQUIREMENTS.map((r) => {
    const raw = process.env[r.name];
    const present = typeof raw === 'string' && raw.length > 0;
    let warning: string | null = null;
    if (present && raw !== raw.trim()) {
      // The documented trap: whitespace in CRON_SECRET has rejected every deploy on this project.
      warning = 'This value has leading or trailing whitespace. On CRON_SECRET that alone rejects '
        + 'every deployment in about two seconds; elsewhere it usually makes the value simply not match.';
    }
    return { ...r, present, warning };
  });
}

export interface ReadinessSummary {
  statuses: EnvStatus[];
  blockingMissing: EnvStatus[];
  degradedMissing: EnvStatus[];
  warnings: EnvStatus[];
  accountBound: EnvStatus[];
  mustMatch: EnvStatus[];
  /** True when nothing blocking or degrading is missing. Optional gaps do not count. */
  ok: boolean;
}

export function deploymentReadiness(): ReadinessSummary {
  const statuses = readEnvStatus();
  const blockingMissing = statuses.filter((s) => !s.present && s.severity === 'blocking');
  const degradedMissing = statuses.filter((s) => !s.present && s.severity === 'degraded');
  return {
    statuses,
    blockingMissing,
    degradedMissing,
    warnings: statuses.filter((s) => s.warning !== null),
    accountBound: statuses.filter((s) => s.accountBound),
    mustMatch: statuses.filter((s) => s.mustMatchOld),
    ok: blockingMissing.length === 0 && degradedMissing.length === 0,
  };
}
