// src/lib/mailplatform/loadgen.ts — the synthetic email generator (Patch 8 §9).
//
// THE SAFETY RULE IS CODE, NOT A README LINE. §9 says "Do NOT send generated load to public
// recipients." A comment saying so prevents nothing at 2am, so every generated address is built at a
// domain RESERVED BY RFC 2606/6761 for exactly this purpose, and assertSafeRecipients() throws on
// anything else. The check runs at generation AND is exported so the send path can run it again
// immediately before a socket is opened — the two places a mistake can enter are "generated wrong"
// and "generated right, then a real list got mixed in", and one check only catches the first.
//
// WHY .invalid AND NOT example.com. `example.com` is real, reserved, and answers DNS — an accidental
// send resolves an MX and leaves the building. `.invalid` is guaranteed by RFC 6761 never to resolve,
// so the same mistake fails at DNS on the sending host. The failure mode of the safety net should be
// a local error, not a delivery.
//
// DETERMINISTIC BY SEED. Same seed, same corpus, byte for byte. Two runs of a benchmark are only
// comparable if they did the same work, and `Math.random()` guarantees they did not. It also makes
// every test here exact instead of statistical.
//
// SIZE DISTRIBUTION IS THE POINT OF A MAIL LOAD TEST. A corpus of identical 2KB messages measures a
// system nobody operates: real traffic is mostly small with a long tail of large multipart mail, and
// that tail is what saturates parsing CPU, storage and SMTP transfer time. bodyFor() draws from a
// distribution instead of a constant, and the benchmark reports the realised distribution so the
// throughput number can be read next to the payload it was achieved with.

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * Domains reserved by RFC 2606 and RFC 6761. Nothing here resolves to a mailbox anyone owns.
 *
 * `.test` and `.invalid` are guaranteed non-resolving. The `example.*` names are reserved but DO
 * resolve, so they are NOT used for generation — they appear here only because a corpus imported
 * from elsewhere may contain them and rejecting those outright would be unhelpful noise. Generation
 * uses `.invalid` exclusively; see SYNTHETIC_DOMAIN.
 */
export const RESERVED_TEST_SUFFIXES: readonly string[] = ['.invalid', '.test', '.example', '.localhost', 'example.com', 'example.net', 'example.org'];

/** Every generated recipient lives here. Never resolves; a leaked send fails at DNS on the sender. */
export const SYNTHETIC_DOMAIN = 'loadtest.invalid';

/** Marks every generated row so a cleanup can find them without guessing. */
export const SYNTHETIC_TAG = 'era-loadgen';
export const SYNTHETIC_HEADER = 'X-EduRankAI-Synthetic';

export function isReservedAddress(address: string): boolean {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return false;
  const domain = String(address).slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return RESERVED_TEST_SUFFIXES.some((s) => {
    // A dotted entry like `.invalid` is a TLD, and the bare label is reserved too: RFC 6761 reserves
    // `localhost` itself, not only `foo.localhost`, and a sink configured as `user@localhost` is the
    // most ordinary local-SMTP address there is. Matching only the dotted form would have rejected
    // the single most likely correct configuration.
    const bare = s.startsWith('.') ? s.slice(1) : s;
    return domain === bare || domain.endsWith('.' + bare);
  });
}

export class UnsafeRecipientError extends Error {
  constructor(readonly offenders: string[]) {
    super(
      'Refusing to proceed: ' + offenders.length + ' recipient(s) are not at a reserved test domain. ' +
      'Load generation must never reach a public mailbox. Offending: ' + offenders.slice(0, 5).join(', ') + (offenders.length > 5 ? ' …' : '')
    );
    this.name = 'UnsafeRecipientError';
  }
}

/**
 * Throw unless EVERY address is at a reserved domain.
 *
 * Throws rather than filtering, deliberately. Silently dropping the unsafe addresses would let a run
 * that was pointed at a real contact list complete and report a throughput number for a smaller
 * corpus than requested — a wrong benchmark AND a near miss that nobody investigates.
 */
export function assertSafeRecipients(addresses: readonly string[]): void {
  const offenders = addresses.filter((a) => !isReservedAddress(a));
  if (offenders.length) throw new UnsafeRecipientError([...new Set(offenders)]);
}

/**
 * Guard for the SEND side: refuse to point generated load at anything but a local relay.
 *
 * The recipient check alone is not enough. A run configured against a production relay still opens a
 * connection to it, authenticates with production credentials, and appears in its logs as traffic —
 * and a relay that rewrites or catches-all could deliver mail addressed to a `.invalid` domain
 * anyway. §9 says "use local SMTP test infrastructure", so this insists on it.
 */
