// The message that carries an ERA-SEL onboarding code to the person it was issued to.
//
// ---------------------------------------------------------------------------------------------
// WHY THE CODE IS A PLACEHOLDER AND NOT A STRING THE OPERATOR HOLDS
// ---------------------------------------------------------------------------------------------
// issueCode() is the only place an ERA-SEL secret exists in plaintext, and it exists only as the
// return value of that one call (src/lib/talent/codes.ts:516 — the table stores sha256 and nothing
// else). So a "compose the message, then send it" flow has exactly two possible shapes:
//
//   1. issue, render the secret into the page, and have the browser post it BACK to send it, or
//   2. compose FIRST with a placeholder where the code goes, and substitute after issuing.
//
// This module is shape 2. Shape 1 puts a live single-use authorization secret into a form body and
// a server log's request line for no gain — the operator is composing a message they have not sent
// yet, so there is nothing they need the real code for while they type. `{{code}}` is substituted
// server-side, inside the same handler that minted it, on the way to the transport.
//
// THE OPERATOR CAN DELETE THE PLACEHOLDER. That is a mistake we can detect and refuse before
// sending (missingTokens below), rather than silently posting a selection letter with no code in it.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL
// ---------------------------------------------------------------------------------------------
// The share message was written out twice, byte for byte, in src/pages/admin/talent/codes.astro and
// src/pages/admin/talent/selected.astro. Adding a composer to both would have made three copies of
// one sentence about how somebody is let into onboarding. There is now one.
import { sanitizeEmailHtml, htmlToPlainText, OUTBOUND } from '@/lib/mailsec/html';
import { brandedEmail } from '@/lib/email';

/** Everything the message can name. Assembled by the page that issued the code. */
export interface CodeMessageContext {
  /** The candidate's name, as the operator typed it. May be empty. */
  personName: string;
  /** The address the code is BOUND to. Never operator-supplied — read from tal_person. */
  boundEmail: string;
  /** The posting, if the selection names one. */
  opportunityTitle: string;
  /** Display date the code stops working. */
  validUntil: string;
  /** Public origin, for the gateway URL. */
  origin: string;
  /** The plaintext secret. ONLY ever passed at the moment of sending. */
  code?: string;
}

/**
 * The tokens an operator may leave in the body. Substituted server-side, once, at send time.
 *
 * Deliberately double-brace and lower-case: a candidate's name or a job title containing a single
 * brace is ordinary, and a substitution that could fire on ordinary text is a substitution that
 * eventually rewrites somebody's message.
 */
export const MESSAGE_TOKENS = [
  '{{code}}',
  '{{name}}',
  '{{email}}',
  '{{expires}}',
  '{{opportunity}}',
  '{{gateway_url}}',
] as const;

/** What each token is for, shown beside the composer so the operator does not have to guess. */
export const TOKEN_HELP: ReadonlyArray<{ token: string; means: string }> = [
  { token: '{{code}}', means: 'the authorization code itself' },
  { token: '{{name}}', means: 'the name on the selection' },
  { token: '{{email}}', means: 'the address the code is bound to' },
  { token: '{{expires}}', means: 'the date it stops working' },
  { token: '{{opportunity}}', means: 'the posting, if the selection names one' },
  { token: '{{gateway_url}}', means: 'the page they enter it on' },
];

/** The one token a selection letter is useless without. */
export const REQUIRED_TOKENS = ['{{code}}'] as const;

export function gatewayUrl(origin: string): string {
  return String(origin || '').replace(/\/+$/, '') + '/apply/gateway';
}

/** Escape for insertion into HTML. Values here are operator- and candidate-supplied. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The default body, as HTML, for the composer to open with.
 *
 * NOT a blank box. An empty composer on a screen that has just issued a single-use credential is an
 * invitation to write something shorter than the situation needs — the sentence about not forwarding
 * it, and the one naming the bound address, are the two that stop the most support tickets.
 */
export function defaultMessageHtml(ctx: CodeMessageContext): string {
  const forRole = ctx.opportunityTitle ? ' for {{opportunity}}' : '';
  return [
    '<p>Dear {{name}},</p>',
    '<p>You have been selected' + forRole + '. Your onboarding authorization code is:</p>',
    '<p><strong>{{code}}</strong></p>',
    '<p>To use it, open <a href="{{gateway_url}}">{{gateway_url}}</a>, choose '
      + '&ldquo;I have an authorization code&rdquo;, and enter the code together with this email '
      + 'address: <strong>{{email}}</strong>.</p>',
    '<p>The code can be used once and it expires on {{expires}}. Please do not forward it to anyone, '
      + 'and do not send it in the same message as any other document.</p>',
    '<p>EduRankAI People Operations</p>',
  ].join('\n');
}

