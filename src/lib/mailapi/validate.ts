// src/lib/mailapi/validate.ts — everything the send API refuses, decided in pure functions.
//
// VALIDATION LIVES APART FROM SENDING SO IT CAN BE TESTED WITHOUT A DATABASE OR A MAIL SERVER. Every
// rule below is a function that takes a value and returns a decision, which is why the test file can
// assert the recipient cap, the header allowlist and the attachment rule directly instead of standing
// up a fake SMTP server to find out.
//
// ATTACHMENTS ARE LINKS. THIS IS A PLATFORM RULE, NOT AN API LIMITATION. src/lib/mail-links.ts states
// it at length: documents of any kind travel as a shared link, never as an uploaded file, and the only
// stored upload anywhere in this product is a small profile photo. So an `attachments` entry carrying
// base64 `content` is refused with an error that explains the rule rather than being silently dropped
// — a caller whose invoice quietly did not attach would find out from the customer.
import { ApiError } from './errors';

export const LIMITS = {
  /** Bodies are HTML and text; links, not files. A megabyte is generous for that. */
  maxBodyBytes: 1024 * 1024,
  maxRecipients: 50,
  maxSubjectChars: 998, // RFC 5322 line-length ceiling for a header
  maxTags: 10,
  maxTagChars: 50,
  maxMetadataKeys: 30,
  maxMetadataBytes: 8 * 1024,
  maxHeaders: 25,
  maxAttachments: 20,
  maxScheduleDays: 90,
} as const;

// A deliberately ordinary address check: it accepts what mail servers accept and rejects the shapes
// that are certainly wrong. Anything stricter starts rejecting valid addresses, which is worse.
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isEmail(v: unknown): boolean {
  const s = String(v || '').trim();
  return s.length <= 254 && EMAIL_RE.test(s);
}

export interface ParsedAddress { email: string; name: string | null }

/** Accepts `addr@example.com` or `Display Name <addr@example.com>`. */
export function parseAddress(raw: string, param: string): ParsedAddress {
  const s = String(raw || '').trim();
  // Checked before anything else, and named for what it is. A CR or LF anywhere in an address field
  // is header injection: it would let a caller append their own `Bcc:` or a second `Subject:` to the
  // outgoing message. Reporting it as "not a valid email address" would be true and useless.
  if (/[\r\n]/.test(s)) {
    throw new ApiError('invalid_request', 'Addresses cannot contain line breaks.', { param });
  }
  const m = /^(.*?)<\s*([^<>]+)\s*>$/.exec(s);
  const email = (m ? m[2] : s).trim().toLowerCase();
  const name = m ? m[1].trim().replace(/^"|"$/g, '').trim() : '';
  if (!isEmail(email)) {
    throw new ApiError('invalid_request', 'Not a valid email address: ' + s.slice(0, 80), { param });
  }
  // A newline in a display name is header injection: it would let a caller append Bcc: or a second
  // Subject: to the outgoing message.
  if (/[\r\n]/.test(name)) throw new ApiError('invalid_request', 'Display names cannot contain line breaks.', { param });
  return { email, name: name || null };
}

export function toList(value: unknown, param: string): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new ApiError('invalid_request', param + ' must be a string or an array of strings.', { param });
    const s = item.trim();
    if (!s) continue;
    out.push(parseAddress(s, param).email);
  }
  return Array.from(new Set(out));
}

export function assertRecipientCount(to: string[], cc: string[], bcc: string[]): void {
  if (to.length === 0) throw new ApiError('invalid_request', 'At least one `to` recipient is required.', { param: 'to' });
  const total = to.length + cc.length + bcc.length;
  if (total > LIMITS.maxRecipients) {
    throw new ApiError('invalid_request', 'A transactional message may address at most ' + LIMITS.maxRecipients + ' recipients (' + total + ' given). Use one call per recipient, or the campaign tools for bulk mail.', { param: 'to' });
  }
}

export function assertSubject(subject: string): string {
  const s = String(subject || '');
  if (!s.trim()) throw new ApiError('invalid_request', 'A subject is required (a template subject counts).', { param: 'subject' });
  if (/[\r\n]/.test(s)) throw new ApiError('invalid_request', 'The subject cannot contain line breaks.', { param: 'subject' });
  if (s.length > LIMITS.maxSubjectChars) {
    throw new ApiError('invalid_request', 'The subject is longer than ' + LIMITS.maxSubjectChars + ' characters.', { param: 'subject' });
  }
  return s.trim();
}

