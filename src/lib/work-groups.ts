// src/lib/work-groups.ts — internal team groups: who is in them, and who may even see them.
//
// Distinct from src/lib/community.ts, which is the LEARNER community (study groups, clubs,
// hackathons). This is the internal side: the one common group, per-department groups, and
// sub-groups inside them, with the external chat links shared at onboarding.
//
// STRUCTURE
//   global      one common group; everyone who completes onboarding is in it
//   department  one per department; joined automatically on onboarding
//   sub         a group inside another group; anyone in the parent may create one
//   custom      explicit membership only
//
// THE RULE THAT MATTERS: a group you are not entitled to is INVISIBLE — not greyed out, not
// "request access", absent. Listing groups someone cannot join hands them a map of the
// organisation: which teams exist, what projects are running, who works on what. That is the
// reconnaissance worth denying, and it is why every read here takes a viewer and scopes at the
// query rather than fetching everything and filtering in the page.
//
// JOIN LINKS ARE THE SHARP EDGE. A WhatsApp or Slack invite link is a bearer credential: whoever
// holds it can join, and nothing on the other side checks who they are. So a link is never included
// in a listing, and joinLinkFor() re-checks membership at the moment of access rather than trusting
// that the caller already filtered.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type GroupKind = 'global' | 'department' | 'sub' | 'custom';
export type MemberRole = 'member' | 'moderator' | 'owner';

export interface WorkGroup {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: GroupKind;
  parentId: string | null;
  parentName?: string | null;
  departmentId: string | null;
  isMain: boolean;        // protected: cannot be deleted or reparented
  isActive: boolean;
  memberCount: number;
  isMember: boolean;      // is the VIEWER in it (vs. merely able to see it via the parent)
  hasLink: boolean;       // whether a chat link exists — never the link itself
  createdBy: string | null;
}

