// SENDING AN HR LETTER TO THE PERSON IT IS ABOUT.
//
// =================================================================================================
// WHAT WAS ACTUALLY MISSING
// =================================================================================================
//
// Three letter surfaces existed and none of them could send anything:
//
//   /admin/hr/recommendation          LOR, To Whom It May Concern, internship completion
//   /admin/hr/offboarding             relieving letter, experience letter, NOC
//   /admin/applications/[id]/offer-letter
//
// The first two are composed entirely in the browser and end at `ERA.PDF.print()`. The third
// generates a real record — offer_letters, with a token, a reference number and an integrity hash —
// moves the application to "offer", pushes a notification, and then says so about itself in its own
// comment: "this file sends no email either. The candidate learned about their offer only if an
// admin told them by hand."
//
// So a letter was a thing you looked at. Getting it to the person was a separate, manual, unrecorded
// act, and the one document a candidate most needs in writing was the one the system would not send.
//
// =================================================================================================
// THE SHAPE IS THE ONE THE ONBOARDING-CODE DESK ALREADY USES
// =================================================================================================
//
// src/lib/talent/code-delivery.ts and src/lib/talent/code-message.ts send the ERA-SEL onboarding
// code: the operator composes a message, the server sanitises the markup, tokens are substituted
// after sanitising, the send is best-effort but never silent, and the outcome is written to the
// audit log. That pattern is deliberate and it is reused here rather than reinvented — one house
// style for "a person at a desk sends a person a document", not three.
//
// WHAT IS DIFFERENT, AND WHY. The code desk composes a body from a template. A LETTER IS ALREADY
// RENDERED — it is on the screen, laid out, with its reference number and its signature block — and
// the whole point of the artefact is that the thing sent is the thing that was reviewed. So the
// letter markup travels from the preview to this module and is sanitised, rather than being built a
// second time from the same fields by different code. Two renderers for one legal document is how
// the emailed copy and the printed copy come to disagree, and the disagreement is only ever found by
// the person holding both.
//
// =================================================================================================
// LINKS, NOT ATTACHMENTS
// =================================================================================================
//
// Nothing here attaches a file, and that is a house rule with teeth behind it: sendExternal() sets
// `disableFileAccess` and `disableUrlAccess` on the transport, and src/lib/mail-transport.ts states
// the reasoning in its send-budget note — "the house rule is links, not attachments, so there are no
// large payloads to push". A letter is therefore sent as the message body itself, and where a
// canonical copy exists on the site (the offer letter has one, at its token URL) the message links
// to it. The recipient's own mail client makes the PDF if they want one.
import { sendEmail, brandedEmail } from '@/lib/email';
import { sanitizeEmailHtml, htmlToPlainText, OUTBOUND } from '@/lib/mailsec/html';
import { logAudit } from '@/lib/audit';

/** Which desk the letter comes from. Only these three; a fourth needs a decision, not a string. */
export type LetterFamily = 'offer' | 'offboarding' | 'recommendation';

export interface LetterType {
  /** `family:subtype`, which is what a form submits and what the audit line records. */
  key: string;
  family: LetterFamily;
  /** What the operator picked, in their words. Goes in the subject line. */
  label: string;
  /** The heading inside the branded wrapper — never the letter's own title, which is in the letter. */
  heading: string;
  /** The one-line preview mail clients show beside the subject. */
  preheader: string;
}

/**
 * EVERY TYPE THE THREE SURFACES CAN PRODUCE, named the same way they name themselves on screen.
 *
 * The keys are not free text. A page submits one of these and this module refuses anything else —
 * an unknown key would otherwise become a subject line reading "Your undefined from EduRankAI",
 * which is the sort of thing that reaches a candidate before it reaches a test.
 */