export function assertTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ApiError('invalid_request', '`tags` must be an array of strings.', { param: 'tags' });
  if (value.length > LIMITS.maxTags) throw new ApiError('invalid_request', 'At most ' + LIMITS.maxTags + ' tags.', { param: 'tags' });
  return value.map((t) => {
    const s = String(t || '').trim();
    if (!s) throw new ApiError('invalid_request', 'Tags cannot be empty.', { param: 'tags' });
    if (s.length > LIMITS.maxTagChars) throw new ApiError('invalid_request', 'A tag may be at most ' + LIMITS.maxTagChars + ' characters.', { param: 'tags' });
    if (!/^[a-zA-Z0-9_.:@\/-]+$/.test(s)) throw new ApiError('invalid_request', 'Tags may contain letters, digits and _ . : @ / - only.', { param: 'tags' });
    return s;
  });
}

export function assertMetadata(value: unknown): Record<string, any> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('invalid_request', '`metadata` must be an object.', { param: 'metadata' });
  }
  const keys = Object.keys(value as object);
  if (keys.length > LIMITS.maxMetadataKeys) {
    throw new ApiError('invalid_request', '`metadata` may have at most ' + LIMITS.maxMetadataKeys + ' keys.', { param: 'metadata' });
  }
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > LIMITS.maxMetadataBytes) {
    throw new ApiError('invalid_request', '`metadata` is larger than ' + LIMITS.maxMetadataBytes + ' bytes.', { param: 'metadata' });
  }
  return value as Record<string, any>;
}

/**
 * Custom headers.
 *
 * Only `X-`-prefixed names and a short allowlist get through. Everything else — From, To, Bcc,
 * Subject, Content-Type, Return-Path, the DKIM headers — is ours to set, and letting a caller
 * override one is either an injection or a way to break a signature we just produced.
 */
const HEADER_ALLOWLIST = new Set(['references', 'in-reply-to', 'importance', 'x-priority', 'auto-submitted']);

export function assertHeaders(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('invalid_request', '`headers` must be an object.', { param: 'headers' });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > LIMITS.maxHeaders) {
    throw new ApiError('invalid_request', 'At most ' + LIMITS.maxHeaders + ' custom headers.', { param: 'headers' });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const name = String(k || '').trim();
    const val = String(v ?? '');
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new ApiError('invalid_request', 'Header names may contain letters, digits and dashes only.', { param: 'headers' });
    }
    if (!/^x-/i.test(name) && !HEADER_ALLOWLIST.has(name.toLowerCase())) {
      throw new ApiError('invalid_request', 'Header `' + name + '` is set by the platform. Custom headers must start with `X-`.', { param: 'headers' });
    }
    if (/[\r\n]/.test(val)) {
      throw new ApiError('invalid_request', 'Header values cannot contain line breaks.', { param: 'headers' });
    }
    if (val.length > 998) throw new ApiError('invalid_request', 'Header `' + name + '` is too long.', { param: 'headers' });
    out[name] = val;
  }
  return out;
}

export interface LinkAttachmentInput { filename?: string; url: string }

/**
 * Attachments must be links. Base64 content is refused with the reason, not ignored.
 */
export function assertAttachments(value: unknown): LinkAttachmentInput[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ApiError('invalid_request', '`attachments` must be an array.', { param: 'attachments' });
  if (value.length > LIMITS.maxAttachments) {
    throw new ApiError('invalid_request', 'At most ' + LIMITS.maxAttachments + ' attachments.', { param: 'attachments' });
  }
  return value.map((a: any, i) => {
    const param = 'attachments[' + i + ']';
    if (!a || typeof a !== 'object') throw new ApiError('invalid_request', 'Each attachment must be an object with a `url`.', { param });
    if (a.content != null || a.path != null || a.data != null) {
      throw new ApiError('attachment_not_a_link',
        'EduRankAI Mail does not accept uploaded file content. Attachments are shared links: give `url` (set to anyone-with-the-link access) and an optional `filename`. Nothing is uploaded or copied.',
        { param });
    }
    const url = String(a.url || '').trim();
    if (!url) throw new ApiError('invalid_request', 'Each attachment needs a `url`.', { param });
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ApiError('invalid_request', 'Attachment `url` must be an absolute URL.', { param }); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ApiError('invalid_request', 'Attachment `url` must be http or https.', { param });
    }
    const filename = a.filename != null ? String(a.filename).slice(0, 200) : undefined;
    if (filename && /[\r\n]/.test(filename)) throw new ApiError('invalid_request', 'Attachment filenames cannot contain line breaks.', { param });
    return { filename, url: parsed.toString() };
  });
}

/** A schedule time must be in the future and inside a horizon we can actually hold. */
export function assertScheduledAt(value: unknown, nowMs = Date.now()): Date | null {
  if (value == null || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw new ApiError('invalid_request', '`scheduled_at` must be an ISO 8601 timestamp.', { param: 'scheduled_at' });
  }
  // A few seconds of clock skew between the caller and us should not be an error.
  if (d.getTime() < nowMs - 60_000) {
    throw new ApiError('invalid_request', '`scheduled_at` is in the past.', { param: 'scheduled_at' });
  }
  if (d.getTime() > nowMs + LIMITS.maxScheduleDays * 86400_000) {
    throw new ApiError('invalid_request', '`scheduled_at` may be at most ' + LIMITS.maxScheduleDays + ' days ahead.', { param: 'scheduled_at' });
  }
  return d;
}

