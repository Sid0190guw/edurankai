// SAMARTH consultation requests: Registration, Applicant details, Project requirements, Booking fee,
// Call booking, Consultant assignment, the call itself. Every status change goes through
// canTransition() (workflow.ts) and is written with `WHERE status = <from>`, so a stale screen can
// never move a request somebody else already moved.
//
// ONE POLICY FOR EVERY APPLICANT. Governments, public-sector bodies, businesses, startups,
// universities and individuals all register and pay the consultation booking fee before a call is
// booked. Official bodies additionally record their department, authorised representative and
// procurement requirements, and may pay against an invoice where their rules require it.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isApplicantCategory, isOfficialCategory, isGovernmentLevel, PROCUREMENT_ROUTES } from '@/lib/samarth/categories';
import { canTransition, APPLICANT_EDITABLE, type Actor, type GuardContext } from '@/lib/samarth/workflow';
import { parseAnswers, pathwayById, type Answers } from '@/lib/samarth/pathways';
import { NEED_TYPES, TURNOVER_BANDS } from '@/lib/samarth/pricing';
import { clean, cleanEmail, cleanPhone, cleanUrl, isCountryCode, isTimeZone, newRef, newToken, hashToken, type DocLink } from '@/lib/samarth/validate';
import type { FeeBreakdown } from '@/lib/samarth/currency';
import {
  rows, readSafely, writeSafely, num, iso, str, isUuid, json, addEvent, audit,
  type Read, type Write, type ActorRef, SYSTEM_ACTOR,
} from '@/lib/samarth/store-core';

export interface OfficialDetails {
  level: string;
  jurisdiction: string;
  department: string;
  office: string;
  repName: string;
  repDesignation: string;
  repEmail: string;
  repPhone: string;
  authorityRef: string;
  procurement: { route: string; tenderRef: string; formalProposal: boolean; invoiceFirst: boolean; language: string; notes: string };
}

export interface FeeSnapshot {
  feeId: string;
  category: string;
  currency: string;
  amountMinor: number;
  taxMode: string;
  taxLabel: string;
  taxRateBp: number;
  processingBp: number;
  chargesNote: string;
  terms: string;
  breakdown: FeeBreakdown;
  method: 'online' | 'invoice';
  acceptedName: string;
}

export interface Booking { timezone: string; slots: string[]; mode: string; note: string }

export interface Application {
  id: string; ref: string; status: string; category: string; country: string; region: string; city: string; timezone: string;
  contactName: string; contactEmail: string; contactPhone: string; contactRole: string;
  orgName: string; orgWebsite: string; orgRegistration: string; turnoverBand: string;
  official: OfficialDetails | null;
  pathway: string; need: string; title: string; summary: string; requirements: Answers; documents: DocLink[];
  feeScheduleId: string | null; feeCurrency: string; feeTotalMinor: number | null; feeSnapshot: FeeSnapshot | null; feeTermsAcceptedAt: string | null;
  paymentMethod: string; paymentOrderId: string; chargedInrPaise: number | null; fxRate: number | null; fxDate: string; paidAt: string | null;
  paymentReference: string; invoiceId: string | null;
  booking: Booking | null; bookingRequestedAt: string | null;
  consultantUserId: string | null; consultantName: string; consultantEmail: string; assignedAt: string | null;
  callAt: string | null; callLink: string; callCompletedAt: string | null; outcomeNote: string;
  aiAssisted: boolean; consentPrivacy: boolean; consentContact: boolean; source: string; accessHash: string; archived: boolean;
  createdAt: string | null; updatedAt: string | null;
}

const obj = (v: unknown): any => (v && typeof v === 'object' ? v : null);

