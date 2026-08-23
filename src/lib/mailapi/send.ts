// src/lib/mailapi/send.ts — the orchestration behind POST /api/v1/email/send.
//
// ORDER MATTERS AND IS DELIBERATE: validate, claim the idempotency key, check that this organization
// may send as this From address, resolve and render the template, sanitise the body, check
// suppression, claim one send out of the daily allowance, WRITE THE MESSAGE ROW, and only then hand
// anything to SMTP. The row exists before the transport is touched so that a crash mid-send leaves a
// record that says 'processing' and a dispatcher that can finish the job — rather than a mail that
// may or may not have gone out and nothing anywhere that knows.
//
// THE REFUSALS ARE ORDERED CHEAPEST FIRST, and that ordering is load-bearing rather than tidy: the
// allowance is the only step that COSTS the organization something, so it is claimed last, after
// every check that could still reject the request has had its say. A bad From address must not spend
// somebody's daily budget on its way to a 400.
//
// THE FROM ADDRESS MAY BE REWRITTEN, AND WE SAY SO. sendExternal() normalises From to the configured
// mailbox when it differs, moving the caller's address to Reply-To, because providers reject or
// spam-folder a From that does not match the authenticated account. That is existing, correct
// behaviour in the SMTP workstream — but a developer who asked for `talent@edurankai.in` and got
// something else deserves to be told, so the send response carries a warning naming the substitution
// instead of letting them discover it in a recipient's inbox.
//
// SUPPRESSION IS NOT FULLY OVERRIDABLE. `options.skip_suppression` can retry an address that hard
// bounced — sometimes a mailbox really was full and is not any more. It cannot override an
// unsubscribe or a complaint. A person who asked us to stop is not a delivery problem to route
// around.
//
// THREE CONTROLS THAT WERE DECLARED AND DID NOT RUN, AND WHAT EACH ONE ALLOWED:
//
//   * The sending identity was never checked at send time. Nothing in this file read
//     mailapi_domains, so a live key could put ANY address in `from` — another school, a bank, a
//     government department — and the only consequence was a warning string in the 202 response.
//     That is the open-relay property without an SMTP listener: our IP, our DKIM signature,
//     somebody else's domain, and the verification screen reduced to decoration. It is checked
//     below, before anything is rendered or stored.
//   * mailapi_orgs.daily_send_cap was read out of the org row, carried through AuthContext and
//     never compared with anything. A limit that reads as if it exists is worse than an absent
//     one, because operators budget against it. It is counted and enforced below.
//   * Caller and template HTML reached mailapi_messages.body_html and sendExternal() untouched:
//     `<script>`, `<iframe>`, `on*` handlers, `javascript:` hrefs and SVG payloads all survived,
//     signed by us and later rendered by our own mail screens. Every body is now put through
//     sanitizeEmailHtml() BEFORE it is stored, so what we keep and what we send are the same bytes.
import crypto from 'node:crypto';
import { SITE } from '@/lib/site';
import { sendExternal } from '@/lib/mail-transport';
// Renders link attachments into the body instead of having the server fetch them. See below.
import { appendLinkAttachments } from '@/lib/mailsec/link-attachments';
import { getMailConfig } from '@/lib/mail';
import { ApiError } from './errors';
import type { AuthContext } from './keys';
import { normalizeSendRequest, type NormalizedSend } from './validate';
import { resolveForSend, renderVersion } from './templates';
import { render, htmlToText } from './render';
import { findSuppressed, suppress } from './suppression';
import { mailplatformSuppressions } from './bridge';
import {
  createMessage, recordEvent, publicMessage, markAttempt, isTransientSmtpError, sendBackoffMs,
  claimDueMessages, getMessage, type MessageRecord,
} from './messages';
import { openPixelUrl, clickUrl, unsubscribeUrl, injectOpenPixel, rewriteLinks, unsubscribeFooter, listUnsubscribeHeaders, trackingConfigured } from './tracking';
import { ensureMailApiSchema, rows as dbRows, dbReason } from './schema';
import { sanitizeEmailHtml, ISOLATED, type Removal } from '@/lib/mailsec/html';
import { checkEnvelopeSender, addressDomain, normalizeAddress, isValidAddress } from '@/lib/mailsec/headers';
import { ensureOnce } from '@/lib/ensure-once';

export function baseUrl(): string {
  return String(process.env.MAILAPI_BASE_URL || process.env.PUBLIC_SITE_URL || SITE.url).replace(/\/$/, '');
}

