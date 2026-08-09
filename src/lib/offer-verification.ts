// src/lib/offer-verification.ts — who is checking an offer letter, and on which path.
//
// Scanning the QR gives an instant authenticity check. Beyond that there are two routes, and the
// difference is deliberate:
//
//   free   an individual, or an educational institution checking a student's claim. Verifying a
//          person's own credential should never cost them or their university money.
//   paid   a firm or organisation doing commercial due diligence. 5 CHF, charged in INR at the
//          live rate, which also functions as a light abuse gate: a fee makes bulk scraping of
//          "does this person work there" pointless.
//
// BOTH PATHS CAPTURE IDENTITY. That is the real product here, not the fee — knowing WHO asked about
// a candidate, and why, is what makes this a verification record rather than an anonymous lookup.
// The candidate's data is not the thing being sold; the assurance is.
//
// WHAT IS NEVER EXPOSED. A verification confirms that a letter is authentic and states the role,
// name and dates. It does not return salary, personal contact details, home address or the
// application file. A verifier is entitled to confirm what they were told, not to acquire a dossier.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type VerifierKind = 'individual' | 'institution' | 'firm';
export type RequestStatus = 'pending_payment' | 'open' | 'answered' | 'rejected';

/** The commercial path fee, in CHF. Converted to INR at the live rate at checkout. */
export const FIRM_VERIFICATION_FEE_CHF = 5;

export function isFreePath(kind: VerifierKind): boolean {
  // Individuals and educational institutions are never charged.
  return kind === 'individual' || kind === 'institution';
}

export interface VerificationRequest {
  id: string;
  token: string;
  kind: VerifierKind;
  status: RequestStatus;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string | null;
  organisation: string | null;
  designation: string | null;
  orgWebsite: string | null;
  purpose: string | null;
  feeChf: number;
  paid: boolean;
  createdAt: string;
  answeredAt: string | null;
  responseNote: string | null;
}

export function ensureVerificationSchema(): Promise<void> {
  return ensureOnce('offer_verification_requests_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS offer_verification_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_phone TEXT,
      organisation TEXT,
      designation TEXT,
      org_website TEXT,
      purpose TEXT,
      fee_chf NUMERIC(8,2) NOT NULL DEFAULT 0,
      paid BOOLEAN NOT NULL DEFAULT false,
      razorpay_order_id TEXT,
      ip TEXT,
      user_agent TEXT,
      response_note TEXT,
      answered_by UUID,
      answered_at TIMESTAMPTZ,
      answer_delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Added after the table shipped, so existing deployments need the column too.
    await db.execute(sql`ALTER TABLE offer_verification_requests ADD COLUMN IF NOT EXISTS answer_delivered_at TIMESTAMPTZ`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS offer_verif_token_idx ON offer_verification_requests (token, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS offer_verif_status_idx ON offer_verification_requests (status, created_at DESC)`);
  });
}

const map = (r: any): VerificationRequest => ({
  id: r.id, token: r.token, kind: r.kind, status: r.status,
  requesterName: r.requester_name, requesterEmail: r.requester_email,
  requesterPhone: r.requester_phone, organisation: r.organisation,
  designation: r.designation, orgWebsite: r.org_website, purpose: r.purpose,
  feeChf: Number(r.fee_chf) || 0, paid: !!r.paid,
  createdAt: String(r.created_at), answeredAt: r.answered_at ? String(r.answered_at) : null,
  responseNote: r.response_note,
});

export interface CreateInput {
  token: string;
  kind: VerifierKind;
  requesterName: string;
  requesterEmail: string;
  requesterPhone?: string;
  organisation?: string;
  designation?: string;
  orgWebsite?: string;
  purpose?: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Record a verification request.
 *
 * A firm's request starts at 'pending_payment' and is NOT answerable until the fee is captured —
 * the status is what gates the response, so a request cannot be satisfied by simply abandoning
 * checkout. Free paths open immediately.
 */
export async function createRequest(input: CreateInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const name = (input.requesterName || '').trim();
  const email = (input.requesterEmail || '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'Please give your name.' };
  if (!/.+@.+\..+/.test(email)) return { ok: false, error: 'Please give a valid email address.' };
  // A firm must say which firm — an unnamed "organisation" defeats the point of recording who asked.
  if (input.kind === 'firm' && !(input.organisation || '').trim()) {
    return { ok: false, error: 'Please give your organisation name.' };
  }
  if (input.kind === 'institution' && !(input.organisation || '').trim()) {
    return { ok: false, error: 'Please give your institution name.' };
  }

  const free = isFreePath(input.kind);
  try {
    await ensureVerificationSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO offer_verification_requests
        (token, kind, status, requester_name, requester_email, requester_phone,
         organisation, designation, org_website, purpose, fee_chf, paid, ip, user_agent)
      VALUES (${input.token}, ${input.kind}, ${free ? 'open' : 'pending_payment'},
              ${name}, ${email}, ${(input.requesterPhone || '').trim() || null},
              ${(input.organisation || '').trim() || null}, ${(input.designation || '').trim() || null},
              ${(input.orgWebsite || '').trim() || null}, ${(input.purpose || '').trim().slice(0, 600) || null},
              ${free ? 0 : FIRM_VERIFICATION_FEE_CHF}, ${free},
              ${input.ip || null}, ${(input.userAgent || '').slice(0, 300) || null})
      RETURNING id`))[0];
    return { ok: true, id: r?.id };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not record the request.' };
  }
}

