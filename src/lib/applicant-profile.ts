// Persistent applicant profile.
//
// Application drafts are wiped on submit (deleteDraft), so every new application
// started from scratch — applicants re-typed their name, email, phone, city,
// links, etc. every time. This stores the common personal info ONCE per user so
// the next application pre-fills automatically (like every serious hiring
// platform). It is also the backing store for the public, LinkedIn-style
// profile (headline / bio / skills / links + a share toggle + slug) — those
// columns exist now so Phase 2 (the profile page) needs no migration.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export function ensureApplicantProfileSchema(): Promise<void> {
  return ensureOnce('applicant_profiles_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS applicant_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      common JSONB NOT NULL DEFAULT '{}'::jsonb,
      headline TEXT,
      bio TEXT,
      skills TEXT[],
      links JSONB,
      experience JSONB,
      education JSONB,
      is_public BOOLEAN NOT NULL DEFAULT false,
      slug VARCHAR(60) UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  });
}

/** Full profile row (or null). */
export async function getApplicantProfile(userId: string): Promise<any | null> {
  try {
    await ensureApplicantProfileSchema();
    return rows(await db.execute(sql`SELECT * FROM applicant_profiles WHERE user_id = ${userId} LIMIT 1`))[0] || null;
  } catch (e: any) {
    console.error('[applicant-profile] get', e?.cause?.message || e?.message);
    return null;
  }
}

/** Just the saved common fields (for pre-filling an application). {} if none. */
export async function getProfileCommon(userId: string): Promise<Record<string, any>> {
  const p = await getApplicantProfile(userId);
  return (p && p.common && typeof p.common === 'object') ? p.common : {};
}

/** Save/merge the common personal info captured from application step 1. */
export async function saveCommonFromStep1(userId: string, email: string, common: Record<string, any>): Promise<void> {
  try {
    await ensureApplicantProfileSchema();
    const json = JSON.stringify(common || {});
    await db.execute(sql`
      INSERT INTO applicant_profiles (user_id, common, updated_at)
      VALUES (${userId}, ${json}::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET common = applicant_profiles.common || ${json}::jsonb,
            updated_at = NOW()
    `);
  } catch (e: any) {
    console.error('[applicant-profile] saveCommon', e?.cause?.message || e?.message);
  }
}

function slugify(s: string): string {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

async function ensureRow(userId: string): Promise<void> {
  await db.execute(sql`INSERT INTO applicant_profiles (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
}

export interface ProfilePatch {
  headline?: string | null;
  bio?: string | null;
  skills?: string[] | null;
  links?: any;
  experience?: any;
  education?: any;
  common?: Record<string, any> | null;
}

/** Full update of editable profile fields (portal self-edit or admin edit). */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<void> {
  await ensureApplicantProfileSchema();
  await ensureRow(userId);
  await db.execute(sql`
    UPDATE applicant_profiles SET
      headline = ${patch.headline ?? null},
      bio = ${patch.bio ?? null},
      skills = ${(patch.skills && patch.skills.length ? patch.skills : null) as any}::text[],
      links = ${patch.links ? JSON.stringify(patch.links) : null}::jsonb,
      experience = ${patch.experience ? JSON.stringify(patch.experience) : null}::jsonb,
      education = ${patch.education ? JSON.stringify(patch.education) : null}::jsonb,
      common = COALESCE(${patch.common ? JSON.stringify(patch.common) : null}::jsonb, common),
      updated_at = NOW()
    WHERE user_id = ${userId}
  `);
}

/** Toggle public visibility; mints a stable unique slug the first time. */
export async function setProfilePublic(userId: string, isPublic: boolean, displayName: string): Promise<string | null> {
  await ensureApplicantProfileSchema();
  await ensureRow(userId);
  let slug: string | null = rows(await db.execute(sql`SELECT slug FROM applicant_profiles WHERE user_id = ${userId}`))[0]?.slug || null;
  if (isPublic && !slug) {
    const base = slugify(displayName) || 'member';
    for (let i = 0; i < 40; i++) {
      const cand = i === 0 ? base : base + '-' + Math.random().toString(36).slice(2, 6);
      const taken = rows(await db.execute(sql`SELECT 1 FROM applicant_profiles WHERE slug = ${cand} AND user_id <> ${userId}`))[0];
      if (!taken) { slug = cand; break; }
    }
  }
  await db.execute(sql`UPDATE applicant_profiles SET is_public = ${isPublic}, slug = ${slug}, updated_at = NOW() WHERE user_id = ${userId}`);
  return slug;
}

/** Public profile by slug (only when is_public). Joins the account email. */
export async function getProfileBySlug(slug: string): Promise<any | null> {
  try {
    await ensureApplicantProfileSchema();
    return rows(await db.execute(sql`
      SELECT p.*, u.email FROM applicant_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.slug = ${slug} AND p.is_public = true LIMIT 1
    `))[0] || null;
  } catch { return null; }
}

/** Admin: list profiles with light search. */
export async function listApplicantProfiles(q = ''): Promise<any[]> {
  try {
    await ensureApplicantProfileSchema();
    const like = '%' + q + '%';
    const r = await db.execute(sql`
      SELECT p.user_id, p.headline, p.is_public, p.slug, p.updated_at, u.email,
             COALESCE(p.common->>'firstName','') AS first_name,
             COALESCE(p.common->>'lastName','') AS last_name
      FROM applicant_profiles p JOIN users u ON u.id = p.user_id
      ${q ? sql`WHERE u.email ILIKE ${like} OR p.common->>'firstName' ILIKE ${like} OR p.common->>'lastName' ILIKE ${like} OR COALESCE(p.headline,'') ILIKE ${like}` : sql``}
      ORDER BY p.updated_at DESC LIMIT 300
    `);
    return rows(r);
  } catch { return []; }
}

/** Admin: delete a profile entirely. */
export async function deleteApplicantProfile(userId: string): Promise<void> {
  await ensureApplicantProfileSchema();
  await db.execute(sql`DELETE FROM applicant_profiles WHERE user_id = ${userId}`);
}
