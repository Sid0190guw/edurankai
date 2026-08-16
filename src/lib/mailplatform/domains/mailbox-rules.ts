// src/lib/mailplatform/domains/mailbox-rules.ts — WHAT A MAILBOX MAY BE CALLED, WHAT STATE IT MAY
// MOVE TO, AND WHEN IT IS ALLOWED TO REPLY BY ITSELF.
//
// Pure. No database.
//
// The auto-reply rules at the bottom are the part worth reading twice. An out-of-office reply is
// the one message a mail system sends without a human deciding to, and every classic mail disaster
// involves one: a vacation responder answering a mailing list, so every member gets it, so the
// list bounces it back, so the responder answers the bounce. The guards here are the ones the
// standards ask for (RFC 3834) plus the ones experience adds, and they are written as a single
// function that returns a REASON, so the reason can be logged when no reply is sent.

export type MailboxStatus = 'active' | 'disabled' | 'suspended' | 'deleted';

/**
 * The lifecycle.
 *
 * DELETED is terminal and it is a SOFT delete: the row keeps its address so that the address cannot
 * be handed to somebody else and start receiving the previous holder's mail. Undeleting is not a
 * transition here — restoring a mailbox is an explicit administrative act with its own audit entry,
 * not a state change somebody can make by accident on a list screen.
 */
export const MAILBOX_TRANSITIONS: Record<MailboxStatus, MailboxStatus[]> = {
  active: ['disabled', 'suspended', 'deleted'],
  disabled: ['active', 'suspended', 'deleted'],
  suspended: ['active', 'disabled', 'deleted'],
  deleted: [],
};

export interface TransitionVerdict {
  ok: boolean;
  reason: string | null;
  /** What actually happens to mail in this state, in a sentence an admin can act on. */
  effect: string;
}

export const STATUS_EFFECT: Record<MailboxStatus, string> = {
  active: 'Mail is delivered normally and the owner can sign in.',
  disabled: 'The owner cannot sign in. Incoming mail is still accepted and stored, so nothing is lost while the mailbox is turned off.',
  suspended: 'Incoming mail is REJECTED at the door and the sender gets a bounce. Use this when an address must stop receiving, not merely stop being read.',
  deleted: 'The mailbox no longer receives mail. Its address stays reserved so it cannot be reissued to somebody else, and stored messages are retained until an administrator purges them.',
};

export function canTransition(from: MailboxStatus, to: MailboxStatus): TransitionVerdict {
  if (from === to) return { ok: false, reason: 'The mailbox is already ' + from + '.', effect: STATUS_EFFECT[to] };
  const allowed = MAILBOX_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: from === 'deleted'
        ? 'A deleted mailbox cannot be changed from this screen. Restoring one is a separate administrative action.'
        : 'A mailbox cannot go from ' + from + ' to ' + to + '.',
      effect: STATUS_EFFECT[to],
    };
  }
  return { ok: true, reason: null, effect: STATUS_EFFECT[to] };
}

/**
 * Addresses every domain that receives mail is expected to answer (RFC 2142).
 *
 * These are not blocked — they are exactly the addresses a customer WANTS. They are flagged so the
 * mailbox screen can point out when `postmaster@` has been left unrouted, which is one of the
 * quieter causes of a domain's mail being treated as unattended.
 */
export const ROLE_ADDRESSES = ['postmaster', 'abuse', 'hostmaster', 'webmaster', 'security'] as const;

/** Local parts we refuse, because delivering them would be actively harmful. */
const REFUSED_LOCAL_PARTS = new Set(['', 'mailer-daemon']);

export interface AddressValidation {
  ok: boolean;
  normalized: string;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a mailbox or alias address.
 *
 * Deliberately narrower than RFC 5321 permits. The RFC allows quoted local parts containing spaces
 * and almost any byte; accepting them means every downstream system — the webmail search index, the
 * SMTP envelope writer, the CSV export a registrar opens in a spreadsheet — has to be right about
 * quoting, and one of them will not be. Refusing them at creation costs a customer nothing real.
 */
export function validateMailboxAddress(address: string, opts: { allowedDomains?: string[] } = {}): AddressValidation {
  const normalized = String(address || '').trim().toLowerCase();
  const errors: string[] = [];
  const warnings: string[] = [];

  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) {
    return { ok: false, normalized, errors: ['"' + address + '" is not a complete email address.'], warnings };
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);

