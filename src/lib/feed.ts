// THE LEARNING FEED'S DATA LAYER.
//
// Every read and write behind /portal/feed lives here, for two reasons.
//
// 1. THE SCHEMA WAS BEING CREATED ON EVERY PAGE LOAD. Six CREATE TABLE statements ran, inside one
//    `catch (e) {}`, each time anybody opened the feed. They are behind a once-per-process guard
//    now, and a boot failure is REPORTED to the page instead of being swallowed — a feed that
//    renders "no posts yet" because its tables are missing is indistinguishable from a quiet feed.
//
// 2. THE PAGE'S BUTTONS HAD NO WRITERS. The comment, share and save controls on every reel carried
//    a count and no handler at all: feed_comments was created and never inserted into or selected
//    from, share_count was never written by any statement in the repository, and the save button
//    rendered the literal string "save" where the other three showed a number. Each of them now has
//    a function below that writes a real row, and each count is read back from what was written.
//
// Every function returns { ok: true, ... } or { ok: false, error } — never a bare [] on failure —
// so the surface can tell "nothing here" apart from "the query did not run".
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real Postgres complaint. e.message is only the statement that failed. */
export function dbReason(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown database error').slice(0, 300);
}

export type FeedResult<T> = { ok: true; rows: T } | { ok: false; error: string };

let schemaBoot: Promise<{ ok: true } | { ok: false; error: string }> | null = null;

/**
 * ONCE PER PROCESS, ADDITIVE ONLY, NEVER A DROP. Repeated calls return the first answer.
 */
export function ensureFeedSchema(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (schemaBoot) return schemaBoot;
  schemaBoot = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_posts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          author_user_id UUID NOT NULL,
          kind VARCHAR(20) NOT NULL DEFAULT 'reel',
          title TEXT,
          description TEXT,
          topic_tags JSONB DEFAULT '[]'::jsonb,
          media_url TEXT,
          thumbnail_url TEXT,
          duration_seconds INT,
          visibility VARCHAR(20) DEFAULT 'public',
          course_id UUID,
          ar_filter_id UUID,
          engagement_score INT DEFAULT 0,
          view_count INT DEFAULT 0,
          like_count INT DEFAULT 0,
          comment_count INT DEFAULT 0,
          share_count INT DEFAULT 0,
          is_pinned BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_likes (
          post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
          user_id UUID NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (post_id, user_id)
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_comments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          post_id UUID REFERENCES feed_posts(id) ON DELETE CASCADE,
          user_id UUID,
          body TEXT,
          reply_to UUID,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS feed_comments_post_idx ON feed_comments(post_id, created_at DESC)`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_view_events (
          user_id UUID,
          post_id UUID,
          watched_pct INT,
          device VARCHAR(20),
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS feed_view_user_idx ON feed_view_events(user_id, created_at DESC)`);
      // NEW, AND THE REASON THE BOOKMARK BUTTON CAN EXIST AT ALL. Additive: CREATE IF NOT EXISTS.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_saves (
          post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
          user_id UUID NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (post_id, user_id)
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ar_filters (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          creator_user_id UUID,
          slug VARCHAR(120) UNIQUE,
          name VARCHAR(200),
          kind VARCHAR(20),
          preview_url TEXT,
          code TEXT,
          use_count INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_user_interests (
          user_id UUID PRIMARY KEY,
          interests JSONB DEFAULT '[]'::jsonb,
          follows JSONB DEFAULT '[]'::jsonb,
          daily_cap_minutes INT DEFAULT 90,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      return { ok: true as const };
    } catch (e: any) {
      const error = dbReason(e);
      console.error('[feed] schema boot failed:', error);
      // Not cached as a permanent failure: a transient outage should not poison the process.
      schemaBoot = null;
      return { ok: false as const, error };
    }
  })();
  return schemaBoot;
}

/**
 * LIKE, COUNTED ONCE. The page used to INSERT ... ON CONFLICT DO NOTHING and then increment
 * like_count unconditionally, so a second press by the same person — a reload, a double tap —
 * raised the number without adding a like. The increment now happens only when a row was really
 * inserted, and the count comes back from the UPDATE so the caller shows a real figure.
 */
