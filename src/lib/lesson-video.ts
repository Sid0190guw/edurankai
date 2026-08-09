// src/lib/lesson-video.ts — where a resolved video link is STORED, and how a page reads it back.
//
// src/lib/video-embed.ts decides what a pasted link is. This file is the only thing that talks to
// the database about it, so the two admin forms and the two learner players share one answer.
//
// WHAT IS STORED, AND WHY BOTH.
//   training_lessons.video_url        the address exactly as the author pasted it (already exists)
//   training_lessons.video_embed_url  the address WE built from it
//   training_lessons.video_provider   the internal enum — never rendered, see video-embed.ts
//   training_lessons.video_link_kind  embed | internal | file | link
// The original is kept so that changing how we build an embed — a provider moving its player, a new
// privacy host — is a migration we run over the derived column, never a message asking every author
// to re-enter their links. The derived form is kept so a page has the finished answer without
// re-deriving, and so a future change has something to migrate.
//
// DDL IS ADDITIVE AND NEVER TRUSTED. src/lib/ensure-once.ts swallows a failed DDL run by design, so
// its resolution proves nothing. Every caller here gets the set of columns that information_schema
// actually reports, and writes only those. On a database where the ALTER did not land, the lesson
// still saves with its video_url and the author is TOLD the derived form was not stored — the write
// is never reported as complete when half of it did not happen.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { resolveStoredVideo, videoColumnValues, type VideoLinkResult } from '@/lib/video-embed';

// Declared before every function that uses them — `const` is not hoisted, and a handler reaching a
// later declaration throws on its first line while the page still looks fine.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) => console.error('[lesson-video] ' + tag, e?.cause?.message || e?.message);

export const VIDEO_COLUMNS = ['video_embed_url', 'video_provider', 'video_link_kind'] as const;

export interface VideoColumnState {
  /** Columns information_schema actually reports. Never inferred from the ensure resolving. */
  present: Set<string>;
  /** All three present. */
  complete: boolean;
  /** The read itself failed — different fact from "the columns are missing". */
  unknown: boolean;
}

const UNKNOWN: VideoColumnState = { present: new Set(), complete: false, unknown: true };

let cached: VideoColumnState | null = null;

/**
 * Add the columns if they are absent, then ASK THE DATABASE what is there.
 *
 * Additive only: three ADD COLUMN IF NOT EXISTS statements, no DROP, no type change, nothing that
 * can lose a row. A cached result is kept only once all three columns are confirmed present, so a
 * database mid-migration is re-checked rather than remembered wrong.
 */
export async function ensureLessonVideoColumns(): Promise<VideoColumnState> {
  if (cached && cached.complete) return cached;

  await ensureOnce('lesson-video-columns', async () => {
    await db.execute(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS video_embed_url TEXT`);
    await db.execute(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS video_provider VARCHAR(40)`);
    await db.execute(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS video_link_kind VARCHAR(16)`);
  });

  try {
    const r = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'training_lessons'
         AND column_name IN ('video_embed_url', 'video_provider', 'video_link_kind')`);
    const present = new Set<string>(rows(r).map((x: any) => String(x.column_name)));
    const state: VideoColumnState = { present, complete: present.size === VIDEO_COLUMNS.length, unknown: false };
    cached = state;
    return state;
  } catch (e) {
    // A verification that could not run is NOT a verification that found nothing. Callers get
    // `unknown` and say so; nothing here pretends the columns are missing or present.
    logFail('verify columns', e);
    cached = null;
    return UNKNOWN;
  }
}

export interface PersistResult {
  /** The derived columns were written. */
  derivedStored: boolean;
  /**
   * A sentence to append to the author's confirmation when the derived form could NOT be stored.
   * Empty when everything landed. Never null-swallowed: a half-written row says so.
   */
  note: string;
}

/**
 * Write the derived columns for a lesson that has already been inserted or updated with its
 * video_url. Separated from the INSERT so the lesson itself still saves on a database where the
 * additive migration has not reached — the author keeps their work and reads an honest sentence
 * about the part that did not.
 */
export async function persistLessonVideo(lessonId: string, resolved: VideoLinkResult | null): Promise<PersistResult> {
  const state = await ensureLessonVideoColumns();
  if (state.unknown) {
    return { derivedStored: false, note: 'The link was saved, but we could not check whether this database stores the derived player address, so the lesson may fall back to working it out on each view.' };
  }
  if (!state.complete) {
    return { derivedStored: false, note: 'The link was saved as you pasted it. The derived player address was NOT stored, because this database does not have those columns yet; the lesson will work it out on each view instead.' };
  }

  const v = videoColumnValues(resolved || { ok: false, originalUrl: '', reason: '', canLinkOut: false, linkOutUrl: null });
  try {
    const r = await db.execute(sql`
      UPDATE training_lessons
         SET video_embed_url = ${v.video_embed_url},
             video_provider  = ${v.video_provider},
             video_link_kind = ${v.video_link_kind}
       WHERE id = ${lessonId}
      RETURNING id`);
    if (!rows(r).length) {
      return { derivedStored: false, note: 'The derived player address was not stored - that lesson could not be found a moment after it was written.' };
    }
    return { derivedStored: true, note: '' };
  } catch (e: any) {
    // NEVER swallowed. The lesson exists with its pasted link; the author is told what is missing.
    logFail('persist derived', e);
    return {
      derivedStored: false,
      note: 'The link was saved as you pasted it, but the derived player address could not be stored (' +
        String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140) + '). The lesson will work it out on each view.',
    };
  }
}

/**
 * Read a lesson row back into something a page can render. Works on rows written before the
 * columns existed, because the pasted address is re-resolved every time.
 */
export function lessonVideo(lesson: any): VideoLinkResult | null {
  if (!lesson) return null;
  const original = lesson.video_url;
  const derived = lesson.video_embed_url;
  if (!original && !derived) return null;
  return resolveStoredVideo(original, derived, lesson.video_link_kind);
}
