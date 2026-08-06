// src/lib/chat-schema.ts — THE ONE PLACE `chat_messages` AND ITS NEIGHBOURS ARE CREATED.
//
// WHY THIS FILE EXISTS. `chat_messages` was CREATEd by two modules with two incompatible shapes:
//
//   scripts/setup-team-chat.mjs:24 (+ the Drizzle declaration at src/lib/db/schema.ts:723)
//       channel_id / sender_name / body TEXT NOT NULL      — the /admin/chat team channels
//   src/pages/portal/messages.astro:50 (inline, at request time)
//       thread_id / ciphertext / iv / envelope             — the E2EE portal messenger
//
// CREATE TABLE IF NOT EXISTS is a NO-OP on an existing table. Whichever statement reached the
// database first owns the table, and for the other module every INSERT throws — forever, invisibly,
// while the code reads as though it were implemented. That is the fault, and one module owning the
// DDL is the only thing that stops it coming back.
//
// WHICH SHAPE IS LIVE — inferred from the repository, NOT verified against the database (no agent on
// this project connects to it). The evidence:
//   * scripts/setup-team-chat.mjs landed 2026-05-16 (173009b) creating the CHANNEL shape and seeding
//     four channels; the commit message states the tables are in the database.
//   * scripts/setup-chat-audit.mjs, same day, runs `ALTER TABLE chat_messages ADD COLUMN IF NOT
//     EXISTS message_code`, then SELECTs and backfills every existing row. An ALTER and a row
//     backfill only make sense against a table that already existed, channel-shaped.
//   * src/pages/portal/messages.astro landed 2026-06-09 (f9b5fd6) — three weeks later — and its
//     CREATE TABLE IF NOT EXISTS was therefore a no-op from its first request.
//   * Corroboration in the code's own error handling: the single statement in that page that would
//     ERROR against a channel-shaped table (CREATE INDEX ... ON chat_messages (thread_id, ...)) is
//     the one wrapped in `.catch(()=>{})`, so the mismatch never surfaced.
// Conclusion: the CHANNEL shape is live, and every portal send/edit/delete has been throwing
// `column "thread_id" of relation "chat_messages" does not exist` since 2026-06-09. To confirm
// against production, a human runs (CLAUDE.md — inspection is handed over, not performed here):
//
//   SELECT column_name, is_nullable, data_type FROM information_schema.columns
//    WHERE table_name = 'chat_messages' ORDER BY ordinal_position;
//
// WHAT THIS MODULE DOES ABOUT IT. It reconciles the two shapes ADDITIVELY into one table:
// ADD COLUMN IF NOT EXISTS for every column either caller needs, and DROP NOT NULL on the four
// columns whose mandatory-ness belongs to only one of the two shapes. Nothing is dropped, renamed or
// rewritten: a live channel-shaped row keeps its channel_id and body untouched and simply gains NULL
// thread columns, and vice versa. Renaming or splitting the table is NOT done here — it is not a
// self-bootstrappable operation against unknown production state, and CLAUDE.md forbids running it.
//
// THE COST OF ADDITIVE, STATED PLAINLY: `thread_id`, `ciphertext` and `iv` cannot stay NOT NULL on a
// table that also holds channel rows, so on a fresh database they are created nullable. The
// enforcement moves up one layer, where it already was: portal/messages.astro rejects a send with a
// missing thread_id, ciphertext or iv before it reaches SQL. A future migration that has taken the
// channel rows somewhere else can put the constraints back.
//
// GROUPS LIVE ON THE THREAD TABLES. Archiving /admin/chat retired the CHANNEL — a named group
// conversation with a membership — and nobody asked to lose group chat. So a thread carries a KIND:
// 'direct' (two people) or 'group' (a name, a description, and rows in chat_thread_members). There
// is no second membership table and no second messenger; send, edit, delete, receipts, unread and
// notifications are the same code for both. The only thing a group needed that a DM did not is a key
// every member can open — see the GROUP KEYS block in run() below.
//
// AFTER THIS, ONE SYSTEM WRITES. The canonical messenger is /portal/messages (threads, E2EE). The
// /admin/chat channels are an archive: readable, not writable — see the endpoints under
// src/pages/admin/api/chat/. This module still creates chat_channels / chat_memberships because the
// archive must keep rendering, and because `chat_channels.is_dm` and `chat_messages.message_code`
// are written by code and appear in no CREATE TABLE in the repository (only in the manually-run
// scripts/setup-chat-audit.mjs, which a fresh database would never have had run against it).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logEvent } from '@/lib/logger';