export const LETTER_TYPES: Readonly<Record<string, LetterType>> = Object.freeze({
  'offer:offer': {
    key: 'offer:offer', family: 'offer',
    label: 'Offer Letter', heading: 'Your offer letter',
    preheader: 'Your offer letter from EduRankAI.',
  },
  'recommendation:recommendation': {
    key: 'recommendation:recommendation', family: 'recommendation',
    label: 'Letter of Recommendation', heading: 'Your letter of recommendation',
    preheader: 'Your letter of recommendation from EduRankAI.',
  },
  'recommendation:twmic': {
    key: 'recommendation:twmic', family: 'recommendation',
    label: 'To Whom It May Concern', heading: 'Your letter',
    preheader: 'A letter confirming your engagement with EduRankAI.',
  },
  'recommendation:completion': {
    key: 'recommendation:completion', family: 'recommendation',
    label: 'Internship Completion Certificate', heading: 'Your completion certificate',
    preheader: 'Your internship completion certificate from EduRankAI.',
  },
  'offboarding:relieving': {
    key: 'offboarding:relieving', family: 'offboarding',
    label: 'Relieving Letter', heading: 'Your relieving letter',
    preheader: 'Your relieving letter from EduRankAI.',
  },
  'offboarding:experience': {
    key: 'offboarding:experience', family: 'offboarding',
    label: 'Experience Letter', heading: 'Your experience letter',
    preheader: 'Your experience letter from EduRankAI.',
  },
  'offboarding:noc': {
    key: 'offboarding:noc', family: 'offboarding',
    label: 'No-Objection Certificate', heading: 'Your no-objection certificate',
    preheader: 'Your no-objection certificate from EduRankAI.',
  },
});

/** Everything a letter email may name. Every field optional except who it is going to. */
export interface LetterContext {
  recipientName: string;
  recipientEmail: string;
  roleTitle?: string;
  department?: string;
  refNumber?: string;
  issueDate?: string;
  signatoryName?: string;
  signatoryTitle?: string;
  /**
   * The canonical copy on the site, when there is one. The offer letter has a token URL; the two HR
   * letters do not, and pass nothing. NEVER a file: see the header.
   */
  letterUrl?: string;
}

/** What an operator may put in their own message. Shown as insert buttons on the composer. */
export const LETTER_TOKENS: ReadonlyArray<{ token: string; means: string }> = Object.freeze([
  { token: '{{name}}', means: 'the recipient’s name' },
  { token: '{{role}}', means: 'the role title on the letter' },
  { token: '{{ref}}', means: 'the letter’s reference number' },
  { token: '{{date}}', means: 'the issue date printed on the letter' },
  { token: '{{signatory}}', means: 'who signed it' },
]);

/**
 * The cap on the rendered letter.
 *
 * A letter is one page. Two hundred kilobytes of markup is already far more than one, and the
 * ceiling exists because this body is posted from a browser: a page that has been left open, edited
 * by an extension, or simply looped by a bug must not be able to hand the SMTP transport a payload
 * it will spend its whole twenty-second budget pushing. The sanitiser has its own 500k truncation;
 * this refuses BEFORE that, so the operator is told rather than sent a silently truncated letter.
 */
export const MAX_LETTER_HTML = 200_000;

