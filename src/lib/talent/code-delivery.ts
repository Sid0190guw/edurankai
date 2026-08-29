// Sending an ERA-SEL onboarding code to the person it was issued to.
//
// ---------------------------------------------------------------------------------------------
// WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
// ---------------------------------------------------------------------------------------------
// src/lib/talent/codes.ts:858 said, in its own words, "This product has no delivery pipeline for
// onboarding codes, so there is no receipt to record and nothing here claims one." That is now
// false, and this file is the pipeline — but the sentence it replaces was making a point worth
// keeping, so the point is kept:
//
//   * markCodeDelivered() still means "an operator says they sent it". Sending by phone, in person
//     or by post remains a first-class route; DELIVERY_CHANNELS lists five and email is one of them.
//     A send from here records channel 'email' through that same function, so the register answers
//     one question with one column rather than two that can disagree.
//   * A FAILED send is recorded as a failure (markCodeDeliveryFailed) and reported to the operator
//     with the code still on screen. It is never swallowed, and it never leaves a "sent" tick behind.
//   * The plaintext code is NEVER logged, never put in an audit diff, and never written to
//     delivery_error. It reaches this module, goes into the message body, and is dropped.
//
// WHY THE SEND IS BEST-EFFORT AND THE ISSUE IS NOT. issueCode() has already committed by the time
// we get here, and it revoked the previous code in the same act. Throwing now would leave the
// candidate with a freshly minted code that the operator never saw and cannot recover. So every
// failure below returns a reason, and the caller shows the code anyway.
import { sendEmail } from '@/lib/email';
import { markCodeDelivered, markCodeDeliveryFailed } from '@/lib/talent/codes';
import { composeCodeEmail, type CodeMessageContext } from '@/lib/talent/code-message';

export interface SendCodeArgs {
  /** tal_onboarding_code.id of the code just issued. */
  codeRowId: string;
  /** The operator's composed body, still holding {{tokens}} and still unsanitised. */
  bodyHtml: string;
  /** Everything the message names, including the plaintext code. */
  context: CodeMessageContext;
}

export interface SendCodeResult {
  /** True only when the transport accepted the message. */
  sent: boolean;
  /** Shown to the operator. Safe: transport reasons only, never the code. */
  message: string;
  /** What the sanitiser stripped out of the operator's markup, so they are told. */
  removed: { kind: string; name: string; reason: string }[];
  /** True when the register could not be updated even though the mail went out. */
  registerStale?: boolean;
}

/**
 * Compose, sanitise, send, and record the outcome.
 *
 * Never throws. The caller is a page that has already minted a credential; an exception here would
 * lose the one screen on which the plaintext code is visible.
 */
export async function sendCodeByEmail(args: SendCodeArgs): Promise<SendCodeResult> {
  const to = String(args.context.boundEmail || '').trim();
  if (!to) {
    return { sent: false, message: 'The selection has no email address on it, so nothing was sent.', removed: [] };
  }

  let composed;
  try {
    composed = composeCodeEmail(args.bodyHtml, args.context);
  } catch (e: any) {
    // A sanitiser or template failure must not be reported as a mail failure — the operator would
    // retry the send, which is the one action that cannot help.
    return {
      sent: false,
      removed: [],
      message: 'The message could not be prepared, so nothing was sent. ' + reasonText(e),
    };
  }

  let r: { ok: boolean; error?: string };
  try {
    r = await sendEmail({ to, subject: composed.subject, html: composed.html, text: composed.text });
  } catch (e: any) {
    // sendEmail returns rather than throws for an SMTP refusal, so reaching here means the transport
    // itself broke. Treated the same way: recorded, reported, code still shown.
    r = { ok: false, error: reasonText(e) };
  }

  if (!r.ok) {
    const why = r.error || 'The mail server did not accept the message.';
    // Best-effort: if the register write also fails there is nothing further to try, and the
    // operator has the reason on screen either way.
    try { await markCodeDeliveryFailed(args.codeRowId, why); } catch (_) { /* reported below anyway */ }
    return {
      sent: false,
      removed: composed.removed,
      message: 'The code was issued but the email was not sent: ' + why
        + ' The code is shown below - send it by hand and mark it as sent.',
    };
  }

  let registerStale = false;
  try {
    const m = await markCodeDelivered(args.codeRowId, 'email');
    if (!m.ok) registerStale = true;
  } catch (_) {
    registerStale = true;
  }

  return {
    sent: true,
    removed: composed.removed,
    registerStale,
    message: registerStale
      // Said plainly rather than smoothed over: the candidate has the message, but the register does
      // not know it, and the register is what the next operator will trust.
      ? 'The email was sent to ' + to + ', but the register could not be updated. Mark it as sent by hand.'
      : 'The email was sent to ' + to + '.',
  };
}

/** The real Postgres/transport reason lives on e.cause on this project; e.message is the failed SQL. */
function reasonText(e: any): string {
  return String(e?.cause?.message || e?.message || 'Unknown error').slice(0, 300);
}