// Declared before every function that uses them: `const` is not hoisted, and a handler that reaches
// a later declaration has taken pages down on this project.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The one surface where a new message may be written. Imported rather than typed out again. */
export const CHAT_CANONICAL_HREF = '/portal/messages';

/**
 * The answer every retired /admin/api/chat write gives.
 *
 * 410 and not 404: the endpoint existed, its history is still readable at /admin/chat, and a caller
 * that gets a 404 cannot tell "never existed" from "deliberately closed". The body names where
 * messages go instead, so the client can say something true to the person who pressed Send.
 *
 * ALWAYS returned AFTER the authorization guard, never before — docs/workforce-os/
 * AUTHORIZATION_FIRST.md. A caller who may not open this surface must get 401/403; telling an
 * unauthorised caller which endpoints exist and what replaced them is itself a disclosure.
 */
export function chatArchivedResponse(what: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      archived: true,
      canonical: CHAT_CANONICAL_HREF,
      error:
        what +
        ' is archived. The Discussion channels are read-only; new messages are written at ' +
        CHAT_CANONICAL_HREF + '.',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } },
  );
}

/**
 * Columns that only ever carried NOT NULL because one of the two shapes required them. On a unified
 * table each is mandatory for exactly one kind of row, so the constraint has to live in the caller.
 */
const RELAXABLE = ['thread_id', 'ciphertext', 'iv', 'channel_id', 'body'] as const;

async function detectShape(): Promise<{ present: Set<string>; notNull: Set<string>; exists: boolean }> {
  const r = await db.execute(sql`
    SELECT column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'chat_messages'`);
  const present = new Set<string>();
  const notNull = new Set<string>();
  for (const row of rows(r)) {
    const name = String((row as any).column_name);
    present.add(name);
    if (String((row as any).is_nullable).toUpperCase() === 'NO') notNull.add(name);
  }
  return { present, notNull, exists: present.size > 0 };
}

