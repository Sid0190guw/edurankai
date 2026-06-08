// Community surfaces: study groups, clubs, hackathons, collaboration boards.
// All self-bootstrapping. Keeps schema in one file so cross-page features stay coherent.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureCommunitySchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // Study groups — small peer cohorts around a specific course/topic
      await db.execute(sql`CREATE TABLE IF NOT EXISTS study_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(140) NOT NULL UNIQUE,
        owner_user_id UUID,
        title VARCHAR(200) NOT NULL,
        subject VARCHAR(80),
        course_id UUID,
        description TEXT,
        cap INT NOT NULL DEFAULT 8,
        meet_cadence VARCHAR(80),
        meet_link TEXT,
        is_open BOOLEAN NOT NULL DEFAULT true,
        member_count INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS study_group_members (
        group_id UUID NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        PRIMARY KEY (group_id, user_id)
      )`);

      // Clubs — cross-course interest groups (AI Safety, Vedic Sciences, Quantum, etc.)
      await db.execute(sql`CREATE TABLE IF NOT EXISTS clubs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(140) NOT NULL UNIQUE,
        name VARCHAR(200) NOT NULL,
        tagline VARCHAR(300),
        description TEXT,
        cover_url TEXT,
        category VARCHAR(80),
        member_count INT NOT NULL DEFAULT 0,
        post_count INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS club_members (
        club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (club_id, user_id)
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS club_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        title VARCHAR(300),
        body TEXT NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'discussion',
        upvotes INT NOT NULL DEFAULT 0,
        reply_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // Hackathons — time-boxed contests, public leaderboard
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hackathons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(140) NOT NULL UNIQUE,
        title VARCHAR(300) NOT NULL,
        tagline VARCHAR(400),
        description TEXT,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        registration_deadline TIMESTAMPTZ,
        prize_pool_chf INT,
        max_team_size INT NOT NULL DEFAULT 4,
        status VARCHAR(20) NOT NULL DEFAULT 'announced',
        rules_url TEXT,
        judges_blurb TEXT,
        cover_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hackathon_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
        team_name VARCHAR(200) NOT NULL,
        lead_user_id UUID NOT NULL,
        members JSONB DEFAULT '[]'::jsonb,
        title VARCHAR(300),
        summary TEXT,
        repo_url TEXT,
        demo_url TEXT,
        video_url TEXT,
        score DECIMAL(5,2),
        rank INT,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // Research collaboration boards — post a project, find co-authors
      await db.execute(sql`CREATE TABLE IF NOT EXISTS collab_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(140) NOT NULL UNIQUE,
        user_id UUID,
        author_name VARCHAR(200),
        title VARCHAR(300) NOT NULL,
        field VARCHAR(80),
        kind VARCHAR(20) NOT NULL DEFAULT 'open-call',
        body TEXT NOT NULL,
        skills_wanted JSONB DEFAULT '[]'::jsonb,
        commitment VARCHAR(120),
        deadline TIMESTAMPTZ,
        contact_email VARCHAR(200),
        is_active BOOLEAN NOT NULL DEFAULT true,
        view_count INT NOT NULL DEFAULT 0,
        interest_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    } catch (_) {}
  })();
  return ready;
}

// ============ Study groups ============
export async function listStudyGroups(opts: { subject?: string; open?: boolean } = {}) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`
    SELECT * FROM study_groups
    WHERE 1=1
      ${opts.open ? sql`AND is_open = true` : sql``}
      ${opts.subject ? sql`AND subject = ${opts.subject}` : sql``}
    ORDER BY created_at DESC LIMIT 100
  `));
}
export async function createStudyGroup(opts: any) {
  await ensureCommunitySchema();
  const r = rows(await db.execute(sql`INSERT INTO study_groups (slug, owner_user_id, title, subject, description, cap, meet_cadence, meet_link)
    VALUES (${opts.slug}, ${opts.ownerUserId || null}, ${opts.title}, ${opts.subject || null}, ${opts.description || null}, ${opts.cap || 8}, ${opts.meetCadence || null}, ${opts.meetLink || null}) RETURNING id, slug`));
  if (opts.ownerUserId) {
    await db.execute(sql`INSERT INTO study_group_members (group_id, user_id, role) VALUES (${r[0]?.id}, ${opts.ownerUserId}, 'owner') ON CONFLICT DO NOTHING`);
  }
  return { ok: true, id: r[0]?.id, slug: r[0]?.slug };
}

// ============ Clubs ============
export async function listClubs(opts: { category?: string } = {}) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`
    SELECT * FROM clubs WHERE is_active = true ${opts.category ? sql`AND category = ${opts.category}` : sql``} ORDER BY member_count DESC, post_count DESC LIMIT 100
  `));
}
export async function getClub(slug: string) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`SELECT * FROM clubs WHERE slug = ${slug} LIMIT 1`))[0] || null;
}
export async function listClubPosts(clubId: string) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`SELECT * FROM club_posts WHERE club_id = ${clubId} ORDER BY created_at DESC LIMIT 50`));
}

// ============ Hackathons ============
export async function listHackathons(opts: { status?: string } = {}) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`
    SELECT * FROM hackathons WHERE 1=1 ${opts.status ? sql`AND status = ${opts.status}` : sql``} ORDER BY starts_at DESC NULLS LAST LIMIT 50
  `));
}

// ============ Collab posts ============
export async function listCollabPosts(opts: { field?: string } = {}) {
  await ensureCommunitySchema();
  return rows(await db.execute(sql`
    SELECT * FROM collab_posts WHERE is_active = true ${opts.field ? sql`AND field = ${opts.field}` : sql``} ORDER BY created_at DESC LIMIT 50
  `));
}
export async function createCollabPost(opts: any) {
  await ensureCommunitySchema();
  const skillsJson = JSON.stringify(opts.skillsWanted || []);
  const r = rows(await db.execute(sql`INSERT INTO collab_posts (slug, user_id, author_name, title, field, kind, body, skills_wanted, commitment, deadline, contact_email)
    VALUES (${opts.slug}, ${opts.userId || null}, ${opts.authorName || null}, ${opts.title}, ${opts.field || null}, ${opts.kind || 'open-call'}, ${opts.body}, ${skillsJson}::jsonb, ${opts.commitment || null}, ${opts.deadline || null}, ${opts.contactEmail || null}) RETURNING id, slug`));
  return { ok: true, id: r[0]?.id, slug: r[0]?.slug };
}
