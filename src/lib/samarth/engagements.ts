// SAMARTH engagements: every commercial engagement AFTER the consultation. A consultancy package, an
// engineering build, a government project proposal, an infrastructure project, implementation or
// support is never charged through the booking fee and never bundled into it. Each one is its own
// record with its own quotation, which must be approved internally (with a note), sent to the
// client, and accepted by the client before any payment is taken or any delivery starts.
//
// A quotation's commercial content can only be edited while it is a DRAFT. Changing an approved or
// sent quotation means returning it to draft, which clears the approval, so nothing reaches a
// client that nobody approved.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { canTransition, ENGAGEMENT_KINDS, ENGAGEMENT_EDITABLE, ENGAGEMENT_CLIENT_VISIBLE, type Actor, type GuardContext } from '@/lib/samarth/workflow';
import { packageByCode, STANDARD_EXCLUSIONS, validateConfirmedAmount, type PackageCode } from '@/lib/samarth/pricing';
import { isSupportedCurrency, feeBreakdown, type FeeBreakdown, type TaxMode } from '@/lib/samarth/currency';
import { DELIVERY_MODELS } from '@/lib/samarth/catalog';
import { clean, newRef } from '@/lib/samarth/validate';
import {
  rows, readSafely, writeSafely, num, iso, isoDay, str, isUuid, json, addEvent, audit,
  type Read, type Write, type ActorRef, SYSTEM_ACTOR,
} from '@/lib/samarth/store-core';

export interface Engagement {
  id: string; ref: string; applicationId: string; kind: string; packageCode: string; status: string;
  title: string; scope: string; deliverables: string; exclusions: string; deliveryModel: string; responsibility: string;
  partnerIds: string[]; currency: string; amountMinor: number | null; taxMode: TaxMode; taxLabel: string; taxRateBp: number;
  totalMinor: number | null; terms: string; validUntil: string | null; paymentMethod: 'invoice' | 'online';
  preparedName: string; approvedBy: string | null; approvedName: string; approvedAt: string | null; approvalNote: string;
  sentAt: string | null; acceptedAt: string | null; acceptedName: string; acceptanceEvidence: string; decidedNote: string;
  paymentState: 'none' | 'pending' | 'paid'; paymentOrderId: string; chargedInrPaise: number | null; fxRate: number | null;
  paidAt: string | null; paymentReference: string; invoiceId: string | null; awardReference: string;
  createdAt: string | null; updatedAt: string | null;
}

