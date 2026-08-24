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
// /admin/diagnostics checked eight environment variables. The rest were the ones nobody would think
// to re-enter, so this list was written to name every one of them.
//
// So each variable below carries the SENTENCE describing what stops working without it, because
// "RESEND_API_KEY: missing" tells somebody nothing and "password reset emails will not send" tells
// them whether they can go to bed.
//
// THE COUNT IS NOT WRITTEN DOWN HERE ANY MORE, DELIBERATELY. This header used to say "this codebase
// reads 48 environment variables". By 2026-08-24 the list held 106 entries and the code read about
// as many, so the sentence had become a confident, checkable, wrong statement in the one file whose
// entire purpose is to be trusted during a migration. A number maintained by hand rots; the drift
// gate in deployment-readiness.test.ts recomputes it from source on every `npm test` and fails when
// the code reads a variable this list does not declare. Ask the gate, not this comment.
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
  /**
   * The variable's real name is this string plus a suffix chosen at runtime, so there is no fixed
   * key to look up: `DATA_ENCRYPTION_KEY_${keyId}`, `FEATURE_${flag}`. Presence means AT LEAST ONE
   * matching variable is set — which is the only question that can honestly be asked here, and is
   * why these carry the loudest mustMatchOld text in the file. A checker that can only compare exact
   * names reports a whole class of variable as absent, or worse, never mentions it at all: the key
   * material for every encrypted column in this database was in that blind spot until 2026-08-24.
   */
  prefix?: true;
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
  // THE ONE WHERE 'ABSENT' HAS A PERSON ON THE OTHER END OF IT.
  //
  // Unset means nobody is monitoring counselling requests, and the Wellness Quarter says so in plain
  // words rather than claiming a team. That is honest, and it is not good: somebody can still ask for
  // help and be told, correctly, that it may not be read today.
  //
  // It sits under `optional` because the platform runs without it and because inventing a recipient
  // would be worse than admitting there is none. It is the entry on this page most worth fixing.
  { name: 'WELLNESS_COUNSELLOR_EMAIL', severity: 'optional',
    breaks: 'Nobody is notified when a person asks for counselling. The request is still saved, and the Wellness Quarter tells the person outright that no counsellor is monitoring the form, so the page stays truthful — but the request waits. Set this to the address of whoever responds. The notification deliberately carries only the urgency, language, preferred slot and the contact they gave; what they wrote never leaves the database.' },

  // ---- the rest of the campus intake desks (src/lib/intake-routing.ts) ----
  //
  // FOUR ENTRIES THAT WERE MISSING, AND WHY NOBODY NOTICED. intake-routing.ts names its recipient
  // for each desk as DATA — `envVar: 'LIBRARY_EMAIL'` — and resolves it at runtime. The checklist
  // test scanned only for a literal lookup on process.env, so these four were invisible to it: the code
  // needed them, the checklist did not list them, and the test that exists to catch exactly that
  // could not see either side. The scanner in deployment-readiness.test.ts now reads the indirect
  // form too, which is what surfaced them.
  //
  // All four are `optional` on the same reasoning as WELLNESS_COUNSELLOR_EMAIL above: the platform
  // runs without them and the request is still SAVED, so nothing a person submits is lost. What is
  // lost is the notification, and therefore the response time.
  //
  // Unlike the counselling desk, these four carry mayForwardContent: true — the person's own words
  // are included in the notification, because an inter-library loan or an access requirement cannot
  // be acted on by somebody who has not been told what it is. That is stated here so whoever sets
  // these addresses knows what will arrive at them.
  { name: 'TEST_CENTRE_EMAIL', severity: 'optional',
    breaks: 'Nobody is notified when somebody books a test-centre slot or states an access requirement. The booking is still saved and can be worked from the admin screen, but it waits until somebody looks. The notification includes what the person wrote, because an accommodation cannot be arranged by anyone who has not been told what it is.' },
  { name: 'LIBRARY_EMAIL', severity: 'optional',
    breaks: 'Nobody is notified when an inter-library loan is requested. The request is still saved and visible in the admin console, but no one is told it arrived, so it waits. Set this to the address of whoever sources loans.' },
  { name: 'CAMPUS_PROGRAMMES_EMAIL', severity: 'optional',
    breaks: 'Nobody is notified when somebody applies for a place on the cultural literacy programme. The application is still saved, so nothing is lost, but it is not routed to anyone who can offer a place.' },
  { name: 'CAMPUS_COMMONS_EMAIL', severity: 'optional',
    breaks: 'Nobody is notified about dorm circles, club joins, coffee matches or study-buddy requests. All four are still saved and are the ones most likely to go stale unread, because a person who asked to be introduced to somebody and heard nothing does not usually ask twice. Set this to whoever runs student community.' },

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
  // THE ONLY UNRECOVERABLE ENTRY IN THIS FILE, AND IT HAD NO ENTRY AT ALL UNTIL 2026-08-24.
  //
  // Everything else here can be put right by pasting the correct value in afterwards, or costs a
  // re-enrolment: new VAPID keys mean people resubscribe, a changed WEBAUTHN_ORIGINS means people
  // re-enrol a passkey, a new SESSION_SECRET means everybody signs in again. Losing this one is not
  // in that category. src/lib/crypto/keys.ts holds ONLY key metadata in Postgres — the 32 bytes that
  // actually decrypt anything live nowhere but this environment variable. Ciphertext whose key
  // material is gone is not recoverable by resetting anything, because there is nothing left to
  // reset it from. crypto_keys will still list the key id, which makes the loss look like a
  // configuration problem right up until somebody works out that it is not.
  //
  // Its absence was a blind spot in this checker rather than an oversight in the list: the name is
  // built at runtime as `DATA_ENCRYPTION_KEY_${keyId}`, and readEnvStatus() could only look up fixed
  // names, so no exact-name entry could ever have been written for it.
  { name: 'DATA_ENCRYPTION_KEY_', severity: 'degraded', prefix: true,
    breaks: 'Field-level encryption has no key material, so every encrypted read and write throws: DKIM private keys for sending domains, and the foundational and intake records that use the envelope.',
    mustMatchOld: 'CARRY THE EXACT BASE64 VALUES ACROSS, DO NOT GENERATE NEW ONES. This is the one variable in this file whose loss is permanent: the key material exists only here, Postgres holds nothing but the key id, and ciphertext written under a key you no longer have cannot be decrypted by any later fix. Copy DATA_ENCRYPTION_KEY_<keyId> for EVERY key id still referenced by crypto_keys, not just the active one — old rows are still encrypted under retired keys.' },
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
  // Genuinely optional, and listed only so the drift gate has something to match: a flag's value is
  // a DB override first, this env var second, the catalogue default third (src/lib/feature-flags.ts),
  // so an environment that sets none of these still resolves every flag. Worth carrying across only
  // if a surface is being deliberately held shut by one.
  { name: 'FEATURE_', severity: 'optional', prefix: true,
    breaks: 'Nothing. Feature flags fall back to their admin toggle, then to the catalogue default.' },

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

  // ---- found by the same test, a second time ----
  // Seventeen more variables had entered the codebase since the list was last reconciled — the mail
  // engine seam, the integration layer, the metrics endpoint and the host's own injected values.
  // Two of them fail CLOSED, which is the reason this reconciliation is not cosmetic: a deployment
  // can be missing them, report itself ready, and drop every webhook and every engine event.
  { name: 'WEBHOOK_SIGNING_KEY', severity: 'degraded',
    breaks: 'No outbound webhook is delivered at all. src/lib/mailplatform/webhooks.ts refuses to send rather than send unsigned, so every subscriber stops receiving events and the deliveries sit failed with that reason recorded.',
    mustMatchOld: 'Signatures are derived from this key and the stored secret hash. A new value makes every signature a receiver has already been told to expect verify differently — their endpoints will start rejecting deliveries.' },
  { name: 'MAIL_APP_SHARED_SECRET', severity: 'degraded',
    breaks: 'The mail engine cannot report anything back to the application: /api/mail/engine/events and /api/mail/engine/suppressions refuse EVERY request when it is unset, so deliveries, bounces and complaints never reach the platform and the suppression list stops growing from real bounces.' },

  { name: 'MAIL_SERVICE_URL', severity: 'optional',
    breaks: 'The application cannot call the standalone mail engine over HTTP — callMailService() returns "MAIL_SERVICE_URL is not set" without attempting a request. Absent is correct while the engine reports IN through /api/mail/engine/* rather than being called OUT to.' },
  { name: 'MAIL_SERVICE_KEY', severity: 'optional',
    breaks: 'The same call is refused before it is made, because the request cannot be signed. Set it together with MAIL_SERVICE_URL or not at all.' },
  { name: 'MAIL_WEBHOOK_SECRET', severity: 'optional',
    breaks: 'Inbound mail can no longer be authenticated by HMAC signature. It is not open: /api/mail/inbound falls back to the shared-secret header (MAIL_INBOUND_SECRET) and refuses anything that presents neither, but a shared secret in a header is replayable and a signature is not.' },
  { name: 'MAIL_TRANSPORT', severity: 'optional',
    breaks: 'Nothing. Outbound uses SMTP, which is the shipped default. Set it to `none` to build a deployment that accepts mail but sends none.' },
  { name: 'MAIL_INBOUND', severity: 'optional',
    breaks: 'Nothing. Inbound polls IMAP, which is the shipped default. Set it to `push` when a gateway posts to /api/mail/inbound and no mailbox should be polled.' },
  { name: 'IMAP_HOST', severity: 'optional',
    breaks: 'Nothing is polled differently — the mailbox that is actually polled is the one configured at /admin/mail/settings, which is authoritative. This value only names that host on the ops screen, which otherwise describes the poll generically.' },
  { name: 'MAIL_MAX_INBOUND_BYTES', severity: 'optional',
    breaks: 'A pushed inbound message larger than 30 MB is rejected. Raise it only if the gateway in front genuinely accepts more, since the whole body is held in memory to verify its signature.' },
  { name: 'MAIL_ALLOW_PRIVATE_SMTP', severity: 'optional',
    breaks: 'Nothing, and leaving it unset is the correct configuration. It disables the check that an SMTP host resolves to a public address — the guard against pointing this platform at a private network address to make it probe an internal service. Set it only for a deployment whose mail server genuinely is on a private network.' },
  { name: 'MAIL_GEOLOCATE_OPENS', severity: 'optional',
    breaks: 'Nothing, and unset is the intended default. An open is recorded without deriving a location for it. Setting it to true restores geolocation of the address that opened a message, which is data about a reader that nobody asked us to collect.' },
  { name: 'MAILINT_ENVIRONMENT', severity: 'optional',
    breaks: 'Nothing. The integration layer decides production versus development from VERCEL_ENV and then NODE_ENV, and fails towards development, so a preview deployment does not mail real people. Set it only to override that judgement deliberately.' },
  { name: 'METRICS_TOKEN', severity: 'optional',
    breaks: 'GET /api/metrics answers 404 and the benchmark report cannot be posted by an unattended runner. The endpoint is not left open when the token is unset — the door simply does not exist, and an admin session is the only other way in.' },
  { name: 'SITE_URL', severity: 'optional',
    breaks: 'Nothing on its own. It is the second fallback for the campaign link base, behind PUBLIC_SITE_URL and ahead of the built-in site constant.' },

  // Injected by the host rather than set by an operator. They are listed because this checklist is
  // also read when moving OFF the current host, where all three are simply absent — and each one
  // then changes a behaviour quietly rather than failing.
  { name: 'VERCEL_ENV', severity: 'optional',
    breaks: 'Nothing to set — the host injects it. Where it is absent the integration layer falls back to NODE_ENV to decide whether this deployment may mail real people, so a self-hosted production deployment must set NODE_ENV=production or it will behave as development and hold mail back.' },
  { name: 'VERCEL_REGION', severity: 'optional',
    breaks: 'Nothing to set — the host injects it. The metrics payload reports no region.' },
  // ---- the two flags the 2026-08-23 outage left behind ----
  //
  // Both are read by code that is on the request path of every page, and neither was on this
  // checklist — which is what the "checklist matches the code" test was failing on. An operator
  // moving this application to a new host had no way to learn either of them existed, and one of
  // them decides whether the application is allowed to alter its own schema.
  { name: 'SCHEMA_BOOTSTRAP', severity: 'optional',
    breaks: 'Nothing breaks when it is unset, and that is the point: it DEFAULTS TO OFF IN PRODUCTION. With it off the application never runs CREATE TABLE or ALTER TABLE on the request path, which is the fix for the 2026-08-23 outage — request-path ALTERs took an ACCESS EXCLUSIVE lock on `roles`, queued every reader behind it and exhausted the connection pooler. The consequence is that a NEW table or column does not create itself on the live site: apply the migration by hand (the files in db/), or set SCHEMA_BOOTSTRAP=on, deploy, confirm /api/health reports missingCount 0, then unset it again.' },
  { name: 'DB_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing, unless the database stops answering. It bounds how long a query may hang before withDbTimeout() rejects it, and it defaults to 8000ms. On 2026-08-23 the transaction pooler accepted connections and authenticated fine while never answering a query, so postgres-js waited forever and /api/health hung along with every other route — meaning nothing anywhere reported an outage that had been running for a quarter of an hour. Keep it well under the platform gateway timeout so the page decides what a visitor sees rather than the platform.' },

  { name: 'FX_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 2500ms. Bounds the exchange-rate lookup to api.frankfurter.app. That fetch had no signal at all, and it runs during a PAGE RENDER on /apply/step-6 -- the final submit screen an applicant reaches after filling in the whole form. A third party that accepts the connection and never answers produced a promise that never settled, so the conservative FALLBACK rate table in the catch below it was unreachable.' },
  { name: 'RAZORPAY_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 8000ms. Bounds all four Razorpay API calls (create order, fetch payment, fetch order payments, refund). Each wraps itself in a try/catch that returns a clean { ok: false } -- which fires on a network error and never on a hang, so a stalled gateway hung the invocation instead of producing the error message the code already knew how to give.' },
  { name: 'SMTP_SEND_BUDGET_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 20000ms. The TOTAL time one SMTP send may take including retries, and the source of the per-attempt connection/greeting/socket timeouts. Previously those were 15s + 10s + 30s per attempt across three attempts plus backoff -- about 95 seconds inside one invocation, on /api/auth/forgot-password, which is public and unauthenticated. The platform killed the function first, so nobody learned anything.' },
  { name: 'RBAC_GRAPH_TTL_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 30000ms. How long the RBAC role graph is memoised per process. It had no cache at all, so every can() call issued two unfiltered full-table reads of rbac_roles and rbac_role_capabilities -- for a graph of ~17 roles that is identical between requests. can() sits inside a 4-second poll on /aquintutor/board and a 6-second poll on /aquintutor/moderate, so one tab left open was ~21,600 polls a day re-reading both tables. Set to 0 to disable the cache entirely. A DEGRADED read is never cached at any setting: that answer denies, and a denial served from memory outlives the hiccup that caused it.' },
  { name: 'BLOB_UPLOAD_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 20000ms. Bounds a single Vercel Blob upload end to end via abortSignal. Without it an upload had no request timeout at all, on seven routes including the ID document behind face-2FA enrolment, which src/middleware.ts forces every signed-in user through.' },
  { name: 'VERCEL_BLOB_RETRIES', severity: 'optional',
    breaks: 'Read by @vercel/blob itself, not by our code, and DEFAULTED TO 2 in src/lib/blob-upload.ts because the library defaults it to TEN. Ten retries through async-retry (factor 2, minTimeout 1s, maxTimeout Infinity) is a backoff of 1,2,4,...,512 seconds -- about seventeen minutes of retrying inside one serverless invocation, none of which is reachable because the platform kills the function first. It is not a per-call option, so it can only be capped through this variable. Raising it re-arms that ladder.' },
  { name: 'PG_STATEMENT_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing to set; it defaults to 30000ms and is sent in the connection startup packet, which the transaction pooler forwards. It is NOT a latency bound -- DB_TIMEOUT_MS is. This is the backstop that makes the SERVER give up on a statement the client has already stopped waiting for, so the connection is handed back. Without it, withDbTimeout sheds the wait but postgres-js keeps the connection reserved until the pooler answers, and with max:2 per instance two abandoned reads wedge everything else that instance is serving. Do not lower it toward DB_TIMEOUT_MS: a server-side cancel arrives as an ordinary query error, which deliberately does not open the circuit breaker, so /admin would pay twelve separate failures instead of one -- and the nightly crons share this client.' },
  { name: 'PG_IDLE_TXN_TIMEOUT_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 15000ms. Bounds how long a transaction abandoned by a crashed handler may hold its locks and its pooler slot. An idle-in-transaction connection is worse than a slow query because it never finishes on its own.' },
  { name: 'DB_CIRCUIT_COOLDOWN_MS', severity: 'optional',
    breaks: 'Nothing, unless the database stops answering. After a bounded wait times out, further database waits are refused INSTANTLY for this long instead of each waiting out its own DB_TIMEOUT_MS; it defaults to 5000ms. This is what makes a per-query timeout sufficient on a page with a dozen reads: /admin issues roughly twelve sequential reads, and twelve consecutive 8-second timeouts is ninety-six seconds, which is still a gateway timeout. With the circuit, the same page costs one timeout and eleven instant refusals and renders its degraded state. The breaker itself re-runs nothing, so raising it only delays recovery; the first call after the cooldown is let through to find out whether the database is back. withDbRetry() is the one thing that does re-run work, and it will not start a second attempt while the circuit is open -- so this value also bounds how long the gates go without retrying.' },
  { name: 'DB_TRY_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 5000ms. The bound on the FIRST attempt inside withDbRetry(), which is what the five session/admin/permission/face gates in src/middleware.ts use instead of a single DB_TIMEOUT_MS wait. With DB_RETRY_MS it sums to the 8000ms those gates used to spend on one attempt, so no gate got slower. Do not tighten it toward the healthy read time: a burst through the live session gate produced three requests at 3.09-3.22s that all SUCCEEDED, and a bound below that turns successes into timeouts, which is not free -- three consecutive timeouts open the circuit breaker and every read in that instance is then refused instantly.' },
  { name: 'DB_RETRY_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 3000ms. The bound on the SECOND attempt inside withDbRetry(). The retry exists because roughly a quarter of the attempts to OPEN a connection on this deployment stall past five seconds while every read that reuses one succeeds -- a fixed rate per connection attempt, not a load-proportional one, which is why four rounds of tuning postgres-js `max` never moved it. The second ask is a second independent draw, and it is cheap because the connection the abandoned first attempt was opening still lands in the pool. DB_TRY_MS + DB_RETRY_MS is the worst case one gate can cost -- deliberately equal to the single DB_TIMEOUT_MS wait it replaced -- and the circuit breaker caps how many gates pay it before the rest are refused instantly.' },
  { name: 'DB_CIRCUIT_OPEN_AFTER', severity: 'optional',
    breaks: 'Nothing, unless the database is slow rather than absent. How many CONSECUTIVE bounded waits must time out before the circuit opens; it defaults to 3, and any success resets the run. It was effectively 1 for one afternoon and that is what took /admin down while the database was answering psql in 143ms: the breaker is process-global, so a single page fanning out more reads than the pool had slots queued the surplus, one queued read blew its fuse, and every later read in that instance -- including the middleware session gate on the NEXT request -- was refused without waiting. Lower it to 1 only to reproduce that. Raising it past a handful delays the protection the breaker exists to give, which is stopping a dozen sequential 8-second waits from becoming a gateway timeout.' },
  { name: 'ADMIN_SEARCH_QUERY_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 700ms. The bound on ONE block of the admin search fan-out in src/pages/api/admin/search.ts, so a single slow scan cannot hold a pool slot while the rest of the request waits behind it.' },
  { name: 'ADMIN_SEARCH_BUDGET_MS', severity: 'optional',
    breaks: 'Nothing to set; defaults to 1800ms. The bound on the WHOLE admin search request, which the per-block bound above cannot give on its own: fifteen blocks each finishing inside 700ms still add up to ten seconds. Typing a name into the admin search box was enough to refuse the NEXT page\'s sign-in — the fan-out spent long enough that reads timed out, three consecutive timeouts opened the process-global circuit breaker, and the middleware session gate on the following request was then refused without waiting. Blocks the budget skips are reported as `partial` rather than dropped silently, because a dropdown showing four results out of forty with no sign that it stopped early is the defect this codebase keeps finding.' },
  { name: 'VERCEL_GIT_COMMIT_SHA', severity: 'optional',
    breaks: 'Nothing to set — the host injects it. The health endpoint and the metrics payload cannot say which commit is serving, which is the first question asked when two deployments behave differently.' },
]);

