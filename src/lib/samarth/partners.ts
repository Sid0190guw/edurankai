// The SAMARTH technology partner registry (spec Part 8): companies, engineers, laboratories,
// manufacturers and technology providers who may be selected to deliver work.
//
// REGISTRATION IS NOT APPROVAL, AND APPROVAL IS NOT AN AWARD. A partner reaches APPROVED only
// through due diligence (every required check passed or not applicable, nothing failed), and an
// approved partner is only ever ELIGIBLE: a person names them on a specific quotation, and the
// client sees that, with the responsibility statement, before accepting. Nothing here assigns work.
//
// Claimed certifications and credentials are stored as the partner's own claims and shown as such
// until the due-diligence item that checks them has passed.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { canTransition, dueDiligenceComplete, DUE_DILIGENCE_ITEMS, type DdState } from '@/lib/samarth/workflow';
import { ENGINEERING_DOMAINS } from '@/lib/samarth/catalog';
import { clean, cleanEmail, cleanPhone, cleanUrl, isCountryCode, newRef, newToken, hashToken, type DocLink } from '@/lib/samarth/validate';
import {
  rows, readSafely, writeSafely, num, iso, str, isUuid, json, addEvent, audit,
  type Read, type Write, type ActorRef, SYSTEM_ACTOR,
} from '@/lib/samarth/store-core';

export const PARTNER_KINDS: readonly { value: string; label: string }[] = [
  { value: 'company', label: 'Engineering or technology company' },
  { value: 'laboratory', label: 'Laboratory or research institution' },
  { value: 'manufacturer', label: 'Manufacturer' },
  { value: 'provider', label: 'Technology or infrastructure provider' },
  { value: 'consultancy', label: 'Specialist consultancy' },
  { value: 'individual', label: 'Independent engineer or specialist' },
];

/** The domains a partner can claim: the engineering domains of the service catalogue. */
export const PARTNER_DOMAINS: readonly { value: string; label: string }[] = ENGINEERING_DOMAINS.map((d) => ({ value: d.id, label: d.title }));

export interface Partner {
  id: string; ref: string; status: string; orgName: string; orgKind: string; country: string; website: string;
  contactName: string; contactEmail: string; contactPhone: string; domains: string[];
  capabilities: string; qualifications: string; certifications: string; previousProjects: string;
  regulatory: string; security: string; commercial: string; documents: DocLink[];
  ddChecklist: Record<string, DdState>; rating: number | null; performanceNote: string;
  accessHash: string; createdAt: string | null; updatedAt: string | null;
}