export const toApplication = (r: any): Application => ({
  id: str(r.id), ref: str(r.ref), status: str(r.status), category: str(r.category), country: str(r.country), region: str(r.region), city: str(r.city), timezone: str(r.timezone),
  contactName: str(r.contact_name), contactEmail: str(r.contact_email), contactPhone: str(r.contact_phone), contactRole: str(r.contact_role),
  orgName: str(r.org_name), orgWebsite: str(r.org_website), orgRegistration: str(r.org_registration), turnoverBand: str(r.turnover_band),
  official: obj(r.official),
  pathway: str(r.pathway), need: str(r.need), title: str(r.title), summary: str(r.summary),
  requirements: obj(r.requirements) || {}, documents: Array.isArray(r.documents) ? r.documents : [],
  feeScheduleId: r.fee_schedule_id ? str(r.fee_schedule_id) : null, feeCurrency: str(r.fee_currency), feeTotalMinor: num(r.fee_total_minor),
  feeSnapshot: obj(r.fee_snapshot), feeTermsAcceptedAt: iso(r.fee_terms_accepted_at),
  paymentMethod: str(r.payment_method), paymentOrderId: str(r.payment_order_id), chargedInrPaise: num(r.charged_inr_paise), fxRate: num(r.fx_rate),
  fxDate: str(r.fx_date), paidAt: iso(r.paid_at), paymentReference: str(r.payment_reference), invoiceId: r.invoice_id ? str(r.invoice_id) : null,
  booking: obj(r.booking), bookingRequestedAt: iso(r.booking_requested_at),
  consultantUserId: r.consultant_user_id ? str(r.consultant_user_id) : null, consultantName: str(r.consultant_name), consultantEmail: str(r.consultant_email),
  assignedAt: iso(r.assigned_at), callAt: iso(r.call_at), callLink: str(r.call_link), callCompletedAt: iso(r.call_completed_at), outcomeNote: str(r.outcome_note),
  aiAssisted: !!r.ai_assisted, consentPrivacy: !!r.consent_privacy, consentContact: !!r.consent_contact, source: str(r.source),
  accessHash: str(r.access_hash), archived: !!r.archived, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

// -------------------------------------------------------------------------------------------------
// VALIDATION (pure)
// -------------------------------------------------------------------------------------------------

export interface DetailsInput {
  category: string; country: string; region: string; city: string; timezone: string;
  contactName: string; contactEmail: string; contactPhone: string; contactRole: string;
  orgName: string; orgWebsite: string; orgRegistration: string; turnoverBand: string;
  official: OfficialDetails | null;
}

/** Read the details form. `get` returns a posted string. Problems are sentences a person can act on. */
export function parseDetails(get: (name: string) => string): { value: DetailsInput; problems: string[] } {
  const problems: string[] = [];
  const category = clean(get('category'), 40);
  const country = clean(get('country'), 2).toUpperCase();
  const email = cleanEmail(get('contact_email'));
  const phoneRaw = clean(get('contact_phone'), 32);
  const phone = phoneRaw ? cleanPhone(phoneRaw) : '';
  const websiteRaw = clean(get('org_website'), 800);
  const website = websiteRaw ? cleanUrl(websiteRaw) : '';
  const tz = clean(get('timezone'), 64);
  const turnover = clean(get('turnover_band'), 40);
  const value: DetailsInput = {
    category, country, region: clean(get('region'), 120), city: clean(get('city'), 120), timezone: isTimeZone(tz) ? tz : '',
    contactName: clean(get('contact_name'), 200), contactEmail: email || '', contactPhone: phone || '', contactRole: clean(get('contact_role'), 200),
    orgName: clean(get('org_name'), 300), orgWebsite: website || '', orgRegistration: clean(get('org_registration'), 120),
    turnoverBand: TURNOVER_BANDS.some((b) => b.value === turnover) ? turnover : '',
    official: null,
  };
  if (!isApplicantCategory(category)) problems.push('Choose what kind of applicant you are.');
  if (!isCountryCode(country)) problems.push('Choose your country.');
  if (value.contactName.length < 2) problems.push('Enter the contact person\'s name.');
  if (!email) problems.push('Enter a valid email address.');
  if (phoneRaw && !phone) problems.push('That phone number does not look right. Include the country code.');
  if (websiteRaw && !website) problems.push('The website must be a full address starting with https://');
  if (category !== 'individual' && value.orgName.length < 2) problems.push('Enter the name of your organisation.');
  if (isOfficialCategory(category)) {
    const route = clean(get('proc_route'), 40);
    const repEmail = cleanEmail(get('rep_email'));
    const repPhoneRaw = clean(get('rep_phone'), 32);
    const o: OfficialDetails = {
      level: clean(get('gov_level'), 40), jurisdiction: clean(get('gov_jurisdiction'), 300), department: clean(get('gov_department'), 300),
      office: clean(get('gov_office'), 300), repName: clean(get('rep_name'), 200), repDesignation: clean(get('rep_designation'), 200),
      repEmail: repEmail || '', repPhone: (repPhoneRaw && cleanPhone(repPhoneRaw)) || '', authorityRef: clean(get('rep_authority'), 500),
      procurement: {
        route: PROCUREMENT_ROUTES.some((p) => p.value === route) ? route : '', tenderRef: clean(get('proc_tender'), 200),
        formalProposal: get('proc_formal') === 'yes', invoiceFirst: get('proc_invoice') === 'yes',
        language: clean(get('proc_language'), 80), notes: clean(get('proc_notes'), 2000, true),
      },
    };
    if (!isGovernmentLevel(o.level)) problems.push('Choose the level of government or public body.');
    if (o.jurisdiction.length < 2) problems.push('Enter the jurisdiction (for example the city, district, state, province or country).');
    if (o.department.length < 2) problems.push('Enter the ministry, department or agency.');
    if (o.repName.length < 2 || o.repDesignation.length < 2) problems.push('Enter the authorised representative\'s name and designation.');
    if (!repEmail) problems.push('Enter the authorised representative\'s official email address.');
    if (repPhoneRaw && !o.repPhone) problems.push('The representative\'s phone number does not look right.');
    if (!o.procurement.route) problems.push('Choose the expected procurement route, or "Not decided yet".');
    value.official = o;
  }
  return { value, problems };
}

export interface RequirementsInput {
  pathway: string; need: string; title: string; summary: string; answers: Answers; documents: DocLink[];
}

export function parseRequirements(get: (name: string) => string, documents: DocLink[], invalidDocs: number): { value: RequirementsInput; problems: string[] } {
  const pathway = clean(get('pathway'), 40);
  const need = clean(get('need'), 40);
  const parsed = parseAnswers(pathway, get);
  const value: RequirementsInput = {
    pathway, need: NEED_TYPES.some((n) => n.value === need) ? need : '',
    title: clean(get('title'), 200), summary: clean(get('summary'), 6000, true), answers: parsed.answers, documents,
  };
  const problems: string[] = [];
  if (!pathwayById(pathway)) problems.push('Choose the kind of project.');
  if (!value.need) problems.push('Say what you are looking for.');
  if (value.title.length < 5) problems.push('Give the project a short title.');
  if (value.summary.length < 30) problems.push('Describe what you are planning to build, improve, transform or achieve (a few sentences).');
  if (parsed.missing.filter((m) => m !== 'Kind of project').length) problems.push('Please answer: ' + parsed.missing.filter((m) => m !== 'Kind of project').join('; ') + '.');
  if (parsed.invalid.length) problems.push('Choose from the listed options for: ' + parsed.invalid.join('; ') + '.');
  if (invalidDocs) problems.push(invalidDocs + ' document link(s) were not full web addresses and were not saved. Share documents as links starting with https://');
  return { value, problems };
}

/** The guard facts for one application, computed from its stored state. */
export function guardContext(a: Application, extra: GuardContext = {}): GuardContext {
  const official = isOfficialCategory(a.category);
  const o = a.official;
  const detailsComplete = isApplicantCategory(a.category) && isCountryCode(a.country) && a.contactName.length >= 2 && !!cleanEmail(a.contactEmail)
    && (a.category === 'individual' || a.orgName.length >= 2)
    && (!official || (!!o && isGovernmentLevel(o.level) && !!o.department && !!o.repName && !!o.repEmail && !!o.procurement?.route));
  const requirementsComplete = !!pathwayById(a.pathway) && !!a.need && a.title.length >= 5 && a.summary.length >= 30;
  return {
    detailsComplete,
    requirementsComplete,
    feeQuoted: !!a.feeSnapshot && !!a.feeScheduleId && (a.feeTotalMinor || 0) > 0,
    termsAccepted: !!a.feeTermsAcceptedAt,
    paymentConfirmed: !!a.paidAt,
    slotsGiven: !!a.booking && Array.isArray(a.booking.slots) && a.booking.slots.length > 0,
    consultantSet: !!a.consultantName,
    callTimeSet: !!a.callAt,
    ...extra,
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export async function getApplicationByRef(ref: string): Promise<Read<Application | null>> {
  return readSafely('the application', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_applications WHERE ref = ${ref} LIMIT 1`))[0];
    return r ? toApplication(r) : null;
  });
}

export async function getApplication(id: string): Promise<Read<Application | null>> {
  if (!isUuid(id)) return { ready: true, value: null };
  return readSafely('the application', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_applications WHERE id = ${id}::uuid LIMIT 1`))[0];
    return r ? toApplication(r) : null;
  });
}

async function load(id: string): Promise<Application | null> {
  const r = rows(await db.execute(sql`SELECT * FROM samarth_applications WHERE id = ${id}::uuid LIMIT 1`))[0];
  return r ? toApplication(r) : null;
}

export interface ApplicationFilter {
  q?: string; status?: string; category?: string; country?: string; pathway?: string;
  archived?: boolean; cursor?: string; limit?: number;
}

export function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

/** Keyset-paginated over ALL applications (never only the loaded page). cursor = "<iso>|<id>". */
export async function listApplications(f: ApplicationFilter = {}): Promise<Read<{ items: Application[]; next: string | null }>> {
  const limit = Math.max(1, Math.min(5000, f.limit || 50));
  const q = clean(f.q, 120);
  const [cTs, cId] = String(f.cursor || '').split('|');
  const hasCursor = !!iso(cTs) && isUuid(cId);
  return readSafely('applications', async () => {
    const r = rows(await db.execute(sql`
      SELECT * FROM samarth_applications
       WHERE archived = ${!!f.archived}
         AND (${f.status || ''} = '' OR status = ${f.status || ''})
         AND (${f.category || ''} = '' OR category = ${f.category || ''})
         AND (${f.country || ''} = '' OR country = ${f.country || ''})
         AND (${f.pathway || ''} = '' OR pathway = ${f.pathway || ''})
         AND (${q} = '' OR ref ILIKE ${likePattern(q)} OR contact_name ILIKE ${likePattern(q)} OR contact_email ILIKE ${likePattern(q)}
              OR org_name ILIKE ${likePattern(q)} OR title ILIKE ${likePattern(q)} OR summary ILIKE ${likePattern(q)}
              OR (official->>'department') ILIKE ${likePattern(q)} OR (official->>'jurisdiction') ILIKE ${likePattern(q)})
         AND (${hasCursor} = false OR (created_at, id) < (${hasCursor ? iso(cTs) : null}::timestamptz, ${hasCursor ? cId : null}::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`));
    const items = r.slice(0, limit).map(toApplication);
    const last = items[items.length - 1];
    return { items, next: r.length > limit && last ? last.createdAt + '|' + last.id : null };
  });
}

// -------------------------------------------------------------------------------------------------
// WRITES BY THE APPLICANT
// -------------------------------------------------------------------------------------------------

export interface RegistrationInput {
  category: string; country: string; contactName: string; contactEmail: string; orgName: string;
  timezone: string; consentPrivacy: boolean; consentContact: boolean; source?: string; aiAssisted?: boolean;
}

/** Step 1. Returns the private token ONCE; only its hash is stored. */
export async function registerApplication(input: RegistrationInput): Promise<Write<{ id: string; ref: string; token: string }>> {
  const email = cleanEmail(input.contactEmail);
  if (!isApplicantCategory(input.category)) return { ok: false, error: 'Choose what kind of applicant you are.' };
  if (!isCountryCode(input.country)) return { ok: false, error: 'Choose your country.' };
  if (clean(input.contactName, 200).length < 2) return { ok: false, error: 'Enter your name.' };
  if (!email) return { ok: false, error: 'Enter a valid email address.' };
  if (!input.consentPrivacy) return { ok: false, error: 'Please confirm you have read how your information is used.' };
  return writeSafely('registering', async () => {
    const token = newToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = newRef('A');
      try {
        const r = rows(await db.execute(sql`
          INSERT INTO samarth_applications (ref, category, country, timezone, contact_name, contact_email, org_name, consent_privacy, consent_contact, source, ai_assisted, access_hash)
          VALUES (${ref}, ${input.category}, ${input.country.toUpperCase()}, ${isTimeZone(input.timezone) ? input.timezone : null},
                  ${clean(input.contactName, 200)}, ${email}, ${clean(input.orgName, 300) || null}, ${!!input.consentPrivacy}, ${!!input.consentContact},
                  ${input.source || 'web'}, ${!!input.aiAssisted}, ${hashToken(token)})
          RETURNING id`))[0];
        const id = str(r?.id);
        await addEvent('application', id, { kind: 'status', to: 'DRAFT', body: 'Registered.', visibility: 'applicant', actor: { userId: null, name: clean(input.contactName, 200) } });
        await audit(SYSTEM_ACTOR, 'samarth.application.register', 'samarth_application', id, { ref, category: input.category, country: input.country });
        return { ok: true, id, ref, token };
      } catch (e: any) {
        const why = String(e?.cause?.message || e?.message || '');
        if (/duplicate key|unique/i.test(why) && attempt < 2) continue;
        throw e;
      }
    }
    return { ok: false, error: 'Could not issue a reference. Try again.' };
  });
}

