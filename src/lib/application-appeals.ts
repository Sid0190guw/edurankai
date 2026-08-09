// "How to Submit an Appeal" — backed product from /policy/recruitment.
// Appeals are NOT for fee waivers (no-appeal policy stands). They are for
// role-application decisions: rejection, scoring disputes, withdrawn offers.
//
// WHAT WAS MISSING: THE CONVERSATION.
//
// `application_appeal_messages` was CREATEd below and indexed, and the string "appeal_messages"
// appeared NOWHERE ELSE in the repository — no INSERT, no SELECT, no UI. So the schema promised an
// exchange between an appellant and a reviewer that neither of them could have. In practice a
// person contesting a rejection wrote their grounds once, waited, and received a decision note; a
// reviewer who needed one clarifying fact had no way to ask for it and had to decide without it.
//
// appendAppealMessage() and listAppealMessages() below are that missing half, and both surfaces
// (/portal/appeals and /admin/appeals) now render the thread.
//
// The schema-ensure also used to end in `catch (_) {}`: a DDL failure was swallowed AND the failed
// promise was memoised for the life of the process, so every later caller was told it had
// succeeded. It is on ensureOnce() now, which drops a failed run so the next call retries.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { dbReason, toRows, uuidish } from '@/lib/page-safety';

export function ensureAppealsSchema(): Promise<void> {
  return ensureOnce('application-appeals:schema', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_appeals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL,
        user_id UUID NOT NULL,
        appeal_kind VARCHAR(40) NOT NULL,
          -- decision | scoring | offer_withdrawn | other
        grounds TEXT NOT NULL,
        new_evidence TEXT,
        drive_url TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
          -- open | reviewing | upheld | denied | withdrawn
        decision_note TEXT,
        decided_by_user_id UUID,
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aa_user_idx ON application_appeals(user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aa_status_idx ON application_appeals(status, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_appeal_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appeal_id UUID NOT NULL REFERENCES application_appeals(id) ON DELETE CASCADE,
        sender_role VARCHAR(16) NOT NULL,
        sender_user_id UUID,
        sender_name VARCHAR(200),
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aam_app_idx ON application_appeal_messages(appeal_id, created_at ASC)`);
    } catch (e: any) {
      console.error('[appeals] schema ensure failed -', dbReason(e));
      throw e;
    }
  });
}

export const APPEAL_KINDS = {
  decision:         { label: 'Final decision (rejection)', description: 'The role decision was rejection and you believe the assessment was incomplete or biased.' },
  scoring:          { label: 'Scoring dispute',            description: 'You contest the per-dimension scoring on your assessment task.' },
  offer_withdrawn:  { label: 'Withdrawn offer',            description: 'An offer was withdrawn without due cause.' },
  other:            { label: 'Other',                      description: 'Anything else procedural or process-based.' },
};

// ---------------------------------------------------------------------------------------------
// The thread. One appeal, two sides, in time order.
// ---------------------------------------------------------------------------------------------

export type AppealSender = 'appellant' | 'reviewer';

export type AppealMessage = {
  id: string;
  appeal_id: string;
  sender_role: AppealSender | string;
  sender_user_id: string | null;
  sender_name: string | null;
  body: string;
  created_at: any;
};

/** Every read here is discriminated. An empty thread and an unreadable one are different facts. */
export type AppealsRead<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: string };

export type AppendResult =
  | { ok: true; message: AppealMessage }
  | { ok: false; reason: string };

const MAX_BODY = 6000;

/**
 * Post one message onto an appeal.
 *
 * OWNERSHIP IS CHECKED HERE, NOT ON THE PAGE. `requireUserId` is passed by the portal surface and
 * makes the statement conditional on the appeal belonging to that person, so an appellant cannot
 * post into somebody else's appeal by editing a hidden field. The admin surface passes nothing,
 * because a reviewer answers any appeal by design — its own page gate decides who is a reviewer.
 *
 * The write NEVER swallows: a failure comes back as a reason the caller must render.
 */
export async function appendAppealMessage(args: {
  appealId: string;
  senderRole: AppealSender;
  senderUserId: string | null;
  senderName: string | null;
  body: string;
  /** When set, the message is only written if the appeal belongs to this user. */
  requireUserId?: string | null;
}): Promise<AppendResult> {
  const appealId = uuidish(args.appealId);
  if (!appealId) return { ok: false, reason: 'That appeal reference is not valid, so nothing was posted.' };

  const body = String(args.body || '').trim().slice(0, MAX_BODY);
  if (!body) return { ok: false, reason: 'Write something before posting — an empty message was not saved.' };

  if (args.senderRole !== 'appellant' && args.senderRole !== 'reviewer') {
    return { ok: false, reason: 'Unknown sender role; nothing was posted.' };
  }

  try {
    await ensureAppealsSchema();
    const owner = args.requireUserId ? uuidish(args.requireUserId) : null;
    if (args.requireUserId && !owner) {
      return { ok: false, reason: 'Your account reference is not valid, so nothing was posted.' };
    }

    const r = await db.execute(sql`
      INSERT INTO application_appeal_messages (appeal_id, sender_role, sender_user_id, sender_name, body)
      SELECT aa.id, ${args.senderRole}, ${args.senderUserId || null}, ${args.senderName || null}, ${body}
        FROM application_appeals aa
       WHERE aa.id = ${appealId}
         ${owner ? sql`AND aa.user_id = ${owner}` : sql``}
      RETURNING id::text AS id, appeal_id::text AS appeal_id, sender_role, sender_user_id::text AS sender_user_id,
                sender_name, body, created_at
    `);
    const rows = toRows<AppealMessage>(r);
    if (rows.length === 0) {
      // The SELECT matched no appeal: it does not exist, or it is not this person's. Saying
      // "posted" here is the exact failure this repair pass exists to remove.
      return { ok: false, reason: 'That appeal could not be found on your record, so nothing was posted.' };
    }
    return { ok: true, message: rows[0] };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[appeals] appendAppealMessage failed -', reason);
    return { ok: false, reason };
  }
}

/** One appeal's thread, oldest first — the order a conversation is read in. */
export async function listAppealMessages(appealId: string): Promise<AppealsRead<AppealMessage>> {
  const id = uuidish(appealId);
  if (!id) return { ok: false, reason: 'That appeal reference is not valid.' };
  try {
    await ensureAppealsSchema();
    const r = await db.execute(sql`
      SELECT id::text AS id, appeal_id::text AS appeal_id, sender_role,
             sender_user_id::text AS sender_user_id, sender_name, body, created_at
        FROM application_appeal_messages
       WHERE appeal_id = ${id}
       ORDER BY created_at ASC
       LIMIT 500
    `);
    return { ok: true, rows: toRows<AppealMessage>(r) };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[appeals] listAppealMessages failed -', reason);
    return { ok: false, reason };
  }
}

/**
 * Every message for a SET of appeals, in one statement.
 *
 * Both surfaces render a list of appeals with each thread inline. Calling listAppealMessages() per
 * row would be one round-trip per appeal on a page that already lists up to 200 of them — the
 * per-recipient loop that src/lib/notify.ts documents as a live performance incident. The id list
 * goes in as JSON and is unrolled inside Postgres, which is the pattern src/lib/pg-array.ts
 * describes: interpolating a JS array and casting it to uuid[] does NOT work with postgres-js.
 */
export async function listAppealMessagesFor(appealIds: string[]): Promise<AppealsRead<AppealMessage>> {
  const ids = (appealIds || []).map((x) => uuidish(x)).filter((x): x is string => !!x);
  if (ids.length === 0) return { ok: true, rows: [] };
  try {
    await ensureAppealsSchema();
    const r = await db.execute(sql`
      SELECT m.id::text AS id, m.appeal_id::text AS appeal_id, m.sender_role,
             m.sender_user_id::text AS sender_user_id, m.sender_name, m.body, m.created_at
        FROM application_appeal_messages m
        JOIN jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)
          ON m.appeal_id = t.x::uuid
       ORDER BY m.created_at ASC
       LIMIT 2000
    `);
    return { ok: true, rows: toRows<AppealMessage>(r) };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[appeals] listAppealMessagesFor failed -', reason);
    return { ok: false, reason };
  }
}

/** Group a flat message list by appeal id, preserving the SQL ordering. */
export function groupMessagesByAppeal(rows: AppealMessage[]): Record<string, AppealMessage[]> {
  const out: Record<string, AppealMessage[]> = {};
  for (const m of rows || []) {
    const k = String(m.appeal_id);
    if (!out[k]) out[k] = [];
    out[k].push(m);
  }
  return out;
}
