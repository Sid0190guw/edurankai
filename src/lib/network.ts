// src/lib/network.ts — the professional directory: profile-led, no feed, no ranking algorithm.
//
// WHAT WAS WRONG. createProfile() was the ONLY INSERT into network_profiles in the entire repository
// and nothing called it. The two reading surfaces —
// /aquintutor/careerflow/network (listProfiles) and /u/[slug] (getProfile) — were therefore
// structurally incapable of showing anything: the directory could only ever render an empty grid,
// and every /u/<slug> address was a 404 by construction. The empty state said "Be the first to
// publish a profile in this category" over a button pointing at /aquintutor/profile, a page that
// edits the account's name and password and has never written a network profile.
//
// network_connections and network_messages were CREATEd here and never read or written by anything
// at all. Their CREATE statements have been REMOVED rather than left standing: a table with no
// reader and no writer is a promise of a feature that does not exist, and this file was making that
// promise twice. (Removing a CREATE TABLE IF NOT EXISTS is not a DROP — any database that already
// has those two empty tables keeps them untouched. Connections and messaging are named as a
// follow-up in the build report instead of being implied by schema.)
//
// WHAT IT IS NOW. One writer, reachable from /aquintutor/profile ("Your public profile"), which is
// exactly where the directory's empty state already pointed. upsertProfile() creates on first save
// and updates thereafter, keyed on the signed-in user, so a person cannot accidentally publish two
// profiles and cannot edit anybody else's.
//
// EVERY READ IS DISCRIMINATED. listProfiles() used to return a bare array from a query whose schema
// ensure swallowed its own failure; an unreachable database and an empty directory rendered the
// identical page. They are different facts and they need different words.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real Postgres reason is on e.cause; e.message is only the failed statement. */
function reasonOf(e: any): string { return String(e?.cause?.message || e?.message || 'unknown error'); }
function logFail(tag: string, e: any): string {
  const reason = reasonOf(e);
  console.error('[network] ' + tag, reason);
  return reason;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export const PROFILE_KINDS = ['individual', 'organisation', 'service'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const SENIORITIES = ['junior', 'mid', 'senior', 'leadership', 'executive'] as const;
export const OPEN_TO = ['placement', 'mentoring', 'consulting', 'collaboration', 'hiring'] as const;

export function ensureNetworkSchema(): Promise<void> {
  return ensureOnce('network_profiles_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS network_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(120) NOT NULL UNIQUE,
        user_id UUID,
        kind VARCHAR(20) NOT NULL DEFAULT 'individual',
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
        seniority VARCHAR(40),
        years_experience INT,
        open_to JSONB DEFAULT '[]'::jsonb,
        is_verified BOOLEAN NOT NULL DEFAULT false,
        is_public BOOLEAN NOT NULL DEFAULT true,
        view_count INT NOT NULL DEFAULT 0,
        connection_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS np_kind_idx ON network_profiles(kind, is_public)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS np_user_idx ON network_profiles(user_id)`);
    } catch (e: any) {
      logFail('ensureNetworkSchema', e);
      throw e; // ensureOnce drops the failed run so the next request retries
    }
  });
}

export interface NetworkProfile {
  id: string;
  slug: string;
  userId: string | null;
  kind: ProfileKind;
  displayName: string;
  tagline: string | null;
  bio: string | null;
  location: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  skills: string[];
  languages: string[];
  servicesOffered: string[];
  seniority: string | null;
  yearsExperience: number | null;
  openTo: string[];
  isVerified: boolean;
  isPublic: boolean;
  viewCount: number;
  /**
   * NOT a count of accepted connections — nothing in this codebase creates a connection. It is the
   * stored column, which is 0 for every row, and no surface presents it as a social number.
   */
  connectionCount: number;
}

function toProfile(r: any): NetworkProfile {
  const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    id: String(r.id),
    slug: String(r.slug),
    userId: r.user_id ? String(r.user_id) : null,
    kind: (PROFILE_KINDS.includes(r.kind) ? r.kind : 'individual') as ProfileKind,
    displayName: String(r.display_name || ''),
    tagline: r.tagline || null,
    bio: r.bio || null,
    location: r.location || null,
    websiteUrl: r.website_url || null,
    contactEmail: r.contact_email || null,
    skills: arr(r.skills),
    languages: arr(r.languages),
    servicesOffered: arr(r.services_offered),
    seniority: r.seniority || null,
    yearsExperience: r.years_experience == null ? null : Number(r.years_experience),
    openTo: arr(r.open_to),
    isVerified: !!r.is_verified,
    isPublic: !!r.is_public,
    viewCount: Number(r.view_count || 0),
    connectionCount: Number(r.connection_count || 0),
  };
}

export function slugifyName(s: string): string {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110);
}

export async function listProfiles(opts: { kind?: string; q?: string; openTo?: string } = {}): Promise<Result<NetworkProfile[]>> {
  try {
    await ensureNetworkSchema();
    const like = '%' + (opts.q || '').trim() + '%';
    const r = await db.execute(sql`
      SELECT * FROM network_profiles
      WHERE is_public = true
        ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
        ${opts.q ? sql`AND (display_name ILIKE ${like} OR tagline ILIKE ${like} OR bio ILIKE ${like})` : sql``}
        ${opts.openTo ? sql`AND open_to::jsonb ? ${opts.openTo}` : sql``}
      ORDER BY is_verified DESC, updated_at DESC, view_count DESC LIMIT 200
    `);
    return { ok: true, value: rows(r).map(toProfile) };
  } catch (e: any) {
    return { ok: false, reason: logFail('listProfiles', e) };
  }
}

/**
 * One public profile. value is null when there is no such address — distinct from { ok:false },
 * which means we could not find out.
 *
 * The view counter is bumped on a best-effort basis and its failure is LOGGED rather than dropped
 * into a bare `.catch(() => {})`: a counter that silently stops moving is how a page ends up
 * reporting a number that has quietly been frozen for months.
 */
export async function getProfile(slug: string): Promise<Result<NetworkProfile | null>> {
  if (!slug) return { ok: true, value: null };
  try {
    await ensureNetworkSchema();
    const r = rows(await db.execute(sql`SELECT * FROM network_profiles WHERE slug = ${slug} LIMIT 1`))[0];
    if (!r) return { ok: true, value: null };
    try {
      await db.execute(sql`UPDATE network_profiles SET view_count = view_count + 1 WHERE id = ${r.id}`);
    } catch (e: any) { logFail('getProfile.viewCount', e); }
    return { ok: true, value: toProfile(r) };
  } catch (e: any) {
    return { ok: false, reason: logFail('getProfile', e) };
  }
}

/** The signed-in person's own profile, so the editor can show what they already published. */
export async function profileForUser(userId: string): Promise<Result<NetworkProfile | null>> {
  if (!userId) return { ok: true, value: null };
  try {
    await ensureNetworkSchema();
    const r = rows(await db.execute(sql`SELECT * FROM network_profiles WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1`))[0];
    return { ok: true, value: r ? toProfile(r) : null };
  } catch (e: any) {
    return { ok: false, reason: logFail('profileForUser', e) };
  }
}

export interface ProfileInput {
  kind?: string;
  displayName: string;
  tagline?: string;
  bio?: string;
  location?: string;
  websiteUrl?: string;
  contactEmail?: string;
  skills?: string[];
  languages?: string[];
  servicesOffered?: string[];
  seniority?: string;
  yearsExperience?: number | null;
  openTo?: string[];
  isPublic?: boolean;
}

function csv(v: string | undefined, cap: number): string[] {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, cap);
}
/** Parse a comma-separated form field into a clean list. Exported so the page and the lib agree. */
export const parseList = csv;

/**
 * Create the signed-in user's profile, or update it if they already have one.
 *
 * Keyed on user_id, NOT on a slug submitted by the browser: a slug in the form body is an
 * account-takeover shape (this project has already shipped one), and a person editing "their"
 * profile must never be able to name someone else's row.
 */
export async function upsertProfile(
  userId: string,
  input: ProfileInput,
): Promise<{ ok: true; slug: string; created: boolean } | { ok: false; error: string }> {
  if (!userId) return { ok: false, error: 'You must be signed in to publish a profile.' };

  const displayName = String(input.displayName || '').trim();
  if (displayName.length < 2) return { ok: false, error: 'Enter the name this profile should be listed under.' };
  if (displayName.length > 200) return { ok: false, error: 'That name is too long.' };

  const kind = (PROFILE_KINDS as readonly string[]).includes(String(input.kind))
    ? (input.kind as ProfileKind) : 'individual';
  const seniority = (SENIORITIES as readonly string[]).includes(String(input.seniority))
    ? String(input.seniority) : null;
  const openTo = (input.openTo || []).filter((o) => (OPEN_TO as readonly string[]).includes(o));

  const website = String(input.websiteUrl || '').trim();
  if (website && !/^https?:\/\//i.test(website)) {
    return { ok: false, error: 'A website address must start with http:// or https://.' };
  }
  const email = String(input.contactEmail || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'That contact email address does not look valid.' };
  }
  const years = input.yearsExperience == null || (input.yearsExperience as any) === ''
    ? null : Math.max(0, Math.min(80, Math.floor(Number(input.yearsExperience) || 0)));

  try {
    await ensureNetworkSchema();
    const existing = rows(await db.execute(sql`SELECT id, slug FROM network_profiles WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1`))[0];

    const skills = (input.skills || []).map((s) => s.slice(0, 60)).slice(0, 30);
    const languages = (input.languages || []).map((s) => s.slice(0, 40)).slice(0, 20);
    const services = (input.servicesOffered || []).map((s) => s.slice(0, 80)).slice(0, 20);

    if (existing) {
      // The slug is NOT rewritten on edit. A published address that changes under a person who has
      // already shared it turns every link they sent into a 404.
      await db.execute(sql`
        UPDATE network_profiles SET
          kind = ${kind}, display_name = ${displayName}, tagline = ${String(input.tagline || '').trim().slice(0, 300) || null},
          bio = ${String(input.bio || '').trim().slice(0, 6000) || null},
          location = ${String(input.location || '').trim().slice(0, 120) || null},
          website_url = ${website || null}, contact_email = ${email || null},
          skills = ${JSON.stringify(skills)}::jsonb, languages = ${JSON.stringify(languages)}::jsonb,
          services_offered = ${JSON.stringify(services)}::jsonb,
          seniority = ${seniority}, years_experience = ${years},
          open_to = ${JSON.stringify(openTo)}::jsonb,
          is_public = ${input.isPublic !== false}, updated_at = NOW()
        WHERE id = ${existing.id}`);
      return { ok: true, slug: String(existing.slug), created: false };
    }

    const base = slugifyName(displayName) || 'profile';
    let slug = base;
    for (let attempt = 0; attempt < 20; attempt++) {
      const taken = rows(await db.execute(sql`SELECT 1 FROM network_profiles WHERE slug = ${slug} LIMIT 1`)).length > 0;
      if (!taken) break;
      slug = base.slice(0, 104) + '-' + (attempt + 2);
      if (attempt === 19) return { ok: false, error: 'Could not derive a free web address for that name. Try a slightly different spelling.' };
    }

    const r = rows(await db.execute(sql`
      INSERT INTO network_profiles (slug, user_id, kind, display_name, tagline, bio, location,
        website_url, contact_email, skills, languages, services_offered, seniority, years_experience,
        open_to, is_public)
      VALUES (${slug}, ${userId}, ${kind}, ${displayName},
        ${String(input.tagline || '').trim().slice(0, 300) || null},
        ${String(input.bio || '').trim().slice(0, 6000) || null},
        ${String(input.location || '').trim().slice(0, 120) || null},
        ${website || null}, ${email || null},
        ${JSON.stringify(skills)}::jsonb, ${JSON.stringify(languages)}::jsonb,
        ${JSON.stringify(services)}::jsonb, ${seniority}, ${years},
        ${JSON.stringify(openTo)}::jsonb, ${input.isPublic !== false})
      RETURNING slug`));
    if (!r[0]?.slug) return { ok: false, error: 'The profile was not saved. Nothing has been published.' };
    return { ok: true, slug: String(r[0].slug), created: true };
  } catch (e: any) {
    return { ok: false, error: logFail('upsertProfile', e) };
  }
}

/** Take a profile off the directory without deleting what the person wrote. */
export async function setProfileVisibility(userId: string, isPublic: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensureNetworkSchema();
    await db.execute(sql`UPDATE network_profiles SET is_public = ${isPublic}, updated_at = NOW() WHERE user_id = ${userId}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: logFail('setProfileVisibility', e) };
  }
}