/**
 * What to print for a requirement on a screen.
 *
 * A prefix entry's `name` is not a variable anybody can set: nothing is called
 * DATA_ENCRYPTION_KEY_. Printed raw it reads as a truncated name or a typo, and the person it was
 * written for is on a migration screen looking for something to paste a value into. The suffix is
 * shown as a placeholder so the shape is obvious at a glance.
 *
 * Kept here rather than in the page so every surface renders these the same way.
 */
export function displayName(r: EnvRequirement): string {
  return r.prefix ? `${r.name}<suffix>` : r.name;
}

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
/**
 * The value to judge a prefix requirement by, or undefined when nothing matches.
 *
 * Prefers a match with leading or trailing whitespace, so one damaged key among five is not hidden
 * behind four good ones — that is the whole reason the shape warning exists. Otherwise any match
 * will do, because presence is the only thing being claimed.
 */
function prefixValue(prefix: string): string | undefined {
  const values = Object.keys(process.env)
    .filter((k) => k.startsWith(prefix) && k.length > prefix.length)
    .map((k) => process.env[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return values.find((v) => v !== v.trim()) ?? values[0];
}

export function readEnvStatus(): EnvStatus[] {
  return REQUIREMENTS.map((r) => {
    // A prefix requirement has no single key to read. Presence is "at least one variable starting
    // with this", and the whitespace check runs over every match, because the one with a stray
    // newline is exactly the one nobody would look at.
    // `const`, not `let`. The narrowing that lets `raw.trim()` below type-check is TypeScript's
    // aliased-condition analysis through `present`, and that applies only to a const binding.
    const raw = r.prefix ? prefixValue(r.name) : process.env[r.name];
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