/**
 * The plain-text share block, for an operator who is sending the message by hand.
 *
 * This is the text that used to be built inline on both admin pages. Kept because sending by hand is
 * still a supported route — a code may go by phone or in person, and DELIVERY_CHANNELS says so.
 */
export function defaultMessageText(ctx: CodeMessageContext): string {
  return [
    'Dear ' + (ctx.personName || 'candidate') + ',',
    '',
    'You have been selected' + (ctx.opportunityTitle ? ' for ' + ctx.opportunityTitle : '')
      + '. Your onboarding authorization code is:',
    '',
    ctx.code || '',
    '',
    'To use it, go to ' + gatewayUrl(ctx.origin) + ' , choose "I have an authorization code", and enter',
    'the code together with this email address: ' + ctx.boundEmail,
    '',
    'The code can be used once and it expires on ' + ctx.validUntil + '. Please do not forward it to anyone,',
    'and do not send it in the same message as any other document.',
    '',
    'EduRankAI People Operations',
  ].join('\n');
}

/**
 * Which required tokens the operator removed.
 *
 * Called BEFORE issuing, so a message with no {{code}} in it costs nothing to reject. Rejecting
 * after issuing would burn a code — issueCode revokes the previous one in the same act, so a
 * refusal at that point leaves the candidate with no working code at all.
 */
export function missingTokens(bodyHtml: string): string[] {
  const s = String(bodyHtml || '');
  return REQUIRED_TOKENS.filter((t) => !s.includes(t));
}

/**
 * Substitute the tokens. HTML-escaped, because every value here is a name, a title or an address
 * that somebody typed, and this result goes into an HTML mail body.
 */
export function fillTokens(bodyHtml: string, ctx: CodeMessageContext): string {
  const url = gatewayUrl(ctx.origin);
  return String(bodyHtml || '')
    // {{gateway_url}} first: it is the only token whose value legitimately appears inside an href,
    // and doing it before the others keeps a name containing the literal text from being rewritten.
    .split('{{gateway_url}}').join(esc(url))
    .split('{{code}}').join(esc(ctx.code || ''))
    .split('{{name}}').join(esc(ctx.personName || 'candidate'))
    .split('{{email}}').join(esc(ctx.boundEmail || ''))
    .split('{{expires}}').join(esc(ctx.validUntil || ''))
    .split('{{opportunity}}').join(esc(ctx.opportunityTitle || ''));
}

export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
  /** What the sanitiser took out, so the operator is told rather than surprised. */
  removed: { kind: string; name: string; reason: string }[];
}

/**
 * Turn the operator's composed body into the message we actually send.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY: sanitise the operator's markup FIRST, then substitute. Doing
 * it the other way round would run the sanitiser over a document containing the live code, and the
 * sanitiser reports what it removed — which is a report that could quote the secret back into a
 * screen, a log, or an error. Substituting after sanitising also means a token cannot be smuggled
 * in through markup the sanitiser would have deleted.
 */
export function composeCodeEmail(bodyHtml: string, ctx: CodeMessageContext): ComposedEmail {
  const clean = sanitizeEmailHtml(bodyHtml, OUTBOUND);
  const filled = fillTokens(clean.html, ctx);

  const subject = ctx.opportunityTitle
    ? 'Your onboarding code for ' + ctx.opportunityTitle
    : 'Your onboarding code';

  const html = brandedEmail({
    preheader: 'Your onboarding authorization code.',
    heading: 'Onboarding authorization',
    body: filled,
    footerNote:
      'This code is personal to you and is bound to this email address. It can be used once. '
      + 'EduRankAI is the technology platform; accredited partners award credentials. If you were '
      + 'not expecting this, please tell us rather than using it.',
  });

  return {
    subject,
    // The text/plain part is derived from the SAME filled body, so the two parts of the message can
    // never disagree about what the code is.
    text: htmlToPlainText(filled),
    html,
    removed: clean.removed.map((r) => ({ kind: r.kind, name: r.name, reason: r.reason })),
  };
}