/**
 * Attach the gateway order to the request before checkout opens.
 *
 * Recorded up front so confirmation can be matched back to the request that was actually paid for.
 * Without it, a confirmation would have to trust a request id supplied by the browser, and anyone
 * could point a real payment at someone else's request — or at a request they never paid for.
 */
export async function setOrderId(id: string, orderId: string): Promise<void> {
  await ensureVerificationSchema();
  await db.execute(sql`UPDATE offer_verification_requests SET razorpay_order_id = ${orderId} WHERE id = ${id}`);
}

/** The request a gateway order belongs to. The authority on what a payment was for. */
export async function findByOrderId(orderId: string): Promise<VerificationRequest | null> {
  try {
    await ensureVerificationSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM offer_verification_requests WHERE razorpay_order_id = ${orderId} LIMIT 1`))[0];
    return r ? map(r) : null;
  } catch { return null; }
}

/** One request by id, for the checkout page. */
export async function getRequest(id: string): Promise<VerificationRequest | null> {
  try {
    await ensureVerificationSchema();
    const r = rows(await db.execute(sql`SELECT * FROM offer_verification_requests WHERE id = ${id} LIMIT 1`))[0];
    return r ? map(r) : null;
  } catch { return null; }
}

/** Mark a firm request paid once the gateway confirms. Idempotent. */
export async function markPaid(id: string, orderId?: string): Promise<void> {
  try {
    await ensureVerificationSchema();
    await db.execute(sql`
      UPDATE offer_verification_requests
      SET paid = true, status = 'open', razorpay_order_id = COALESCE(${orderId || null}, razorpay_order_id)
      WHERE id = ${id} AND paid = false`);
  } catch { /* the webhook may retry; never throw back at the gateway */ }
}

/**
 * Email the answer to whoever asked.
 *
 * Deliberately conservative about what it discloses: it confirms the letter and repeats the note
 * the reviewer wrote, and nothing else. A verification entitles someone to confirm what they were
 * told — not to receive salary, contact details or the application file. The same rule the module
 * header states, enforced at the point the data actually leaves the building.
 */
export async function deliverAnswer(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureVerificationSchema();
    const r = rows(await db.execute(sql`
      SELECT requester_name, requester_email, organisation, kind, response_note, token
        FROM offer_verification_requests WHERE id = ${id} LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'No such request.' };
    if (!r.requester_email) return { ok: false, error: 'No email on the request.' };

    const { sendExternal } = await import('@/lib/mail-transport');
    const note = String(r.response_note || '').trim();
    const safe = (s: string) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]);

    const html = `
      <p>Dear ${safe(r.requester_name)},</p>
      <p>We have completed the offer-letter verification you requested${r.organisation ? ' on behalf of ' + safe(r.organisation) : ''}.</p>
      <blockquote style="margin:16px 0;padding:12px 16px;background:#faf6ef;border-left:3px solid #c2410c;">${safe(note).replace(/\n/g, '<br>')}</blockquote>
      <p style="color:#5c5349;font-size:13px;">This response confirms the authenticity of the letter presented to you and its stated role and dates. It does not include compensation, personal contact details or any part of the candidate's application.</p>
      <p style="color:#5c5349;font-size:13px;">Reference ${safe(String(r.token).slice(0, 10))}.</p>
      <p>EduRankAI</p>`;

    const res = await sendExternal({
      from: 'EduRankAI Verification <hr@edurankai.in>',
      to: r.requester_email,
      subject: 'Offer letter verification — reference ' + String(r.token).slice(0, 10),
      html,
      text: `Dear ${r.requester_name},\n\nWe have completed the offer-letter verification you requested.\n\n${note}\n\nThis response confirms the authenticity of the letter and its stated role and dates only.\n\nReference ${String(r.token).slice(0, 10)}.\n\nEduRankAI`,
    });

    if (!(res as any)?.ok) return { ok: false, error: (res as any)?.error || 'Mail transport refused the message.' };
    await db.execute(sql`UPDATE offer_verification_requests SET answer_delivered_at = NOW() WHERE id = ${id}`).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    console.error('[offer-verification/deliverAnswer]', e?.cause?.message || e?.message);
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not send the answer.' };
  }
}