export const toPartner = (r: any): Partner => ({
  id: str(r.id), ref: str(r.ref), status: str(r.status), orgName: str(r.org_name), orgKind: str(r.org_kind), country: str(r.country), website: str(r.website),
  contactName: str(r.contact_name), contactEmail: str(r.contact_email), contactPhone: str(r.contact_phone),
  domains: Array.isArray(r.domains) ? r.domains.map(String) : [],
  capabilities: str(r.capabilities), qualifications: str(r.qualifications), certifications: str(r.certifications), previousProjects: str(r.previous_projects),
  regulatory: str(r.regulatory), security: str(r.security), commercial: str(r.commercial), documents: Array.isArray(r.documents) ? r.documents : [],
  ddChecklist: (r.dd_checklist && typeof r.dd_checklist === 'object') ? r.dd_checklist : {}, rating: num(r.rating), performanceNote: str(r.performance_note),
  accessHash: str(r.access_hash), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export interface PartnerInput {
  orgName: string; orgKind: string; country: string; website: string; contactName: string; contactEmail: string; contactPhone: string;
  domains: string[]; capabilities: string; qualifications: string; certifications: string; previousProjects: string;
  regulatory: string; security: string; commercial: string; documents: DocLink[]; consentPrivacy: boolean;
}

export function parsePartner(get: (n: string) => string, getAll: (n: string) => string[], documents: DocLink[]): { value: PartnerInput; problems: string[] } {
  const problems: string[] = [];
  const email = cleanEmail(get('contact_email'));
  const phoneRaw = clean(get('contact_phone'), 32);
  const siteRaw = clean(get('website'), 800);
  const value: PartnerInput = {
    orgName: clean(get('org_name'), 300), orgKind: clean(get('org_kind'), 40), country: clean(get('country'), 2).toUpperCase(),
    website: (siteRaw && cleanUrl(siteRaw)) || '', contactName: clean(get('contact_name'), 200), contactEmail: email || '',
    contactPhone: (phoneRaw && cleanPhone(phoneRaw)) || '',
    domains: getAll('domains').map((d) => clean(d, 40)).filter((d) => PARTNER_DOMAINS.some((x) => x.value === d)).slice(0, 10),
    capabilities: clean(get('capabilities'), 6000, true), qualifications: clean(get('qualifications'), 4000, true),
    certifications: clean(get('certifications'), 4000, true), previousProjects: clean(get('previous_projects'), 6000, true),
    regulatory: clean(get('regulatory'), 4000, true), security: clean(get('security'), 4000, true), commercial: clean(get('commercial'), 4000, true),
    documents, consentPrivacy: get('consent_privacy') === 'yes',
  };
  if (value.orgName.length < 2) problems.push('Enter the organisation name.');
  if (!PARTNER_KINDS.some((k) => k.value === value.orgKind)) problems.push('Choose what kind of partner you are.');
  if (!isCountryCode(value.country)) problems.push('Choose your country.');
  if (siteRaw && !value.website) problems.push('The website must be a full address starting with https://');
  if (value.contactName.length < 2) problems.push('Enter a contact name.');
  if (!email) problems.push('Enter a valid email address.');
  if (phoneRaw && !value.contactPhone) problems.push('That phone number does not look right.');
  if (!value.domains.length) problems.push('Choose at least one domain you work in.');
  if (value.capabilities.length < 40) problems.push('Describe your technical capabilities (a few sentences).');
  if (!value.consentPrivacy) problems.push('Please confirm you have read how your information is used.');
  return { value, problems };
}

export async function registerPartner(p: PartnerInput): Promise<Write<{ id: string; ref: string; token: string }>> {
  return writeSafely('registering the partner', async () => {
    const token = newToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = newRef('P');
      try {
        const r = rows(await db.execute(sql`
          INSERT INTO samarth_partners (ref, org_name, org_kind, country, website, contact_name, contact_email, contact_phone, domains, capabilities,
            qualifications, certifications, previous_projects, regulatory, security, commercial, documents, consent_privacy, access_hash)
          VALUES (${ref}, ${p.orgName}, ${p.orgKind}, ${p.country}, ${p.website || null}, ${p.contactName}, ${p.contactEmail}, ${p.contactPhone || null},
            ${json(p.domains)}::jsonb, ${p.capabilities}, ${p.qualifications || null}, ${p.certifications || null}, ${p.previousProjects || null},
            ${p.regulatory || null}, ${p.security || null}, ${p.commercial || null}, ${json(p.documents)}::jsonb, ${p.consentPrivacy}, ${hashToken(token)})
          RETURNING id`))[0];
        const id = str(r?.id);
        await addEvent('partner', id, { kind: 'status', to: 'REGISTERED', body: 'Registration received.', visibility: 'applicant', actor: { userId: null, name: p.contactName } });
        await audit(SYSTEM_ACTOR, 'samarth.partner.register', 'samarth_partner', id, { ref, country: p.country });
        return { ok: true, id, ref, token };
      } catch (e: any) {
        if (/duplicate key|unique/i.test(String(e?.cause?.message || e?.message || '')) && attempt < 2) continue;
        throw e;
      }
    }
    return { ok: false, error: 'Could not issue a reference. Try again.' };
  });
}

export async function getPartner(id: string): Promise<Read<Partner | null>> {
  if (!isUuid(id)) return { ready: true, value: null };
  return readSafely('the partner', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_partners WHERE id = ${id}::uuid LIMIT 1`))[0];
    return r ? toPartner(r) : null;
  });
}

export async function getPartnerByRef(ref: string): Promise<Read<Partner | null>> {
  return readSafely('the partner', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_partners WHERE ref = ${ref} LIMIT 1`))[0];
    return r ? toPartner(r) : null;
  });
}

export async function partnersByIds(ids: string[]): Promise<Partner[]> {
  const list = ids.filter(isUuid).slice(0, 20);
  if (!list.length) return [];
  return rows(await db.execute(sql`SELECT * FROM samarth_partners WHERE id IN (SELECT (jsonb_array_elements_text(${json(list)}::jsonb))::uuid)`)).map(toPartner);
}

export async function approvedPartners(): Promise<Read<Partner[]>> {
  return readSafely('approved partners', async () =>
    rows(await db.execute(sql`SELECT * FROM samarth_partners WHERE status = 'APPROVED' ORDER BY org_name LIMIT 500`)).map(toPartner));
}