/** Move an application, guarded, with the timeline and audit entries. Used by every status change. */
async function move(a: Application, to: string, actor: Actor, who: ActorRef, note: string | null, extra: GuardContext = {}, publicNote = true): Promise<Write> {
  const check = canTransition('application', a.status, to, actor, guardContext(a, extra), note);
  if (!check.ok) return { ok: false, error: check.error || 'That change is not allowed.' };
  const done = rows(await db.execute(sql`
    UPDATE samarth_applications SET status = ${to}, updated_at = NOW() WHERE id = ${a.id}::uuid AND status = ${a.status} RETURNING id`));
  if (!done.length) return { ok: false, error: 'This request changed a moment ago. Reload the page to see its current state.' };
  await addEvent('application', a.id, { kind: 'status', from: a.status, to, body: note || null, visibility: publicNote ? 'applicant' : 'internal', actor: who });
  await audit(who, 'samarth.application.status', 'samarth_application', a.id, { ref: a.ref, from: a.status, to, note: note ? note.slice(0, 300) : undefined });
  return { ok: true };
}

export async function saveDetails(a: Application, d: DetailsInput, who: ActorRef): Promise<Write> {
  if (!APPLICANT_EDITABLE.includes(a.status)) return { ok: false, error: 'Your details can no longer be changed here. Send the SAMARTH team a message instead.' };
  return writeSafely('saving your details', async () => {
    const categoryChanged = d.category !== a.category;
    await db.execute(sql`
      UPDATE samarth_applications SET
        category = ${d.category}, country = ${d.country}, region = ${d.region || null}, city = ${d.city || null}, timezone = ${d.timezone || null},
        contact_name = ${d.contactName}, contact_email = ${d.contactEmail}, contact_phone = ${d.contactPhone || null}, contact_role = ${d.contactRole || null},
        org_name = ${d.orgName || null}, org_website = ${d.orgWebsite || null}, org_registration = ${d.orgRegistration || null},
        turnover_band = ${d.turnoverBand || null}, official = ${d.official ? json(d.official) : null}::jsonb, updated_at = NOW()
      WHERE id = ${a.id}::uuid`);
    await audit(who, 'samarth.application.details', 'samarth_application', a.id, { ref: a.ref, categoryChanged });
    const fresh = await load(a.id);
    if (fresh && fresh.status === 'DRAFT') return move(fresh, 'DETAILS_COMPLETE', 'applicant', who, null);
    return { ok: true };
  });
}

