// Mail groups — named distribution lists you can mail in one shot.
// Each group has a hidden_recipients flag:
//   true  → members are expanded into BCC (the existing /api/mail/send path
//           supports BCC already), so recipients never see each other
//   false → members are expanded into TO (everyone sees who else received)
//
// Members can be EduRankAI users (by user_id) OR raw external emails — so
// you can mix internal staff + external contacts in one group.
//
// Self-bootstrapping schema, called from ensureMailSchema-style consumers.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureMailGroupsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(64) NOT NULL UNIQUE,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        hidden_recipients BOOLEAN NOT NULL DEFAULT true,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_groups_slug_idx ON mail_groups(slug)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_group_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES mail_groups(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        external_email VARCHAR(255),
        external_name VARCHAR(200),
        added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_group_members_group_idx ON mail_group_members(group_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_group_members_user_idx ON mail_group_members(user_id) WHERE user_id IS NOT NULL`);
    } catch (e: any) {
      // NOT SWALLOWED, AND NOT CACHED AS DONE. `catch (_) {}` left `ready` resolved, so a boot that
      // failed was never retried for the life of the process AND said nothing: every getGroupBySlug
      // /listGroups/getGroupMembers after it threw "relation mail_groups does not exist" into the
      // caller with no line anywhere explaining that the tables had never been created. The reason
      // goes to the log, and the promise is dropped so the next call tries again — a transient
      // pooler failure must not poison the process.
      console.error('[mail-groups] schema boot failed:', e?.cause?.message || e?.message);
      ready = null;
    }
  })();
  return ready;
}

export interface MailGroup {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  hidden_recipients: boolean;
}

export async function getGroupBySlug(slug: string): Promise<MailGroup | null> {
  await ensureMailGroupsSchema();
  const r = rows(await db.execute(sql`SELECT id, slug, name, description, hidden_recipients FROM mail_groups WHERE slug = ${slug} LIMIT 1`));
  return r[0] || null;
}

export async function listGroups(): Promise<(MailGroup & { member_count: number })[]> {
  await ensureMailGroupsSchema();
  return rows(await db.execute(sql`
    SELECT g.id, g.slug, g.name, g.description, g.hidden_recipients,
      (SELECT COUNT(*)::int FROM mail_group_members m WHERE m.group_id = g.id) AS member_count
    FROM mail_groups g ORDER BY g.name ASC
  `));
}

export async function getGroupMembers(groupId: string): Promise<{ email: string; name: string | null; user_id: string | null }[]> {
  await ensureMailGroupsSchema();
  return rows(await db.execute(sql`
    SELECT
      m.user_id,
      COALESCE(m.external_email, u.email) AS email,
      COALESCE(m.external_name, u.name) AS name
    FROM mail_group_members m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ${groupId}
      AND COALESCE(m.external_email, u.email) IS NOT NULL
  `));
}

// Expand a To/Cc/Bcc list, replacing any "@group:slug" token with the group's
// member emails. Returns { to, cc, bcc, anyHidden } so the caller can decide
// to use BCC routing for hidden groups even if they were placed in To/Cc.
/**
 * A GROUP THAT RESOLVES TO NOBODY IS REPORTED, NOT DROPPED.
 *
 * `if (!g) continue` used to delete the token and say nothing. So a composer that typed
 * `@group:all-staf` (one letter short of a real slug) alongside one ordinary address sent the
 * message to that one address, reported "Sent", and the operator believed a whole distribution
 * list had received it. The same silence covered a group that exists but has no members left.
 *
 * Both cases now travel back to the caller in `unknownGroups` / `emptyGroups` so the send path can
 * refuse the first and say the second out loud. This is the rule /api/mail/send already applies to
 * attachment links one function away: "a link we refuse is REPORTED rather than quietly dropped".
 */
export async function expandGroupTokens(opts: { to: string[]; cc: string[]; bcc: string[] }): Promise<{ to: string[]; cc: string[]; bcc: string[]; expandedGroups: { slug: string; count: number; hidden: boolean }[]; unknownGroups: string[]; emptyGroups: string[] }> {
  await ensureMailGroupsSchema();
  const out = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  const expanded: { slug: string; count: number; hidden: boolean }[] = [];
  const unknownGroups: string[] = [];
  const emptyGroups: string[] = [];

  async function expandList(list: string[], target: 'to' | 'cc' | 'bcc') {
    for (const raw of list || []) {
      const v = (raw || '').toString().trim();
      if (!v) continue;
      const m = v.match(/^@group:([a-z0-9-]+)$/i);
      if (m) {
        const slug = m[1].toLowerCase();
        const g = await getGroupBySlug(slug);
        if (!g) { if (!unknownGroups.includes(slug)) unknownGroups.push(slug); continue; }
        const members = await getGroupMembers(g.id);
        const emails = members.map(x => x.email).filter(Boolean);
        if (emails.length === 0 && !emptyGroups.includes(g.slug)) emptyGroups.push(g.slug);
        // Hidden-recipients groups ALWAYS route to BCC regardless of target,
        // so external recipients never see each other's addresses.
        const finalTarget: 'to' | 'cc' | 'bcc' = g.hidden_recipients ? 'bcc' : target;
        for (const e of emails) {
          if (!out[finalTarget].includes(e)) out[finalTarget].push(e);
        }
        expanded.push({ slug: g.slug, count: emails.length, hidden: g.hidden_recipients });
      } else {
        if (!out[target].includes(v)) out[target].push(v);
      }
    }
  }

  await expandList(opts.to || [], 'to');
  await expandList(opts.cc || [], 'cc');
  await expandList(opts.bcc || [], 'bcc');

  return { ...out, expandedGroups: expanded, unknownGroups, emptyGroups };
}
