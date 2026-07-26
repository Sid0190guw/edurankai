// src/lib/aquin-partners.ts — AquinTutor's accredited-partner registry (spec §5). AquinTutor builds
// partnerships instead of infrastructure: practical competencies are completed at accredited partners
// and assessed jointly. Real organizations only — no seeded fake partners; an empty category shows an
// honest "being established" state.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export interface PartnerType { key: string; label: string; blurb: string; }
export const PARTNER_TYPES: PartnerType[] = [
  { key: 'academic', label: 'Academic', blurb: 'Universities, colleges, libraries and innovation hubs.' },
  { key: 'industry', label: 'Industry', blurb: 'Firms, plants, engineering & testing facilities, maker spaces — for industry projects and partner labs.' },
  { key: 'hospital', label: 'Health', blurb: 'Teaching hospitals, clinics, PHCs/CHCs, diagnostic labs and simulation centres — for clinical rotations.' },
  { key: 'research', label: 'Research', blurb: 'National labs, research institutes and R&D centres — for research-intensive practical work.' },
  { key: 'remote_lab', label: 'Remote labs', blurb: 'Remote FPGA, PLC, oscilloscope and circuit-simulation providers.' },
  { key: 'studio', label: 'Creative studios', blurb: 'Design firms, production houses and studios — for creative-discipline practice.' },
  { key: 'field', label: 'Field', blurb: 'NGOs, government agencies, farms and local research centres — for supervised fieldwork.' },
  { key: 'sports_wellness', label: 'Sports & wellness', blurb: 'Sports clubs, fitness centres, martial-arts academies, yoga, swimming and performing arts — for holistic development.' },
  { key: 'community', label: 'Community', blurb: 'NGOs, community organizations, volunteer groups, incubators and local businesses.' },
];
export function partnerTypeLabel(key: string): string { return (PARTNER_TYPES.find((t) => t.key === key) || { label: key }).label; }

export const MOU_STATUS = [
  { key: 'prospective', label: 'Prospective' },
  { key: 'mou_signed', label: 'MoU signed' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
] as const;

let _ready: Promise<void> | null = null;
export function ensurePartnersSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aquin_partners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'academic',
        accreditation TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        capacity INT,
        mou_status TEXT NOT NULL DEFAULT 'prospective',
        website TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        is_published BOOLEAN NOT NULL DEFAULT true,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aquin_partners_type_idx ON aquin_partners (type, name)`);
    } catch (_) { _ready = null; }
  })();
  return _ready;
}

export interface Partner {
  id: string; name: string; type: string; accreditation: string; location: string;
  capacity: number | null; mouStatus: string; website: string; description: string;
}
function toPartner(r: any): Partner {
  return {
    id: String(r.id), name: r.name, type: r.type, accreditation: r.accreditation || '', location: r.location || '',
    capacity: r.capacity != null ? Number(r.capacity) : null, mouStatus: r.mou_status || 'prospective',
    website: r.website || '', description: r.description || '',
  };
}

export async function listPartners(opts: { publishedOnly?: boolean } = {}): Promise<Partner[]> {
  await ensurePartnersSchema();
  const where = opts.publishedOnly ? sql`WHERE is_published = true` : sql``;
  return rows(await db.execute(sql`SELECT * FROM aquin_partners ${where} ORDER BY type ASC, name ASC`)).map(toPartner);
}

/** Partners grouped by ecosystem category (all categories present, even when empty). */
export async function partnersByType(publishedOnly = true): Promise<{ type: PartnerType; partners: Partner[] }[]> {
  const all = await listPartners({ publishedOnly });
  return PARTNER_TYPES.map((type) => ({ type, partners: all.filter((p) => p.type === type.key) }));
}

export async function addPartner(p: {
  name: string; type: string; accreditation?: string; location?: string; capacity?: number | null;
  mouStatus?: string; website?: string; description?: string; createdBy?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const name = String(p.name || '').trim();
  if (name.length < 2) return { ok: false, error: 'Partner name is required.' };
  const type = PARTNER_TYPES.some((t) => t.key === p.type) ? p.type : 'academic';
  const mou = MOU_STATUS.some((m) => m.key === p.mouStatus) ? p.mouStatus! : 'prospective';
  await ensurePartnersSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO aquin_partners (name, type, accreditation, location, capacity, mou_status, website, description, created_by)
    VALUES (${name.slice(0, 200)}, ${type}, ${String(p.accreditation || '').slice(0, 200)}, ${String(p.location || '').slice(0, 200)},
      ${p.capacity != null && Number.isFinite(p.capacity) ? Math.max(0, Math.floor(p.capacity)) : null}, ${mou},
      ${String(p.website || '').slice(0, 300)}, ${String(p.description || '').slice(0, 1000)}, ${p.createdBy || null})
    RETURNING id`));
  return { ok: true, id: String(r[0]?.id || '') };
}