export function ensureWorkGroupSchema(): Promise<void> {
  return ensureOnce('work_groups_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS work_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'custom',
      parent_id UUID REFERENCES work_groups(id) ON DELETE CASCADE,
      department_id VARCHAR(50),
      is_main BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      join_url TEXT,
      join_label TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS work_group_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      source TEXT NOT NULL DEFAULT 'auto',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT work_group_member_unique UNIQUE (group_id, user_id)
    )`);
    // CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS.
    // Every column above past the primary key is therefore asserted again here. This is not
    // belt-and-braces: it is the exact failure that put hr_employees.work_email in db/hr-schema.sql
    // and not on the live table, and visibleGroupsFor() NAMES join_url, parent_id, department_id,
    // is_main and created_by — a query that names a missing column throws, and the only symptom on
    // /portal/employee is a Community card that says "you are not in a team group yet". On a fresh
    // database these are no-ops.
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'custom'`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES work_groups(id) ON DELETE CASCADE`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS department_id VARCHAR(50)`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS join_url TEXT`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS join_label TEXT`);
    await db.execute(sql`ALTER TABLE work_groups ADD COLUMN IF NOT EXISTS created_by UUID`);
    await db.execute(sql`ALTER TABLE work_group_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'`);
    await db.execute(sql`ALTER TABLE work_group_members ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto'`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS work_group_members_user_idx ON work_group_members (user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS work_groups_parent_idx ON work_groups (parent_id)`);
    // The one common group. is_main protects it from deletion or reparenting.
    await db.execute(sql`
      INSERT INTO work_groups (slug, name, description, kind, is_main)
      VALUES ('everyone', 'Everyone at EduRankAI', 'The one place the whole organisation is in.', 'global', true)
      ON CONFLICT (slug) DO NOTHING`);
  });
}

const map = (r: any): WorkGroup => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description,
  kind: r.kind, parentId: r.parent_id, parentName: r.parent_name ?? null,
  departmentId: r.department_id, isMain: !!r.is_main, isActive: !!r.is_active,
  memberCount: Number(r.member_count) || 0,
  isMember: !!r.is_member,
  hasLink: !!r.has_link,
  createdBy: r.created_by,
});

/**
 * Groups this user may SEE, and nothing else:
 *   - groups they belong to, plus
 *   - sub-groups of those groups, so a department member can discover and join its sub-groups.
 *
 * Note it selects `join_url IS NOT NULL AS has_link` rather than the URL. A listing must never
 * carry a bearer credential, even for rows the viewer is entitled to — one accidental log line or
 * template change would leak every group link at once.
 */
export async function visibleGroupsFor(userId: string): Promise<WorkGroup[]> {
  if (!userId) return [];
  try {
    await ensureWorkGroupSchema();
    return rows(await db.execute(sql`
      WITH mine AS (SELECT group_id FROM work_group_members WHERE user_id = ${userId})
      SELECT g.id, g.slug, g.name, g.description, g.kind, g.parent_id, g.department_id,
             g.is_main, g.is_active, g.created_by,
             p.name AS parent_name,
             (g.join_url IS NOT NULL AND g.join_url <> '') AS has_link,
             (g.id IN (SELECT group_id FROM mine)) AS is_member,
             (SELECT COUNT(*)::int FROM work_group_members m WHERE m.group_id = g.id) AS member_count
      FROM work_groups g
      LEFT JOIN work_groups p ON p.id = g.parent_id
      WHERE g.is_active = true
        AND (
          g.id IN (SELECT group_id FROM mine)
          OR (g.parent_id IS NOT NULL AND g.parent_id IN (SELECT group_id FROM mine))
        )
      ORDER BY g.is_main DESC, g.kind, g.name`)).map(map);
  } catch (e: any) {
    // Was a bare `catch { return [] }`. Still fails closed — showing no groups is always the safe
    // answer — but the failure now leaves a trace. Silently returning [] here makes every caller
    // print "you are not in a team group yet", which is a claim about someone's membership made by
    // code that has just failed to find out.
    console.error('[work-groups] visibleGroupsFor', e?.cause?.message || e?.message);
    return [];
  }
}

/** Membership check. Every privileged read goes through this rather than trusting a caller. */
export async function isMember(groupId: string, userId: string): Promise<boolean> {
  if (!groupId || !userId) return false;
  try {
    await ensureWorkGroupSchema();
    return rows(await db.execute(sql`
      SELECT 1 FROM work_group_members WHERE group_id = ${groupId} AND user_id = ${userId} LIMIT 1`)).length > 0;
  } catch { return false; }
}

/**
 * The chat link, only for a confirmed member. Membership is re-derived here at the moment of
 * access — see the note at the top about invite links being bearer credentials.
 */
export async function joinLinkFor(groupId: string, userId: string): Promise<{ url: string; label: string } | null> {
  if (!(await isMember(groupId, userId))) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT join_url, join_label FROM work_groups WHERE id = ${groupId} AND is_active = true LIMIT 1`))[0];
    if (!r?.join_url) return null;
    return { url: r.join_url, label: r.join_label || 'Open group chat' };
  } catch { return null; }
}

/** Idempotent add. Never throws: group membership must not be able to fail onboarding. */
export async function addMember(groupId: string, userId: string, role: MemberRole = 'member', source = 'auto'): Promise<void> {
  try {
    await ensureWorkGroupSchema();
    await db.execute(sql`
      INSERT INTO work_group_members (group_id, user_id, role, source)
      VALUES (${groupId}, ${userId}, ${role}, ${source})
      ON CONFLICT (group_id, user_id) DO NOTHING`);
  } catch { /* deliberately silent — see above */ }
}

/**
 * Called when someone completes onboarding: into the common group, and into their department's
 * group, which is created on first use so a new department needs no manual step.
 */
export async function autoJoinOnOnboard(
  userId: string,
  departmentId?: string | null,
  departmentName?: string | null,
): Promise<{ joined: string[] }> {
  const joined: string[] = [];
  if (!userId) return { joined };
  try {
    await ensureWorkGroupSchema();
    const everyone = rows(await db.execute(sql`SELECT id FROM work_groups WHERE slug = 'everyone' LIMIT 1`))[0];
    if (everyone) { await addMember(everyone.id, userId, 'member', 'auto'); joined.push('everyone'); }

    if (departmentId) {
      const slug = 'dept-' + String(departmentId).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
      const label = departmentName || departmentId;
      await db.execute(sql`
        INSERT INTO work_groups (slug, name, description, kind, department_id, is_main)
        VALUES (${slug}, ${label + ' team'}, ${'Everyone working in ' + label + '.'}, 'department', ${departmentId}, true)
        ON CONFLICT (slug) DO NOTHING`);
      const dept = rows(await db.execute(sql`SELECT id FROM work_groups WHERE slug = ${slug} LIMIT 1`))[0];
      if (dept) { await addMember(dept.id, userId, 'member', 'auto'); joined.push(slug); }
    }
  } catch { /* onboarding must succeed regardless */ }
  return { joined };
}