  if (normalized.length > 320) errors.push('The address is longer than the 320-character limit.');
  if (local.length > 64) errors.push('The part before the @ is longer than the 64-character limit.');
  if (REFUSED_LOCAL_PARTS.has(local)) errors.push('"' + local + '" is reserved by the mail system and cannot be a mailbox.');
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) {
    errors.push('The part before the @ may contain letters, digits, and . _ % + - only, and may not start or end with a dot.');
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    errors.push('"' + domain + '" is not a valid domain name.');
  }
  const allowed = (opts.allowedDomains || []).map((d) => String(d).toLowerCase());
  if (allowed.length > 0 && !allowed.includes(domain)) {
    errors.push('"' + domain + '" is not one of this organization\'s verified domains. Add and verify the domain first.');
  }
  if ((ROLE_ADDRESSES as readonly string[]).includes(local)) {
    warnings.push('"' + local + '@" is a role address that other mail systems expect to be answered by a person. Make sure somebody reads it.');
  }
  if (/^(no-?reply|donotreply)$/.test(local)) {
    warnings.push('A no-reply address discards replies from real people. If this is a sending identity, consider pointing Reply-To at a mailbox somebody reads.');
  }

  return { ok: errors.length === 0, normalized, errors, warnings };
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2,
  gb: 1024 ** 3, g: 1024 ** 3, tb: 1024 ** 4, t: 1024 ** 4,
};

/** Parse `5GB`, `500 MB`, `1024`. Returns null for unlimited (empty) and throws on nonsense. */
export function parseQuota(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error('A quota cannot be negative.');
    return Math.round(input);
  }
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'unlimited' || s === 'none') return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) throw new Error('"' + input + '" is not a size. Write it like 5GB or 500MB.');
  const unit = m[2] || 'b';
  if (!(unit in UNITS)) throw new Error('"' + m[2] + '" is not a size unit. Use KB, MB, GB or TB.');
  return Math.round(Number(m[1]) * UNITS[unit]);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unlimited';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

export interface QuotaState {
  used: number;
  quota: number | null;
  percent: number | null;
  level: 'ok' | 'warn' | 'critical' | 'full' | 'unlimited';
  message: string;
}

export function quotaState(usedBytes: number, quotaBytes: number | null): QuotaState {
  const used = Math.max(0, Number(usedBytes) || 0);
  if (quotaBytes === null || quotaBytes === undefined) {
    return { used, quota: null, percent: null, level: 'unlimited', message: formatBytes(used) + ' used. No quota is set.' };
  }
  if (quotaBytes <= 0) {
    return { used, quota: quotaBytes, percent: 100, level: 'full', message: 'The quota is zero, so no mail can be stored.' };
  }
  const percent = Math.min(999, Math.round((used / quotaBytes) * 100));
  const level: QuotaState['level'] = percent >= 100 ? 'full' : percent >= 90 ? 'critical' : percent >= 75 ? 'warn' : 'ok';
  const message =
    level === 'full'
      ? 'The mailbox is full. New mail is being rejected, and the sender gets a bounce.'
      : level === 'critical'
        ? formatBytes(used) + ' of ' + formatBytes(quotaBytes) + ' used. Delivery stops at 100%.'
        : formatBytes(used) + ' of ' + formatBytes(quotaBytes) + ' used.';
  return { used, quota: quotaBytes, percent, level, message };
}

// ---------------------------------------------------------------------------
// Auto-reply / vacation
// ---------------------------------------------------------------------------

export interface AutoReplySettings {
  enabled: boolean;
  subject: string;
  body: string;
  /** Inclusive start; null means "from now". */
  startsAt?: string | null;
  /** Inclusive end; null means "until switched off". */
  endsAt?: string | null;
  /** Reply at most once per sender per this many days. */
  intervalDays?: number;
  /** Reply to senders outside the organization's own domains? Usually yes. */
  replyToExternal?: boolean;
  /** Reply to colleagues? Usually yes; sometimes a team wants internal-only. */
  replyToInternal?: boolean;
}

export interface IncomingSummary {
  from: string;
  to: string[];
  /** Header names lower-cased, values as received. */
  headers: Record<string, string>;
  /** When it arrived. */
  receivedAt: string;
}

export interface AutoReplyDecision {
  send: boolean;
  /** Always populated, including when sending. The reason is what gets logged. */
  reason: string;
}

const NO_REPLY_PATTERNS = [/^no-?reply@/i, /^donotreply@/i, /^bounce/i, /^mailer-daemon@/i, /^postmaster@/i, /^listserv@/i];

/**
 * Decide whether an out-of-office reply may be sent.
 *
 * Ordered by how bad it is to get wrong. The first four guards are the ones that stop a reply
 * storm; the rest stop merely annoying replies.
 *
 * `alreadyRepliedAt` is supplied by the caller from its own record of replies to this sender —
 * the per-sender interval is what prevents a mailing list receiving one reply per message rather
 * than one per interval.
 */