/** The cap on the operator's own message. Long enough for a real note, short enough to be one. */
export const MAX_NOTE_HTML = 20_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Is this something we can actually send to? Returns the reason it is not, or null. */
export function recipientProblem(email: unknown): string | null {
  const e = String(email ?? '').trim();
  if (!e) return 'No email address was given, so nothing was sent.';
  if (e.length > 254) return 'That email address is too long to be a real one, so nothing was sent.';
  if (!EMAIL_RE.test(e)) return 'That does not look like an email address, so nothing was sent.';
  return null;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Substitute the operator's tokens.
 *
 * ESCAPED ON THE WAY IN. Every value here comes off a form — a name, a role title someone typed —
 * and lands inside markup we are about to send under our own domain's signature. A name containing
 * an angle bracket must arrive as an angle bracket, not as the start of a tag the sanitiser has
 * already finished inspecting.
 */
export function fillLetterTokens(html: string, ctx: LetterContext): string {
  return String(html ?? '')
    .replace(/\{\{name\}\}/g, esc(ctx.recipientName))
    .replace(/\{\{role\}\}/g, esc(ctx.roleTitle || ''))
    .replace(/\{\{ref\}\}/g, esc(ctx.refNumber || ''))
    .replace(/\{\{date\}\}/g, esc(ctx.issueDate || ''))
    .replace(/\{\{signatory\}\}/g, esc(ctx.signatoryName || ''));
}

export interface ComposedLetter {
  subject: string;
  html: string;
  text: string;
  /** What the sanitiser took out of either part, so the operator is told rather than surprised. */
  removed: { kind: string; name: string; reason: string }[];
}

export interface ComposeLetterInput {
  /** A key of LETTER_TYPES. Anything else is refused. */
  typeKey: string;
  ctx: LetterContext;
  /** The operator's covering message, still holding {{tokens}} and still unsanitised. */
  noteHtml?: string;
  /** The letter exactly as the preview rendered it, unsanitised. Omitted when only a link is sent. */
  letterHtml?: string;
}

/**
 * Turn a letter and a covering note into the message we actually send.
 *
 * ORDER MATTERS AND IS THE SAME ORDER src/lib/talent/code-message.ts USES: sanitise first, then
 * substitute. Doing it the other way round would let a token carry markup in through a value the
 * sanitiser had already finished with — and the sanitiser reports what it removed, so a report can
 * end up quoting a field back onto a screen.
 *
 * PURE. It touches no database and sends nothing, so a test can put a hostile letter body through it
 * without a transport, which is the whole reason the send below is a separate function.
 */
export function composeLetterEmail(input: ComposeLetterInput): ComposedLetter {
  const type = LETTER_TYPES[input.typeKey];
  if (!type) throw new Error('Unknown letter type: ' + String(input.typeKey));

  const removed: { kind: string; name: string; reason: string }[] = [];

  let noteBlock = '';
  if (input.noteHtml && input.noteHtml.trim()) {
    const cleanNote = sanitizeEmailHtml(input.noteHtml, OUTBOUND);
    removed.push(...cleanNote.removed.map((r) => ({ kind: r.kind, name: r.name, reason: r.reason })));
    noteBlock = fillLetterTokens(cleanNote.html, input.ctx);
  }

  let letterBlock = '';
  if (input.letterHtml && input.letterHtml.trim()) {
    const cleanLetter = sanitizeEmailHtml(input.letterHtml, OUTBOUND);
    removed.push(...cleanLetter.removed.map((r) => ({ kind: r.kind, name: r.name, reason: r.reason })));
    // NOT token-substituted. The letter is already rendered — every field on it was filled by the
    // page before the operator read it — so running the substitution over it could only change a
    // document that has already been reviewed, which is the one thing a letter must never do.
    letterBlock =
      '<div style="margin-top:22px;padding:18px;background:#fdfcf8;border:1px solid rgba(0,0,0,0.08);border-radius:10px;">'
      + cleanLetter.html + '</div>';
  }

  // A DEFAULT NOTE RATHER THAN AN EMPTY ONE. A letter arriving with no sentence in front of it reads
  // like an automated dispatch, and this is the least automated thing the company sends.
  if (!noteBlock) {
    noteBlock = '<p>Dear ' + esc(input.ctx.recipientName || 'colleague') + ',</p>'
      + '<p>Please find your ' + esc(type.label.toLowerCase()) + ' below'
      + (input.ctx.refNumber ? ' (reference ' + esc(input.ctx.refNumber) + ')' : '') + '.</p>';
  }

  const subject = type.label
    + (input.ctx.roleTitle ? ' — ' + input.ctx.roleTitle : '')
    + ' — EduRankAI';

  const body = noteBlock + letterBlock;

  const html = brandedEmail({
    preheader: type.preheader,
    heading: type.heading,
    body,
    ctaText: input.ctx.letterUrl ? 'Open the signed copy' : undefined,
    ctaUrl: input.ctx.letterUrl || undefined,
    // THE POSITIONING SENTENCE, on every letter this company sends. EduRankAI is the technology
    // platform; accredited partners award credentials. A letter is exactly the artefact somebody
    // later reads as a claim about what we are, so the claim is made correctly on it.
    footerNote:
      'Sent by the EduRankAI people desk'
      + (input.ctx.signatoryName ? ' on behalf of ' + esc(input.ctx.signatoryName) : '')
      + '. EduRankAI is the technology platform; accredited partners award credentials. '
      + 'If anything on this letter is wrong, reply to this email and we will correct it.',
  });

  return {
    subject,
    // Derived from the SAME body, so the two parts of the message can never disagree about what the
    // letter said.
    text: htmlToPlainText(body),
    html,
    removed,
  };
}

export interface SendLetterInput extends ComposeLetterInput {
  /** Who pressed the button. Recorded; never shown to the recipient. */
  actorUserId: string | null;
}

export interface SendLetterResult {
  sent: boolean;
  /** Shown to the operator, in their words. Safe: transport reasons only. */
  message: string;
  /** What the sanitiser stripped, so the operator can put it back or accept it. */
  removed: { kind: string; name: string; reason: string }[];
  /** True when the mail went out but the audit line did not. Said plainly rather than smoothed over. */
  auditStale?: boolean;
}

/**
 * Compose, sanitise, send, and record the outcome.
 *
 * NEVER THROWS. Every caller is a page that has already produced a letter and, in the offer case,
 * already committed a record and moved the application's stage. An exception here would report a
 * failure for work that had already happened, which is the failure mode this codebase keeps having
 * to undo — so every path returns a sentence instead.
 */
export async function sendLetterEmail(input: SendLetterInput): Promise<SendLetterResult> {
  const type = LETTER_TYPES[input.typeKey];
  if (!type) {
    return { sent: false, removed: [], message: 'That letter type is not one this desk can send, so nothing was sent.' };
  }

  const to = String(input.ctx.recipientEmail || '').trim();
  const bad = recipientProblem(to);
  if (bad) return { sent: false, removed: [], message: bad };

  if ((input.letterHtml || '').length > MAX_LETTER_HTML) {
    return {
      sent: false, removed: [],
      message: 'That letter is larger than a letter should be (' + Math.round((input.letterHtml || '').length / 1024)
        + ' KB), so nothing was sent. Reload the page and try again.',
    };
  }
  if ((input.noteHtml || '').length > MAX_NOTE_HTML) {
    return { sent: false, removed: [], message: 'That covering message is too long to send. Shorten it and try again.' };
  }

  let composed: ComposedLetter;
  try {
    composed = composeLetterEmail(input);
  } catch (e: any) {
    // A sanitiser or template failure must not be reported as a mail failure — the operator would
    // press send again, which is the one action that cannot help.
    return {
      sent: false, removed: [],
      message: 'The message could not be prepared, so nothing was sent. ' + reasonText(e),
    };
  }

  let r: { ok: boolean; error?: string };
  try {
    r = await sendEmail({ to, subject: composed.subject, html: composed.html, text: composed.text, replyTo: 'hr@edurankai.in' });
  } catch (e: any) {
    // sendEmail returns rather than throws for an SMTP refusal, so reaching here means the transport
    // itself broke. Treated the same way: recorded, reported, letter still on screen.
    r = { ok: false, error: reasonText(e) };
  }

  // RECORDED EITHER WAY, because "we sent it" and "we tried and could not" are both facts somebody
  // needs later — a leaver chasing a relieving letter is the exact conversation this answers.
  let auditStale = false;
  try {
    const a = await logAudit({
      userId: input.actorUserId,
      action: r.ok ? 'hr.letter.emailed' : 'hr.letter.email_failed',
      entity: 'hr_letter',
      entityId: input.ctx.refNumber || undefined,
      diff: {
        type: type.key,
        to,
        role: input.ctx.roleTitle || '',
        sent: r.ok,
        // The reason only. The letter body is never written to the audit log: it is the person's
        // own document and the log is read by more people than the letter is.
        note: r.ok ? '' : String(r.error || '').slice(0, 300),
      },
    });
    if (!a.ok) auditStale = true;
  } catch (_) {
    auditStale = true;
  }

  if (!r.ok) {
    const why = r.error || 'The mail server did not accept the message.';
    return {
      sent: false,
      removed: composed.removed,
      message: 'The letter was NOT sent: ' + why + ' It is still on screen — save it as a PDF and send it by hand.',
    };
  }

  return {
    sent: true,
    removed: composed.removed,
    auditStale,
    message: auditStale
      ? 'The letter was emailed to ' + to + ', but the audit record could not be written. Note it by hand.'
      : 'The letter was emailed to ' + to + '.',
  };
}

/** The real Postgres/SMTP reason lives on e.cause; e.message is often only the failed statement. */
function reasonText(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error').slice(0, 300);
}