export async function saveRequirements(a: Application, r: RequirementsInput, who: ActorRef): Promise<Write> {
  if (!APPLICANT_EDITABLE.includes(a.status) || a.status === 'DRAFT') {
    return { ok: false, error: a.status === 'DRAFT' ? 'Complete your details first.' : 'Your requirements can no longer be changed here. Send the SAMARTH team a message instead.' };
  }
  return writeSafely('saving your requirements', async () => {
    await db.execute(sql`
      UPDATE samarth_applications SET pathway = ${r.pathway}, need = ${r.need}, title = ${r.title}, summary = ${r.summary},
        requirements = ${json(r.answers)}::jsonb, documents = ${json(r.documents)}::jsonb, updated_at = NOW()
      WHERE id = ${a.id}::uuid`);
    await audit(who, 'samarth.application.requirements', 'samarth_application', a.id, { ref: a.ref, pathway: r.pathway, documents: r.documents.length });
    const fresh = await load(a.id);
    if (fresh && fresh.status === 'DETAILS_COMPLETE') return move(fresh, 'REQUIREMENTS_COMPLETE', 'applicant', who, null);
    return { ok: true };
  });
}

/** The applicant accepts the quoted fee and its terms. The snapshot is what they agreed to. */
export async function acceptFee(a: Application, snap: FeeSnapshot, totalMinor: number, who: ActorRef): Promise<Write> {
  return writeSafely('accepting the booking fee', async () => {
    const ctx = guardContext(a, { feeQuoted: totalMinor > 0, termsAccepted: true });
    const check = canTransition('application', a.status, 'FEE_PENDING', 'applicant', ctx);
    if (!check.ok) return { ok: false, error: check.error || 'The fee cannot be accepted now.' };
    const done = rows(await db.execute(sql`
      UPDATE samarth_applications SET status = 'FEE_PENDING', fee_schedule_id = ${snap.feeId}::uuid, fee_currency = ${snap.currency},
        fee_total_minor = ${totalMinor}, fee_snapshot = ${json(snap)}::jsonb, fee_terms_accepted_at = NOW(), payment_method = ${snap.method},
        payment_order_id = NULL, charged_inr_paise = NULL, fx_rate = NULL, fx_date = NULL, updated_at = NOW()
      WHERE id = ${a.id}::uuid AND status = 'REQUIREMENTS_COMPLETE' RETURNING id`));
    if (!done.length) return { ok: false, error: 'This request changed a moment ago. Reload the page.' };
    await addEvent('application', a.id, {
      kind: 'status', from: a.status, to: 'FEE_PENDING', visibility: 'applicant', actor: who,
      body: 'Booking fee accepted with its terms: ' + snap.currency + ' ' + totalMinor + ' minor units, to be paid ' + (snap.method === 'invoice' ? 'against an invoice' : 'online') + '.',
    });
    await audit(who, 'samarth.application.fee_accepted', 'samarth_application', a.id, { ref: a.ref, feeId: snap.feeId, currency: snap.currency, totalMinor, method: snap.method });
    return { ok: true };
  });
}