async function run(): Promise<void> {
  try {
    // ---- channel side of the house, so the archive renders on a database that never had the
    // manually-run setup scripts. Same shape as src/lib/db/schema.ts:711-741, is_dm included.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(60) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        is_private BOOLEAN NOT NULL DEFAULT false,
        is_dm BOOLEAN NOT NULL DEFAULT false,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // Declared in Drizzle and written by start-dm.ts:49, created by no CREATE TABLE in the repo.
    await db.execute(sql`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chat_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (channel_id, user_id)
      )`);

    // ---- thread side of the house (the canonical messenger).
    //
    // `kind` is the only distinction between a direct message and a group: 'direct' | 'group'.
    // There is no second thread table and no second membership table — a group is a thread with a
    // name and more than two rows in chat_thread_members. See GROUP KEYS below for what the extra
    // columns on the membership table carry.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(20) NOT NULL DEFAULT 'direct',
        title VARCHAR(200),
        description TEXT,
        cover_url TEXT,
        last_message_preview TEXT,
        last_message_at TIMESTAMPTZ,
        disappearing_seconds INT,
        created_by_user_id UUID,
        source_kind VARCHAR(20),
        source_group_id UUID,
        key_epoch INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chat_thread_members (
        thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_read_at TIMESTAMPTZ,
        notifications_muted BOOLEAN NOT NULL DEFAULT false,
        public_key_pem TEXT,
        wrapped_key TEXT,
        wrapped_key_iv TEXT,
        wrapped_by_user_id UUID,
        wrapped_by_public_key_pem TEXT,
        wrapped_key_epoch INT NOT NULL DEFAULT 1,
        PRIMARY KEY (thread_id, user_id)
      )`);

    // CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS —
    // and both tables above already exist on the live database (portal/messages.astro created them
    // inline from 2026-06-09; only chat_messages collided with the channel shape). So every column
    // added after that date is asserted again here, or the queries that name it throw. Same reason
    // the same block exists in work-groups.ts. On a fresh database these are no-ops.
    await db.execute(sql`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.execute(sql`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS created_by_user_id UUID`);
    // Where a group's membership came from, so a department channel derives from the work group
    // instead of being a second, immediately-stale copy of it. No FOREIGN KEY to work_groups: that
    // table is ensured by a different module (work-groups.ts) and may not exist yet when this runs,
    // and a constraint that can fail the whole ensure would take the messenger down to gain nothing
    // chat-groups.ts does not already check.
    await db.execute(sql`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS source_kind VARCHAR(20)`);
    await db.execute(sql`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS source_group_id UUID`);
    await db.execute(sql`ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS key_epoch INT NOT NULL DEFAULT 1`);

    // ---- GROUP KEYS. WHY THESE COLUMNS EXIST, AND WHAT THEY DO NOT CONTAIN.
    //
    // A direct thread needs no stored key: both ends derive the same AES-GCM key from ECDH between
    // their two published public keys. That construction does NOT extend to three people — with
    // members A, B, C, A derives ECDH(A,B) and C derives ECDH(C,A), which are different keys, and a
    // group built on it would simply not decrypt. So a group has ONE random AES-GCM-256 key,
    // generated in the creator's browser, and each member gets their own copy of it WRAPPED:
    //
    //   wrapped_key                = the 32-byte group key, AES-GCM encrypted under a key-encryption
    //                                key derived by ECDH between the wrapper's private key and this
    //                                member's published public key
    //   wrapped_key_iv             = the IV for that wrap
    //   wrapped_by_user_id         = who wrapped it (for display and audit)
    //   wrapped_by_public_key_pem  = the wrapper's public key AT THE TIME OF WRAPPING. Stored rather
    //                                than looked up, because the wrapper may later leave the group
    //                                or regenerate their device key, and either would otherwise make
    //                                every copy they wrapped permanently unopenable.
    //   wrapped_key_epoch          = which generation of the group key this copy holds. Nothing
    //                                rotates keys today; the column is what lets a client say "your
    //                                copy is stale" later instead of silently decrypting to noise.
    //
    // THE SERVER STILL CANNOT READ ANYTHING. Every value here is ciphertext or a PUBLIC key. Opening
    // a wrapped_key needs an ECDH private key, and private keys are generated in the browser and
    // live only in that browser's localStorage — there is no column for one anywhere in this file,
    // and there must never be. This is what keeps src/lib/legal-hold.ts truthful for group threads
    // as well as direct ones.
    await db.execute(sql`ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS wrapped_key TEXT`);
    await db.execute(sql`ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS wrapped_key_iv TEXT`);
    await db.execute(sql`ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS wrapped_by_user_id UUID`);
    await db.execute(sql`ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS wrapped_by_public_key_pem TEXT`);
    await db.execute(sql`ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS wrapped_key_epoch INT NOT NULL DEFAULT 1`);

    // ---- the table both systems collided on. Created UNIFIED when it is absent, so a fresh
    // database can never reproduce the split; reconciled additively when it is present.
    const before = await detectShape();
    if (!before.exists) {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          thread_id UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
          channel_id UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
          sender_user_id UUID NOT NULL,
          sender_name VARCHAR(120),
          body TEXT,
          message_code VARCHAR(20),
          ciphertext TEXT,
          iv TEXT,
          envelope JSONB DEFAULT '{}'::jsonb,
          attachment_url TEXT,
          attachment_meta JSONB,
          reply_to_message_id UUID,
          edited_at TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    } else {
      // Whichever half is missing is added. No foreign key is attached to a column added here: the
      // live table may already hold rows a new constraint would reject, and a failed ensure would
      // take both surfaces down to gain nothing the application does not already check.
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_id UUID`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS channel_id UUID`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_name VARCHAR(120)`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS body TEXT`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_code VARCHAR(20)`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS ciphertext TEXT`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS iv TEXT`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS envelope JSONB DEFAULT '{}'::jsonb`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_meta JSONB`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_message_id UUID`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);

      // A column that is NOT NULL for the OTHER shape's rows makes this table impossible to write.
      // Dropping a NOT NULL constraint removes no column and rewrites no row; it is the one change
      // a merged table cannot avoid. Applied only where it is actually set, so this is a no-op on
      // every request after the first, and each statement names a column that demonstrably exists.
      for (const col of RELAXABLE) {
        if (!before.notNull.has(col)) continue;
        if (col === 'thread_id') await db.execute(sql`ALTER TABLE chat_messages ALTER COLUMN thread_id DROP NOT NULL`);
        else if (col === 'ciphertext') await db.execute(sql`ALTER TABLE chat_messages ALTER COLUMN ciphertext DROP NOT NULL`);
        else if (col === 'iv') await db.execute(sql`ALTER TABLE chat_messages ALTER COLUMN iv DROP NOT NULL`);
        else if (col === 'channel_id') await db.execute(sql`ALTER TABLE chat_messages ALTER COLUMN channel_id DROP NOT NULL`);
        else if (col === 'body') await db.execute(sql`ALTER TABLE chat_messages ALTER COLUMN body DROP NOT NULL`);
      }

      // The shape this process found, recorded once per cold start. This is the line that answers
      // "which CREATE won" from the logs instead of from an argument about commit dates.
      logEvent('info', 'chat.schema.reconciled', {
        hadThreadColumn: before.present.has('thread_id'),
        hadChannelColumn: before.present.has('channel_id'),
        relaxed: Array.from(before.notNull).filter((c) => (RELAXABLE as readonly string[]).includes(c)),
      });
    }

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chat_message_receipts (
        message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        PRIMARY KEY (message_id, user_id)
      )`);

    // Indexes last: after the ALTERs above, both of these name columns that exist under either
    // starting shape. They are NOT swallowed — an index that silently fails to exist is how the
    // original mismatch stayed hidden for eight weeks.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages (thread_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages (channel_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_thread_members (user_id)`);
    // The group list is "my threads WHERE kind = 'group'", and the department-channel top-up asks
    // "which thread was seeded from this work group".
    await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_threads_kind_idx ON chat_threads (kind)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_threads_source_group_idx ON chat_threads (source_group_id)`);
  } catch (e: any) {
    // Logged before it is rethrown. ensureOnce drops a failed run from its cache so the next request
    // retries; without this line that retry would be the only trace that anything went wrong.
    logEvent('error', 'chat.schema.ensure-failed', { message: reason(e) });
    throw e;
  }
}

/**
 * Create/reconcile the chat tables, at most once per server process.
 *
 * Every surface that touches chat calls THIS — /portal/messages, /admin/chat and the endpoints under
 * /admin/api/chat. No other module may CREATE these tables; adding a second one recreates the exact
 * defect this file was written to remove.
 */
export function ensureChatSchema(): Promise<void> {
  // v2 and not v1: ensureOnce memoises per PROCESS, so a process that already ran the v1 ensure
  // would never run the group-key ALTERs added in this revision. A deploy restarts every process
  // and would have covered it, but a cache key that changes with the DDL does not depend on that.
  return ensureOnce('chat.schema.unified.v2', run);
}
