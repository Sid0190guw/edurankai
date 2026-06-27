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