/** Back from FEE_PENDING to review the fee again, refused while a payment may be in flight. */
export async function reviseFee(a: Application, who: ActorRef, paymentPossiblyCaptured: boolean): Promise<Write> {
  if (paymentPossiblyCaptured) return { ok: false, error: 'A payment for this request may already have gone through. Wait a few minutes and reload, or contact the SAMARTH team before paying again.' };
  return writeSafely('reopening the fee step', async () => {
    const res = await move(a, 'REQUIREMENTS_COMPLETE', 'applicant', who, null);
    if (!res.ok) return res;
    await db.execute(sql`
      UPDATE samarth_applications SET fee_schedule_id = NULL, fee_currency = NULL, fee_total_minor = NULL, fee_snapshot = NULL,
        fee_terms_accepted_at = NULL, payment_method = NULL, payment_order_id = NULL, updated_at = NOW()
      WHERE id = ${a.id}::uuid AND status = 'REQUIREMENTS_COMPLETE'`);
    return { ok: true };
  });
}

export async function requestBooking(a: Application, b: Booking, who: ActorRef): Promise<Write> {
  return writeSafely('requesting the call', async () => {
    const check = canTransition('application', a.status, 'BOOKING_REQUESTED', 'applicant', guardContext(a, { slotsGiven: b.slots.length > 0 }));
    if (!check.ok) return { ok: false, error: check.error || 'The call cannot be requested now.' };
    const done = rows(await db.execute(sql`
      UPDATE samarth_applications SET status = 'BOOKING_REQUESTED', booking = ${json(b)}::jsonb, booking_requested_at = NOW(),
        timezone = COALESCE(${b.timezone || null}, timezone), updated_at = NOW()
      WHERE id = ${a.id}::uuid AND status = 'FEE_PAID' RETURNING id`));
    if (!done.length) return { ok: false, error: 'This request changed a moment ago. Reload the page.' };
    await addEvent('application', a.id, { kind: 'status', from: a.status, to: 'BOOKING_REQUESTED', visibility: 'applicant', actor: who, body: 'Call requested with ' + b.slots.length + ' preferred time(s) in ' + b.timezone + '.' });
    await audit(who, 'samarth.application.booking', 'samarth_application', a.id, { ref: a.ref, slots: b.slots.length });
    return { ok: true };
  });
}