/**
 * Is this host literally a private or loopback IPv4 address?
 *
 * FULL-STRING MATCH, AND THAT IS THE ENTIRE POINT. This check was originally written as prefix
 * regexes — `/^10\./`, `/^192\.168\./`, `/^172\.(1[6-9]|2\d|3[01])\./` — which are anchored at the
 * START and not at the end. An adversarial review caught it and a two-line probe confirmed it:
 * `10.0.0.1.evil.com`, `192.168.1.1.attacker.net` and `172.16.0.1.evil.com` all satisfied those
 * regexes and were accepted as "local", which would have pointed a load generator at a
 * publicly-resolvable host under somebody else's control. That is precisely the barrier this
 * function exists to be.
 *
 * So the host must parse as four octets and nothing else. Octet range is checked too, because
 * `10.999.0.1` is not an address and should not be treated as one.
 */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (o[0] === 127) return true;                          // loopback
  if (o[0] === 10) return true;                           // RFC 1918
  if (o[0] === 192 && o[1] === 168) return true;          // RFC 1918
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // RFC 1918
  if (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return true; // unspecified
  return false;
}

/** A hostname label suffix, matched on a label boundary so `evil-internal.com` cannot pass as `.internal`. */
function hasLocalSuffix(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

export function assertLocalSmtp(host: string, opts: { allowRemote?: boolean } = {}): void {
  // A trailing dot is a fully-qualified name and is equivalent for our purposes; strip it so
  // `localhost.` is not treated as a different, non-local host.
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const loopbackV6 = h === '::1' || h === '[::1]';
  const local = loopbackV6 || hasLocalSuffix(h) || isPrivateIPv4(h);
  if (!local && !opts.allowRemote) {
    throw new Error(
      'Refusing to send generated load to "' + host + '". Load tests must target local SMTP test infrastructure ' +
      '(MailHog/Mailpit/smtp-sink on localhost). Pass allowRemote only for a relay you have confirmed is a sink, never for a production relay.'
    );
  }
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, and adequate for corpus generation. Not for anything security-bearing. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T { return items[Math.floor(rng() * items.length) % items.length]; }
function intBetween(rng: () => number, lo: number, hi: number): number { return lo + Math.floor(rng() * (hi - lo + 1)); }

const FIRST = ['ana', 'ben', 'chi', 'dev', 'eli', 'fay', 'gil', 'hana', 'ira', 'jo', 'kai', 'lea', 'mo', 'nia', 'ola', 'pia', 'quin', 'rai', 'sam', 'tal'];
const LAST = ['adler', 'bose', 'cruz', 'dutta', 'eriks', 'flor', 'gupta', 'hale', 'iyer', 'jain', 'kaur', 'lima', 'mehta', 'nair', 'okoro', 'pillai', 'rao', 'sen', 'tran', 'volk'];
const SUBJECT_STEMS = [
  'Your enrolment confirmation', 'Assessment window opens Monday', 'Certificate ready to download',
  'Session rescheduled', 'Weekly progress summary', 'Action needed on your application',
  'Your invoice', 'Cohort welcome pack', 'Password change confirmation', 'Feedback on your submission',
];

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

export interface SyntheticContact {
  externalId: string;
  email: string;
  firstName: string;
  lastName: string;
  tags: string[];
  synthetic: true;
}

export interface SyntheticMessage {
  externalId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  sizeBytes: number;
  campaignId: string | null;
  headers: Record<string, string>;
  synthetic: true;
}

export interface SyntheticCampaign {
  externalId: string;
  name: string;
  recipientCount: number;
  synthetic: true;
}

export interface SyntheticWorkflowRun {
  externalId: string;
  workflowExternalId: string;
  contactExternalId: string;
  nodesExecuted: number;
  synthetic: true;
}

export interface GenerateOptions {
  seed?: number;
  /** Sender. Also forced to a reserved domain — a synthetic bounce must not reach a real inbox. */
  fromDomain?: string;
  tenantId?: string;
}

export function generateContacts(count: number, opts: GenerateOptions = {}): SyntheticContact[] {
  const rng = seededRandom(opts.seed ?? 1);
  const out: SyntheticContact[] = [];
  for (let i = 0; i < count; i++) {
    const first = pick(rng, FIRST);
    const last = pick(rng, LAST);
    // Index in the local part guarantees uniqueness; without it a 100k-contact corpus collides
    // constantly and the run silently tests upsert conflicts instead of throughput.
    out.push({
      externalId: SYNTHETIC_TAG + '-contact-' + i,
      email: first + '.' + last + '.' + i + '@' + SYNTHETIC_DOMAIN,
      firstName: first,
      lastName: last,
      tags: [SYNTHETIC_TAG, pick(rng, ['cohort-a', 'cohort-b', 'cohort-c'])],
      synthetic: true,
    });
  }
  return out;
}

/**
 * Body size distribution, in bytes, with the weights meaning "share of messages".
 *
 * Roughly: most mail is a short transactional notice; a fifth is a real newsletter; a small tail is
 * large multipart. The tail matters far more than its share suggests, because parse time and
 * transfer time are proportional to size, so 2% of messages at 500KB is a meaningful fraction of
 * total bytes and of total CPU.
 */
export const SIZE_MIX: readonly { weight: number; minBytes: number; maxBytes: number; label: string }[] = [
  { weight: 0.55, minBytes: 1_000, maxBytes: 6_000, label: 'transactional' },
  { weight: 0.28, minBytes: 6_000, maxBytes: 40_000, label: 'newsletter' },
  { weight: 0.15, minBytes: 40_000, maxBytes: 150_000, label: 'rich' },
  { weight: 0.02, minBytes: 150_000, maxBytes: 600_000, label: 'large' },
];

function sizeFor(rng: () => number): { bytes: number; label: string } {
  let r = rng();
  for (const band of SIZE_MIX) {
    if (r < band.weight) return { bytes: intBetween(rng, band.minBytes, band.maxBytes), label: band.label };
    r -= band.weight;
  }
  const last = SIZE_MIX[SIZE_MIX.length - 1];
  return { bytes: intBetween(rng, last.minBytes, last.maxBytes), label: last.label };
}

/**
 * Filler that COMPRESSES LIKE PROSE.
 *
 * A body of one repeated character compresses to nothing, so any measurement of storage, of network
 * transfer, or of a TLS record is wrong by an order of magnitude — the benchmark would report a
 * system moving 500KB messages while actually moving 500 bytes on the wire. Varied words give a
 * compression ratio in the neighbourhood of real mail.
 */
function filler(rng: () => number, bytes: number): string {
  const words = ['module', 'session', 'assessment', 'cohort', 'schedule', 'progress', 'submission', 'feedback', 'credential', 'transcript', 'workshop', 'mentor', 'deadline', 'rubric', 'portfolio', 'seminar'];
  const parts: string[] = [];
  let len = 0;
  while (len < bytes) {
    const w = pick(rng, words);
    parts.push(w);
    len += w.length + 1;
    if (parts.length % 18 === 0) { parts.push('\n'); len += 1; }
  }
  return parts.join(' ').slice(0, bytes);
}

export function generateMessages(count: number, contacts: readonly SyntheticContact[], opts: GenerateOptions & { campaignId?: string | null } = {}): SyntheticMessage[] {
  if (contacts.length === 0) throw new Error('generateMessages needs at least one contact');
  const rng = seededRandom((opts.seed ?? 1) + 977);
  const fromDomain = opts.fromDomain ?? SYNTHETIC_DOMAIN;
  if (!isReservedAddress('x@' + fromDomain)) throw new UnsafeRecipientError(['x@' + fromDomain]);

  const out: SyntheticMessage[] = [];
  for (let i = 0; i < count; i++) {
    const contact = contacts[i % contacts.length];
    const { bytes, label } = sizeFor(rng);
    const body = filler(rng, bytes);
    const subject = pick(rng, SUBJECT_STEMS) + ' (' + label + ' #' + i + ')';
    out.push({
      externalId: SYNTHETIC_TAG + '-msg-' + i,
      from: 'noreply@' + fromDomain,
      to: contact.email,
      subject,
      text: body,
      html: '<html><body><p>' + body.replace(/\n/g, '</p><p>') + '</p></body></html>',
      sizeBytes: bytes,
      campaignId: opts.campaignId ?? null,
      // The header is what makes a synthetic message identifiable in a mail log, a sink, or a
      // database row long after the run that produced it has been forgotten.
      headers: { [SYNTHETIC_HEADER]: SYNTHETIC_TAG, 'X-EduRankAI-Size-Band': label },
      synthetic: true,
    });
  }
  assertSafeRecipients(out.map((m) => m.to));
  return out;
}

export function generateCampaigns(count: number, recipientsEach: number, opts: GenerateOptions = {}): SyntheticCampaign[] {
  const rng = seededRandom((opts.seed ?? 1) + 31);
  return Array.from({ length: count }, (_, i) => ({
    externalId: SYNTHETIC_TAG + '-campaign-' + i,
    name: SYNTHETIC_TAG + ' ' + pick(rng, ['spring', 'autumn', 'orientation', 'reminder']) + ' ' + i,
    recipientCount: recipientsEach,
    synthetic: true,
  }));
}

export function generateWorkflowRuns(count: number, contacts: readonly SyntheticContact[], opts: GenerateOptions = {}): SyntheticWorkflowRun[] {
  if (contacts.length === 0) throw new Error('generateWorkflowRuns needs at least one contact');
  const rng = seededRandom((opts.seed ?? 1) + 613);
  return Array.from({ length: count }, (_, i) => ({
    externalId: SYNTHETIC_TAG + '-run-' + i,
    workflowExternalId: SYNTHETIC_TAG + '-workflow-' + (i % 5),
    contactExternalId: contacts[i % contacts.length].externalId,
    nodesExecuted: intBetween(rng, 2, 9),
    synthetic: true,
  }));
}

/** Events for a message's lifecycle, with a realistic terminal-state mix. Uses events.makeEvent shape. */
export function generateEventStream(message: SyntheticMessage, contact: SyntheticContact, opts: GenerateOptions & { seedOffset?: number } = {}): { eventType: string; metadata: Record<string, unknown> }[] {
  const rng = seededRandom((opts.seed ?? 1) + (opts.seedOffset ?? 0) + 7919);
  const stream: { eventType: string; metadata: Record<string, unknown> }[] = [
    { eventType: 'message.queued', metadata: { sizeBytes: message.sizeBytes, synthetic: true } },
    { eventType: 'message.sent', metadata: { synthetic: true } },
  ];
  const roll = rng();
  // ~2% hard bounce, ~5% deferred-then-delivered, ~93% delivered. Deliverability numbers vary
  // enormously by list quality; this mix exists to exercise every code path, not to model a market.
  if (roll < 0.02) { stream.push({ eventType: 'message.bounced', metadata: { bounceType: 'hard', smtpCode: 550, synthetic: true } }); return stream; }
  if (roll < 0.07) stream.push({ eventType: 'message.deferred', metadata: { smtpCode: 451, synthetic: true } });
  stream.push({ eventType: 'message.delivered', metadata: { synthetic: true } });
  if (rng() < 0.35) stream.push({ eventType: 'message.opened', metadata: { synthetic: true, contact: contact.externalId } });
  if (rng() < 0.08) stream.push({ eventType: 'message.clicked', metadata: { synthetic: true, url: 'https://' + SYNTHETIC_DOMAIN + '/l/1' } });
  return stream;
}

// ---------------------------------------------------------------------------
// Corpus summary
// ---------------------------------------------------------------------------

export interface CorpusSummary {
  contacts: number;
  messages: number;
  campaigns: number;
  workflowRuns: number;
  totalBytes: number;
  meanBytes: number;
  bandCounts: Record<string, number>;
  allRecipientsReserved: boolean;
  seed: number;
}

/**
 * Describe what was generated.
 *
 * The realised size distribution goes in the benchmark report next to the throughput number, because
 * "1,200 msg/s" means nothing without it — the same system does very different numbers on 2KB and
 * 500KB messages, and a report that omits the payload is not reproducible.
 */
export function summarizeCorpus(input: { contacts: readonly SyntheticContact[]; messages: readonly SyntheticMessage[]; campaigns?: readonly SyntheticCampaign[]; workflowRuns?: readonly SyntheticWorkflowRun[]; seed: number }): CorpusSummary {
  const bandCounts: Record<string, number> = {};
  let totalBytes = 0;
  for (const m of input.messages) {
    totalBytes += m.sizeBytes;
    const band = String(m.headers['X-EduRankAI-Size-Band'] ?? 'unknown');
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }
  return {
    contacts: input.contacts.length,
    messages: input.messages.length,
    campaigns: input.campaigns?.length ?? 0,
    workflowRuns: input.workflowRuns?.length ?? 0,
    totalBytes,
    meanBytes: input.messages.length ? Math.round(totalBytes / input.messages.length) : 0,
    bandCounts,
    allRecipientsReserved: input.messages.every((m) => isReservedAddress(m.to)),
    seed: input.seed,
  };
}

/** SQL that removes everything a run created, matched on the tag rather than on a time window. */
export const CLEANUP_SQL: readonly string[] = [
  `DELETE FROM mp_events WHERE metadata->>'synthetic' = 'true'`,
  `DELETE FROM edu_jobs WHERE dedup_key LIKE '${SYNTHETIC_TAG}%'`,
  `DELETE FROM edu_job_log WHERE detail LIKE '%${SYNTHETIC_TAG}%'`,
  `DELETE FROM email_logs WHERE to_email LIKE '%@${SYNTHETIC_DOMAIN}'`,
];