export async function listPartners(f: { q?: string; status?: string; domain?: string; cursor?: string; limit?: number } = {}): Promise<Read<{ items: Partner[]; next: string | null }>> {
  const limit = Math.max(1, Math.min(5000, f.limit || 50));
  const q = clean(f.q, 120);
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const [cTs, cId] = String(f.cursor || '').split('|');
  const hasCursor = !!iso(cTs) && isUuid(cId);
  return readSafely('partners', async () => {
    const r = rows(await db.execute(sql`
      SELECT * FROM samarth_partners
       WHERE (${f.status || ''} = '' OR status = ${f.status || ''})
         AND (${f.domain || ''} = '' OR domains ? ${f.domain || ''})
         AND (${q} = '' OR ref ILIKE ${like} OR org_name ILIKE ${like} OR contact_name ILIKE ${like} OR contact_email ILIKE ${like}
              OR capabilities ILIKE ${like} OR certifications ILIKE ${like} OR previous_projects ILIKE ${like})
         AND (${hasCursor} = false OR (created_at, id) < (${hasCursor ? iso(cTs) : null}::timestamptz, ${hasCursor ? cId : null}::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`));
    const items = r.slice(0, limit).map(toPartner);
    const last = items[items.length - 1];
    return { items, next: r.length > limit && last ? last.createdAt + '|' + last.id : null };
  });
}

export async function saveDueDiligence(id: string, checklist: Record<string, DdState>, who: ActorRef): Promise<Write> {
  const clean: Record<string, DdState> = {};
  for (const item of DUE_DILIGENCE_ITEMS) {
    const v = checklist[item.key];
    clean[item.key] = v === 'pass' || v === 'fail' || v === 'na' ? v : 'pending';
  }
  return writeSafely('saving due diligence', async () => {
    const done = rows(await db.execute(sql`UPDATE samarth_partners SET dd_checklist = ${json(clean)}::jsonb, updated_at = NOW() WHERE id = ${id}::uuid RETURNING ref`));
    if (!done.length) return { ok: false, error: 'That partner no longer exists.' };
    await addEvent('partner', id, { kind: 'note', body: 'Due diligence updated: ' + DUE_DILIGENCE_ITEMS.map((i) => i.label.split(' ')[0] + ' ' + clean[i.key]).join(', ') + '.', actor: who });
    await audit(who, 'samarth.partner.due_diligence', 'samarth_partner', id, { checklist: clean });
    return { ok: true };
  });
}

export async function savePerformance(id: string, rating: number | null, note: string, who: ActorRef): Promise<Write> {
  const r = rating == null ? null : Math.max(1, Math.min(5, Math.round(rating)));
  return writeSafely('saving the performance note', async () => {
    await db.execute(sql`UPDATE samarth_partners SET rating = ${r}, performance_note = ${clean(note, 4000, true) || null}, updated_at = NOW() WHERE id = ${id}::uuid`);
    await addEvent('partner', id, { kind: 'note', body: 'Performance recorded' + (r ? ': ' + r + ' of 5' : '') + '.', actor: who });
    await audit(who, 'samarth.partner.performance', 'samarth_partner', id, { rating: r });
    return { ok: true };
  });
}

export async function transitionPartner(id: string, to: string, note: string, who: ActorRef): Promise<Write> {
  return writeSafely('changing the partner status', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_partners WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'That partner no longer exists.' };
    const p = toPartner(r);
    const check = canTransition('partner', p.status, to, 'staff', { dueDiligenceComplete: dueDiligenceComplete(p.ddChecklist) }, note);
    if (!check.ok) return { ok: false, error: check.error || 'That change is not allowed.' };
    const done = rows(await db.execute(sql`UPDATE samarth_partners SET status = ${to}, updated_at = NOW() WHERE id = ${id}::uuid AND status = ${p.status} RETURNING id`));
    if (!done.length) return { ok: false, error: 'This partner changed a moment ago. Reload the page.' };
    await addEvent('partner', id, { kind: 'status', from: p.status, to, body: note.trim() || null, visibility: 'applicant', actor: who });
    await audit(who, 'samarth.partner.status', 'samarth_partner', id, { ref: p.ref, from: p.status, to });
    return { ok: true };
  });
}

export async function partnerNote(id: string, body: string, toPartner: boolean, who: ActorRef): Promise<Write> {
  const text = clean(body, 5000, true);
  if (text.length < 2) return { ok: false, error: 'Write the note first.' };
  return writeSafely('saving the note', async () => {
    await addEvent('partner', id, { kind: toPartner ? 'message' : 'note', body: text, visibility: toPartner ? 'applicant' : 'internal', actor: who });
    return { ok: true };
  });
}