export interface SendOutcome {
  message: MessageRecord;
  response: Record<string, any>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Sending identity — "we are not an open relay", asked at send time
//
// Everything in this section is declared ABOVE prepareMessage() on purpose. `const` is not hoisted,
// and a const declared below the handler that uses it throws on the handler's first line every time
// while the surface above it reports that all checks passed. That exact shape has already taken this
// project down twice.
// ---------------------------------------------------------------------------

/** The address out of `a@b.com`, `Name <a@b.com>` or nothing at all. Lower-cased, never throws. */
function bareAddress(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const angled = /<([^>]*)>/.exec(s);
  return normalizeAddress(angled ? angled[1] : s);
}

/**
 * The domains this deployment may send as on its own authority, whatever any organization has
 * verified: the mailbox the transport authenticates as, the configured default sender, and our own
 * site. An address on one of these is not relaying for somebody else — it is us.
 *
 * Derived from CONFIGURATION, not from the database, and checked first for two reasons: it costs no
 * query, so a request that will be refused for a bad address never reaches the domain table; and our
 * own default From keeps working during a database fault instead of taking first-party transactional
 * mail (password resets, verification codes) down with the tenant feature.
 */
export function platformSendingDomains(configuredFrom?: string | null): string[] {
  const out: string[] = [];
  for (const candidate of [configuredFrom, process.env.MAILAPI_DEFAULT_FROM, 'noreply@' + String(SITE.domain)]) {
    const d = addressDomain(bareAddress(candidate));
    if (d) out.push(d);
  }
  return Array.from(new Set(out));
}

/**
 * The organization's own verified domains, out of mailapi_domains rows.
 *
 * ONLY `status` IS READ, DELIBERATELY — not spf_ok and not dkim_ok. verifyDomain() in domains.ts
 * writes null into those columns when a DNS lookup could not RUN, and deliberately leaves `status`
 * alone in that case so a resolver having a bad minute does not downgrade a working domain. A check
 * here that demanded `spf_ok === true` would resurrect precisely the bug that file was written to
 * prevent, and would stop a verified tenant's mail because of a four-second timeout somewhere else.
 * `status` is the recorded verdict; these flags are the evidence behind it, and the evidence is
 * allowed to be temporarily unknown.
 */
export function verifiedSendingDomains(domainRows: any[]): string[] {
  return (domainRows || [])
    .filter((r) => String(r?.status || '').trim().toLowerCase() === 'verified')
    .map((r) => String(r?.domain || '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Refuse a From address that this organization is not entitled to use.
 *
 * FAILS CLOSED, AND SAYS WHICH KIND OF NO IT IS. "The domain is not verified" (the caller's problem,
 * 400, fixable in the console) and "we could not read the domain table" (our problem, 500, retry) are
 * different answers, and collapsing them is how this project has shipped outages before. Neither one
 * sends the mail: relaying for a domain we cannot confirm we own is the failure that costs us the
 * reputation of every other domain we sign.
 */
async function assertSenderIdentity(auth: AuthContext, fromEmail: string, platform: string[], configError: string,
                                   callerSuppliedFrom: boolean): Promise<void> {
  // A malformed address is answered before any query: a bad address must not cost a round trip, and
  // it certainly must not reach the allowance counter further down.
  if (!isValidAddress(fromEmail)) {
    throw new ApiError('invalid_request', 'The `from` address is not a valid email address, so nothing was sent.', { param: 'from' });
  }
  // ═══ THE PLATFORM ALLOWANCE IS FOR ADDRESSES WE CHOSE, NOT ADDRESSES A TENANT ASKED FOR ═══
  //
  // `platform` is the deployment's own sending identity — the configured mailbox,
  // MAILAPI_DEFAULT_FROM, and noreply@ on the site domain. It has to be allowed, or our own default
  // From stops working the moment the domain table cannot be read.
  //
  // But allowing it UNCONDITIONALLY made it a tenant-spoofing lane: any organization holding any
  // live key could put `security@<our own domain>` in `from` and have us sign it. That is worse
  // than sending as an unverified third-party domain, because mail from our own domain is the mail
  // our own people trust.
  //
  // So the allowance applies only when WE chose the address — the caller supplied no `from` and we
  // filled in the default. A tenant that explicitly names an address on the platform domain has to
  // verify it like any other domain.
  if (!callerSuppliedFrom && checkEnvelopeSender(fromEmail, platform).allowed) return;

  let verified: string[];
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    await ensureMailApiSchema();
    verified = verifiedSendingDomains(dbRows(await db.execute(sql`
      SELECT domain, status FROM mailapi_domains
      WHERE org_id = ${auth.orgId} AND environment = ${auth.environment}
      ORDER BY domain ASC LIMIT 500`)));
  } catch (e: any) {
    console.error('[mailapi] sending identity for org ' + auth.orgId + ' could not be checked:', dbReason(e));
    throw new ApiError('internal_error',
      'The sending identity for ' + (addressDomain(fromEmail) || 'that address') + ' could not be verified just now, so nothing was sent. This is a fault on our side, not a problem with the request — retry shortly.',
      { param: 'from' });
  }

  // checkEnvelopeSender() owns the domain arithmetic, including the "ends with ours" trap: a
  // sender at `notedurankai.in` must not pass because the string ends with `edurankai.in`.
  // Same rule on the second pass: the platform list is only in play when we chose the address.
  const allowed = callerSuppliedFrom ? verified : [...platform, ...verified];
  if (checkEnvelopeSender(fromEmail, allowed).allowed) return;

  const domain = addressDomain(fromEmail);
  // The list is trimmed for the message: an organization with two hundred verified domains should
  // get a readable error, not its own inventory pasted into a sentence.
  const shown = verified.slice(0, 10);
  throw new ApiError('invalid_request',
    'This organization is not verified to send as ' + (domain || 'that address') + ' in the ' + auth.environment + ' environment, so the message was refused rather than signed by us. '
    + (verified.length
      ? 'Verified sending domains for this organization: ' + shown.join(', ') + (verified.length > shown.length ? ', and ' + (verified.length - shown.length) + ' more' : '') + '.'
      : 'No sending domain has been verified for this organization yet. Add the domain and publish its SPF and DKIM records, then verify it.')
    + (configError ? ' (The configured platform mailbox could not be read on this request: ' + configError + '.)' : ''),
    { param: 'from', extra: { from_domain: domain, verified_domains: shown, environment: auth.environment } });
}

// ---------------------------------------------------------------------------
// Daily send allowance
// ---------------------------------------------------------------------------

/** A null or absent cap means NO cap; that is existing, intended behaviour and it is preserved. */
export type DailyCap =
  | { kind: 'none' }
  | { kind: 'cap'; limit: number }
  | { kind: 'unreadable'; raw: string };

/**
 * Read mailapi_orgs.daily_send_cap into something enforceable.
 *
 * Zero means zero, not unlimited: the column is nullable and NULL is the "no cap" sentinel, so a
 * stored 0 can only be somebody saying this organization may not send today. A value that is neither
 * (a fraction, a negative, text) is reported as unreadable rather than rounded into a guess — an
 * unenforceable limit must not quietly become an unlimited one, which is the whole defect being
 * fixed here.
 */
export function readDailyCap(raw: unknown): DailyCap {
  if (raw === null || raw === undefined || raw === '') return { kind: 'none' };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { kind: 'unreadable', raw: String(raw).slice(0, 40) };
  return { kind: 'cap', limit: n };
}

/** Whole seconds until the next UTC midnight, so a 429 can say when the allowance returns. */
export function utcDayResetSec(nowMs = Date.now()): number {
  const day = 86_400_000;
  return Math.max(1, Math.ceil((Math.floor(nowMs / day) * day + day - nowMs) / 1000));
}

// COUNTED IN A TABLE OF ITS OWN, NOT IN mailapi_rate_windows, AND THAT IS NOT A PREFERENCE.
// consume() is the right shape — one atomic INSERT … ON CONFLICT DO UPDATE … RETURNING count, no
// read-then-write race — but pruneRateWindows() deletes every window whose start is more than two
// hours old, and it runs on the dispatch cron. A daily bucket starts at UTC midnight, so from 02:00
// UTC onward the pruner would silently delete the counter and reset the day's total to zero. The cap
// would look enforced and would not be, which is the exact defect this change exists to remove.
//
// The count is a RESERVATION taken immediately before the message row is written. If the write then
// fails, the organization has been charged for a message that does not exist. That drift is in the
// safe direction — it can only refuse sooner, never send more — and a reservation released on the
// way out of a failure would be a second write that can itself fail.
const DAILY_SENDS_DDL = `CREATE TABLE IF NOT EXISTS mailapi_daily_sends (
    org_id uuid NOT NULL REFERENCES mailapi_orgs(id) ON DELETE CASCADE,
    day date NOT NULL,
    count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, day)
  )`;

/**
 * Reserve one send against today's allowance and return the post-increment total.
 *
 * Throws when the counter cannot be written. ensureOnce() swallows a DDL failure and RESOLVES, so
 * its success proves nothing; the INSERT below is the real verification — if the table is not there,
 * this throws and the caller refuses the send rather than assuming an empty count.
 *
 * The day is `(now() AT TIME ZONE 'utc')::date`, computed by the database, so every instance agrees
 * on where the boundary is regardless of the clock or the timezone of the process.
 */
async function reserveDailySend(orgId: string): Promise<number> {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  await ensureMailApiSchema();
  await ensureOnce('mailapi.daily_sends', async () => { await db.execute(sql.raw(DAILY_SENDS_DDL)); });
  const r = dbRows(await db.execute(sql`
    INSERT INTO mailapi_daily_sends (org_id, day, count)
    VALUES (${orgId}, (now() AT TIME ZONE 'utc')::date, 1)
    ON CONFLICT (org_id, day) DO UPDATE SET count = mailapi_daily_sends.count + 1, updated_at = now()
    RETURNING count`));
  const used = Number(r[0]?.count);
  if (!Number.isFinite(used) || used < 1) throw new Error('daily send counter returned no count');
  return used;
}

// ---------------------------------------------------------------------------
// Body sanitisation
// ---------------------------------------------------------------------------

/**
 * A short, readable account of what was taken out of a body, for the warning the caller gets.
 *
 * The removals are SURFACED rather than applied in silence: a developer whose template quietly lost
 * its tracking script or its layout should learn that from our response, not from a recipient.
 */
export function summarizeRemovals(removed: Removal[], max = 6): string {
  const counts = new Map<string, number>();
  for (const r of removed || []) {
    const label = r.kind === 'element' ? '<' + r.name + '>'
      : r.kind === 'attribute' ? r.name + '='
      : r.kind === 'url' ? r.name + ' (unsafe URL)'
      : r.kind === 'style' ? r.name + ' (style)'
      : r.name;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => (n > 1 ? label + ' x' + n : label));
  if (parts.length <= max) return parts.join(', ');
  return parts.slice(0, max).join(', ') + ', and ' + (parts.length - max) + ' more';
}

/**
 * Build the message row (and everything rendered into it) without touching the transport.
 *
 * Split out from delivery so the dispatcher, the retry path and the API all agree on what a message
 * is, and so a test can assert the rendering and suppression behaviour without a mail server.
 */
export async function prepareMessage(auth: AuthContext, body: any, headers: { idempotencyKey?: string | null } = {}): Promise<{ message: MessageRecord; warnings: string[] }> {
  const input: NormalizedSend = normalizeSendRequest(body, headers);
  const warnings: string[] = [];

  // ---- sender, and the identity behind it --------------------------------
  // CHEAPEST REFUSALS FIRST, AND THAT IS WHY THIS BLOCK MOVED UP. It used to sit after template
  // resolution and rendering, so a request that was never entitled to send as this domain first
  // spent a template read and a full render — and, once the daily allowance below became a real
  // control, it would have spent a slot out of the organization's budget as well. The From address
  // does not depend on the body, so there was nothing to gain by resolving it later.
  let configError = '';
  const config = await getMailConfig().catch((e: any) => {
    // Still non-fatal: an unreadable mail config must not stop a tenant sending from its own
    // verified domain. But it is REMEMBERED rather than swallowed, because it narrows the set of
    // addresses we can accept, and a refusal actually caused by an unreadable config has to say so
    // instead of telling the caller their domain is unverified.
    configError = dbReason(e);
    console.error('[mailapi] mail config could not be read for a send:', configError);
    return {} as any;
  });
  const fromEmail = input.from?.email || config.fromAddress || process.env.MAILAPI_DEFAULT_FROM || 'noreply@' + String(SITE.domain);
  const fromName = input.from?.name || config.fromName || auth.orgName;
  await assertSenderIdentity(auth, bareAddress(fromEmail), platformSendingDomains(config.fromAddress), configError, !!input.from?.email);
  if (config.fromAddress && fromEmail.toLowerCase() !== String(config.fromAddress).toLowerCase()) {
    // The tail of this warning used to read "Verify <domain> as a sending identity to send From it
    // directly". It cannot say that any more: by the time execution reaches this line the identity
    // HAS been checked, so the advice would be telling an already-verified sender to verify.
    warnings.push('The mail server is authenticated as ' + config.fromAddress + ', so this message is sent From that address with ' + fromEmail + ' as Reply-To. The sending identity was accepted; the substitution is the transport\'s, because providers reject or spam-folder a From that does not match the authenticated account.');
  }

  // ---- content -----------------------------------------------------------
  let subject: string;
  let html: string;
  let text: string;
  let templateId: string | null = null;
  let templateKey: string | null = null;
  let templateVersion: number | null = null;
  let templateState: string | null = null;
  /** True when the plain-text part was derived from the html rather than supplied — see below. */
  let textDerivedFromHtml = false;

  if (input.templateRef) {
    const resolved = await resolveForSend({
      orgId: auth.orgId,
      environment: auth.environment,
      idOrKey: input.templateRef,
      version: input.templateVersion,
      allowDraft: input.options.allowDraft,
    });
    const rendered = renderVersion(resolved.version, input.variables);
    if (rendered.missing.length) {
      // Refused, not rendered blank. "Dear ," is already in the recipient's inbox by the time
      // anybody notices, and the templates screen carries a note about exactly this failure mode.
      throw new ApiError('template_variable_missing',
        'Template `' + resolved.template.key + '` needs variables that were not supplied: ' + rendered.missing.join(', ') + '.',
        { param: 'variables', extra: { missing_variables: rendered.missing, template: resolved.template.key, template_version: resolved.version.version } });
    }
    subject = input.subject || rendered.subject;
    html = rendered.html;
    text = rendered.text;
    templateId = resolved.template.id;
    templateKey = resolved.template.key;
    templateVersion = resolved.version.version;
    templateState = resolved.version.state;
    if (resolved.overridden) {
      warnings.push('Sent from an unpublished template version (' + resolved.version.state + ' v' + resolved.version.version + ') because options.allow_draft was set.');
    }
  } else {
    // An inline body may still carry variables — the same renderer, so behaviour does not change
    // depending on where the content came from.
    const s = render(input.subject || '', input.variables, { escape: false });
    const h = input.html ? render(input.html, input.variables, { escape: true }) : { output: '', missing: [] as string[] };
    const t = input.text ? render(input.text, input.variables, { escape: false }) : { output: '', missing: [] as string[] };
    const missing = Array.from(new Set([...s.missing, ...h.missing, ...t.missing])).sort();
    if (missing.length) {
      throw new ApiError('template_variable_missing', 'The inline body references variables that were not supplied: ' + missing.join(', ') + '.', { param: 'variables', extra: { missing_variables: missing } });
    }
    subject = s.output;
    html = h.output || '';
    text = t.output || (html ? htmlToText(html) : '');
    // The two derived parts — a text part taken from the html, and the <pre> wrapper for a body that
    // is only text — are now built AFTER sanitisation instead of here. See the block below: built
    // here, the wrapper would be stripped by the sanitiser as if the caller had written it.
    textDerivedFromHtml = !t.output && !!html;
  }

  // ---- sanitise the body BEFORE it is stored -----------------------------
  // Whatever produced this HTML — a caller's inline body or a stored template — it is about to be
  // written to mailapi_messages.body_html, sent under our DKIM signature, and later rendered on our
  // own mail screens. Nothing used to stand between those three and a `<script>`, an `<iframe>`, an
  // `onerror=`, a `javascript:` href or an SVG payload. Sanitising HERE, before createMessage(),
  // rather than in deliverMessage() is deliberate: the stored copy and the delivered copy must be
  // the same bytes, or the archive stops being evidence of what was sent.
  //
  // ISOLATED, not ORIGIN: this body is going into an EMAIL. ORIGIN additionally forbids position and
  // z-index, which is right for markup rendered inside our own document and wrong here — it would
  // silently re-lay-out templates that have been sending correctly for months. Script, framing,
  // event handlers and unsafe URL schemes are refused by both profiles; that is the part that
  // matters for a body we sign.
  const sanitized = sanitizeEmailHtml(html, ISOLATED);
  html = sanitized.html;
  if (!sanitized.clean) {
    warnings.push('Part of the HTML body was removed before sending: ' + summarizeRemovals(sanitized.removed) + '. The message was sent without it rather than with markup we will not put our signature on.');
  }

  // THE TEXT PART HAS TO AGREE WITH THE HTML PART. When the caller sent html and no text, the plain
  // text was taken from the body they sent — so the contents of a `<script>` we had just removed
  // would still have travelled, as text, in the same message. Regenerated from the sanitised html,
  // the two alternatives of one multipart message say the same thing. A text part the CALLER wrote,
  // or one that came from a template, is never rewritten: it is theirs.
  if (textDerivedFromHtml && !sanitized.clean) text = html.trim() ? htmlToText(html) : '';

  // Our own wrapper for a body that is only text, built here rather than before the sanitiser
  // because `pre` is not on the email allow-list: sanitising it would strip the wrapper we had just
  // added and then report our own markup to the caller as something removed from theirs. What goes
  // inside it is escaped on the way in, so it never needed sanitising. Inline bodies only — a
  // template that ships a text part and no html has always sent exactly that.
  if (!input.templateRef && !html.trim() && text.trim()) {
    html = '<pre style="font-family:inherit;white-space:pre-wrap;">' + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]) + '</pre>';
  }

  if (!html.trim() && !text.trim() && !sanitized.clean) {
    // Distinct from the generic empty-body error below, which would be a confusing answer to a body
    // that was not empty when it arrived.
    throw new ApiError('invalid_request',
      'Nothing was left of the HTML body once the unsafe parts were removed (' + summarizeRemovals(sanitized.removed) + '), and there is no text body to fall back to.',
      { param: 'html', extra: { removed: sanitized.removed.slice(0, 20) } });
  }

  if (!subject.trim()) throw new ApiError('invalid_request', 'The rendered subject is empty.', { param: 'subject' });
  if (!html.trim() && !text.trim()) throw new ApiError('invalid_request', 'The rendered body is empty.', { param: 'html' });

  // ---- suppression -------------------------------------------------------
  const allRecipients = [...input.to, ...input.cc, ...input.bcc];
  const suppressedMap = await findSuppressed(auth.orgId, auth.environment, allRecipients);
  // BOTH LISTS. A candidate who unsubscribed from a campaign is recorded by the campaign platform,
  // not here; checking only our own list would mail a person who already asked us to stop, from a
  // system that had the answer and did not look. See src/lib/mailapi/bridge.ts.
  const shared = await mailplatformSuppressions(auth.mpOrgId, allRecipients);
  for (const [email, hit] of shared) if (!suppressedMap.has(email)) {
    suppressedMap.set(email, { email, reason: hit.reason, source: hit.source, detail: null, createdAt: '' });
  }
  const blocked: { email: string; reason: string }[] = [];
  const keep = (list: string[]) => list.filter((e) => {
    const hit = suppressedMap.get(e);
    if (!hit) return true;
    // A bounce may be retried on request; an unsubscribe or a complaint may not.
    if (input.options.skipSuppression && hit.reason === 'bounce') return true;
    blocked.push({ email: e, reason: hit.reason });
    return false;
  });
  const to = keep(input.to);
  const cc = keep(input.cc);
  const bcc = keep(input.bcc);
  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    throw new ApiError('all_recipients_suppressed',
      'Every recipient is on this organization\'s suppression list for the ' + auth.environment + ' environment.',
      { extra: { suppressed: blocked } });
  }
  if (blocked.length) {
    warnings.push(blocked.length + ' recipient(s) were skipped because they are suppressed: ' + blocked.map((b) => b.email + ' (' + b.reason + ')').join(', ') + '.');
  }