export const toEngagement = (r: any): Engagement => ({
  id: str(r.id), ref: str(r.ref), applicationId: str(r.application_id), kind: str(r.kind), packageCode: str(r.package_code), status: str(r.status),
  title: str(r.title), scope: str(r.scope), deliverables: str(r.deliverables), exclusions: str(r.exclusions), deliveryModel: str(r.delivery_model),
  responsibility: str(r.responsibility), partnerIds: Array.isArray(r.partner_ids) ? r.partner_ids.map(String) : [],
  currency: str(r.currency) || 'INR', amountMinor: num(r.amount_minor),
  taxMode: (['none', 'exclusive', 'inclusive'].includes(r.tax_mode) ? r.tax_mode : 'none') as TaxMode, taxLabel: str(r.tax_label), taxRateBp: num(r.tax_rate_bp) || 0,
  totalMinor: num(r.total_minor), terms: str(r.terms), validUntil: isoDay(r.valid_until), paymentMethod: r.payment_method === 'online' ? 'online' : 'invoice',
  preparedName: str(r.prepared_name), approvedBy: r.approved_by ? str(r.approved_by) : null, approvedName: str(r.approved_name), approvedAt: iso(r.approved_at),
  approvalNote: str(r.approval_note), sentAt: iso(r.sent_at), acceptedAt: iso(r.accepted_at), acceptedName: str(r.accepted_name),
  acceptanceEvidence: str(r.acceptance_evidence), decidedNote: str(r.decided_note),
  paymentState: (['none', 'pending', 'paid'].includes(r.payment_state) ? r.payment_state : 'none') as Engagement['paymentState'],
  paymentOrderId: str(r.payment_order_id), chargedInrPaise: num(r.charged_inr_paise), fxRate: num(r.fx_rate), paidAt: iso(r.paid_at),
  paymentReference: str(r.payment_reference), invoiceId: r.invoice_id ? str(r.invoice_id) : null, awardReference: str(r.award_reference),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export function engagementBreakdown(e: Pick<Engagement, 'amountMinor' | 'currency' | 'taxMode' | 'taxLabel' | 'taxRateBp' | 'title'>): FeeBreakdown {
  return feeBreakdown({ amountMinor: e.amountMinor || 0, currency: e.currency, taxMode: e.taxMode, taxLabel: e.taxLabel, taxRateBp: e.taxRateBp, processingBp: 0 }, e.title || 'Engagement');
}

/** Today as YYYY-MM-DD in UTC. A quotation valid "until" a date is valid through that whole day. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Everything a quotation needs before it can go for approval or be sent. Pure. */
export function quotationProblems(e: Engagement): string[] {
  const p: string[] = [];
  if (!ENGAGEMENT_KINDS.some((k) => k.value === e.kind)) p.push('Choose the kind of engagement.');
  if (e.title.trim().length < 5) p.push('Give the quotation a title.');
  if (e.scope.trim().length < 20) p.push('Describe the scope of work.');
  if (!isSupportedCurrency(e.currency)) p.push('Choose a supported currency.');
  if (!e.amountMinor || e.amountMinor <= 0) p.push('Enter the amount.');
  if (e.taxMode !== 'none' && (!e.taxLabel.trim() || !e.taxRateBp)) p.push('A taxed quotation needs the tax name and rate.');
  if (e.terms.trim().length < 40) p.push('Write the terms of this engagement (payment, delivery, acceptance and cancellation).');
  if (!e.validUntil) p.push('Set the date the quotation is valid until.');
  if (!e.deliveryModel) p.push('Choose the delivery model.');
  if ((e.deliveryModel === 'partner' || e.deliveryModel === 'joint') && e.responsibility.trim().length < 20) {
    p.push('State who is responsible for what, and what is subcontracted, because partners are involved.');
  }
  if (e.kind === 'consultancy_package') {
    const pkg = packageByCode(e.packageCode);
    if (!pkg) p.push('Choose the consultancy package this quotation is for.');
    else if (e.currency === 'INR' && e.amountMinor) {
      const v = validateConfirmedAmount(pkg.code as PackageCode, e.amountMinor);
      if (!v.ok) p.push(v.error);
    }
  }
  return p;
}

export function engagementGuards(e: Engagement, note?: string | null): GuardContext {
  return {
    quotationValid: quotationProblems(e).length === 0,
    approvalNoteGiven: String(note || '').trim().length >= 5,
    notExpired: !!e.validUntil && e.validUntil >= todayUtc(),
    paidOrContracted: e.paymentState === 'paid' || !!e.awardReference.trim(),
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

async function load(id: string): Promise<Engagement | null> {
  if (!isUuid(id)) return null;
  const r = rows(await db.execute(sql`SELECT * FROM samarth_engagements WHERE id = ${id}::uuid LIMIT 1`))[0];
  return r ? toEngagement(r) : null;
}

export async function getEngagement(id: string): Promise<Read<Engagement | null>> {
  return readSafely('the engagement', () => load(id));
}

export async function engagementsForApplication(applicationId: string, clientVisibleOnly: boolean): Promise<Read<Engagement[]>> {
  if (!isUuid(applicationId)) return { ready: true, value: [] };
  return readSafely('engagements', async () => {
    const list = rows(await db.execute(sql`SELECT * FROM samarth_engagements WHERE application_id = ${applicationId}::uuid ORDER BY created_at DESC LIMIT 100`)).map(toEngagement);
    return clientVisibleOnly ? list.filter((e) => ENGAGEMENT_CLIENT_VISIBLE.includes(e.status)) : list;
  });
}

export async function listEngagements(f: { q?: string; status?: string; kind?: string; cursor?: string; limit?: number } = {}): Promise<Read<{ items: (Engagement & { appRef: string; client: string })[]; next: string | null }>> {
  const limit = Math.max(1, Math.min(5000, f.limit || 50));
  const q = clean(f.q, 120);
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const [cTs, cId] = String(f.cursor || '').split('|');
  const hasCursor = !!iso(cTs) && isUuid(cId);
  return readSafely('engagements', async () => {
    const r = rows(await db.execute(sql`
      SELECT e.*, a.ref AS app_ref, COALESCE(NULLIF(a.org_name, ''), a.contact_name) AS client
        FROM samarth_engagements e LEFT JOIN samarth_applications a ON a.id = e.application_id
       WHERE (${f.status || ''} = '' OR e.status = ${f.status || ''})
         AND (${f.kind || ''} = '' OR e.kind = ${f.kind || ''})
         AND (${q} = '' OR e.ref ILIKE ${like} OR e.title ILIKE ${like} OR e.scope ILIKE ${like} OR a.ref ILIKE ${like}
              OR a.org_name ILIKE ${like} OR a.contact_name ILIKE ${like} OR e.award_reference ILIKE ${like})
         AND (${hasCursor} = false OR (e.created_at, e.id) < (${hasCursor ? iso(cTs) : null}::timestamptz, ${hasCursor ? cId : null}::uuid))
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${limit + 1}`));
    const items = r.slice(0, limit).map((x) => ({ ...toEngagement(x), appRef: str(x.app_ref), client: str(x.client) }));
    const last = items[items.length - 1];
    return { items, next: r.length > limit && last ? last.createdAt + '|' + last.id : null };
  });
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export async function createEngagement(applicationId: string, kind: string, title: string, currency: string, who: ActorRef): Promise<Write<{ id: string; ref: string }>> {
  if (!isUuid(applicationId)) return { ok: false, error: 'Unknown application.' };
  if (!ENGAGEMENT_KINDS.some((k) => k.value === kind)) return { ok: false, error: 'Choose the kind of engagement.' };
  const t = clean(title, 200);
  if (t.length < 5) return { ok: false, error: 'Give the engagement a title.' };
  return writeSafely<{ id: string; ref: string }>('creating the engagement', async () => {
    const app = rows(await db.execute(sql`SELECT id, ref, status FROM samarth_applications WHERE id = ${applicationId}::uuid LIMIT 1`))[0];
    if (!app) return { ok: false, error: 'That application no longer exists.' };
    if (!['CALL_SCHEDULED', 'CALL_COMPLETED', 'CLOSED', 'CONSULTANT_ASSIGNED'].includes(str(app.status))) {
      return { ok: false, error: 'An engagement is quoted after the consultation: assign a consultant and hold the call first.' };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = newRef('E');
      try {
        const r = rows(await db.execute(sql`
          INSERT INTO samarth_engagements (ref, application_id, kind, title, currency, exclusions, prepared_by, prepared_name)
          VALUES (${ref}, ${applicationId}::uuid, ${kind}, ${t}, ${isSupportedCurrency(currency) ? currency.toUpperCase() : 'INR'},
                  ${STANDARD_EXCLUSIONS.map((x) => '- ' + x).join('\n')}, ${isUuid(who.userId) ? who.userId : null}::uuid, ${who.name})
          RETURNING id`))[0];
        const id = str(r?.id);
        await addEvent('engagement', id, { kind: 'status', to: 'DRAFT', body: 'Quotation drafted.', actor: who });
        await addEvent('application', applicationId, { kind: 'system', body: 'Engagement ' + ref + ' drafted (' + t + ').', actor: who });
        await audit(who, 'samarth.engagement.create', 'samarth_engagement', id, { ref, applicationRef: str(app.ref), kind });
        return { ok: true, id, ref };
      } catch (e: any) {
        if (/duplicate key|unique/i.test(String(e?.cause?.message || e?.message || '')) && attempt < 2) continue;
        throw e;
      }
    }
    return { ok: false, error: 'Could not issue a reference. Try again.' };
  });
}

export interface DraftInput {
  kind: string; packageCode: string; title: string; scope: string; deliverables: string; exclusions: string;
  deliveryModel: string; responsibility: string; partnerIds: string[]; currency: string; amountMinor: number | null;
  taxMode: string; taxLabel: string; taxRateBp: number | null; terms: string; validUntil: string | null; paymentMethod: string;
}

export async function updateDraft(id: string, d: DraftInput, who: ActorRef): Promise<Write> {
  return writeSafely('saving the quotation', async () => {
    const e = await load(id);
    if (!e) return { ok: false, error: 'That engagement no longer exists.' };
    if (!ENGAGEMENT_EDITABLE.includes(e.status)) return { ok: false, error: 'Only a draft can be edited. Return it to draft first; that clears its approval.' };
    const currency = isSupportedCurrency(d.currency) ? d.currency.toUpperCase() : e.currency;
    const taxMode = ['none', 'exclusive', 'inclusive'].includes(d.taxMode) ? d.taxMode : 'none';
    const amount = d.amountMinor && d.amountMinor > 0 ? Math.round(d.amountMinor) : null;
    const total = amount ? feeBreakdown({ amountMinor: amount, currency, taxMode, taxLabel: d.taxLabel, taxRateBp: d.taxRateBp || 0, processingBp: 0 }).total : null;
    const partnerIds = (d.partnerIds || []).filter(isUuid).slice(0, 20);
    if (partnerIds.length) {
      const approved = rows(await db.execute(sql`SELECT id FROM samarth_partners WHERE status = 'APPROVED' AND id IN (SELECT (jsonb_array_elements_text(${json(partnerIds)}::jsonb))::uuid)`)).map((r) => str(r.id));
      if (approved.length !== partnerIds.length) return { ok: false, error: 'Only approved partners can be named on a quotation.' };
    }
    const validUntil = d.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(d.validUntil) ? d.validUntil : null;
    await db.execute(sql`
      UPDATE samarth_engagements SET
        kind = ${ENGAGEMENT_KINDS.some((k) => k.value === d.kind) ? d.kind : e.kind},
        package_code = ${packageByCode(d.packageCode) ? d.packageCode : null},
        title = ${clean(d.title, 200) || e.title}, scope = ${clean(d.scope, 8000, true) || null}, deliverables = ${clean(d.deliverables, 8000, true) || null},
        exclusions = ${clean(d.exclusions, 4000, true) || null},
        delivery_model = ${DELIVERY_MODELS.some((m) => m.value === d.deliveryModel) ? d.deliveryModel : null},
        responsibility = ${clean(d.responsibility, 4000, true) || null}, partner_ids = ${json(partnerIds)}::jsonb,
        currency = ${currency}, amount_minor = ${amount}, tax_mode = ${taxMode}, tax_label = ${clean(d.taxLabel, 60) || null},
        tax_rate_bp = ${Math.max(0, Math.min(10000, Math.round(d.taxRateBp || 0)))}, total_minor = ${total},
        terms = ${clean(d.terms, 12000, true) || null}, valid_until = ${validUntil}::date,
        payment_method = ${d.paymentMethod === 'online' ? 'online' : 'invoice'}, updated_at = NOW()
      WHERE id = ${id}::uuid AND status = 'DRAFT'`);
    await audit(who, 'samarth.engagement.edit', 'samarth_engagement', id, { ref: e.ref, amountMinor: amount, currency });
    return { ok: true };
  });
}

/** Every status change on an engagement, with its side effects. */
export async function transitionEngagement(id: string, to: string, actor: Actor, who: ActorRef, note: string | null): Promise<Write<{ engagement: Engagement }>> {
  return writeSafely<{ engagement: Engagement }>('changing the engagement', async () => {
    const e = await load(id);
    if (!e) return { ok: false, error: 'That engagement no longer exists.' };
    const check = canTransition('engagement', e.status, to, actor, engagementGuards(e, note), note);
    if (!check.ok) {
      const extra = to === 'PENDING_APPROVAL' || to === 'APPROVED' || to === 'SENT' ? ' ' + quotationProblems(e).join(' ') : '';
      return { ok: false, error: (check.error || 'That change is not allowed.') + extra };
    }
    const n = (note || '').trim().slice(0, 2000) || null;
    const uid = isUuid(who.userId) ? who.userId : null;
    let done: any[];
    if (to === 'APPROVED') {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = 'APPROVED', approved_by = ${uid}::uuid, approved_name = ${who.name}, approved_at = NOW(), approval_note = ${n}, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    } else if (to === 'DRAFT') {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = 'DRAFT', approved_by = NULL, approved_name = NULL, approved_at = NULL, approval_note = NULL, sent_at = NULL, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    } else if (to === 'SENT') {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = 'SENT', sent_at = NOW(), updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    } else if (to === 'ACCEPTED') {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = 'ACCEPTED', accepted_at = NOW(), accepted_name = COALESCE(accepted_name, ${who.name}), payment_state = CASE WHEN payment_state = 'paid' THEN 'paid' ELSE 'pending' END, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    } else if (to === 'DECLINED' || to === 'WITHDRAWN' || to === 'CANCELLED' || to === 'EXPIRED') {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = ${to}, decided_note = ${n}, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    } else {
      done = rows(await db.execute(sql`UPDATE samarth_engagements SET status = ${to}, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${e.status} RETURNING *`));
    }
    if (!done.length) return { ok: false, error: 'This engagement changed a moment ago. Reload the page.' };
    const clientSees = ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'IN_DELIVERY', 'COMPLETED', 'CANCELLED'].includes(to) && to !== 'WITHDRAWN';
    await addEvent('engagement', id, { kind: 'status', from: e.status, to, body: n, visibility: clientSees ? 'applicant' : 'internal', actor: who });
    await audit(who, 'samarth.engagement.status', 'samarth_engagement', id, { ref: e.ref, from: e.status, to, note: n ? n.slice(0, 300) : undefined });
    return { ok: true, engagement: toEngagement(done[0]) };
  });
}

/** The client accepts a sent quotation, typing their name. Only for their own application. */
export async function clientAccept(engagementId: string, applicationId: string, typedName: string): Promise<Write<{ engagement: Engagement }>> {
  const name = clean(typedName, 200);
  if (name.length < 2) return { ok: false, error: 'Type your full name to accept.' };
  const e = await load(engagementId);
  if (!e || e.applicationId !== applicationId) return { ok: false, error: 'That quotation is not part of this request.' };
  await db.execute(sql`UPDATE samarth_engagements SET accepted_name = ${name} WHERE id = ${engagementId}::uuid AND status = 'SENT'`);
  return transitionEngagement(engagementId, 'ACCEPTED', 'applicant', { userId: null, name }, 'Accepted by ' + name + '.');
}

export async function clientDecline(engagementId: string, applicationId: string, reason: string, name: string): Promise<Write<{ engagement: Engagement }>> {
  const e = await load(engagementId);
  if (!e || e.applicationId !== applicationId) return { ok: false, error: 'That quotation is not part of this request.' };
  return transitionEngagement(engagementId, 'DECLINED', 'applicant', { userId: null, name: clean(name, 200) || 'Client' }, clean(reason, 2000, true) || 'Declined by the client.');
}

/** Staff record an acceptance that arrived outside the website (signed letter, purchase order). */
export async function recordOfflineAcceptance(id: string, acceptedName: string, evidence: string, who: ActorRef): Promise<Write<{ engagement: Engagement }>> {
  const ev = clean(evidence, 600);
  if (clean(acceptedName, 200).length < 2 || ev.length < 5) return { ok: false, error: 'Record who accepted and the evidence (a document link, purchase order or letter reference).' };
  await db.execute(sql`UPDATE samarth_engagements SET accepted_name = ${clean(acceptedName, 200)}, acceptance_evidence = ${ev} WHERE id = ${id}::uuid AND status = 'SENT'`);
  return transitionEngagement(id, 'ACCEPTED', 'staff', who, 'Acceptance recorded from outside the website: ' + ev);
}

export async function setAwardReference(id: string, reference: string, who: ActorRef): Promise<Write> {
  const ref = clean(reference, 200);
  if (ref.length < 3) return { ok: false, error: 'Enter the contract, purchase order or award reference.' };
  return writeSafely('recording the award reference', async () => {
    const done = rows(await db.execute(sql`UPDATE samarth_engagements SET award_reference = ${ref}, updated_at = NOW() WHERE id = ${id}::uuid AND status IN ('ACCEPTED', 'IN_DELIVERY') RETURNING ref`));
    if (!done.length) return { ok: false, error: 'An award or contract reference is recorded once the quotation has been accepted.' };
    await addEvent('engagement', id, { kind: 'system', body: 'Contract, purchase order or award reference recorded: ' + ref, visibility: 'applicant', actor: who });
    await audit(who, 'samarth.engagement.award', 'samarth_engagement', id, { reference: ref });
    return { ok: true };
  });
}

export async function recordEngagementPayment(id: string, reference: string, who: ActorRef): Promise<Write> {
  const ref = clean(reference, 200);
  if (ref.length < 3) return { ok: false, error: 'Enter the payment reference you reconciled.' };
  return writeSafely('recording the payment', async () => {
    const done = rows(await db.execute(sql`
      UPDATE samarth_engagements SET payment_state = 'paid', paid_at = NOW(), payment_reference = ${ref}, updated_at = NOW()
       WHERE id = ${id}::uuid AND status IN ('ACCEPTED', 'IN_DELIVERY', 'COMPLETED') AND payment_state <> 'paid' RETURNING ref`));
    if (!done.length) return { ok: false, error: 'A payment is recorded against an accepted quotation that is not already paid.' };
    await addEvent('engagement', id, { kind: 'payment', body: 'Payment received and recorded (reference ' + ref + ').', visibility: 'applicant', actor: who });
    await audit(who, 'samarth.engagement.offline_payment', 'samarth_engagement', id, { reference: ref });
    return { ok: true };
  });
}

export async function markEngagementPaidByGateway(id: string, orderId: string, paymentId: string | null): Promise<{ changed: boolean; engagement: Engagement | null }> {
  const done = rows(await db.execute(sql`
    UPDATE samarth_engagements SET payment_state = 'paid', paid_at = NOW(), payment_order_id = ${orderId}, payment_reference = ${paymentId || orderId}, updated_at = NOW()
     WHERE id = ${id}::uuid AND payment_state <> 'paid' RETURNING *`));
  if (done.length) {
    await addEvent('engagement', id, { kind: 'payment', body: 'Payment confirmed by the payment provider.', visibility: 'applicant' });
    await audit(SYSTEM_ACTOR, 'samarth.engagement.paid', 'samarth_engagement', id, { orderId, paymentId });
    return { changed: true, engagement: toEngagement(done[0]) };
  }
  return { changed: false, engagement: await load(id) };
}

export async function setEngagementInvoice(id: string, invoiceId: string, who: ActorRef): Promise<void> {
  await db.execute(sql`UPDATE samarth_engagements SET invoice_id = ${invoiceId}::uuid, updated_at = NOW() WHERE id = ${id}::uuid`);
  await addEvent('engagement', id, { kind: 'system', body: 'Invoice raised.', actor: who });
}

export async function engagementNote(id: string, body: string, toClient: boolean, who: ActorRef): Promise<Write> {
  const text = clean(body, 5000, true);
  if (text.length < 2) return { ok: false, error: 'Write the note first.' };
  return writeSafely('saving the note', async () => {
    await addEvent('engagement', id, { kind: toClient ? 'message' : 'note', body: text, visibility: toClient ? 'applicant' : 'internal', actor: who });
    return { ok: true };
  });
}