export async function listRequests(status?: RequestStatus): Promise<VerificationRequest[]> {
  try {
    await ensureVerificationSchema();
    const r = status
      ? await db.execute(sql`SELECT * FROM offer_verification_requests WHERE status = ${status} ORDER BY created_at DESC LIMIT 300`)
      : await db.execute(sql`SELECT * FROM offer_verification_requests ORDER BY created_at DESC LIMIT 300`);
    return rows(r).map(map);
  } catch { return []; }
}

/**
 * Answer a request. Refuses while a firm's fee is outstanding.
 *
 * IT REPORTS WHETHER THE ANSWER ACTUALLY LEFT THE BUILDING. The delivery call sat behind
 * `.catch(() => {})` with a comment saying delivery "is reported separately" — and it was not
 * reported anywhere: this returned `{ ok: true }` whatever the mail transport said, and
 * /admin/offer-verifications printed "Response recorded." So a firm that had paid could be moved
 * into the Answered column having received nothing, and the only person who could have chased it
 * was told it had gone.
 */
export async function answerRequest(id: string, byUserId: string, note: string): Promise<{ ok: boolean; error?: string; delivered?: boolean; deliveryError?: string }> {
  try {
    await ensureVerificationSchema();
    const req = rows(await db.execute(sql`SELECT kind, paid, status FROM offer_verification_requests WHERE id = ${id} LIMIT 1`))[0];
    if (!req) return { ok: false, error: 'That request no longer exists.' };
    if (String(req.status) === 'rejected') {
      return { ok: false, error: 'That request was declined, so it cannot be answered. Nothing was changed.' };
    }
    if (!isFreePath(req.kind) && !req.paid) {
      return { ok: false, error: 'This request has not been paid for yet, so it cannot be answered.' };
    }
    await db.execute(sql`
      UPDATE offer_verification_requests
      SET status = 'answered', response_note = ${note.slice(0, 2000)}, answered_by = ${byUserId}, answered_at = NOW()
      WHERE id = ${id}`);

    // Tell the requester. Answering used to write the note to the database and stop there, so the
    // firm that had just paid 5 CHF for a verification received nothing at all and had no way to
    // know it had been answered. A paid request that produces silence is worse than no service.
    let delivered = false;
    let deliveryError = '';
    try {
      const sent = await deliverAnswer(id);
      delivered = !!sent.ok;
      if (!sent.ok) deliveryError = sent.error || 'The mail transport did not accept the message.';
    } catch (e: any) {
      deliveryError = e?.cause?.message || e?.message || 'The answer could not be sent.';
    }
    if (!delivered) {
      console.error('[offer-verification] the requester was NOT sent the answer to', id, '-', deliveryError);
    }

    return { ok: true, delivered, deliveryError: delivered ? undefined : deliveryError };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not save.' };
  }
}

/**
 * DECLINE A REQUEST — the transition 'rejected' never had.
 *
 * RequestStatus has declared 'rejected' since this module shipped and NOTHING in src/ ever wrote it.
 * The console's own header says "this is where a human confirms or declines", and there was no
 * decline: a request from somebody with no legitimate interest, or one whose fee never arrived,
 * had exactly two futures — answered, or sitting on the queue forever. The requester was never told
 * either, so they waited on an answer that was never coming.
 *
 * The reason is stored in response_note, the same column an answer uses, because it is the same
 * thing from the requester's side: the sentence they are given. No new column, no migration.
 */
