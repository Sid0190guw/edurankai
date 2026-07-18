// src/lib/edu-community.ts — Community & discussion (Prompt 20). Threads/posts scoped to a course,
// a KnowledgeObject, or a general space; visibility follows the viewer's access + securityLabels.
// Post/reply/edit-own/report; a moderator queue (moderator capability) hides/removes; replies notify
// (Prompt 18). Minor safety: a minor may participate only if their guardian consented (Prompt 14
// community consent). The participation + visibility logic is pure and unit-tested. Distinct from the
// existing generic community (kernel-scoped edu_* tables).

export type Scope = 'general' | 'course' | 'ko';
/** A minor may participate only with community consent (guardian-managed, Prompt 14). Pure. */
export function canParticipate(isMinor: boolean, communityConsent: boolean): boolean { return !isMinor || communityConsent; }
/** Students never see removed posts; moderators see everything. Pure. */
export function filterVisible<T extends { removed?: boolean }>(posts: T[], isModerator: boolean): T[] { return isModerator ? posts : posts.filter((p) => !p.removed); }
/** May the viewer edit this post? Only its author, and not once removed. Pure. */
export function canEditPost(post: { user_id: string; removed?: boolean }, viewerId: string): boolean { return !post.removed && post.user_id === viewerId; }

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureCommunitySchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_threads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scope TEXT NOT NULL DEFAULT 'general', scope_id TEXT, title TEXT NOT NULL, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_posts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), thread_id UUID NOT NULL, user_id UUID NOT NULL, body TEXT NOT NULL, parent_id UUID, removed BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_posts_thread_idx ON edu_posts (thread_id, created_at)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL, reporter_id UUID, reason TEXT, resolved BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}
export async function createThread(scope: Scope, scopeId: string | null, title: string, by: string): Promise<string> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`INSERT INTO edu_threads (scope, scope_id, title, created_by) VALUES (${scope}, ${scopeId}, ${title.slice(0, 200)}, ${by}) RETURNING id`))[0].id;
}
export async function listThreads(scope: Scope, scopeId?: string | null, limit = 50): Promise<any[]> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT t.*, u.name AS author, (SELECT COUNT(*)::int FROM edu_posts p WHERE p.thread_id = t.id AND p.removed = false) AS posts
    FROM edu_threads t LEFT JOIN users u ON u.id = t.created_by WHERE t.scope = ${scope} ${scopeId ? sql`AND t.scope_id = ${scopeId}` : sql``} ORDER BY t.created_at DESC LIMIT ${limit}`));
}
export async function getThread(id: string): Promise<any | null> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_threads WHERE id = ${id} LIMIT 1`))[0] || null;
}
export async function threadPosts(threadId: string): Promise<any[]> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT p.*, u.name AS author FROM edu_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.thread_id = ${threadId} ORDER BY p.created_at`));
}
export async function createPost(threadId: string, userId: string, body: string, parentId: string | null): Promise<string> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  const id = rows(await db.execute(sql`INSERT INTO edu_posts (thread_id, user_id, body, parent_id) VALUES (${threadId}, ${userId}, ${body.slice(0, 8000)}, ${parentId}) RETURNING id`))[0].id;
  if (parentId) { try { const parent = rows(await db.execute(sql`SELECT user_id FROM edu_posts WHERE id = ${parentId} LIMIT 1`))[0]; if (parent && parent.user_id !== userId) { const { notify } = await import('@/lib/edu-notify'); await notify(parent.user_id, { type: 'general', title: 'New reply to your post', link: '/aquintutor/discussion?t=' + threadId }); } } catch { /* notify best-effort */ } }
  return id;
}
export async function reportPost(postId: string, reporterId: string, reason: string): Promise<void> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_reports (post_id, reporter_id, reason) VALUES (${postId}, ${reporterId}, ${(reason || '').slice(0, 500)})`);
}
export async function removePost(postId: string): Promise<void> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_posts SET removed = true WHERE id = ${postId}`);
  await db.execute(sql`UPDATE edu_reports SET resolved = true WHERE post_id = ${postId}`);
}
export async function moderatorQueue(limit = 50): Promise<any[]> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT r.id, r.post_id, r.reason, r.created_at, p.body, p.removed, p.thread_id, u.name AS author, ru.name AS reporter
    FROM edu_reports r JOIN edu_posts p ON p.id = r.post_id LEFT JOIN users u ON u.id = p.user_id LEFT JOIN users ru ON ru.id = r.reporter_id
    WHERE r.resolved = false ORDER BY r.created_at LIMIT ${limit}`));
}
export async function resolveReport(reportId: string): Promise<void> {
  await ensureCommunitySchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_reports SET resolved = true WHERE id = ${reportId}`);
}