/**
 * Create a sub-group inside a group the creator already belongs to.
 *
 * Requiring parent membership IS the access model: someone can only create inside what they can
 * already see, so nobody can graft a group onto a part of the organisation they have no business
 * in. The parent stays main — a child never replaces it.
 */
export async function createSubGroup(input: {
  parentId: string; creatorId: string; name: string;
  description?: string; joinUrl?: string; joinLabel?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const name = (input.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'A name is required.' };
  if (!(await isMember(input.parentId, input.creatorId))) {
    // Same message whether the group is missing or merely not theirs — a distinct "no such group"
    // would confirm which group ids exist.
    return { ok: false, error: 'That group is not available.' };
  }
  const url = (input.joinUrl || '').trim();
  if (url && !/^https:\/\//i.test(url)) return { ok: false, error: 'A chat link must start with https://' };
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      + '-' + Date.now().toString(36).slice(-4);
    const r = rows(await db.execute(sql`
      INSERT INTO work_groups (slug, name, description, kind, parent_id, is_main, join_url, join_label, created_by)
      VALUES (${slug}, ${name}, ${(input.description || '').slice(0, 400) || null}, 'sub', ${input.parentId}, false,
              ${url || null}, ${(input.joinLabel || '').slice(0, 60) || null}, ${input.creatorId})
      RETURNING id`))[0];
    if (r?.id) await addMember(r.id, input.creatorId, 'owner', 'self');
    return { ok: true, id: r?.id };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not create the group.' };
  }
}

/**
 * Join a sub-group of a group you are already in. Entitlement is re-derived from the parent rather
 * than taken from the request, so a posted group id cannot be used to join something unrelated.
 */
export async function joinGroup(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureWorkGroupSchema();
    const g = rows(await db.execute(sql`
      SELECT id, parent_id, kind, is_active FROM work_groups WHERE id = ${groupId} LIMIT 1`))[0];
    // One message for every refusal, so probing ids reveals nothing.
    const NO = { ok: false as const, error: 'That group is not available.' };
    if (!g || !g.is_active) return NO;
    // Only sub-groups are self-joinable. Global and department membership is assigned by
    // onboarding, not chosen — otherwise anyone could add themselves to any department.
    if (g.kind !== 'sub' || !g.parent_id) return NO;
    if (!(await isMember(g.parent_id, userId))) return NO;
    await addMember(groupId, userId, 'member', 'self');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not join.' };
  }
}

/** Leave a group. Main groups cannot be left — they follow employment, not preference. */
export async function leaveGroup(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureWorkGroupSchema();
    const g = rows(await db.execute(sql`SELECT is_main FROM work_groups WHERE id = ${groupId} LIMIT 1`))[0];
    if (!g) return { ok: false, error: 'That group is not available.' };
    if (g.is_main) return { ok: false, error: 'You cannot leave your organisation or department group.' };
    await db.execute(sql`DELETE FROM work_group_members WHERE group_id = ${groupId} AND user_id = ${userId}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not leave.' };
  }
}

/** Members of a group, for the group page. Only returned to someone already in it. */
export async function membersOf(groupId: string, viewerId: string): Promise<{ id: string; name: string; role: string }[]> {
  if (!(await isMember(groupId, viewerId))) return [];
  try {
    return rows(await db.execute(sql`
      SELECT u.id, COALESCE(u.name, u.email) AS name, m.role
      FROM work_group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ${groupId}
      ORDER BY (m.role = 'owner') DESC, name ASC LIMIT 500`))
      .map((r: any) => ({ id: r.id, name: r.name, role: r.role }));
  } catch { return []; }
}