export function shouldAutoReply(
  message: IncomingSummary,
  settings: AutoReplySettings,
  ctx: { now: Date; ownDomains: string[]; ownAddresses: string[]; alreadyRepliedAt?: string | null },
): AutoReplyDecision {
  if (!settings.enabled) return { send: false, reason: 'Auto-reply is switched off.' };

  const h = message.headers || {};
  const get = (name: string): string => {
    const key = Object.keys(h).find((k) => k.toLowerCase() === name);
    return key ? String(h[key] || '') : '';
  };

  // 1. RFC 3834: never reply to something that was itself generated automatically. This single
  //    header is what stops two vacation responders answering each other forever.
  const autoSubmitted = get('auto-submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return { send: false, reason: 'The message carries Auto-Submitted: ' + autoSubmitted + ', so it was generated automatically.' };
  }
  if (get('x-auto-response-suppress')) {
    return { send: false, reason: 'The sender asked for automatic responses to be suppressed.' };
  }
  // 2. Mailing lists. Replying puts an out-of-office notice in front of every subscriber.
  if (get('list-id') || get('list-unsubscribe') || get('list-post')) {
    return { send: false, reason: 'The message came from a mailing list.' };
  }
  const precedence = get('precedence').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) {
    return { send: false, reason: 'The message is marked Precedence: ' + precedence + '.' };
  }
  // 3. A null return-path is a bounce. Answering a bounce is answering nobody, loudly.
  const returnPath = get('return-path').trim();
  if (returnPath === '<>' || returnPath === '') {
    if (returnPath === '<>') return { send: false, reason: 'The message has a null return-path, which marks it as a bounce or other automatic mail.' };
  }
  const from = String(message.from || '').trim().toLowerCase();
  if (!from || !from.includes('@')) return { send: false, reason: 'The message has no usable From address to reply to.' };
  if (NO_REPLY_PATTERNS.some((p) => p.test(from))) {
    return { send: false, reason: 'The sender address "' + from + '" does not accept replies.' };
  }
  // 4. Never reply to ourselves.
  const ownAddrs = (ctx.ownAddresses || []).map((a) => a.toLowerCase());
  if (ownAddrs.includes(from)) return { send: false, reason: 'The message is from this mailbox itself.' };

  // 5. The mailbox must actually be an addressee. Being bcc'd or on a catch-all does not warrant a
  //    reply, and this is what stops a catch-all address auto-replying to every spam run.
  const recipients = (message.to || []).map((t) => t.toLowerCase());
  if (ownAddrs.length > 0 && recipients.length > 0 && !recipients.some((r) => ownAddrs.includes(r))) {
    return { send: false, reason: 'This mailbox is not a visible recipient, so the message was bcc\'d or routed by a catch-all.' };
  }

  // 6. Date window.
  const now = ctx.now.getTime();
  if (settings.startsAt) {
    const start = Date.parse(settings.startsAt);
    if (Number.isFinite(start) && now < start) return { send: false, reason: 'The out-of-office period has not started yet.' };
  }
  if (settings.endsAt) {
    const end = Date.parse(settings.endsAt);
    if (Number.isFinite(end) && now > end) return { send: false, reason: 'The out-of-office period has ended.' };
  }

  // 7. Internal / external scope.
  const senderDomain = from.slice(from.lastIndexOf('@') + 1);
  const internal = (ctx.ownDomains || []).map((d) => d.toLowerCase()).includes(senderDomain);
  if (internal && settings.replyToInternal === false) return { send: false, reason: 'Auto-reply is set to external senders only.' };
  if (!internal && settings.replyToExternal === false) return { send: false, reason: 'Auto-reply is set to internal senders only.' };

  // 8. One per sender per interval.
  const intervalDays = settings.intervalDays ?? 7;
  if (ctx.alreadyRepliedAt) {
    const last = Date.parse(ctx.alreadyRepliedAt);
    if (Number.isFinite(last) && now - last < intervalDays * 86400000) {
      return { send: false, reason: 'This sender already received an auto-reply within the last ' + intervalDays + ' day(s).' };
    }
  }

  return { send: true, reason: 'No suppression rule applies.' };
}

/** Headers an auto-reply MUST carry so that the next system in line does not answer it back. */
export function autoReplyHeaders(): Record<string, string> {
  return {
    'Auto-Submitted': 'auto-replied',
    'X-Auto-Response-Suppress': 'All',
    Precedence: 'auto_reply',
  };
}

/**
 * Append a signature.
 *
 * The `-- ` separator (two hyphens, a space, a newline) is not decoration: mail clients use it to
 * trim signatures when quoting a reply. Without it every reply in a long thread carries a stack of
 * signatures.
 */
export function applySignature(body: string, signature: string | null | undefined, format: 'text' | 'html' = 'text'): string {
  const sig = String(signature || '').trim();
  if (!sig) return body;
  if (format === 'html') {
    return String(body || '') + '<div class="mp-signature" data-signature="1"><hr style="border:none;border-top:1px solid #ddd;margin:16px 0 8px;">' + sig + '</div>';
  }
  return String(body || '').replace(/\s+$/, '') + '\n\n-- \n' + sig + '\n';
}
