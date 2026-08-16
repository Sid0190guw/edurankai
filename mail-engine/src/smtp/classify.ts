// mail-engine/src/smtp/classify.ts — reading what the far end said, and deciding what it means.
//
// THE THREE-LINE VERSION OF SMTP: 2xx is success, 4xx means try again later, 5xx means never. That
// much is RFC 5321 and it is the outer decision made here. Everything below it exists because the
// outer decision is not enough to run a sending reputation on: "550 5.1.1 user unknown" and
// "550 5.7.1 message rejected as spam" are both permanent, but the first means take this address off
// every list forever and the second means the mail we are sending is the problem, not the address.
//
// ORDER OF EVIDENCE, most trustworthy first:
//   1. The enhanced status code (RFC 3463) — a machine-readable answer the server chose to give.
//   2. The numeric reply code — coarse, but never wrong about temporary versus permanent.
//   3. The English text — a guess, and treated as one. Only ever used to make the class MORE
//      specific, never to overturn 4xx/5xx.
//
// A NOTE ON WHY THE TEXT HEURISTICS ARE HERE AT ALL. Plenty of large providers answer with a bare
// "550 5.0.0" plus prose, or with an enhanced code that says 5.7.1 for both "you are blocked" and
// "that mailbox is disabled". Without the text pass those all collapse into `hard`, and a hard
// bounce suppresses the address permanently — which is a real harm to a real person when the actual
// cause was our own sending reputation for one afternoon.

import type { BounceClass, SuppressionEntry } from '../contracts/index.js';

export interface Classification {
  outcome: 'delivered' | 'deferred' | 'bounced';
  bounceClass: BounceClass | null;
  enhancedCode: string | null;
  /** Which layer decided. Recorded on the event so a wrong classification is traceable. */
  basis: 'enhanced' | 'code' | 'text' | 'network';
}

/** Pull an RFC 3463 code out of a reply. Real servers put it after the numeric code. */
export function parseEnhancedCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Pull the leading three-digit reply code out of a raw response line. */
export function parseReplyCode(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^\s*(\d{3})\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 200 && n <= 599 ? n : null;
}