  // ---- attachments as links ---------------------------------------------
  const attachments = input.attachments.map((a) => {
    const filename = a.filename || filenameFromUrl(a.url);
    return { filename, url: a.url, kind: 'link' };
  });
  if (attachments.length) {
    const list = attachments.map((a) => '<li style="margin:4px 0;"><a href="' + a.url.replace(/"/g, '&quot;') + '" style="color:#c2410c;">' + escapeHtml(a.filename) + '</a></li>').join('');
    html += '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e5e5;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:12px;color:#555;">'
      + '<p style="margin:0 0 6px;font-weight:600;">Linked documents</p><ul style="margin:0;padding-left:18px;">' + list + '</ul>'
      + '<p style="margin:8px 0 0;color:#8a8a94;">Shared links — nothing is uploaded or copied. The recipient opens each document where it lives.</p></div>';
    text += '\n\nLinked documents:\n' + attachments.map((a) => '- ' + a.filename + ': ' + a.url).join('\n');
  }

  // ---- daily allowance ---------------------------------------------------
  // LAST OF THE REFUSALS, AND ON PURPOSE. Every check above can reject this request — an unverified
  // sender, a missing template variable, a body with nothing left in it, a recipient list that is
  // entirely suppressed — and none of them should cost the organization a send out of its day. So
  // the allowance is claimed here, once nothing else can say no, and immediately before the row that
  // it is counting.
  //
  // The counter counts messages ACCEPTED, not delivered: a scheduled message is charged to the day
  // it was accepted, and a message that later bounces is not refunded. Anything else would let a
  // caller queue an unbounded number of sends for tomorrow.
  const cap = readDailyCap(auth.dailySendCap);
  if (cap.kind === 'unreadable') {
    // A limit we cannot read is not a limit of zero and is not a licence to send. It is a broken
    // row, and the honest answer is our own error rather than a silently unlimited organization.
    console.error('[mailapi] org ' + auth.orgId + ' has an unusable daily_send_cap: ' + cap.raw);
    throw new ApiError('internal_error', 'The daily send limit recorded for this organization cannot be read, so nothing was sent. This needs fixing on our side.');
  }
  if (cap.kind === 'cap') {
    let used: number;
    try {
      used = await reserveDailySend(auth.orgId);
    } catch (e: any) {
      // Fails CLOSED, unlike the per-minute limiter in ratelimit.ts, and the difference is
      // deliberate. That limiter guards latency and fails open so a slow database cannot become a
      // total sending outage. This one is the organization's abuse and spend ceiling, and it is
      // backed by the same database that is about to store the message — so allowing a send past an
      // uncountable ceiling buys no availability at all (createMessage would fail next anyway) and
      // would let a runaway loop through the one control meant to bound it.
      console.error('[mailapi] daily send allowance for org ' + auth.orgId + ' could not be counted:', dbReason(e));
      throw new ApiError('internal_error', 'The daily send allowance for this organization could not be counted, so nothing was sent. This is a fault on our side — retry shortly.');
    }
    if (used > cap.limit) {
      throw new ApiError('rate_limit_exceeded',
        'This organization has used its daily send allowance of ' + cap.limit + ' message(s). The allowance resets at 00:00 UTC.',
        { extra: { daily_send_cap: cap.limit, used, resets_in_seconds: utcDayResetSec() } });
    }
    const remaining = cap.limit - used;
    if (remaining <= Math.max(1, Math.floor(cap.limit * 0.1))) {
      warnings.push(remaining + ' of this organization\'s daily allowance of ' + cap.limit + ' message(s) remain. It resets at 00:00 UTC.');
    }
  }

  // ---- create the row ----------------------------------------------------
  const message = await createMessage({
    orgId: auth.orgId,
    environment: auth.environment,
    apiKeyId: auth.keyId,
    from: fromEmail,
    fromName,
    replyTo: input.replyTo,
    to, cc, bcc,
    suppressed: blocked,
    subject,
    html,
    text,
    templateId, templateKey, templateVersion, templateState,
    tags: input.tags,
    metadata: input.metadata,
    headers: input.headers,
    attachments,
    idempotencyKey: input.idempotencyKey,
    scheduledAt: input.scheduledAt,
  });

  // ---- tracking (opt-in, and only if a signing key exists) ---------------
  if ((input.options.trackOpens || input.options.trackClicks || input.options.includeUnsubscribe) && !trackingConfigured()) {
    warnings.push('Open/click tracking and unsubscribe links are disabled: no MAILAPI_TRACK_SECRET (or SESSION_SECRET) is configured on this deployment. The message was sent without them rather than with unsigned links.');
  } else {
    const decorated = decorateForTracking(message, html, {
      trackOpens: input.options.trackOpens,
      trackClicks: input.options.trackClicks,
      includeUnsubscribe: input.options.includeUnsubscribe,
      orgName: auth.orgName,
    });
    if (decorated !== html) {
      const { db } = await import('@/lib/db');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`UPDATE mailapi_messages SET body_html = ${decorated} WHERE id = ${message.id}`);
    }
  }

  await recordEvent({ message, orgSlug: auth.orgSlug, type: 'email.queued', data: { scheduled_at: message.scheduledAt, warnings } });
  return { message, warnings };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last && decodeURIComponent(last).slice(0, 120)) || u.hostname;
  } catch { return 'Shared link'; }
}