export async function withdrawApplication(a: Application, who: ActorRef): Promise<Write> {
  return writeSafely('withdrawing', () => move(a, 'WITHDRAWN', 'applicant', who, 'Withdrawn by the applicant.'));
}

export async function applicantMessage(a: Application, body: string, who: ActorRef): Promise<Write> {
  const text = clean(body, 4000, true);
  if (text.length < 2) return { ok: false, error: 'Write a message first.' };
  return writeSafely('sending your message', async () => {
    await addEvent('application', a.id, { kind: 'reply', body: text, visibility: 'applicant', actor: who });
    await db.execute(sql`UPDATE samarth_applications SET updated_at = NOW() WHERE id = ${a.id}::uuid`);
    return { ok: true };
  });
}

export async function replaceAccessToken(id: string): Promise<Write<{ token: string }>> {
  return writeSafely('issuing a new link', async () => {
    const token = newToken();
    await db.execute(sql`UPDATE samarth_applications SET access_hash = ${hashToken(token)}, updated_at = NOW() WHERE id = ${id}::uuid`);
    return { ok: true, token };
  });
}

/** For "resend my link": the application only if the ref AND the email match. */
export async function findForResend(ref: string, email: string): Promise<Application | null> {
  const e = cleanEmail(email);
  if (!e) return null;
  const r = rows(await db.execute(sql`SELECT * FROM samarth_applications WHERE ref = ${ref} AND lower(contact_email) = ${e} LIMIT 1`))[0];
  return r ? toApplication(r) : null;
}

