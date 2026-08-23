// src/lib/wellness-routing.ts — making a counselling request reach a person, without letting anybody
// read what that person wrote.
//
// =================================================================================================
// WHAT THIS WAS WRITTEN FOR
// =================================================================================================
//
// /aquintutor/campus/wellness once answered three crisis buttons with a toast. "Connecting - 24/7
// crisis line - please hold." No call was placed. That was found and removed earlier, and the
// replacement told the truth about what the page cannot do — except for one clause, which said the
// counselling request below
//
//     "reaches the counselling team as a real request, not a message into the void."
//
// It was a message into the void. Measured, not assumed:
//
//   - /api/aquintutor/wellness/counselling exposes POST and nothing else. There is no GET.
//   - Nothing in the codebase SELECTs the notes, the contact, or the display name. Nothing.
//   - The one admin surface that touches the table, /aquintutor/admin/index.astro line 169, reads
//     id, status and created_at — deliberately identity-free, while the queries on either side of it
//     select name and email for partnership and placement enquiries. That restraint was correct and
//     is kept.
//   - Nothing notified anybody.
//
// So a person could mark a request urgent, write two thousand characters about what was wrong, be
// told "pending", and be read by nobody, ever. The privacy was airtight and the service did not
// exist. Of the two failures on that page this is the quieter one, and it is not the smaller one:
// that sentence is read by somebody deciding whether to ask for help at all.
//
// =================================================================================================
// WHY THE NOTES ARE NOT IN THE NOTIFICATION
// =================================================================================================
//
// The obvious fix — mail the request to an administrator — is the screen this project forbids.
// CLAUDE.md: "No admin, and not the founder, may see one person's cycle, symptoms or consult
// messages", and "if you find yourself writing a query that returns a row per user on an admin
// surface, that is the screen that must not exist." A counselling disclosure is that data. Putting
// it in an email would put it in an inbox, in a backup, and in a forwarded thread, permanently.
//
// So the notification carries the FACT of a request and nothing of its content: urgency, language,
// preferred slot, and the contact the person chose to give. A counsellor then reaches out and hears
// it from the person directly, which is how they would want to tell it anyway.
//
// `notes` never leaves the database. `display_name` is not sent either — `contact` is what a
// responder needs, and it is the one field somebody fills in knowing it will be used to reach them.
//
// The SUBJECT carries less still. sendExternal writes to, from and subject into `email_logs`, which
// is readable on the admin mail screens — so a subject naming the person would leak into precisely
// the place this is trying to avoid. The subject is urgency and nothing else.
//
// =================================================================================================
// WHEN NOBODY IS CONFIGURED, THE PAGE SAYS SO
// =================================================================================================
//
// WELLNESS_COUNSELLOR_EMAIL is a policy decision — who the counsellor IS — and this file does not
// invent one. Unset is a legitimate state, and it is handled by telling the truth rather than by
// falling back to an administrator.
//
// The request is still WRITTEN when nobody is configured: the row is the evidence that somebody
// asked, and it can be worked the day a responder exists. What changes is what the person is told.
// `monitored: false` comes back and the page stops claiming a team.
//
// That is the whole point. The bug being fixed here is a promise the software could not keep, and a
// fallback that quietly mailed the founder instead would be another one.
import { sendExternal } from '@/lib/mail-transport';
import { intakeRecipient, envValue } from '@/lib/intake-routing';

export interface CounsellingNotice {
  urgency: string;
  language: string;
  /** The contact the person supplied. Not the display name, and never the notes. */
  contact: string;
  preferredSlot?: string | null;
  anonymous: boolean;
}

/**
 * Who responds. Unset is legitimate and means nobody is monitoring — see the header.
 *
 * Delegated to the intake registry rather than reading the variable here, so that this address and
 * the one /admin/deployment-check reports cannot disagree about whether anybody is listening.
 */
export function counsellingRecipient(): string | null {
  return intakeRecipient('counselling');
}

/** Whether the page may tell somebody their request will be read. */
export function isCounsellingMonitored(): boolean {
  return counsellingRecipient() !== null;
}

/**
 * What the page is allowed to say after a successful write.
 *
 * Returned to the browser rather than hard-coded in the page, so the promise and the configuration
 * cannot drift apart. A copy edit alone can no longer make this untrue.
 */
export function counsellingPromise(monitored = isCounsellingMonitored()): string {
  return monitored
    ? 'Your request has been sent to the counselling team, and they will use the contact you gave to reach you. What you wrote in the message is stored for them and is not shown on any staff dashboard.'
    : 'Your request is saved. You should know that no counsellor is monitoring this form at the moment, so nobody may read it today. If you need to speak to someone now, contact your local emergency number or someone physically near you. We would rather tell you this than let you wait for an answer that is not coming.';
}

/** The body a responder receives. Exported so a test can assert what is NOT in it. */
export function noticeBody(n: CounsellingNotice): string {
  const slot = n.preferredSlot ? String(n.preferredSlot) : 'none given';
  return [
    'A counselling request was submitted through the Wellness Quarter.',
    '',
    'Urgency: ' + n.urgency,
    'Language: ' + n.language,
    'Preferred slot: ' + slot,
    'Reach them at: ' + n.contact,
    n.anonymous ? 'They asked to remain anonymous, so no name was recorded.' : '',
    '',
    'What they wrote is deliberately not in this email, and it is not on any dashboard either.',
    'Ask them directly. They will tell you, and it stays theirs to tell.',
  ].filter(Boolean).join('\n');
}

/**
 * Tell the counsellor a request exists.
 *
 * Never throws. The row is already written by the time this runs, and a failed notification must not
 * turn into a lost request.
 */
export async function notifyCounselling(n: CounsellingNotice): Promise<{ notified: boolean; reason?: string }> {
  const to = counsellingRecipient();
  if (!to) return { notified: false, reason: 'no recipient configured' };
  const body = noticeBody(n);
  try {
    const r = await sendExternal({
      from: envValue('EMAIL_FROM') || 'AquinTutor Wellness <connect@edurankai.in>',
      to,
      // Identity-free: this string is written to email_logs.
      subject: n.urgency === 'urgent'
        ? 'Wellness Quarter - URGENT counselling request'
        : 'Wellness Quarter - counselling request',
      html: '<pre style="font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap;">'
        + body.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>',
      text: body,
    });
    return r.ok ? { notified: true } : { notified: false, reason: r.error || 'send failed' };
  } catch (e: any) {
    // The reason, never the payload: an error string from this path could carry the contact.
    console.error('[wellness-routing] could not notify counsellor:', e?.cause?.message || e?.message);
    return { notified: false, reason: 'send failed' };
  }
}