const TEXT_RULES: { re: RegExp; cls: BounceClass; permanentOnly?: boolean; temporaryOnly?: boolean }[] = [
  // Over quota. Temporary at 4.2.2, permanent at 5.2.2 — the class is the same either way, and the
  // permanence is taken from the reply code, not from here.
  { re: /\b(over ?quota|quota exceeded|mailbox (is )?full|insufficient (system )?storage|not enough storage)\b/i, cls: 'mailbox_full' },
  // No such person.
  { re: /\b(no such (user|mailbox|recipient|address)|user unknown|unknown user|recipient (address )?(rejected|not found|unknown)|mailbox unavailable|does ?n[o']?t exist|invalid (recipient|mailbox|address)|address (rejected|unknown)|user (is )?(unknown|disabled|suspended|terminated)|account (has been )?(disabled|deactivated|closed))\b/i, cls: 'invalid_mailbox' },
  // No such domain / nowhere to route it.
  { re: /\b(domain (not found|does ?n[o']?t exist|is not (hosted|valid))|unrouteable address|unrouteable domain|no route to host for domain|host or domain name not found|nxdomain)\b/i, cls: 'invalid_domain' },
  // We are being told to slow down. Checked BEFORE the policy rule: many servers phrase throttling
  // as a 4.7.x policy response, and treating that as a policy block would be the wrong lesson.
  { re: /\b(too many (messages|connections|recipients|emails)|rate ?limit|throttl|slow down|try again later|temporarily deferred|deferred due to (user|volume)|connection (rate )?limit|exceeded the maximum|sending quota|maximum number of connections)\b/i, cls: 'rate_limited' },
  // Content or reputation rejection.
  { re: /\b(spam|spamhaus|blacklist|blocklist|block ?list|rbl|dnsbl|bulk mail|message (content )?rejected|considered (unsolicited|spam)|reputation|poor reputation|listed (on|by|in)|blocked using|virus|malware|phishing)\b/i, cls: 'spam_rejection' },
  // Message too large / MIME refused.
  { re: /\b(message (size|too (big|large))|exceeds (size|maximum message size)|size limit exceeded|line (length )?(limit|too long))\b/i, cls: 'content_rejection' },
  // Policy: relaying, authentication, sender not allowed.
  { re: /\b(relay(ing)? (access )?denied|not permitted to relay|access denied|authentication required|sender (address )?(rejected|not allowed|verification failed)|spf (check )?fail|dmarc|not authori[sz]ed|policy (violation|rejection|reasons)|client host rejected)\b/i, cls: 'policy_rejection' },
  // Greylisting is explicitly temporary and explicitly not our fault.
  { re: /\b(greylist|grey ?listed|graylist)\b/i, cls: 'temporary_rejection', temporaryOnly: true },
];

/** Enhanced-code table. Only the codes whose meaning is unambiguous appear here. */
const ENHANCED_RULES: Record<string, BounceClass> = {
  '4.2.2': 'mailbox_full',
  '5.2.2': 'mailbox_full',
  '4.2.1': 'temporary_rejection',
  '5.1.1': 'invalid_mailbox',
  '5.1.6': 'invalid_mailbox',
  '5.1.10': 'invalid_mailbox',
  '5.1.2': 'invalid_domain',
  '4.1.2': 'invalid_domain',
  '5.2.0': 'hard',
  '5.3.4': 'content_rejection',
  '5.2.3': 'content_rejection',
  '4.3.1': 'temporary_rejection',
  '4.4.1': 'connection_failure',
  '4.4.2': 'connection_failure',
  '4.7.0': 'rate_limited',
  '4.7.1': 'policy_rejection',
  '4.7.26': 'policy_rejection',
  '5.7.0': 'policy_rejection',
  '5.7.1': 'policy_rejection',
  '5.7.23': 'policy_rejection',   // SPF failure
  '5.7.26': 'policy_rejection',   // DMARC failure
  '5.7.509': 'policy_rejection',
};

/**
 * Classify one SMTP reply.
 * `code` may be null when only the raw line is available — it is then read out of the text.
 */
export function classifySmtpReply(code: number | null, text: string | null): Classification {
  const raw = (text || '').trim();
  const replyCode = code ?? parseReplyCode(raw);
  const enhanced = parseEnhancedCode(raw);

  if (replyCode != null && replyCode >= 200 && replyCode < 300) {
    return { outcome: 'delivered', bounceClass: null, enhancedCode: enhanced, basis: 'code' };
  }

  // Permanence comes from the reply code first, and from the enhanced code only when there is no
  // reply code. A 4xx line that happens to quote "5.1.1" in prose is still a deferral.
  const permanent =
    replyCode != null ? replyCode >= 500 : enhanced != null ? enhanced.startsWith('5') : false;
  const outcome: 'deferred' | 'bounced' = permanent ? 'bounced' : 'deferred';

  // 1. Enhanced code.
  if (enhanced && ENHANCED_RULES[enhanced]) {
    const cls = ENHANCED_RULES[enhanced];
    // The text can still sharpen a generic policy verdict into "you are being throttled" or
    // "we think this is spam", both of which are handled differently downstream.
    const refined = refineFromText(raw, cls, permanent);
    return { outcome, bounceClass: refined, enhancedCode: enhanced, basis: refined === cls ? 'enhanced' : 'text' };
  }

  // 2. Text.
  const fromText = matchText(raw, permanent);
  if (fromText) return { outcome, bounceClass: fromText, enhancedCode: enhanced, basis: 'text' };

  // 3. Reply code alone. 421 is "service not available, closing channel" — in practice, throttling.
  if (replyCode === 421) return { outcome: 'deferred', bounceClass: 'rate_limited', enhancedCode: enhanced, basis: 'code' };
  if (replyCode === 450 || replyCode === 451 || replyCode === 452) {
    return { outcome: 'deferred', bounceClass: replyCode === 452 ? 'mailbox_full' : 'temporary_rejection', enhancedCode: enhanced, basis: 'code' };
  }
  if (replyCode === 550 || replyCode === 551 || replyCode === 553) {
    return { outcome: 'bounced', bounceClass: 'invalid_mailbox', enhancedCode: enhanced, basis: 'code' };
  }
  if (replyCode === 552) return { outcome: 'bounced', bounceClass: 'mailbox_full', enhancedCode: enhanced, basis: 'code' };
  if (replyCode === 554 || replyCode === 521) return { outcome: 'bounced', bounceClass: 'policy_rejection', enhancedCode: enhanced, basis: 'code' };

  return {
    outcome,
    bounceClass: permanent ? 'hard' : 'soft',
    enhancedCode: enhanced,
    basis: 'code',
  };
}

function matchText(raw: string, permanent: boolean): BounceClass | null {
  for (const rule of TEXT_RULES) {
    if (rule.temporaryOnly && permanent) continue;
    if (rule.permanentOnly && !permanent) continue;
    if (rule.re.test(raw)) return rule.cls;
  }
  return null;
}

/**
 * Let the text narrow a generic verdict. It may only replace `hard`, `soft` or `policy_rejection` —
 * a server that took the trouble to say 5.1.1 is not going to be second-guessed by a keyword.
 */
function refineFromText(raw: string, cls: BounceClass, permanent: boolean): BounceClass {
  if (cls !== 'hard' && cls !== 'soft' && cls !== 'policy_rejection') return cls;
  const t = matchText(raw, permanent);
  if (!t) return cls;
  if (cls === 'policy_rejection' && (t === 'rate_limited' || t === 'spam_rejection' || t === 'invalid_mailbox')) return t;
  if (cls === 'hard' || cls === 'soft') return t;
  return cls;
}

/** Node/OpenSSL error codes that mean "we never got to talk to them". */
const NETWORK_TEMPORARY = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|ESERVFAIL|ETIMEOUT|ECONNABORTED|EADDRNOTAVAIL|ENOBUFS)$/i;

/**
 * Classify a failure that happened below SMTP: DNS, TCP, TLS.
 *
 * ENOTFOUND IS THE ONE PERMANENT ONE, and only for a domain lookup: NXDOMAIN is the DNS system
 * saying this name does not exist, which no amount of retrying fixes and which is exactly the
 * "invalid domain" bounce class the brief asks for. A SERVFAIL or a timeout is the opposite — the
 * answer is unknown, so it is temporary.
 */
export function classifyNetworkError(err: unknown): Classification {
  const e = err as { code?: string; message?: string; command?: string } | null;
  const code = String(e?.code || '').toUpperCase();
  const msg = String(e?.message || '');

  if (code === 'ENOTFOUND' || /nxdomain|no mx (record|host)s? found|domain does not exist/i.test(msg)) {
    return { outcome: 'bounced', bounceClass: 'invalid_domain', enhancedCode: '5.1.2', basis: 'network' };
  }
  if (NETWORK_TEMPORARY.test(code) || /timeout|timed out|socket close|connection closed|network/i.test(msg)) {
    return { outcome: 'deferred', bounceClass: 'connection_failure', enhancedCode: '4.4.1', basis: 'network' };
  }
  if (/certificate|self.signed|tls|ssl|wrong version number|unable to verify/i.test(msg) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) {
    // A broken TLS handshake is deferred, not bounced. Certificates get renewed, and a permanent
    // failure here would silently stop mail to a whole domain over a one-day expiry.
    return { outcome: 'deferred', bounceClass: 'connection_failure', enhancedCode: '4.7.0', basis: 'network' };
  }
  // An SMTP-level error surfaced as an exception (nodemailer puts responseCode on it).
  const responseCode = (err as { responseCode?: number } | null)?.responseCode;
  const response = (err as { response?: string } | null)?.response;
  if (responseCode || response) return classifySmtpReply(responseCode ?? null, response ?? msg);

  return { outcome: 'deferred', bounceClass: 'connection_failure', enhancedCode: null, basis: 'network' };
}

/** Suppression classes and how long they last. Temporary entries expire on their own. */
const SUPPRESSION_RULES: Partial<Record<BounceClass, { permanent: boolean; ttlMs?: number }>> = {
  invalid_mailbox: { permanent: true },
  invalid_domain: { permanent: true },
  hard: { permanent: true },
  mailbox_full: { permanent: false, ttlMs: 7 * 24 * 60 * 60 * 1000 },
  spam_rejection: { permanent: false, ttlMs: 24 * 60 * 60 * 1000 },
  rate_limited: { permanent: false, ttlMs: 60 * 60 * 1000 },
  policy_rejection: { permanent: false, ttlMs: 24 * 60 * 60 * 1000 },
};

/**
 * Should this outcome put the recipient on the suppression list, and for how long?
 *
 * DELIBERATELY NOT SUPPRESSING ON A DEFERRAL. A 4xx is the receiving server asking for patience; the
 * retry engine already provides it. Suppressing there would turn one bad hour at a large provider
 * into a list of addresses this platform refuses to mail. Only a permanent outcome — or a message
 * that exhausted its retries entirely, which the caller signals with `exhausted` — creates an entry.
 */
export function suppressionFor(
  recipient: string,
  cls: BounceClass | null,
  outcome: 'delivered' | 'deferred' | 'bounced',
  eventId: string,
  detail: string | null,
  now = Date.now(),
  exhausted = false,
): SuppressionEntry | null {
  if (outcome === 'delivered') return null;
  if (outcome === 'deferred' && !exhausted) return null;
  if (!cls) return null;

  const rule = SUPPRESSION_RULES[cls];
  if (!rule) {
    if (!exhausted) return null;
    // Ran out of retries with nothing conclusive: a short cool-off, not a permanent block.
    return {
      recipient: recipient.toLowerCase(),
      reason: cls,
      permanent: false,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(now).toISOString(),
      lastEventId: eventId,
      detail,
    };
  }
  return {
    recipient: recipient.toLowerCase(),
    reason: cls,
    permanent: rule.permanent,
    expiresAt: rule.permanent ? null : new Date(now + (rule.ttlMs || 24 * 60 * 60 * 1000)).toISOString(),
    createdAt: new Date(now).toISOString(),
    lastEventId: eventId,
    detail,
  };
}