export interface NormalizedSend {
  from: ParsedAddress | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
  templateRef: string | null;
  templateVersion: number | null;
  variables: Record<string, any>;
  attachments: LinkAttachmentInput[];
  metadata: Record<string, any>;
  tags: string[];
  headers: Record<string, string>;
  idempotencyKey: string | null;
  scheduledAt: Date | null;
  options: {
    allowDraft: boolean;
    trackOpens: boolean;
    trackClicks: boolean;
    includeUnsubscribe: boolean;
    skipSuppression: boolean;
  };
}

/**
 * Normalize a POST /v1/email/send body.
 *
 * Both `variables` and `template_variables` are accepted because the specification uses both names;
 * silently honouring only one of them would produce a mail full of unresolved placeholders for
 * whoever picked the other. Both present and disagreeing is an error rather than a coin toss.
 */
export function normalizeSendRequest(body: any, headers: { idempotencyKey?: string | null } = {}, nowMs = Date.now()): NormalizedSend {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('invalid_request', 'The request body must be a JSON object.');
  }

  const to = toList(body.to, 'to');
  const cc = toList(body.cc, 'cc');
  const bcc = toList(body.bcc, 'bcc');
  assertRecipientCount(to, cc, bcc);

  const from = body.from ? parseAddress(String(body.from), 'from') : null;
  const replyTo = body.reply_to ? parseAddress(String(body.reply_to), 'reply_to').email : null;

  const templateRef = body.template_id != null && String(body.template_id).trim()
    ? String(body.template_id).trim()
    : (body.template != null && String(body.template).trim() ? String(body.template).trim() : null);

  const hasInline = (body.html != null && String(body.html).trim()) || (body.text != null && String(body.text).trim());
  if (!templateRef && !hasInline) {
    throw new ApiError('invalid_request', 'Provide either `template_id` or an inline `html`/`text` body.', { param: 'template_id' });
  }
  if (templateRef && hasInline) {
    throw new ApiError('invalid_request', 'Provide `template_id` or an inline body, not both — otherwise it is unclear which one was sent.', { param: 'template_id' });
  }

  let templateVersion: number | null = null;
  if (body.template_version != null && body.template_version !== '') {
    const v = Number(body.template_version);
    if (!Number.isInteger(v) || v < 1) throw new ApiError('invalid_request', '`template_version` must be a positive integer.', { param: 'template_version' });
    templateVersion = v;
  }

  const varsA = body.variables;
  const varsB = body.template_variables;
  if (varsA != null && varsB != null && JSON.stringify(varsA) !== JSON.stringify(varsB)) {
    throw new ApiError('invalid_request', '`variables` and `template_variables` are two names for the same field and they disagree. Send one.', { param: 'variables' });
  }
  const variablesRaw = varsA != null ? varsA : varsB;
  if (variablesRaw != null && (typeof variablesRaw !== 'object' || Array.isArray(variablesRaw))) {
    throw new ApiError('invalid_request', '`variables` must be an object.', { param: 'variables' });
  }

  const subject = body.subject != null && String(body.subject).trim() ? assertSubject(String(body.subject)) : null;
  if (!templateRef && !subject) {
    throw new ApiError('invalid_request', 'An inline message needs a `subject`.', { param: 'subject' });
  }

  const opts = (body.options && typeof body.options === 'object' && !Array.isArray(body.options)) ? body.options : {};
  const idempotencyKey = (headers.idempotencyKey && String(headers.idempotencyKey).trim())
    || (body.idempotency_key != null && String(body.idempotency_key).trim() ? String(body.idempotency_key).trim() : null)
    || null;

  return {
    from,
    to, cc, bcc,
    replyTo,
    subject,
    html: body.html != null && String(body.html).trim() ? String(body.html) : null,
    text: body.text != null && String(body.text).trim() ? String(body.text) : null,
    templateRef,
    templateVersion,
    variables: (variablesRaw as Record<string, any>) || {},
    attachments: assertAttachments(body.attachments),
    metadata: assertMetadata(body.metadata),
    tags: assertTags(body.tags),
    headers: assertHeaders(body.headers),
    idempotencyKey,
    scheduledAt: assertScheduledAt(body.scheduled_at, nowMs),
    options: {
      allowDraft: opts.allow_draft === true,
      trackOpens: opts.track_opens === true,
      trackClicks: opts.track_clicks === true,
      includeUnsubscribe: opts.include_unsubscribe === true,
      skipSuppression: opts.skip_suppression === true,
    },
  };
}