export async function rejectRequest(id: string, byUserId: string, reason: string): Promise<{ ok: boolean; error?: string; delivered?: boolean; deliveryError?: string }> {
  const why = String(reason || '').trim().slice(0, 2000);
  if (why.length < 5) {
    return { ok: false, error: 'Say why it is being declined. The requester is sent this sentence, so "no" on its own is not enough.' };
  }
  try {
    await ensureVerificationSchema();
    // The UPDATE's own answer decides, rather than a read followed by a write: two reviewers on the
    // same queue must not both be told they declined it.
    const changed = rows(await db.execute(sql`
      UPDATE offer_verification_requests
         SET status = 'rejected', response_note = ${why}, answered_by = ${byUserId}, answered_at = NOW()
       WHERE id = ${id} AND status <> 'answered' AND status <> 'rejected'
       RETURNING requester_name, requester_email, organisation, token`));
    if (!changed.length) {
      return { ok: false, error: 'That request is already answered or already declined. Nothing was changed. Reload the list.' };
    }

    const r = changed[0] as any;
    let delivered = false;
    let deliveryError = '';
    if (r.requester_email) {
      try {
        const { sendExternal } = await import('@/lib/mail-transport');
        const safe = (s: string) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]);
        const ref = String(r.token || '').slice(0, 10);
        const html = '<p>Dear ' + safe(r.requester_name) + ',</p>'
          + '<p>We are not able to complete the offer-letter verification you requested'
          + (r.organisation ? ' on behalf of ' + safe(r.organisation) : '') + '.</p>'
          + '<blockquote style="margin:16px 0;padding:12px 16px;background:#faf6ef;border-left:3px solid #c2410c;">'
          + safe(why).replace(/\n/g, '<br>') + '</blockquote>'
          + '<p style="color:#5c5349;font-size:13px;">No information about any candidate has been disclosed. '
          + 'If a fee was taken for this request it is refundable; reply to this message and quote the reference.</p>'
          + '<p style="color:#5c5349;font-size:13px;">Reference ' + safe(ref) + '.</p>'
          + '<p>EduRankAI</p>';
        const res = await sendExternal({
          from: 'EduRankAI Verification <hr@edurankai.in>',
          to: r.requester_email,
          subject: 'Offer letter verification - reference ' + ref,
          html,
          text: 'Dear ' + r.requester_name + ',\n\nWe are not able to complete the offer-letter verification you requested.\n\n'
            + why + '\n\nNo information about any candidate has been disclosed. If a fee was taken for this request it is refundable.\n\nReference '
            + ref + '.\n\nEduRankAI',
        });
        delivered = !!(res as any)?.ok;
        if (!delivered) deliveryError = (res as any)?.error || 'The mail transport did not accept the message.';
      } catch (e: any) {
        deliveryError = e?.cause?.message || e?.message || 'The decline notice could not be sent.';
      }
    } else {
      deliveryError = 'There is no email address on the request, so nobody could be told.';
    }
    if (!delivered) {
      console.error('[offer-verification] the requester was NOT told about the decline of', id, '-', deliveryError);
    }

    return { ok: true, delivered, deliveryError: delivered ? undefined : deliveryError };
  } catch (e: any) {
    console.error('[offer-verification/rejectRequest]', e?.cause?.message || e?.message);
    return { ok: false, error: e?.cause?.message || e?.message || 'The request was not declined.' };
  }
}

/**
 * Notify the people entitled to act on a verification request.
 *
 * Sent to admins with the offers permission, which includes the super admin. Best-effort: a
 * notification failure must never lose the request, which is already committed by this point.
 */
export async function notifyNewRequest(req: { id: string; kind: VerifierKind; requesterName: string; organisation?: string | null; token: string }): Promise<void> {
  try {
    const { sendPushToAdmins } = await import('@/lib/push');
    const who = req.organisation ? `${req.requesterName} (${req.organisation})` : req.requesterName;
    await sendPushToAdmins({
      type: 'offer_verification_request',
      title: isFreePath(req.kind) ? 'Offer verification requested' : 'Paid verification requested',
      body: `${who} — ${req.kind}. Ref ${req.token.slice(0, 10)}.`,
      url: '/admin/offer-verifications',
      tag: 'offer-verif-' + req.id,
    });
  } catch { /* the request is already recorded; the notification is secondary */ }
}