// -------------------------------------------------------------------------------------------------
// WRITES BY STAFF
// -------------------------------------------------------------------------------------------------

export async function staffTransition(id: string, to: string, note: string, who: ActorRef): Promise<Write> {
  return writeSafely('changing the status', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    return move(a, to, 'staff', who, note.trim() || null);
  });
}

export async function assignConsultant(id: string, c: { userId: string | null; name: string; email: string }, who: ActorRef): Promise<Write> {
  if (clean(c.name, 200).length < 2) return { ok: false, error: 'Choose a consultant.' };
  return writeSafely('assigning the consultant', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    if (!['BOOKING_REQUESTED', 'CONSULTANT_ASSIGNED', 'CALL_SCHEDULED'].includes(a.status)) {
      return { ok: false, error: 'A consultant is assigned once the applicant has paid the booking fee and requested a call.' };
    }
    await db.execute(sql`
      UPDATE samarth_applications SET consultant_user_id = ${isUuid(c.userId) ? c.userId : null}::uuid, consultant_name = ${clean(c.name, 200)},
        consultant_email = ${cleanEmail(c.email) || null}, assigned_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid`);
    await addEvent('application', id, { kind: 'assignment', body: 'Consultant: ' + clean(c.name, 200) + '.', visibility: 'applicant', actor: who });
    await audit(who, 'samarth.application.assign', 'samarth_application', id, { ref: a.ref, consultant: clean(c.name, 200) });
    if (a.status === 'BOOKING_REQUESTED') {
      const fresh = await load(id);
      if (fresh) return move(fresh, 'CONSULTANT_ASSIGNED', 'staff', who, null);
    }
    return { ok: true };
  });
}

export async function scheduleCall(id: string, at: Date, link: string | null, who: ActorRef): Promise<Write> {
  if (isNaN(at.getTime())) return { ok: false, error: 'Enter the call date and time.' };
  return writeSafely('scheduling the call', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    if (!['CONSULTANT_ASSIGNED', 'CALL_SCHEDULED'].includes(a.status)) return { ok: false, error: 'Assign a consultant before scheduling the call.' };
    await db.execute(sql`UPDATE samarth_applications SET call_at = ${at.toISOString()}::timestamptz, call_link = ${link || null}, updated_at = NOW() WHERE id = ${id}::uuid`);
    await addEvent('application', id, { kind: 'schedule', body: 'Call set for ' + at.toISOString() + (link ? ' (meeting link shared)' : '') + '.', visibility: 'applicant', actor: who });
    await audit(who, 'samarth.application.schedule', 'samarth_application', id, { ref: a.ref, at: at.toISOString() });
    if (a.status === 'CONSULTANT_ASSIGNED') {
      const fresh = await load(id);
      if (fresh) return move(fresh, 'CALL_SCHEDULED', 'staff', who, null);
    }
    return { ok: true };
  });
}

export async function completeCall(id: string, outcome: string, shareWithApplicant: boolean, who: ActorRef): Promise<Write> {
  return writeSafely('recording the call', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    const res = await move(a, 'CALL_COMPLETED', 'staff', who, null);
    if (!res.ok) return res;
    const text = clean(outcome, 6000, true);
    await db.execute(sql`UPDATE samarth_applications SET call_completed_at = NOW(), outcome_note = ${text || null}, updated_at = NOW() WHERE id = ${id}::uuid`);
    if (text) await addEvent('application', id, { kind: 'note', body: text, visibility: shareWithApplicant ? 'applicant' : 'internal', actor: who });
    return { ok: true };
  });
}