/** Apply the opt-in tracking decorations to a body. Pure apart from the configured secret. */
export function decorateForTracking(message: MessageRecord, html: string, opts: { trackOpens: boolean; trackClicks: boolean; includeUnsubscribe: boolean; orgName: string }): string {
  let out = html;
  const base = baseUrl();
  if (opts.trackClicks) {
    const r = rewriteLinks(out, (target) => clickUrl(base, message.id, target));
    out = r.html;
  }
  if (opts.includeUnsubscribe) {
    const primary = message.to[0];
    const u = primary ? unsubscribeUrl(base, message.id, primary) : null;
    if (u) out += unsubscribeFooter(u, opts.orgName);
  }
  if (opts.trackOpens) {
    const pixel = openPixelUrl(base, message.id);
    if (pixel) out = injectOpenPixel(out, pixel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryOutcome { ok: boolean; status: string; error?: string; willRetry: boolean }

/**
 * Hand one message to the SMTP transport and record what happened.
 *
 * Used by the API (for an immediate send) and by the dispatcher (for scheduled sends and retries),
 * so both paths produce the same events and the same statuses.
 */
export async function deliverMessage(message: MessageRecord, orgSlug: string): Promise<DeliveryOutcome> {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  const bodyRow = (await db.execute(sql`SELECT body_html, body_text, headers FROM mailapi_messages WHERE id = ${message.id} LIMIT 1`)) as any;
  const row = (Array.isArray(bodyRow) ? bodyRow : bodyRow?.rows || [])[0] || {};

  const extraHeaders: Record<string, string> = (row.headers && typeof row.headers === 'object') ? { ...row.headers } : {};
  if (/data-no-track/.test(String(row.body_html || '')) && trackingConfigured() && message.to[0]) {
    const u = unsubscribeUrl(baseUrl(), message.id, message.to[0]);
    if (u) Object.assign(extraHeaders, listUnsubscribeHeaders(u));
  }

  const rfcId = '<' + message.id + '@' + String(SITE.domain) + '>';

  // ATTACHMENT LINKS GO INTO THE MESSAGE. THEY ARE NOT FETCHED BY US.
  //
  // This used to be `attachments: message.attachments.map(a => ({ filename: a.filename, href: a.url }))`.
  // nodemailer's `href` does not mean "link to this" — it means FETCH THAT URL and embed the
  // response, and neither transport in this repository set `disableUrlAccess`. The URL comes from
  // the body of POST /api/v1/email/send (validate.ts accepts any absolute http(s) address), so any
  // API key holder could name an address inside the deployment's own network — the cloud metadata
  // endpoint, an internal service — and have the response delivered to a mailbox of their choosing.
  // A full-response SSRF with exfiltration by email, on a route documented as never fetching
  // anything.
  //
  // appendLinkAttachments() puts the links in the body instead, where the RECIPIENT's browser
  // fetches them under the recipient's own authority. The server opens no connection at all.
  const withLinks = appendLinkAttachments(String(row.body_html || ''), String(row.body_text || ''), message.attachments);

  const result = await sendExternal({
    from: (message.fromName ? message.fromName + ' ' : '') + '<' + message.from + '>',
    to: message.to,
    cc: message.cc.length ? message.cc : undefined,
    bcc: message.bcc.length ? message.bcc : undefined,
    subject: message.subject,
    html: withLinks.html,
    text: withLinks.text,
    replyTo: message.replyTo || undefined,
    messageId: rfcId,
    // Custom X- headers from the caller, plus List-Unsubscribe when an unsubscribe link was added.
    headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
    // The transactional platform keeps its own event log; a second row per send in email_logs would
    // double every count on /admin/mail/analytics, which reads that table for the webmail side.
    logToDb: false,
  });

  const fresh = (await getMessage(message.id)) || message;

  // ONE MAILBOX, NOT THREE — the delivery half. createMessage() writes the message into the shared
  // store (mail_messages); this puts what actually happened to it onto the shared delivery tables,
  // so /admin/mail shows a real delivery state instead of a message with no outcome recorded.
  // Never throws, never changes the branch taken below. See src/lib/mailplatform/mailapi-bridge.ts.
  const mirrorOutcome = async (status: 'sent' | 'deferred' | 'failed' | 'bounced') => {
    try {
      const { mirrorDeliveryOutcome } = await import('@/lib/mailplatform/mailapi-bridge');
      await mirrorDeliveryOutcome({
        sendJobId: message.id,
        recipients: [...fresh.to, ...fresh.cc, ...fresh.bcc],
        status,
        error: result.ok ? null : result.error || null,
        attemptNo: fresh.attempts + 1,
      });
    } catch (e: any) {
      console.error('[mailapi] delivery mirror failed for', message.id, '-', e?.cause?.message || e?.message);
    }
  };

  if (result.ok) {
    await markAttempt(message.id, { rfcMessageId: result.id || rfcId, nextAttemptAt: null, error: null });
    await recordEvent({ message: fresh, orgSlug, type: 'email.sent', data: { provider: result.provider, rfc_message_id: result.id || rfcId } });
    await mirrorOutcome('sent');
    return { ok: true, status: 'sent', willRetry: false };
  }

  const error = result.error || 'delivery failed';
  const noTransport = result.provider === 'none';
  const transient = !noTransport && isTransientSmtpError(error);
  const attemptsSoFar = fresh.attempts + 1;
  const willRetry = (transient || noTransport) && attemptsSoFar < 5;

  await markAttempt(message.id, {
    nextAttemptAt: willRetry ? new Date(Date.now() + sendBackoffMs(attemptsSoFar - 1)) : null,
    error,
  });

  if (willRetry) {
    await recordEvent({ message: fresh, orgSlug, type: 'email.deferred', data: { error, attempt: attemptsSoFar, retry_in_seconds: Math.round(sendBackoffMs(attemptsSoFar - 1) / 1000) } });
    await mirrorOutcome('deferred');
    return { ok: false, status: 'deferred', error, willRetry: true };
  }

  // A permanent 5xx from the receiving server is a bounce; anything else that has run out of
  // attempts is a failure on our side. The distinction is what the recipient's provider actually
  // said, not how many times we tried.
  const bounced = /\b5\d\d\b/.test(error) || /user unknown|no such user|mailbox unavailable|does not exist|recipient rejected/i.test(error);
  if (bounced) {
    await recordEvent({ message: fresh, orgSlug, type: 'email.bounced', data: { error, bounce_type: 'hard' } });
    for (const r of fresh.to) {
      await suppress({ orgId: fresh.orgId, environment: fresh.environment, email: r, reason: 'bounce', source: 'smtp', detail: error }).catch(() => {});
    }
    await mirrorOutcome('bounced');
    return { ok: false, status: 'bounced', error, willRetry: false };
  }
  await recordEvent({ message: fresh, orgSlug, type: 'email.failed', data: { error } });
  await mirrorOutcome('failed');
  return { ok: false, status: 'failed', error, willRetry: false };
}

/**
 * The whole send: prepare, then deliver unless it is scheduled for later.
 *
 * A scheduled message stops after prepare — the row is queued with its time and the dispatcher picks
 * it up. Delivering it now "because we are here" would defeat the point of asking for a time.
 */
export async function sendNow(auth: AuthContext, body: any, headers: { idempotencyKey?: string | null } = {}): Promise<SendOutcome> {
  const { message, warnings } = await prepareMessage(auth, body, headers);

  if (message.scheduledAt && new Date(message.scheduledAt).getTime() > Date.now() + 5_000) {
    return {
      message,
      warnings,
      response: { ...publicMessage(message), scheduled: true, warnings: warnings.length ? warnings : undefined },
    };
  }

  const outcome = await deliverMessage(message, auth.orgSlug);
  const finalRow = (await getMessage(message.id)) || message;
  if (outcome.status === 'deferred') {
    warnings.push('The first delivery attempt was deferred (' + (outcome.error || 'transient error') + '). It will be retried automatically.');
  }
  if (outcome.status === 'failed' && /no smtp transport/i.test(outcome.error || '')) {
    warnings.push('No SMTP transport is configured on this deployment, so nothing was handed to a mail server. Configure it at /admin/mail/settings.');
  }
  return {
    message: finalRow,
    warnings,
    response: { ...publicMessage(finalRow), warnings: warnings.length ? warnings : undefined },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Drain due messages: scheduled sends that have come due, deferred retries, and anything a dying
 * process left in 'processing'.
 *
 * The deadline is real work, not decoration: a serverless invocation has a wall-clock limit, and a
 * loop that ignores it gets killed halfway through a batch with rows left claimed.
 */
export async function dispatchMessages(limit = 20, deadlineMs = 20_000): Promise<{ claimed: number; sent: number; deferred: number; failed: number }> {
  const started = Date.now();
  const due = await claimDueMessages(limit);
  let sent = 0, deferred = 0, failed = 0;
  const orgSlugs = new Map<string, string>();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');

  for (const m of due) {
    if (Date.now() - started > deadlineMs) {
      await db.execute(sql`UPDATE mailapi_messages SET status = 'queued', claimed_at = NULL WHERE id = ${m.id} AND status = 'processing'`);
      continue;
    }
    let slug = orgSlugs.get(m.orgId);
    if (!slug) {
      const r = (await db.execute(sql`SELECT slug FROM mailapi_orgs WHERE id = ${m.orgId} LIMIT 1`)) as any;
      slug = ((Array.isArray(r) ? r : r?.rows || [])[0]?.slug) || 'unknown';
      orgSlugs.set(m.orgId, slug!);
    }
    try {
      const outcome = await deliverMessage(m, slug!);
      if (outcome.ok) sent++;
      else if (outcome.willRetry) deferred++;
      else failed++;
    } catch (e: any) {
      failed++;
      console.error('[mailapi] dispatch of ' + m.id + ' threw:', e?.cause?.message || e?.message);
      await markAttempt(m.id, { error: String(e?.cause?.message || e?.message || 'dispatch error'), nextAttemptAt: new Date(Date.now() + sendBackoffMs(m.attempts)) });
      await db.execute(sql`UPDATE mailapi_messages SET status = 'deferred' WHERE id = ${m.id} AND status = 'processing'`);
    }
  }
  return { claimed: due.length, sent, deferred, failed };
}

/** A message id in the RFC form we stamp on outgoing mail, for correlating an inbound bounce. */
export function rfcMessageIdFor(messageId: string): string {
  return '<' + messageId + '@' + String(SITE.domain) + '>';
}

export function messageIdFromRfc(rfc: string): string | null {
  const m = /^<?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i.exec(String(rfc || '').trim());
  return m ? m[1] : null;
}

/** Unused today but exported for the SMTP workstream's bounce parser: a stable idempotency seed. */
export function eventDedupKey(messageId: string, type: string, recipient?: string | null): string {
  return crypto.createHash('sha256').update([messageId, type, recipient || ''].join('|')).digest('hex').slice(0, 32);
}
