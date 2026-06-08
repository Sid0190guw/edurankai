// Professional network — individuals, organisations, and services.
// LinkedIn-shape but profile-led, no algorithmic noise. Self-bootstrap schema.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureNetworkSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS network_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(120) NOT NULL UNIQUE,
        user_id UUID,
        kind VARCHAR(20) NOT NULL DEFAULT 'individual',
          -- individual | organisation | service
        display_name VARCHAR(200) NOT NULL,
        tagline VARCHAR(300),
        bio TEXT,
        avatar_url TEXT,
        cover_url TEXT,
        location VARCHAR(120),
        website_url TEXT,
        contact_email VARCHAR(200),
        contact_phone VARCHAR(40),
        skills JSONB DEFAULT '[]'::jsonb,
        languages JSONB DEFAULT '[]'::jsonb,
        services_offered JSONB DEFAULT '[]'::jsonb,
          -- for kind=service or kind=organisation
        seniority VARCHAR(40),
          -- junior | mid | senior | leadership | executive
        years_experience INT,
        open_to JSONB DEFAULT '[]'::jsonb,
          -- e.g. ['placement','mentoring','consulting','collaboration']
        is_verified BOOLEAN NOT NULL DEFAULT false,
        is_public BOOLEAN NOT NULL DEFAULT true,
        view_count INT NOT NULL DEFAULT 0,
        connection_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS np_kind_idx ON network_profiles(kind, is_public)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS np_user_idx ON network_profiles(user_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS network_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_profile_id UUID NOT NULL REFERENCES network_profiles(id) ON DELETE CASCADE,
        target_profile_id UUID NOT NULL REFERENCES network_profiles(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | accepted | declined
        message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ,
        UNIQUE(requester_profile_id, target_profile_id)
      )`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS network_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_profile_id UUID NOT NULL REFERENCES network_profiles(id) ON DELETE CASCADE,
        to_profile_id UUID NOT NULL REFERENCES network_profiles(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS nm_to_idx ON network_messages(to_profile_id, created_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

export async function listProfiles(opts: { kind?: string; q?: string; openTo?: string } = {}) {
  await ensureNetworkSchema();
  const like = '%' + (opts.q || '').trim() + '%';
  return rows(await db.execute(sql`
    SELECT * FROM network_profiles
    WHERE is_public = true
      ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
      ${opts.q ? sql`AND (display_name ILIKE ${like} OR tagline ILIKE ${like} OR bio ILIKE ${like})` : sql``}
      ${opts.openTo ? sql`AND open_to::jsonb ? ${opts.openTo}` : sql``}
    ORDER BY is_verified DESC, connection_count DESC, view_count DESC LIMIT 200
  `));
}

export async function getProfile(slug: string) {
  await ensureNetworkSchema();
  const r = rows(await db.execute(sql`SELECT * FROM network_profiles WHERE slug = ${slug} LIMIT 1`));
  if (r[0]) await db.execute(sql`UPDATE network_profiles SET view_count = view_count + 1 WHERE id = ${r[0].id}`).catch(() => {});
  return r[0] || null;
}

export async function createProfile(opts: any) {
  await ensureNetworkSchema();
  const skillsJson = JSON.stringify(opts.skills || []);
  const langJson = JSON.stringify(opts.languages || []);
  const servicesJson = JSON.stringify(opts.servicesOffered || []);
  const openToJson = JSON.stringify(opts.openTo || []);
  const r = rows(await db.execute(sql`
    INSERT INTO network_profiles (slug, user_id, kind, display_name, tagline, bio, avatar_url, cover_url,
      location, website_url, contact_email, contact_phone, skills, languages, services_offered,
      seniority, years_experience, open_to)
    VALUES (${opts.slug}, ${opts.userId || null}, ${opts.kind || 'individual'}, ${opts.displayName},
      ${opts.tagline || null}, ${opts.bio || null}, ${opts.avatarUrl || null}, ${opts.coverUrl || null},
      ${opts.location || null}, ${opts.websiteUrl || null}, ${opts.contactEmail || null}, ${opts.contactPhone || null},
      ${skillsJson}::jsonb, ${langJson}::jsonb, ${servicesJson}::jsonb,
      ${opts.seniority || null}, ${opts.yearsExperience || null}, ${openToJson}::jsonb)
    RETURNING id, slug
  `));
  return { ok: true, id: r[0]?.id, slug: r[0]?.slug };
}