export async function likePost(postId: string, userId: string): Promise<FeedResult<{ liked: boolean; count: number }>> {
  try {
    const inserted = rows(await db.execute(sql`
      INSERT INTO feed_likes (post_id, user_id) VALUES (${postId}::uuid, ${userId})
      ON CONFLICT DO NOTHING RETURNING post_id`));
    if (inserted.length === 0) {
      const cur = rows(await db.execute(sql`SELECT like_count FROM feed_posts WHERE id = ${postId}::uuid`));
      if (cur.length === 0) return { ok: false, error: 'That post no longer exists.' };
      return { ok: true, rows: { liked: false, count: Number(cur[0].like_count) || 0 } };
    }
    const upd = rows(await db.execute(sql`
      UPDATE feed_posts SET like_count = COALESCE(like_count, 0) + 1
       WHERE id = ${postId}::uuid RETURNING like_count`));
    return { ok: true, rows: { liked: true, count: Number(upd[0]?.like_count) || 0 } };
  } catch (e: any) {
    console.error('[feed] likePost failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * A COMMENT, WRITTEN AND COUNTED FROM WHAT IS STORED. comment_count is recomputed with COUNT(*)
 * rather than incremented, so the number under the button is the number of comments that exist —
 * it cannot drift the way the seeded literals it replaced did.
 */
export async function addComment(postId: string, userId: string, body: string): Promise<FeedResult<{ count: number }>> {
  const text = body.trim().slice(0, 2000);
  if (!text) return { ok: false, error: 'Write something first — an empty comment is not posted.' };
  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO feed_comments (post_id, user_id, body)
      SELECT ${postId}::uuid, ${userId}, ${text}
       WHERE EXISTS (SELECT 1 FROM feed_posts WHERE id = ${postId}::uuid)
      RETURNING id`));
    if (ins.length === 0) return { ok: false, error: 'That post no longer exists, so the comment was not saved.' };
    const upd = rows(await db.execute(sql`
      UPDATE feed_posts
         SET comment_count = (SELECT COUNT(*) FROM feed_comments WHERE post_id = ${postId}::uuid)
       WHERE id = ${postId}::uuid RETURNING comment_count`));
    return { ok: true, rows: { count: Number(upd[0]?.comment_count) || 0 } };
  } catch (e: any) {
    console.error('[feed] addComment failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/** Comments for the posts currently on screen, newest last, with the author's name. */
export async function listComments(postIds: string[], perPost = 20): Promise<FeedResult<Record<string, any[]>>> {
  if (postIds.length === 0) return { ok: true, rows: {} };
  try {
    // Parameterised id list — never string-built. sql.join keeps every id a bound value.
    const idList = sql.join(postIds.map(id => sql`${id}::uuid`), sql`, `);
    const r = rows(await db.execute(sql`
      SELECT c.id, c.post_id, c.body, c.created_at, COALESCE(u.name, 'A learner') AS author_name
        FROM feed_comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.post_id IN (${idList})
       ORDER BY c.created_at ASC
       LIMIT ${Math.min(2000, postIds.length * perPost)}`));
    const byPost: Record<string, any[]> = {};
    for (const id of postIds) byPost[id] = [];
    for (const c of r) {
      if (!byPost[c.post_id]) byPost[c.post_id] = [];
      byPost[c.post_id].push(c);
    }
    return { ok: true, rows: byPost };
  } catch (e: any) {
    console.error('[feed] listComments failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * SHARE. The count under the share button was a permanent zero because nothing in the repository
 * ever wrote share_count. This is that write, and it runs only when the browser reports that a
 * share or a copy-to-clipboard actually happened.
 */
export async function recordShare(postId: string): Promise<FeedResult<{ count: number }>> {
  try {
    const upd = rows(await db.execute(sql`
      UPDATE feed_posts SET share_count = COALESCE(share_count, 0) + 1
       WHERE id = ${postId}::uuid RETURNING share_count`));
    if (upd.length === 0) return { ok: false, error: 'That post no longer exists.' };
    return { ok: true, rows: { count: Number(upd[0].share_count) || 0 } };
  } catch (e: any) {
    console.error('[feed] recordShare failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/** Bookmark toggle. Returns the state the row is actually in after the write. */
export async function toggleSave(postId: string, userId: string): Promise<FeedResult<{ saved: boolean }>> {
  try {
    const del = rows(await db.execute(sql`
      DELETE FROM feed_saves WHERE post_id = ${postId}::uuid AND user_id = ${userId} RETURNING post_id`));
    if (del.length > 0) return { ok: true, rows: { saved: false } };
    const ins = rows(await db.execute(sql`
      INSERT INTO feed_saves (post_id, user_id)
      SELECT ${postId}::uuid, ${userId}
       WHERE EXISTS (SELECT 1 FROM feed_posts WHERE id = ${postId}::uuid)
      ON CONFLICT DO NOTHING RETURNING post_id`));
    if (ins.length === 0) return { ok: false, error: 'That post no longer exists, so it was not saved.' };
    return { ok: true, rows: { saved: true } };
  } catch (e: any) {
    console.error('[feed] toggleSave failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/** Which of these posts the signed-in person has already saved. */
export async function savedPostIds(userId: string): Promise<FeedResult<string[]>> {
  try {
    const r = rows(await db.execute(sql`SELECT post_id FROM feed_saves WHERE user_id = ${userId} LIMIT 500`));
    return { ok: true, rows: r.map((x: any) => String(x.post_id)) };
  } catch (e: any) {
    console.error('[feed] savedPostIds failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}