/**
 * Money received outside the gateway (a bank transfer against an invoice, for example). Staff
 * record it with the reference they reconciled; this is the only way a person can mark the fee
 * paid, and it is audited with that reference.
 */
export async function recordOfflineFeePayment(id: string, reference: string, note: string, who: ActorRef): Promise<Write> {
  const ref = clean(reference, 200);
  if (ref.length < 3) return { ok: false, error: 'Enter the payment reference you reconciled (bank reference, receipt or invoice number).' };
  return writeSafely('recording the payment', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    const check = canTransition('application', a.status, 'FEE_PAID', 'staff', guardContext(a, { paymentConfirmed: true }));
    if (!check.ok) return { ok: false, error: a.status === 'FEE_PAID' ? 'The fee is already recorded as paid.' : (check.error || 'The fee cannot be recorded now.') };
    const done = rows(await db.execute(sql`
      UPDATE samarth_applications SET status = 'FEE_PAID', paid_at = NOW(), payment_method = 'offline', payment_reference = ${ref}, updated_at = NOW()
       WHERE id = ${id}::uuid AND status = 'FEE_PENDING' RETURNING id`));
    if (!done.length) return { ok: false, error: 'This request changed a moment ago. Reload the page.' };
    await addEvent('application', id, { kind: 'payment', from: 'FEE_PENDING', to: 'FEE_PAID', visibility: 'applicant', actor: who, body: 'Booking fee payment received and recorded (reference ' + ref + ').' + (note ? ' ' + clean(note, 500) : '') });
    await audit(who, 'samarth.application.offline_payment', 'samarth_application', id, { ref: a.ref, reference: ref });
    return { ok: true };
  });
}

/** Called from the gateway paid-effect path. Idempotent: a second call changes nothing. */
export async function markFeePaidByGateway(id: string, orderId: string, paymentId: string | null): Promise<{ changed: boolean; app: Application | null }> {
  const done = rows(await db.execute(sql`
    UPDATE samarth_applications SET status = 'FEE_PAID', paid_at = NOW(), payment_method = 'online',
      payment_order_id = ${orderId}, payment_reference = ${paymentId || orderId}, updated_at = NOW()
     WHERE id = ${id}::uuid AND status = 'FEE_PENDING' RETURNING *`));
  if (done.length) {
    await addEvent('application', id, { kind: 'payment', from: 'FEE_PENDING', to: 'FEE_PAID', visibility: 'applicant', body: 'Booking fee payment confirmed by the payment provider.' });
    await audit(SYSTEM_ACTOR, 'samarth.application.paid', 'samarth_application', id, { orderId, paymentId });
    return { changed: true, app: toApplication(done[0]) };
  }
  return { changed: false, app: await load(id) };
}

export async function setApplicationInvoice(id: string, invoiceId: string, who: ActorRef): Promise<void> {
  await db.execute(sql`UPDATE samarth_applications SET invoice_id = ${invoiceId}::uuid, updated_at = NOW() WHERE id = ${id}::uuid`);
  await addEvent('application', id, { kind: 'system', body: 'Invoice raised.', visibility: 'internal', actor: who });
}

export async function staffMessage(id: string, body: string, toApplicant: boolean, who: ActorRef): Promise<Write> {
  const text = clean(body, 5000, true);
  if (text.length < 2) return { ok: false, error: 'Write the message first.' };
  return writeSafely('saving the message', async () => {
    const a = await load(id);
    if (!a) return { ok: false, error: 'That request no longer exists.' };
    await addEvent('application', id, { kind: toApplicant ? 'message' : 'note', body: text, visibility: toApplicant ? 'applicant' : 'internal', actor: who });
    await audit(who, toApplicant ? 'samarth.application.message' : 'samarth.application.note', 'samarth_application', id, { ref: a.ref });
    return { ok: true };
  });
}

export async function setArchived(id: string, archived: boolean, who: ActorRef): Promise<Write> {
  return writeSafely('archiving', async () => {
    await db.execute(sql`UPDATE samarth_applications SET archived = ${archived}, updated_at = NOW() WHERE id = ${id}::uuid`);
    await addEvent('application', id, { kind: 'system', body: archived ? 'Archived (hidden from the default list, nothing deleted).' : 'Restored from the archive.', actor: who });
    await audit(who, archived ? 'samarth.application.archive' : 'samarth.application.restore', 'samarth_application', id);
    return { ok: true };
  });
}
